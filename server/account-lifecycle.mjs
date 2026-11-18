import { randomBytes } from 'node:crypto';
import { lstatSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiError, audit, passwordMatches, transaction } from './core.mjs';

const photoPattern = /^\/assets\/host-photos\/([a-f0-9]{32}\.webp)$/;
const RECENT_SIGN_IN_MS = 5 * 60_000;
const SESSION_IDLE_MS = 30 * 60_000;
const redactedMessage = '[Content removed by account deletion]';
const tableExists = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

export function accountState(db, userId) {
  return db.prepare('SELECT state FROM user_account_state WHERE user_id=?').get(userId)?.state || 'active';
}

export function assertAccountActive(db, userId) {
  const state = accountState(db, userId);
  if (state === 'deleted') throw new ApiError('This account has been deleted.', 401);
  if (state !== 'active') throw new ApiError('This account is suspended. Contact support for help.', 403);
}

function activeSession(db, userId, session, now) {
  const current = session?.token_hash && db.prepare(`SELECT * FROM sessions WHERE token_hash=? AND user_id=?
    AND expires_at>? AND last_seen>?`).get(session.token_hash, userId, now, now - SESSION_IDLE_MS);
  if (!current) throw new ApiError('Sign in again before deleting your account.', 401);
  return current;
}

function blockers(db, userId, now) {
  const result = [];
  const bookings = db.prepare(`SELECT count(*) AS n FROM reservations r JOIN garages g ON g.id=r.garage_id
    WHERE r.status='confirmed' AND r.ends_at>? AND (r.guest_id=? OR g.owner_id=?)`).get(now, userId, userId).n;
  if (bookings) result.push({ code: 'active_bookings', count: bookings });
  const administrator = db.prepare("SELECT 1 FROM staff_members WHERE user_id=? AND role='admin'").get(userId);
  if (administrator && accountState(db, userId) === 'active' && db.prepare(`SELECT count(*) AS n FROM staff_members s LEFT JOIN user_account_state a ON a.user_id=s.user_id
    WHERE s.role='admin' AND coalesce(a.state,'active')='active'`).get().n <= 1) result.push({ code: 'last_administrator' });
  return result;
}

function deletionStatus(db, user, session, now) {
  const current = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  if (!current) throw new ApiError('Account not found.', 404);
  const state = accountState(db, user.id), conditions = blockers(db, user.id, now);
  return { state, can_delete: state !== 'deleted' && !conditions.length, blockers: conditions,
    requires_password: Boolean(current.password_hash), requires_recent_sign_in: !current.password_hash,
    recent_sign_in: !current.password_hash && session.created_at <= now && session.created_at > now - RECENT_SIGN_IN_MS,
    retention: 'pseudonymous_history' };
}

function evidencePhotoReferences(db) {
  const images = new Set();
  if (!tableExists(db, 'ugc_reports')) return { images, uncertain: false };
  let uncertain = false;
  function collect(value) {
    if (typeof value === 'string' && photoPattern.test(value)) images.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  }
  for (const row of db.prepare("SELECT evidence_json FROM ugc_reports WHERE status IN ('pending','under_review')").all()) {
    try { collect(JSON.parse(row.evidence_json)); } catch { uncertain = true; }
  }
  return { images, uncertain };
}

// Run after account deletion and periodically by the operator. A pending report
// or another listing can hold a photo; file errors remain queued for retry.
export function cleanupDeletedAccountPhotos(db, web, maximum = 100) {
  const limit = Math.max(1, Math.min(1000, Number.isSafeInteger(maximum) ? maximum : 100));
  const evidence = evidencePhotoReferences(db);
  for (const row of db.prepare('SELECT image FROM account_photo_cleanup ORDER BY requested_at,image LIMIT ?').all(limit)) {
    if (evidence.uncertain || evidence.images.has(row.image) || db.prepare('SELECT 1 FROM garages WHERE image=? LIMIT 1').get(row.image)) continue;
    const match = row.image.match(photoPattern);
    if (!match) continue;
    db.prepare('UPDATE account_photo_cleanup SET last_attempt=?,attempts=attempts+1 WHERE image=?').run(Date.now(), row.image);
    try {
      const directory = resolve(web, 'assets/host-photos'), filename = resolve(directory, match[1]);
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const file = lstatSync(filename);
      if (!file.isFile() || file.isSymbolicLink()) continue;
      unlinkSync(filename);
      transaction(db, () => {
        db.prepare('DELETE FROM account_photo_cleanup WHERE image=?').run(row.image);
        db.prepare('DELETE FROM listing_photo_owners WHERE image=?').run(row.image);
      });
    } catch (error) {
      if (error.code === 'ENOENT') transaction(db, () => {
        db.prepare('DELETE FROM account_photo_cleanup WHERE image=?').run(row.image);
        db.prepare('DELETE FROM listing_photo_owners WHERE image=?').run(row.image);
      });
    }
  }
  return { pending: db.prepare('SELECT count(*) AS n FROM account_photo_cleanup').get().n };
}

