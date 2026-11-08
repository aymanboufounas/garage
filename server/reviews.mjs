import { ApiError, audit, integer, limit, text, transaction } from './core.mjs';

const REVIEW_WINDOW = 14 * 86400000;

function stay(db, userId, reservationId) {
  const row = db.prepare(`
    SELECT b.id,b.guest_id,b.ends_at,b.status,g.owner_id,g.name
    FROM reservations b JOIN garages g ON g.id=b.garage_id
    WHERE b.id=? AND (b.guest_id=? OR g.owner_id=?)
  `).get(reservationId, userId, userId);
  if (!row) throw new ApiError('Reservation not found.', 404);
  return row;
}

function reviewView(db, row, userId, now) {
  const role = row.owner_id === userId ? 'host' : 'renter';
  const deadline = row.ends_at + REVIEW_WINDOW;
  const reviews = db.prepare('SELECT role,rating,comment,created_at,publish_at FROM stay_reviews WHERE reservation_id=?').all(row.id);
  const mine = reviews.find(review => review.role === role) || null;
  const other = reviews.find(review => review.role !== role && review.publish_at <= now) || null;
  return { reservation_id: row.id, garage_name: row.name, role, deadline, mine, other,
    can_review: row.status === 'confirmed' && row.ends_at <= now && now < deadline && !mine,
    published: Boolean(mine && mine.publish_at <= now) };
}

export function garageReviews(db, garageId) {
  if (!db.prepare("SELECT id FROM garages WHERE id=? AND status='approved'").get(garageId)) {
    throw new ApiError('This garage is unavailable.', 404);
  }
  const reviews = db.prepare(`
    SELECT r.rating,r.comment,r.created_at FROM stay_reviews r JOIN reservations b ON b.id=r.reservation_id
    WHERE b.garage_id=? AND b.status='confirmed' AND r.role='renter' AND r.publish_at<=?
    ORDER BY r.publish_at DESC,r.created_at DESC LIMIT 30
  `).all(garageId, Date.now());
  return { reviews };
}

export function reviewsRoute(db, userId, method, path, data) {
  const match = path.match(/^\/api\/reviews\/([a-f0-9]{32})$/);
  if (!match) throw new ApiError('Endpoint not found.', 404);
  const reservationId = match[1];
  if (method === 'GET') return reviewView(db, stay(db, userId, reservationId), userId, Date.now());
  const rating = integer(data.rating, 1, 5, 'star rating');
  const comment = text({ comment: data.comment ?? '' }, 'comment', 0, 1000);
  limit(db, `review:${userId}`, 30, 3600000);
  return transaction(db, () => {
    const now = Date.now();
    const row = stay(db, userId, reservationId);
    const view = reviewView(db, row, userId, now);
    if (view.mine) {
      if (view.mine.rating === rating && view.mine.comment === comment) return view;
      throw new ApiError('You already reviewed this stay.', 409);
    }
    if (!view.can_review) throw new ApiError('Reviews are open for 14 days after a completed stay.', 409);
    db.prepare('INSERT INTO stay_reviews (reservation_id,author_id,role,rating,comment,created_at,publish_at) VALUES (?,?,?,?,?,?,?)')
      .run(reservationId, userId, view.role, rating, comment, now, view.deadline);
    const count = db.prepare('SELECT count(*) AS count FROM stay_reviews WHERE reservation_id=?').get(reservationId).count;
    if (count === 2) db.prepare('UPDATE stay_reviews SET publish_at=? WHERE reservation_id=?').run(now, reservationId);
    audit(db, userId, 'stay_review_submitted', reservationId);
    return reviewView(db, row, userId, now);
  });
}
