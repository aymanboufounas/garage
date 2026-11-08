import { ApiError, audit, checkedRequestKey, cities, garageAvailableSql, id, integer, interval, limit, noOverlap, transaction } from './core.mjs';

const HOUR = 3600000;
const recordId = /^[a-f0-9]{32}$/;

function totalPrice(value, period) {
  const maxRate = period.mode === 'hourly' ? 100000 : 10000000;
  return integer(value, 100, maxRate * period.units * 2, 'total price');
}

function requestView(db, row) {
  const { guest_id, request_key, ...view } = row;
  view.quotes = db.prepare(`
    SELECT q.id, q.garage_id, q.status, q.total_cents, g.name, g.area,
           g.covered, g.vehicle_size, u.name AS owner_name,
           CASE WHEN g.status='approved' AND ${garageAvailableSql} THEN 1 ELSE 0 END AS available
    FROM rental_quotes q JOIN garages g ON g.id=q.garage_id
    JOIN users u ON u.id=g.owner_id WHERE q.request_id=?
    ORDER BY q.total_cents IS NULL, q.total_cents, g.name
  `).all(row.ends_at, row.starts_at, row.ends_at, row.starts_at, row.id);
  return view;
}

function guestRequest(db, guestId, requestId) {
  const row = db.prepare(`
    SELECT r.*, b.garage_id AS selected_garage_id FROM rental_requests r
    LEFT JOIN reservations b ON b.id=r.reservation_id WHERE r.id=? AND r.guest_id=?
  `).get(requestId, guestId);
  if (!row) throw new ApiError('Price request not found.', 404);
  return row;
}

function requireOpen(row, now) {
  if (row.status !== 'open' || row.expires_at <= now) {
    throw new ApiError('This price request is closed.', 409);
  }
}

function createRequest(db, userId, data) {
  const key = checkedRequestKey(data);
  limit(db, `deal-create:${userId}`, 12, HOUR);
  return transaction(db, () => {
    const previous = db.prepare('SELECT id FROM rental_requests WHERE guest_id=? AND request_key=?').get(userId, key);
    if (previous) return requestView(db, guestRequest(db, userId, previous.id));
    const garageIds = data.garage_ids;
    if (!Array.isArray(garageIds) || garageIds.length < 1 || garageIds.length > 5 ||
        garageIds.some(value => typeof value !== 'string' || !recordId.test(value)) ||
        new Set(garageIds).size !== garageIds.length) {
      throw new ApiError('Choose one to five different garages.');
    }
    if (!cities.includes(data.city)) throw new ApiError('Choose a supported city.');
    const now = Date.now();
    const period = interval(data, now);
    const proposed = totalPrice(data.proposed_cents, period);
    const active = db.prepare("SELECT count(*) AS count FROM rental_requests WHERE guest_id=? AND status='open'").get(userId);
    if (active.count >= 5) throw new ApiError('Close one of your open price requests first.', 409);
    const findGarage = db.prepare("SELECT owner_id FROM garages WHERE id=? AND city=? AND status='approved'");
    for (const garageId of garageIds) {
      const garage = findGarage.get(garageId, data.city);
      if (!garage) throw new ApiError('This garage is unavailable.', 404);
      if (garage.owner_id === userId) throw new ApiError('You cannot book your own garage.', 409);
      noOverlap(db, garageId, period.starts_at, period.ends_at);
    }
    const requestId = id();
    db.prepare(`
      INSERT INTO rental_requests (id,guest_id,city,mode,starts_at,ends_at,units,proposed_cents,status,expires_at,created_at,request_key)
      VALUES (?,?,?,?,?,?,?,?,'open',?,?,?)
    `).run(requestId, userId, data.city, period.mode, period.starts_at, period.ends_at,
      period.units, proposed, Math.min(now + 24 * HOUR, period.starts_at), now, key);
    const invite = db.prepare("INSERT INTO rental_quotes (id,request_id,garage_id,status) VALUES (?,?,?,'invited')");
    for (const garageId of garageIds) invite.run(id(), requestId, garageId);
    audit(db, userId, 'price_request_created', requestId);
    return requestView(db, guestRequest(db, userId, requestId));
  });
}

function respondToRequest(db, userId, quoteId, data) {
  if (!['match', 'counter', 'decline'].includes(data.action)) throw new ApiError('This action is not available.');
  return transaction(db, () => {
    const quote = db.prepare(`
      SELECT q.*, r.mode, r.units, r.proposed_cents, r.starts_at, r.ends_at,
             r.status AS request_status, r.expires_at, g.status AS garage_status
      FROM rental_quotes q JOIN rental_requests r ON r.id=q.request_id
      JOIN garages g ON g.id=q.garage_id WHERE q.id=? AND g.owner_id=?
    `).get(quoteId, userId);
    if (!quote) throw new ApiError('Price quote not found.', 404);
    requireOpen({ status: quote.request_status, expires_at: quote.expires_at }, Date.now());
    if (data.action === 'decline') {
      if (quote.status !== 'declined') {
        db.prepare("UPDATE rental_quotes SET status='declined',total_cents=NULL WHERE id=?").run(quoteId);
        audit(db, userId, 'price_quote_declined', quoteId);
      }
      return { ok: true };
    }
    const total = data.action === 'match' ? quote.proposed_cents : totalPrice(data.total_cents, quote);
    if (quote.status === 'quoted' && quote.total_cents === total) return { ok: true };
    if (quote.status !== 'invited') throw new ApiError('This action is not available.', 409);
    if (quote.garage_status !== 'approved') throw new ApiError('This garage is unavailable.', 409);
    noOverlap(db, quote.garage_id, quote.starts_at, quote.ends_at);
    db.prepare("UPDATE rental_quotes SET status='quoted',total_cents=? WHERE id=?").run(total, quoteId);
    audit(db, userId, 'price_quote_sent', quoteId);
    return { ok: true };
  });
}

