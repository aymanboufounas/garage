import { ApiError, audit, cities, id, integer, passwordHash, text, transaction } from './core.mjs';
import { requireModerator } from './moderation.mjs';

const recordId = /^[a-f0-9]{32}$/;
const bookingStatuses = ['requested', 'countered', 'confirmed', 'declined', 'cancelled', 'expired'];
function identifier(value) {
  if (typeof value !== 'string' || !recordId.test(value)) throw new ApiError('Choose a valid account or listing.');
  return value;
}
function emailField(data) {
  const email = text(data, 'email', 3, 190).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError('Enter a valid email.');
  return email;
}
function pagination(params) {
  const offset = Number(params.get('offset') || 0);
  const q = (params.get('q') || '').trim();
  if (!Number.isSafeInteger(offset) || offset < 0 || q.length > 120) throw new ApiError('Invalid page or search.');
  return { offset, q };
}
const page = (name, rows) => ({ [name]: rows.slice(0, 25), has_more: rows.length > 25 });
function counts(db, table) {
  return Object.fromEntries(db.prepare(`SELECT status,count(*) AS n FROM ${table} GROUP BY status`).all().map(row => [row.status, row.n]));
}
function total(values) { return Object.values(values).reduce((sum, value) => sum + value, 0); }
function percentage(value, denominator) { return denominator ? Math.round(value / denominator * 1000) / 10 : 0; }
function userView(db, userId) {
  return db.prepare(`SELECT u.id,u.name,u.email,u.created_at,coalesce(s.role,'customer') AS role,
    (SELECT count(*) FROM garages WHERE owner_id=u.id) AS garage_count,
    (SELECT count(*) FROM reservations WHERE guest_id=u.id) AS reservation_count
    FROM users u LEFT JOIN staff_members s ON s.user_id=u.id WHERE u.id=?`).get(userId);
}
function requireTarget(db, userId) {
  const row = userView(db, userId);
  if (!row) throw new ApiError('Account not found.', 404);
  return row;
}
function duplicateEmail(error) {
  if (String(error.message).includes('UNIQUE constraint failed: users.email')) throw new ApiError('This email is already registered.', 409);
  throw error;
}
function overview(db) {
  const garages = counts(db, 'garages'), bookings = counts(db, 'reservations'), tickets = counts(db, 'support_tickets');
  const garageTotal = total(garages), bookingTotal = total(bookings), ticketTotal = total(tickets);
  return {
    counts: {
      users: db.prepare('SELECT count(*) AS n FROM users').get().n,
      garages: garageTotal, reservations: bookingTotal,
      pending_garages: garages.pending || 0, approved_garages: garages.approved || 0,
      open_tickets: (tickets.open || 0) + (tickets.waiting || 0)
    },
    garage_statuses: garages, booking_statuses: bookings, ticket_statuses: tickets,
    percentages: {
      approved_garages: percentage(garages.approved || 0, garageTotal),
      confirmed_bookings: percentage(bookings.confirmed || 0, bookingTotal),
      cancelled_bookings: percentage(bookings.cancelled || 0, bookingTotal),
      resolved_tickets: percentage(tickets.resolved || 0, ticketTotal)
    },
    confirmed_booking_value_cents: db.prepare("SELECT coalesce(sum(total_cents),0) AS n FROM reservations WHERE status='confirmed'").get().n,
    payment_mode: 'pay_on_arrival',
    recent_activity: db.prepare(`SELECT a.id,u.name AS actor_name,a.action,a.target_id,a.created_at
      FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 15`).all(),
    generated_at: Date.now()
  };
}
function users(db, params) {
  const { offset, q } = pagination(params);
  return page('users', db.prepare(`SELECT u.id,u.name,u.email,u.created_at,coalesce(s.role,'customer') AS role,
    (SELECT count(*) FROM garages WHERE owner_id=u.id) AS garage_count,
    (SELECT count(*) FROM reservations WHERE guest_id=u.id) AS reservation_count
    FROM users u LEFT JOIN staff_members s ON s.user_id=u.id
    WHERE (?='' OR instr(lower(u.name),lower(?))>0 OR instr(lower(u.email),lower(?))>0)
    ORDER BY u.created_at DESC,u.id LIMIT 26 OFFSET ?`).all(q, q, q, offset));
}
function updateUser(db, actor, userId, data) {
  const name = text(data, 'name', 2, 80), email = emailField(data);
  return transaction(db, () => {
    const current = requireTarget(db, userId);
    if (current.name !== data.expected_name || current.email !== data.expected_email) throw new ApiError('Account changed. Refresh and try again.', 409);
    try { db.prepare('UPDATE users SET name=?,email=? WHERE id=?').run(name, email, userId); }
    catch (error) { duplicateEmail(error); }
    // Identity edits end the target's sessions, including the admin's own session when editing self.
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    audit(db, actor.id, 'admin_account_updated', userId);
    return { user: userView(db, userId), sign_in_required: actor.id === userId };
  });
}
function changeRole(db, actor, userId, data) {
  if (!['customer', 'support', 'admin'].includes(data.role)) throw new ApiError('Choose a valid account role.');
  return transaction(db, () => {
    const current = requireTarget(db, userId);
    if (current.role !== data.expected_role) throw new ApiError('Account changed. Refresh and try again.', 409);
    if (actor.id === userId && data.role !== 'admin') throw new ApiError('You cannot remove your own administrator access.', 409);
    if (current.role === 'admin' && data.role !== 'admin' && db.prepare("SELECT count(*) AS n FROM staff_members WHERE role='admin'").get().n <= 1) {
      throw new ApiError('Keep at least one administrator.', 409);
    }
    if (data.role === 'customer') db.prepare('DELETE FROM staff_members WHERE user_id=?').run(userId);
    else db.prepare('INSERT INTO staff_members(user_id,role) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role').run(userId, data.role);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    audit(db, actor.id, 'admin_role_' + data.role, userId);
    return { user: userView(db, userId), sign_in_required: actor.id === userId };
  });
}
function removeUser(db, actor, userId, data) {
  return transaction(db, () => {
    const current = requireTarget(db, userId);
    if (current.email !== data.expected_email) throw new ApiError('Account changed. Refresh and try again.', 409);
    if (actor.id === userId) throw new ApiError('You cannot remove your own account here.', 409);
    if (current.role === 'admin' && db.prepare("SELECT count(*) AS n FROM staff_members WHERE role='admin'").get().n <= 1) throw new ApiError('Keep at least one administrator.', 409);
    // Deletion is limited to unused accounts. Historical rental/support records remain intact.
    const relationships = [
      ['garages', 'owner_id'], ['reservations', 'guest_id'], ['rental_requests', 'guest_id'],
      ['support_tickets', 'customer_id'], ['support_tickets', 'assignee_id'], ['support_messages', 'author_id'],
      ['chat_threads', 'guest_id'], ['chat_threads', 'host_id'], ['chat_messages', 'sender_id'], ['stay_reviews', 'author_id'],
      ['admin_reservation_decisions', 'actor_id']
    ];
    if (relationships.some(([table, field]) => db.prepare(`SELECT 1 FROM ${table} WHERE ${field}=? LIMIT 1`).get(userId))) {
      throw new ApiError('This account has rental or support history and cannot be removed here.', 409);
    }
    db.prepare('DELETE FROM users WHERE id=?').run(userId);
    audit(db, actor.id, 'admin_account_removed', userId);
    return { ok: true };
  });
}
function reservations(db, params) {
  const { offset, q } = pagination(params), status = params.get('status') || 'all';
  if (status !== 'all' && !bookingStatuses.includes(status)) throw new ApiError('Choose a reservation status.');
  return page('reservations', db.prepare(`SELECT r.id,r.status,r.mode,r.starts_at,r.ends_at,r.total_cents,r.updated_at,
    g.name AS garage_name,u.name AS guest_name,u.email AS guest_email,o.name AS owner_name,
    d.reason AS last_cancel_reason,d.created_at AS cancelled_at
    FROM reservations r JOIN garages g ON g.id=r.garage_id JOIN users u ON u.id=r.guest_id JOIN users o ON o.id=g.owner_id
    LEFT JOIN admin_reservation_decisions d ON d.reservation_id=r.id
    WHERE (?='all' OR r.status=?) AND (?='' OR instr(lower(g.name),lower(?))>0 OR instr(lower(u.name),lower(?))>0
      OR instr(lower(u.email),lower(?))>0 OR instr(r.id,?)>0)
    ORDER BY r.created_at DESC,r.id LIMIT 26 OFFSET ?`).all(status, status, q, q, q, q, q, offset));
}
function cancelReservation(db, actor, reservationId, data) {
  const reason = text(data, 'reason', 5, 300);
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM reservations WHERE id=?').get(reservationId);
    if (!row) throw new ApiError('Reservation not found.', 404);
    if (!Number.isSafeInteger(data.expected_updated_at) || row.updated_at !== data.expected_updated_at) throw new ApiError('Reservation changed. Refresh and try again.', 409);
    if (!['requested', 'countered', 'confirmed'].includes(row.status) || row.starts_at <= Date.now()) throw new ApiError('This reservation can no longer be cancelled here.', 409);
    const now = Math.max(Date.now(), row.updated_at + 1);
    db.prepare("UPDATE reservations SET status='cancelled',updated_at=? WHERE id=?").run(now, reservationId);
    db.prepare('INSERT INTO admin_reservation_decisions(reservation_id,actor_id,reason,created_at) VALUES (?,?,?,?)').run(reservationId, actor.id, reason, now);
    audit(db, actor.id, 'admin_reservation_cancelled', reservationId);
    return { id: reservationId, status: 'cancelled', updated_at: now };
  });
}
function garageFields(db, data) {
  const owner = identifier(data.owner_id);
  requireTarget(db, owner);
  const value = {
    owner_id: owner, name: text(data, 'name', 3, 100), city: text(data, 'city', 2, 60),
    area: text(data, 'area', 2, 100), address: text(data, 'address', 5, 220), description: text(data, 'description', 10, 1500),
    hourly_cents: integer(data.hourly_cents, 100, 100000, 'hourly price'),
    monthly_cents: integer(data.monthly_cents, 10000, 10000000, 'monthly price'),
    height_cm: integer(data.height_cm, 140, 500, 'entrance height in cm'),
    vehicle_size: data.vehicle_size, covered: data.covered, latitude: data.latitude, longitude: data.longitude
  };
  if (!cities.includes(value.city)) throw new ApiError('Choose a supported city.');
  if (!['compact', 'suv', 'van'].includes(value.vehicle_size) || typeof value.covered !== 'boolean') throw new ApiError('Check vehicle size and cover.');
  if (!Number.isFinite(value.latitude) || value.latitude < 27.5 || value.latitude > 36 || !Number.isFinite(value.longitude) || value.longitude < -14 || value.longitude > -0.8) throw new ApiError('Place your garage pin inside Morocco.');
  return value;
}
function manageGarage(db, actor, garageId, data) {
  const value = garageFields(db, data);
  return transaction(db, () => {
    if (!garageId) {
      garageId = id();
      db.prepare('INSERT INTO garages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(garageId, value.owner_id, value.name, value.city, value.area, value.address,
        value.latitude, value.longitude, value.hourly_cents, value.monthly_cents, value.height_cm, value.vehicle_size, value.covered ? 1 : 0,
        value.description, '/assets/garage-placeholder.svg', 'pending', Date.now());
      audit(db, actor.id, 'admin_listing_created', garageId);
    } else {
      const current = db.prepare('SELECT * FROM garages WHERE id=?').get(garageId);
      if (!current) throw new ApiError('Listing not found.', 404);
      if (current.status !== data.expected_status) throw new ApiError('Listing changed. Refresh and try again.', 409);
      if (value.owner_id !== current.owner_id && db.prepare('SELECT 1 FROM reservations WHERE garage_id=? LIMIT 1').get(garageId)) {
        throw new ApiError('The owner of a garage with reservation history cannot be changed.', 409);
      }
      if (db.prepare("SELECT 1 FROM reservations WHERE garage_id=? AND status='confirmed' AND ends_at>?").get(garageId, Date.now())) throw new ApiError('Resolve upcoming reservations before editing this space.', 409);
      db.prepare(`UPDATE garages SET owner_id=?,name=?,city=?,area=?,address=?,latitude=?,longitude=?,hourly_cents=?,monthly_cents=?,
        height_cm=?,vehicle_size=?,covered=?,description=?,status='pending' WHERE id=?`).run(value.owner_id, value.name, value.city, value.area, value.address,
        value.latitude, value.longitude, value.hourly_cents, value.monthly_cents, value.height_cm, value.vehicle_size, value.covered ? 1 : 0, value.description, garageId);
      audit(db, actor.id, 'admin_listing_updated', garageId);
    }
    return { garage: db.prepare('SELECT * FROM garages WHERE id=?').get(garageId) };
  });
}