function scrubModerationData(db, userId) {
  if (tableExists(db, 'ugc_reports')) {
    // Unresolved reports are protected evidence, not publicly visible content.
    db.prepare("UPDATE ugc_reports SET evidence_json='{}' WHERE subject_user_id=? AND status IN ('resolved','dismissed')").run(userId);
    db.prepare("UPDATE ugc_reports SET explanation='' WHERE reporter_id=? AND status IN ('resolved','dismissed')").run(userId);
    db.prepare("UPDATE ugc_reports SET review_note='' WHERE reviewed_by=? AND status IN ('resolved','dismissed')").run(userId);
  }
  if (tableExists(db, 'content_moderation')) db.prepare("UPDATE content_moderation SET note='' WHERE removed_by=? AND report_id IN (SELECT id FROM ugc_reports WHERE status IN ('resolved','dismissed'))").run(userId);
  if (tableExists(db, 'user_blocks')) db.prepare('DELETE FROM user_blocks WHERE blocker_id=?').run(userId);
  if (tableExists(db, 'user_guideline_acceptances')) db.prepare('DELETE FROM user_guideline_acceptances WHERE user_id=?').run(userId);
  if (tableExists(db, 'ugc_notices')) db.prepare('DELETE FROM ugc_notices WHERE user_id=?').run(userId);
}

function scrubAccount(db, userId, now) {
  const photos = db.prepare('SELECT image FROM garages WHERE owner_id=? UNION SELECT image FROM listing_photo_owners WHERE user_id=?').all(userId, userId).map(row => row.image).filter(image => photoPattern.test(image));
  const oldUser = db.prepare('SELECT email FROM users WHERE id=?').get(userId);
  // Invalidate Google proofs already waiting for this verified account as well as
  // all authenticated sessions (session deletion cascades their OAuth attempts).
  db.prepare(`DELETE FROM google_attempts WHERE CASE WHEN json_valid(identity)
    THEN lower(json_extract(identity,'$.email'))=? ELSE 0 END`).run(oldUser.email.toLowerCase());
  db.prepare("UPDATE reservations SET status='cancelled',expires_at=NULL,updated_at=? WHERE status IN ('requested','countered') AND (guest_id=? OR garage_id IN (SELECT id FROM garages WHERE owner_id=?))").run(now, userId, userId);
  db.prepare("UPDATE rental_requests SET status='cancelled' WHERE guest_id=? AND status='open'").run(userId);
  db.prepare(`UPDATE rental_quotes SET status='declined',total_cents=NULL WHERE (garage_id IN (SELECT id FROM garages WHERE owner_id=?)
    AND request_id IN (SELECT id FROM rental_requests WHERE status='open')) OR request_id IN (SELECT id FROM rental_requests WHERE guest_id=? AND status='cancelled')`).run(userId, userId);
  db.prepare("UPDATE garages SET name='Unavailable garage',area='',address='',latitude=0,longitude=0,description='',image='/assets/garage-placeholder.svg',status='archived' WHERE owner_id=?").run(userId);
  db.prepare('DELETE FROM garage_blocks WHERE garage_id IN (SELECT id FROM garages WHERE owner_id=?)').run(userId);
  db.prepare('UPDATE chat_messages SET message=? WHERE sender_id=?').run(redactedMessage, userId);
  db.prepare('UPDATE support_messages SET message=? WHERE author_id=?').run(redactedMessage, userId);
  db.prepare("UPDATE support_tickets SET subject='Removed account request',status='resolved',updated_at=? WHERE customer_id=?").run(now, userId);
  db.prepare("UPDATE stay_reviews SET comment='' WHERE author_id=?").run(userId);
  db.prepare('UPDATE admin_reservation_decisions SET reason=? WHERE actor_id=?').run(redactedMessage, userId);
  scrubModerationData(db, userId);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM google_identities WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM staff_members WHERE user_id=?').run(userId);
  db.prepare("UPDATE users SET name='Deleted account',email=?,password_hash='' WHERE id=?").run('deleted-' + randomBytes(16).toString('hex') + '@deleted.invalid', userId);
  db.prepare(`INSERT INTO user_account_state(user_id,state,reason,updated_at) VALUES (?,'deleted','self_service_deletion',?)
    ON CONFLICT(user_id) DO UPDATE SET state='deleted',reason=excluded.reason,updated_at=excluded.updated_at`).run(userId, now);
  db.prepare('INSERT INTO account_deletion_events(user_id,completed_at) VALUES (?,?)').run(userId, now);
  for (const image of photos) db.prepare('INSERT OR IGNORE INTO account_photo_cleanup(image,requested_at) VALUES (?,?)').run(image, now);
  audit(db, userId, 'account_deleted', userId);
  return photos;
}

