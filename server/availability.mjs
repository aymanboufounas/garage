import { ApiError, audit, checkedRequestKey, garageAvailableSql, id, interval, limit, noOverlap,
  publicGarage, text, transaction, zonedTimestamp } from './core.mjs';

const DAY = 86400000;

export function browseGarages(db, params) {
  const city = params.get('city') || null;
  const hasPeriod = ['starts_at', 'mode', 'units'].some(key => params.has(key));
  const period = hasPeriod ? interval({ starts_at: params.get('starts_at'), mode: params.get('mode'), units: Number(params.get('units')) }) : null;
  const times = period ? [period.ends_at, period.starts_at, period.ends_at, period.starts_at] : [];
  const rows = db.prepare(`
    SELECT g.*,u.name AS owner_name,score.rating,score.review_count FROM garages g
    JOIN users u ON u.id=g.owner_id
    LEFT JOIN (
      SELECT b.garage_id,round(avg(r.rating),1) AS rating,count(*) AS review_count
      FROM stay_reviews r JOIN reservations b ON b.id=r.reservation_id
      WHERE b.status='confirmed' AND r.role='renter' AND r.publish_at<=?
      GROUP BY b.garage_id
    ) score ON score.garage_id=g.id
    WHERE g.status='approved' AND (? IS NULL OR g.city=?) ${period ? `AND ${garageAvailableSql}` : ''}
    ORDER BY g.created_at DESC LIMIT 200
  `).all(Date.now(), city, city, ...times);
  return { garages: rows.map(publicGarage), period };
}

function ownedGarage(db, userId, garageId) {
  const garage = db.prepare('SELECT id,status FROM garages WHERE id=? AND owner_id=?').get(garageId, userId);
  if (!garage) throw new ApiError('Garage calendar not found.', 404);
  return garage;
}

function range(start, end, days) {
  const starts_at = zonedTimestamp(start);
  const ends_at = zonedTimestamp(end, 'end time');
  if (!Number.isFinite(starts_at) || !Number.isFinite(ends_at) || ends_at<=starts_at || ends_at-starts_at>days*DAY) {
    throw new ApiError('Choose a valid calendar range.');
  }
  return { starts_at, ends_at };
}

export function calendarRoute(db, userId, method, path, params, data) {
  const match = path.match(/^\/api\/host\/calendar\/([a-f0-9]{32})(?:\/(blocks)(?:\/([a-f0-9]{32})\/remove)?)?$/);
  if (!match) throw new ApiError('Endpoint not found.', 404);
  const [, garageId, blocks, blockId] = match;
  const garage = ownedGarage(db, userId, garageId);
  if (method === 'GET' && !blocks) {
    const period = range(params.get('from'), params.get('to'), 32);
    const args = [garageId, period.ends_at, period.starts_at];
    return {
      blocks: db.prepare('SELECT id,starts_at,ends_at,note FROM garage_blocks WHERE garage_id=? AND starts_at<? AND ends_at>? ORDER BY starts_at').all(...args),
      bookings: db.prepare("SELECT id,starts_at,ends_at FROM reservations WHERE garage_id=? AND status='confirmed' AND starts_at<? AND ends_at>? ORDER BY starts_at").all(...args)
    };
  }
  if (method === 'POST' && blockId) {
    return transaction(db, () => {
      const removed = db.prepare('DELETE FROM garage_blocks WHERE garage_id=? AND id=?').run(garageId, blockId);
      if (removed.changes) audit(db, userId, 'calendar_block_removed', blockId);
      return { ok: true };
    });
  }
  if (method === 'POST' && blocks) {
    if (garage.status === 'archived') throw new ApiError('This garage is unavailable.', 409);
    const key = checkedRequestKey(data);
    limit(db, `calendar-block:${userId}`, 60, 3600000);
    return transaction(db, () => {
      const previous = db.prepare('SELECT id FROM garage_blocks WHERE garage_id=? AND request_key=?').get(garageId, key);
      if (previous) return previous;
      const { starts_at, ends_at } = range(data.starts_at, data.ends_at, 366);
      const now = Date.now();
      if (starts_at < now - 60000 || ends_at > now + 366 * DAY || ends_at - starts_at < 15 * 60000) {
        throw new ApiError('Block at least 15 minutes within the next year.');
      }
      const note = text({ note: data.note ?? '' }, 'note', 0, 200);
      noOverlap(db, garageId, starts_at, ends_at);
      const block = id();
      db.prepare('INSERT INTO garage_blocks (id,garage_id,starts_at,ends_at,note,request_key,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(block, garageId, starts_at, ends_at, note, key, now);
      audit(db, userId, 'calendar_block_created', block);
      return { id: block };
    });
  }
  throw new ApiError('Endpoint not found.', 404);
}