export async function adminOperationsRoute(db, actor, method, path, params, data) {
  requireModerator(db, actor);
  if (method === 'GET' && path === '/api/staff/overview') return overview(db);
  if (path === '/api/staff/users') {
    if (method === 'GET') return users(db, params);
    if (method === 'POST') {
      const name = text(data, 'name', 2, 80), email = emailField(data);
      if (typeof data.password !== 'string' || data.password.length < 12 || data.password.length > 128) throw new ApiError('Use a password of 12–128 characters.');
      const password = await passwordHash(data.password);
      // Hashing is asynchronous, so recheck authorization before any mutation.
      requireModerator(db, actor);
      const userId = id();
      return transaction(db, () => {
        try { db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(userId, name, email, password, Date.now()); }
        catch (error) { duplicateEmail(error); }
        audit(db, actor.id, 'admin_account_created', userId);
        return { user: userView(db, userId) };
      });
    }
  }
  const account = path.match(/^\/api\/staff\/users\/([a-f0-9]{32})\/(update|role|remove)$/);
  if (method === 'POST' && account) {
    const [, userId, action] = account;
    if (action === 'update') return updateUser(db, actor, userId, data);
    if (action === 'role') return changeRole(db, actor, userId, data);
    if (action === 'remove') return removeUser(db, actor, userId, data);
  }
  if (method === 'GET' && path === '/api/staff/reservations') return reservations(db, params);
  const reservation = path.match(/^\/api\/staff\/reservations\/([a-f0-9]{32})\/cancel$/);
  if (method === 'POST' && reservation) return cancelReservation(db, actor, reservation[1], data);
  if (method === 'POST' && path === '/api/staff/managed-garages') return manageGarage(db, actor, null, data);
  const garage = path.match(/^\/api\/staff\/managed-garages\/([a-f0-9]{32})\/update$/);
  if (method === 'POST' && garage) return manageGarage(db, actor, garage[1], data);
  throw new ApiError('Endpoint not found.', 404);
}
