import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiError, audit, id, transaction } from './core.mjs';

const maximumPhotoBytes = 5 * 1024 * 1024;
const storedPhotoPattern = /^\/assets\/host-photos\/([a-f0-9]{32}\.webp)$/;

function validatePhoto(bytes) {
  if (bytes.length < 20 || bytes.length > maximumPhotoBytes || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8) throw new ApiError('Choose a valid WebP photo.');
  let image = false;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new ApiError('Choose a valid WebP photo.');
    const kind = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const next = offset + 8 + length + (length % 2);
    if (next > bytes.length || ['EXIF', 'XMP ', 'ICCP', 'ANIM', 'ANMF'].includes(kind)) throw new ApiError('Use a still WebP photo without metadata.');
    if (['VP8 ', 'VP8L'].includes(kind) && length > 0) image = true;
    offset = next;
  }
  if (!image) throw new ApiError('Choose a valid WebP photo.');
  return bytes;
}

export function decodeListingPhoto(value) {
  if (typeof value !== 'string' || value.length > 6990508 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new ApiError('Choose a WebP photo under 5 MB.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new ApiError('Choose a valid WebP photo.');
  return validatePhoto(bytes);
}

// The callback commits the listing mutation. If storage or the DB transaction
// fails, remove only the new file created by this operation, never an older photo.
export function withListingPhoto(web, bytes, action) {
  if (!bytes) return action(null);
  const directory = resolve(web, 'assets/host-photos');
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('Invalid photo directory.');
  const name = id() + '.webp', filename = resolve(directory, name);
  let descriptor, created = false;
  try {
    descriptor = openSync(filename, 'wx', 0o644); created = true;
    writeFileSync(descriptor, bytes); closeSync(descriptor); descriptor = undefined;
    return action('/assets/host-photos/' + name);
  } catch (error) {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} }
    if (created) { try { unlinkSync(filename); } catch {} }
    throw error;
  }
}

export function requireStoredListingPhoto(web, image) {
  const match = typeof image === 'string' && image.match(storedPhotoPattern);
  if (!match) throw new ApiError('Ask the host to upload a garage photo before approval.');
  try {
    const directory = resolve(web, 'assets/host-photos'), filename = resolve(directory, match[1]);
    const directoryInfo = lstatSync(directory), info = lstatSync(filename);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || info.isSymbolicLink() || !info.isFile() || info.size > maximumPhotoBytes) {
      throw new Error('Unavailable stored photo.');
    }
    validatePhoto(readFileSync(filename));
  } catch {
    throw new ApiError('The listing photo is unavailable. Ask the host to upload it again.', 409);
  }
  return image;
}

// Run before reading a large upload body, and again immediately before mutation.
export function requireHostPhotoListing(db, user, garageId) {
  const row = db.prepare('SELECT * FROM garages WHERE id=? AND owner_id=?').get(garageId, user.id);
  if (!row) throw new ApiError('Listing not found.', 404);
  if (!['pending', 'rejected', 'approved'].includes(row.status)) throw new ApiError('This listing cannot be changed in its current status.', 409);
  if (row.status === 'approved' && db.prepare("SELECT 1 FROM reservations WHERE garage_id=? AND status='confirmed' AND ends_at>?").get(garageId, Date.now())) {
    throw new ApiError('Resolve upcoming reservations before editing this space.', 409);
  }
  return row;
}

export function submitHostPhoto(db, web, user, garageId, data) {
  const row = requireHostPhotoListing(db, user, garageId);
  if (data.expected_image !== row.image || data.expected_status !== row.status) throw new ApiError('Listing changed. Refresh and try again.', 409);
  const bytes = decodeListingPhoto(data.photo_base64);
  return withListingPhoto(web, bytes, image => transaction(db, () => {
    db.prepare('INSERT OR IGNORE INTO listing_photo_owners(image,user_id,created_at) VALUES(?,?,?)').run(image,user.id,Date.now());
    db.prepare("UPDATE garages SET image=?,status='pending' WHERE id=?").run(image, garageId);
    audit(db, user.id, 'host_listing_photo_submitted', garageId);
    return { id: garageId, status: 'pending', image };
  }));
}
