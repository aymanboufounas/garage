import { ApiError, audit, transaction } from './core.mjs';
import { staffRole } from './support.mjs';
import { decodeListingPhoto, requireStoredListingPhoto, withListingPhoto } from './listing-photos.mjs';

export function requireModerator(db, user) {
  if (staffRole(db, user.id) !== 'admin') throw new ApiError('Administrator access is required.', 403);
}

export function moderationRoute(db, web, user, method, path, params, data) {
  requireModerator(db, user);
  if (method === 'GET' && path === '/api/staff/garages') {
    const status = params.get('status') || 'pending';
    if (!['pending', 'approved', 'rejected', 'archived'].includes(status)) throw new ApiError('Choose a listing status.');
    const offset = Number(params.get('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ApiError('Invalid page.');
    const rows = db.prepare(`SELECT g.*,u.name AS owner_name,u.email AS owner_email
      FROM garages g JOIN users u ON u.id=g.owner_id WHERE g.status=? ORDER BY g.created_at,g.id LIMIT 26 OFFSET ?`).all(status, offset);
    return { garages: rows.slice(0, 25), has_more: rows.length > 25 };
  }
  const match = path.match(/^\/api\/staff\/garages\/([a-f0-9]{32})\/(approve|reject|archive)$/);
  if (method !== 'POST' || !match) throw new ApiError('Endpoint not found.', 404);
  const [, gid, action] = match;
  const row = db.prepare('SELECT * FROM garages WHERE id=?').get(gid);
  if (!row) throw new ApiError('Listing not found.', 404);
  if (typeof data.expected_status !== 'string' || row.status !== data.expected_status) throw new ApiError('Listing changed. Refresh and try again.', 409);
  if (action === 'approve' && row.status !== 'pending' || action === 'reject' && row.status !== 'pending' || action === 'archive' && row.status !== 'approved') {
    throw new ApiError('This listing cannot be changed in its current status.', 409);
  }
  if (action === 'approve' && data.confirmed !== true) throw new ApiError('Confirm the listing and photo review.');
  let bytes = null;
  if (action === 'approve') {
    if (Object.hasOwn(data, 'expected_image') && data.expected_image !== row.image) throw new ApiError('Listing changed. Refresh and try again.', 409);
    if (Object.hasOwn(data, 'photo_base64')) bytes = decodeListingPhoto(data.photo_base64);
    else {
      if (data.expected_image !== row.image) throw new ApiError('Listing changed. Refresh and try again.', 409);
      requireStoredListingPhoto(web, row.image);
    }
  }
  return withListingPhoto(web, bytes, uploadedImage => transaction(db, () => {
    if (action !== 'approve' && db.prepare("SELECT 1 FROM reservations WHERE garage_id=? AND status='confirmed' AND ends_at>?").get(gid, Date.now())) {
      throw new ApiError('Resolve upcoming reservations before archiving or rejecting this space.', 409);
    }
    const status = { approve: 'approved', reject: 'rejected', archive: 'archived' }[action];
    const image = uploadedImage || row.image;
    db.prepare('UPDATE garages SET status=?,image=? WHERE id=?').run(status, image, gid);
    audit(db, user.id, 'moderator_' + (action === 'approve' ? 'approved' : action), gid);
    return { id: gid, status, image };
  }));
}