export async function accountDeletionRoute(db, web, user, session, method, path, data = {}) {
  if (!(method === 'GET' && path === '/api/account/deletion') && !(method === 'POST' && path === '/api/account/delete')) throw new ApiError('Endpoint not found.', 404);
  const now = Date.now();
  if (accountState(db, user.id) === 'deleted') throw new ApiError('This account has been deleted.', 401);
  const signedIn = activeSession(db, user.id, session, now);
  if (method === 'GET') return deletionStatus(db, user, signedIn, now);
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['confirmation', 'password'].includes(key))) throw new ApiError('Only your own account can be deleted here.');
  if (data.confirmation !== 'DELETE') throw new ApiError('Type DELETE to confirm account deletion.');
  const original = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  if (!original) throw new ApiError('Account not found.', 404);
  if (original.password_hash) {
    if (typeof data.password !== 'string' || data.password.length > 128 || !await passwordMatches(data.password, original.password_hash)) {
      throw new ApiError('Password is incorrect.', 403);
    }
  } else if (!db.prepare('SELECT 1 FROM google_identities WHERE user_id=?').get(user.id) || signedIn.created_at > now || signedIn.created_at <= now - RECENT_SIGN_IN_MS) {
    throw new ApiError('Sign in with Google again before deleting your account.', 401);
  }
  const pendingImages = transaction(db, () => {
    const commitAt = Date.now();
    if (accountState(db, user.id) === 'deleted') throw new ApiError('This account has been deleted.', 401);
    const currentSession = activeSession(db, user.id, session, commitAt);
    const current = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
    if (!current || current.password_hash !== original.password_hash) throw new ApiError('Account changed. Sign in again before deleting it.', 409);
    if (!original.password_hash && (!db.prepare('SELECT 1 FROM google_identities WHERE user_id=?').get(user.id) || currentSession.created_at > commitAt || currentSession.created_at <= commitAt - RECENT_SIGN_IN_MS)) throw new ApiError('Sign in with Google again before deleting your account.', 401);
    const remaining = blockers(db, user.id, commitAt);
    if (remaining.some(row => row.code === 'active_bookings')) throw new ApiError('Complete or cancel active bookings before deleting your account.', 409);
    if (remaining.some(row => row.code === 'last_administrator')) throw new ApiError('Keep another active administrator before deleting your account.', 409);
    return scrubAccount(db, user.id, commitAt);
  });
  try { cleanupDeletedAccountPhotos(db, web); } catch { /* Committed deletion is complete; queued photos remain retryable. */ }
  const photoCleanupPending = pendingImages.some(image => db.prepare('SELECT 1 FROM account_photo_cleanup WHERE image=?').get(image));
  return { deleted: true, state: 'deleted', retained_history: true, photo_cleanup_pending: photoCleanupPending };
}