function selectQuote(db, userId, requestId, data) {
  return transaction(db, () => {
    const request = guestRequest(db, userId, requestId);
    if (typeof data.quote_id !== 'string' || !recordId.test(data.quote_id)) throw new ApiError('Price quote not found.', 404);
    const quote = db.prepare(`
      SELECT q.*, g.status AS garage_status FROM rental_quotes q
      JOIN garages g ON g.id=q.garage_id WHERE q.id=? AND q.request_id=?
    `).get(data.quote_id, requestId);
    if (!quote) throw new ApiError('Price quote not found.', 404);
    if (quote.status !== 'quoted' || quote.total_cents !== data.total_cents) {
      throw new ApiError('This price quote is no longer available. Refresh your offers.', 409);
    }
    if (request.reservation_id) {
      if (request.selected_garage_id !== quote.garage_id) throw new ApiError('This price request already has a booking.', 409);
      return { reservation_id: request.reservation_id };
    }
    const now = Date.now();
    requireOpen(request, now);
    if (quote.garage_status !== 'approved') throw new ApiError('This garage is unavailable.', 409);
    noOverlap(db, quote.garage_id, request.starts_at, request.ends_at);
    const reservationId = id();
    db.prepare(`
      INSERT INTO reservations (id,garage_id,guest_id,mode,starts_at,ends_at,units,total_cents,status,expires_at,created_at,updated_at,request_key)
      VALUES (?,?,?,?,?,?,?,?,'confirmed',NULL,?,?,?)
    `).run(reservationId, quote.garage_id, userId, request.mode, request.starts_at,
      request.ends_at, request.units, quote.total_cents, now, now, `deal:${requestId}`);
    db.prepare("UPDATE rental_requests SET status='booked',reservation_id=? WHERE id=?").run(reservationId, requestId);
    audit(db, userId, 'price_quote_booked', reservationId);
    return { reservation_id: reservationId };
  });
}

export function dealsRoute(db, userId, method, path, data) {
  const now = Date.now();
  db.prepare("UPDATE rental_requests SET status='expired' WHERE status='open' AND expires_at<=?").run(now);
  if (method === 'GET' && path === '/api/deals') {
    const rows = db.prepare(`
      SELECT r.*, b.garage_id AS selected_garage_id FROM rental_requests r
      LEFT JOIN reservations b ON b.id=r.reservation_id WHERE r.guest_id=?
      ORDER BY r.status<>'open', r.created_at DESC LIMIT 40
    `).all(userId);
    return { requests: rows.map(row => requestView(db, row)) };
  }
  if (method === 'GET' && path === '/api/host/deals') {
    const quotes = db.prepare(`
      SELECT q.id, q.garage_id, q.status, q.total_cents, r.mode, r.units,
             r.starts_at, r.ends_at, r.expires_at, r.proposed_cents, r.status AS request_status,
             g.name, g.city, g.area, u.name AS guest_name, b.garage_id=q.garage_id AS selected
      FROM rental_quotes q JOIN rental_requests r ON r.id=q.request_id
      JOIN garages g ON g.id=q.garage_id JOIN users u ON u.id=r.guest_id
      LEFT JOIN reservations b ON b.id=r.reservation_id WHERE g.owner_id=?
      ORDER BY r.status<>'open', r.created_at DESC LIMIT 80
    `).all(userId);
    return { quotes };
  }
  if (method === 'POST' && path === '/api/deals') return { request: createRequest(db, userId, data) };
  const host = path.match(/^\/api\/host\/deals\/([a-f0-9]{32})\/respond$/);
  if (method === 'POST' && host) return respondToRequest(db, userId, host[1], data);
  const guest = path.match(/^\/api\/deals\/([a-f0-9]{32})\/(select|cancel)$/);
  if (method === 'POST' && guest?.[2] === 'select') return selectQuote(db, userId, guest[1], data);
  if (method === 'POST' && guest?.[2] === 'cancel') {
    return transaction(db, () => {
      const request = guestRequest(db, userId, guest[1]);
      if (request.status === 'cancelled') return { ok: true };
      requireOpen(request, Date.now());
      db.prepare("UPDATE rental_requests SET status='cancelled' WHERE id=?").run(request.id);
      audit(db, userId, 'price_request_cancelled', request.id);
      return { ok: true };
    });
  }
  throw new ApiError('Endpoint not found.', 404);
}
