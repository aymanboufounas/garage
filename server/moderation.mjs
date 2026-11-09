import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiError, audit, id, transaction } from './core.mjs';
import { staffRole } from './support.mjs';

export function requireModerator(db, user) {
  if (staffRole(db, user.id) !== 'admin') throw new ApiError('Administrator access is required.', 403);
}

function photoBytes(value) {
  if (typeof value !== 'string' || value.length > 6990508 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new ApiError('Choose a WebP photo under 5 MB.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length < 20 || bytes.length > 5 * 1024 * 1024 ||
      bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' ||
      bytes.readUInt32LE(4) !== bytes.length - 8) throw new ApiError('Choose a valid WebP photo.');
  let image = false;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new ApiError('Choose a valid WebP photo.');
    const kind = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const next = offset + 8 + length + (length % 2);
    if (next > bytes.length || ['EXIF', 'XMP ', 'ICCP', 'ANIM', 'ANMF'].includes(kind)) {
      throw new ApiError('Use a still WebP photo without metadata.');
    }
    if (['VP8 ', 'VP8L'].includes(kind) && length > 0) image = true;
    offset = next;
  }
  if (!image) throw new ApiError('Choose a valid WebP photo.');
  return bytes;
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
  let filename;
  try {
    const image = action === 'approve' ? photoBytes(data.photo_base64) : null;
    return transaction(db, () => {
      if (action !== 'approve' && db.prepare("SELECT 1 FROM reservations WHERE garage_id=? AND status='confirmed' AND ends_at>?").get(gid, Date.now())) {
        throw new ApiError('Resolve upcoming reservations before archiving or rejecting this space.', 409);
      }
      const status = { approve: 'approved', reject: 'rejected', archive: 'archived' }[action];
      let imagePath = row.image;
      if (image) {
        const directory = resolve(web, 'assets/host-photos');
        mkdirSync(directory, { recursive: true });
        const name = id() + '.webp';
        filename = resolve(directory, name);
        writeFileSync(filename, image, { flag: 'wx', mode: 0o644 });
        imagePath = '/assets/host-photos/' + name;
      }
      db.prepare('UPDATE garages SET status=?,image=? WHERE id=?').run(status, imagePath, gid);
      audit(db, user.id, 'moderator_' + (action === 'approve' ? 'approved' : action), gid);
      return { id: gid, status, image: imagePath };
    });
  } catch (error) {
    if (filename) { try { unlinkSync(filename); } catch {} }
    throw error;
  }
}
