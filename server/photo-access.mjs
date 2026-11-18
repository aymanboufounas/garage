import { ApiError, hash } from './core.mjs';

const photoPath = /^\/assets\/host-photos\/[a-f0-9]{32}\.webp$/;

// Run both before I/O and immediately before returning bytes. Private photo
// access never creates a session and always reads current roles/account state.
export function uploadedPhotoAccess(db, image, token, now = Date.now()) {
  if (!photoPath.test(image)) throw new ApiError('Not found.',404);
  const removed = db.prepare(`SELECT cm.report_id FROM content_moderation cm
    LEFT JOIN garages g ON cm.target_type='garage' AND g.id=cm.target_id
    JOIN ugc_reports r ON r.id=cm.report_id
    WHERE cm.target_type='garage' AND (g.image=? OR json_extract(r.evidence_json,'$.image')=?) LIMIT 1`).get(image,image);
  const published = !removed && db.prepare(`SELECT g.id FROM garages g LEFT JOIN user_account_state a ON a.user_id=g.owner_id
    WHERE g.image=? AND g.status='approved' AND COALESCE(a.state,'active')='active'
    AND NOT EXISTS (SELECT 1 FROM content_moderation cm WHERE cm.target_type='garage' AND cm.target_id=g.id) LIMIT 1`).get(image);
  if (published) return { public:true };
  const viewer = typeof token==='string' && /^[a-f0-9]{64}$/.test(token) && db.prepare(`
    SELECT u.id,COALESCE(a.state,'active') AS state,s.role
    FROM sessions x JOIN users u ON u.id=x.user_id
    LEFT JOIN user_account_state a ON a.user_id=u.id LEFT JOIN staff_members s ON s.user_id=u.id
    WHERE x.token_hash=? AND x.expires_at>? AND x.last_seen>?`).get(hash(token),now,now-30*60000);
  if (!viewer || viewer.state!=='active') throw new ApiError('Not found.',404);
  const owned = !removed && db.prepare(`SELECT g.id FROM garages g WHERE g.image=? AND g.owner_id=?
    AND NOT EXISTS (SELECT 1 FROM content_moderation cm WHERE cm.target_type='garage' AND cm.target_id=g.id) LIMIT 1`).get(image,viewer.id);
  if (owned && viewer.role!=='admin') return { public:false,user_id:viewer.id };
  if (viewer.role==='admin') {
    if (removed) return { public:false,user_id:viewer.id,audit_action:'ugc_photo_evidence_viewed',target_id:removed.report_id };
    const evidence = db.prepare(`SELECT id FROM ugc_reports WHERE target_type='garage' AND json_extract(evidence_json,'$.image')=? ORDER BY created_at DESC LIMIT 1`).get(image);
    if (evidence) return { public:false,user_id:viewer.id,audit_action:'ugc_photo_evidence_viewed',target_id:evidence.id };
    const listing = db.prepare('SELECT id FROM garages WHERE image=? LIMIT 1').get(image);
    if (listing) return { public:false,user_id:viewer.id,audit_action:'listing_photo_reviewed',target_id:listing.id };
  }
  throw new ApiError('Not found.',404);
}
