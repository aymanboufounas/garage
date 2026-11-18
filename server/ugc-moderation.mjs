import { ApiError, audit, checkedRequestKey, id, limit, text, transaction } from './core.mjs';
import { staffRole } from './support.mjs';

const ID = /^[a-f0-9]{32}$/;
const activeStatuses = ['pending', 'under_review'];
const statuses = [...activeStatuses, 'resolved', 'dismissed'];
const reasons = ['spam', 'harassment', 'fraud', 'inappropriate', 'misleading', 'other'];
export const UGC_CLOSED_EVIDENCE_RETENTION_DAYS = 90;
export const UGC_MAX_EVIDENCE_RETENTION_DAYS = 180;

export function isContentRemoved(db, targetType, targetId) {
  return Boolean(db.prepare('SELECT 1 FROM content_moderation WHERE target_type=? AND target_id=?').get(targetType, String(targetId)));
}

export function purgeClosedReportEvidence(db, now = Date.now()) {
  const closedBefore = now - UGC_CLOSED_EVIDENCE_RETENTION_DAYS * 86400000;
  const maximumBefore = now - UGC_MAX_EVIDENCE_RETENTION_DAYS * 86400000;
  return transaction(db, () => {
    // Capture the decision-note version before clearing it. A later action may
    // reuse an already-expired case; its new note must also receive cleanup.
    const expired = db.prepare(`SELECT id,subject_user_id,review_note,updated_at FROM ugc_reports r
      WHERE ((status IN ('resolved','dismissed') AND updated_at<?) OR created_at<?)
      AND (evidence_json<>'{"expired":true}' OR explanation<>'' OR review_note<>'' OR EXISTS (
        SELECT 1 FROM content_moderation cm WHERE cm.report_id=r.id AND cm.note<>''))`).all(closedBefore,maximumBefore);
    const clearContent = db.prepare("UPDATE content_moderation SET note='' WHERE report_id=? AND removed_at<=?");
    const clearAccount = db.prepare("UPDATE user_account_state SET reason='' WHERE user_id=? AND reason=? AND updated_at<=?");
    const clearReport = db.prepare(`UPDATE ugc_reports SET evidence_json='{"expired":true}',explanation='',review_note='' WHERE id=?`);
    for (const row of expired) {
      // report_id identifies the current removal; do not touch a replacement
      // decision from another case. Keep its structured tombstone in force.
      clearContent.run(row.id,row.updated_at);
      if (row.review_note) clearAccount.run(row.subject_user_id,row.review_note,row.updated_at);
      clearReport.run(row.id);
    }
    return expired.length;
  });
}

function requireAdmin(db, user) {
  if (staffRole(db, user.id) !== 'admin') throw new ApiError('Administrator access is required.', 403);
}
function notFound() { throw new ApiError('Reportable content not found.', 404); }
function assertOther(reporterId, authorId) {
  if (reporterId === authorId) throw new ApiError('You cannot report your own content.');
}
function sharedUserContext(db, reporterId, subjectId) {
  if (db.prepare("SELECT 1 FROM garages WHERE owner_id=? AND status='approved'").get(subjectId)) return 'public_host';
  if (db.prepare(`SELECT 1 FROM chat_threads WHERE (guest_id=? AND host_id=?) OR (host_id=? AND guest_id=?)`).get(reporterId, subjectId, reporterId, subjectId)) return 'conversation';
  if (db.prepare(`SELECT 1 FROM reservations b JOIN garages g ON g.id=b.garage_id
    WHERE (b.guest_id=? AND g.owner_id=?) OR (g.owner_id=? AND b.guest_id=?)`).get(reporterId, subjectId, reporterId, subjectId)) return 'shared_booking';
  if (db.prepare(`SELECT 1 FROM rental_quotes q JOIN rental_requests r ON r.id=q.request_id JOIN garages g ON g.id=q.garage_id
    WHERE (r.guest_id=? AND g.owner_id=?) OR (g.owner_id=? AND r.guest_id=?)`).get(reporterId, subjectId, reporterId, subjectId)) return 'shared_quote';
  return null;
}
function evidenceFor(db, reporterId, targetType, targetId) {
  if (targetType === 'user') {
    if (!ID.test(targetId)) notFound();
    const user = db.prepare('SELECT id,name FROM users WHERE id=?').get(targetId);
    const context = user && sharedUserContext(db, reporterId, targetId);
    if (!user || !context) notFound();
    assertOther(reporterId, user.id);
    return { subject: user.id, evidence: { id: user.id, name: user.name, visible_context: context } };
  }
  if (targetType === 'garage') {
    if (!ID.test(targetId)) notFound();
    const garage = db.prepare('SELECT id,owner_id,name,city,area,description,image,status FROM garages WHERE id=?').get(targetId);
    if (!garage || isContentRemoved(db, 'garage', targetId)) notFound();
    const linked = garage.status === 'approved' || garage.owner_id === reporterId ||
      db.prepare('SELECT 1 FROM reservations WHERE garage_id=? AND guest_id=?').get(targetId, reporterId) ||
      db.prepare('SELECT 1 FROM rental_quotes q JOIN rental_requests r ON r.id=q.request_id WHERE q.garage_id=? AND r.guest_id=?').get(targetId, reporterId);
    if (!linked) notFound();
    assertOther(reporterId, garage.owner_id);
    return { subject: garage.owner_id, evidence: garage };
  }
  if (targetType === 'message') {
    if (!/^[1-9]\d{0,15}$/.test(targetId) || !Number.isSafeInteger(Number(targetId))) notFound();
    const message = db.prepare(`SELECT m.seq,m.message,m.sender_id,m.created_at,m.thread_id
      FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id
      WHERE m.seq=? AND (t.guest_id=? OR t.host_id=?)`).get(Number(targetId), reporterId, reporterId);
    if (!message || isContentRemoved(db, 'message', targetId)) notFound();
    assertOther(reporterId, message.sender_id);
    const preceding = db.prepare('SELECT seq,sender_id,message,created_at FROM chat_messages WHERE thread_id=? AND seq<? ORDER BY seq DESC LIMIT 3').all(message.thread_id, message.seq).reverse();
    const following = db.prepare('SELECT seq,sender_id,message,created_at FROM chat_messages WHERE thread_id=? AND seq>? ORDER BY seq LIMIT 3').all(message.thread_id, message.seq);
    return { subject: message.sender_id, evidence: { ...message, context: [...preceding, { seq:message.seq,sender_id:message.sender_id,message:message.message,created_at:message.created_at }, ...following] } };
  }
  if (targetType === 'review') {
    const match = /^([a-f0-9]{32}):(renter|host)$/.exec(targetId);
    if (!match) notFound();
    const review = db.prepare(`SELECT r.*,b.guest_id,b.status AS booking_status,g.owner_id,g.status AS garage_status,g.id AS garage_id
      FROM stay_reviews r JOIN reservations b ON b.id=r.reservation_id JOIN garages g ON g.id=b.garage_id
      WHERE r.reservation_id=? AND r.role=?`).get(match[1], match[2]);
    if (!review || isContentRemoved(db, 'review', targetId)) notFound();
    const published = review.publish_at <= Date.now() && review.booking_status === 'confirmed';
    const publicReview = published && review.role === 'renter' && review.garage_status === 'approved';
    const participantReview = published && [review.guest_id, review.owner_id].includes(reporterId);
    if (!publicReview && !participantReview) notFound();
    assertOther(reporterId, review.author_id);
    return { subject: review.author_id, evidence: { reservation_id:review.reservation_id,role:review.role,author_id:review.author_id,rating:review.rating,comment:review.comment,created_at:review.created_at,publish_at:review.publish_at,garage_id:review.garage_id } };
  }
  throw new ApiError('Choose a report target.');
}
function reporterView(row) {
  return { id:row.id,target_type:row.target_type,target_id:row.target_id,reason:row.reason,status:row.status,created_at:row.created_at,updated_at:row.updated_at };
}
function createReport(db, user, data) {
  const key = checkedRequestKey(data);
  if (!['user','garage','message','review'].includes(data.target_type)) throw new ApiError('Choose a report target.');
  if (typeof data.target_id !== 'string' || data.target_id.length > 80) throw new ApiError('Choose a report target.');
  if (!reasons.includes(data.reason)) throw new ApiError('Choose a report reason.');
  const explanation = text({ explanation:data.explanation ?? '' }, 'explanation', 0, 1000);
  limit(db, `ugc-report:${user.id}`, 12, 3600000);
  return transaction(db, () => {
    const previous = db.prepare('SELECT * FROM ugc_reports WHERE reporter_id=? AND request_key=?').get(user.id, key);
    if (previous) {
      if (previous.target_type !== data.target_type || previous.target_id !== data.target_id) throw new ApiError('This request key belongs to another report.', 409);
      return { report:reporterView(previous) };
    }
    const duplicate = db.prepare("SELECT * FROM ugc_reports WHERE reporter_id=? AND target_type=? AND target_id=? AND status IN ('pending','under_review')").get(user.id, data.target_type, data.target_id);
    if (duplicate) return { report:reporterView(duplicate) };
    const { subject,evidence } = evidenceFor(db, user.id, data.target_type, data.target_id);
    const reportId = id(), now = Date.now();
    db.prepare(`INSERT INTO ugc_reports(id,reporter_id,target_type,target_id,subject_user_id,reason,explanation,status,evidence_json,created_at,updated_at,request_key)
      VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?)`).run(reportId,user.id,data.target_type,data.target_id,subject,data.reason,explanation,JSON.stringify(evidence),now,now,key);
    audit(db,user.id,'ugc_report_submitted',reportId);
    return { report:reporterView(db.prepare('SELECT * FROM ugc_reports WHERE id=?').get(reportId)) };
  });
}
function queue(db, params) {
  const status = params.get('status') || 'pending';
  if (status !== 'all' && !statuses.includes(status)) throw new ApiError('Choose a report status.');
  const query = (params.get('q') || '').trim(), offset = Number(params.get('offset') || 0);
  if (query.length > 120 || !Number.isSafeInteger(offset) || offset < 0) throw new ApiError('Choose a valid report page.');
  const reports = db.prepare(`SELECT r.id,r.target_type,r.target_id,r.reason,r.status,r.created_at,r.updated_at,u.name AS subject_name
    FROM ugc_reports r JOIN users u ON u.id=r.subject_user_id
    WHERE (?='all' OR r.status=?) AND (?='' OR instr(lower(u.name),lower(?))>0 OR instr(r.id,?)>0 OR instr(r.target_id,?)>0)
    ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END,r.created_at,r.id LIMIT 26 OFFSET ?`)
    .all(status,status,query,query,query,query,offset);
  const counts = Object.fromEntries(db.prepare('SELECT status,count(*) AS count FROM ugc_reports GROUP BY status').all().map(row=>[row.status,row.count]));
  return { reports:reports.slice(0,25),has_more:reports.length>25,counts };
}
function findReport(db, reportId) {
  const row = ID.test(reportId) && db.prepare('SELECT * FROM ugc_reports WHERE id=?').get(reportId);
  if (!row) throw new ApiError('Report not found.',404);
  return row;
}
function adminView(db,row) {
  const { evidence_json,request_key,...view } = row;
  view.evidence = JSON.parse(evidence_json);
  view.subject = db.prepare("SELECT u.id,u.name,u.email,COALESCE(s.state,'active') AS state FROM users u LEFT JOIN user_account_state s ON s.user_id=u.id WHERE u.id=?").get(row.subject_user_id);
  view.reporter = db.prepare('SELECT id,name,email FROM users WHERE id=?').get(row.reporter_id);
  const removal = db.prepare('SELECT report_id FROM content_moderation WHERE target_type=? AND target_id=?').get(row.target_type,row.target_id);
  view.content_removed = Boolean(removal);
  view.can_restore_content = Boolean(removal && removal.report_id===row.id && row.status==='resolved' && view.subject?.state!=='deleted' &&
    (row.target_type!=='garage' || view.subject?.state==='active'));
  return view;
}
function addNotice(db, subjectId, reportId, kind) {
  const message = {
    warning:'A moderator has issued a community guidelines warning. Please review the community rules.',
    removed:'A moderator removed reported content for a community guidelines violation.',
    suspended:'A moderator suspended this account following a community safety review.',
    restored:'A moderator restored access to this account. Archived listings require a new review before publication.'
  }[kind];
  db.prepare('INSERT INTO ugc_notices(id,user_id,report_id,kind,message,created_at) VALUES (?,?,?,?,?,?)').run(id(),subjectId,reportId,kind,message,Date.now());
}
function setUserState(db, actor, row, state, note) {
  const previous = db.prepare('SELECT state FROM user_account_state WHERE user_id=?').get(row.subject_user_id)?.state || 'active';
  if (previous === 'deleted') throw new ApiError('Deleted accounts cannot be restored or suspended.',409);
  if (row.subject_user_id === actor.id) throw new ApiError('You cannot suspend your own administrator account.',409);
  if (state === 'suspended' && staffRole(db,row.subject_user_id) === 'admin') {
    const activeAdmins = db.prepare(`SELECT count(*) AS n FROM staff_members s LEFT JOIN user_account_state a ON a.user_id=s.user_id
      WHERE s.role='admin' AND COALESCE(a.state,'active')='active'`).get().n;
    if (previous === 'active' && activeAdmins <= 1) throw new ApiError('Keep at least one active administrator.',409);
  }
  if (state === 'active' && previous !== 'suspended') throw new ApiError('This account is not suspended.',409);
  db.prepare(`INSERT INTO user_account_state(user_id,state,reason,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,updated_at=excluded.updated_at`).run(row.subject_user_id,state,note,Date.now());
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.subject_user_id);
  if (state === 'suspended') db.prepare("UPDATE garages SET status='archived' WHERE owner_id=? AND status<>'archived'").run(row.subject_user_id);
  audit(db,actor.id,state==='suspended'?'ugc_account_suspended':'ugc_account_restored',row.subject_user_id);
}
function actionReport(db,actor,reportId,data) {
  const note = text(data,'note',3,1000), action = data.action;
  if (!['review','dismiss','remove_content','restore_content','warn','suspend','restore'].includes(action)) throw new ApiError('Choose a moderation action.');
  const status = {review:'under_review',dismiss:'dismissed',remove_content:'resolved',restore_content:'resolved',warn:'resolved',suspend:'resolved',restore:'resolved'}[action];
  if (data.status !== undefined && data.status !== status) throw new ApiError('Choose the status for this moderation action.');
  return transaction(db, () => {
    const row = findReport(db,reportId);
    if (row.status !== data.expected_status || (Object.hasOwn(data,'expected_updated_at') && data.expected_updated_at!==row.updated_at)) throw new ApiError('Report changed. Refresh and try again.',409);
    if (!activeStatuses.includes(row.status) && !['restore','restore_content'].includes(action)) throw new ApiError('This report has already been closed.',409);
    if (JSON.parse(row.evidence_json).expired && ['remove_content','warn','suspend'].includes(action)) throw new ApiError('Report evidence has expired. Close this case and request a new report before taking action.',409);
    if (action === 'remove_content') {
      if (!['garage','message','review'].includes(row.target_type)) throw new ApiError('Choose a content report before removing content.');
      db.prepare(`INSERT INTO content_moderation(target_type,target_id,report_id,removed_by,removed_at,note) VALUES (?,?,?,?,?,?)
        ON CONFLICT(target_type,target_id) DO UPDATE SET report_id=excluded.report_id,removed_by=excluded.removed_by,removed_at=excluded.removed_at,note=excluded.note`)
        .run(row.target_type,row.target_id,row.id,actor.id,Date.now(),note);
      if (row.target_type === 'garage') db.prepare("UPDATE garages SET status='archived' WHERE id=?").run(row.target_id);
      addNotice(db,row.subject_user_id,row.id,'removed');
    }
    if (action === 'restore_content') {
      const removal=db.prepare('SELECT report_id FROM content_moderation WHERE target_type=? AND target_id=?').get(row.target_type,row.target_id);
      const ownerState=db.prepare('SELECT state FROM user_account_state WHERE user_id=?').get(row.subject_user_id)?.state||'active';
      if (row.status!=='resolved' || !removal || removal.report_id!==row.id) throw new ApiError('Content moderation changed. Review the current removal case.',409);
      if (ownerState==='deleted' || (row.target_type==='garage' && ownerState!=='active')) throw new ApiError('Restore the owner account before restoring this content.',409);
      db.prepare('DELETE FROM content_moderation WHERE target_type=? AND target_id=? AND report_id=?').run(row.target_type,row.target_id,row.id);
      if (row.target_type==='garage') db.prepare("UPDATE garages SET status='pending' WHERE id=?").run(row.target_id);
    }
    if (action === 'warn') addNotice(db,row.subject_user_id,row.id,'warning');
    if (action === 'suspend' || action === 'restore') {
      setUserState(db,actor,row,action==='suspend'?'suspended':'active',note);
      addNotice(db,row.subject_user_id,row.id,action==='suspend'?'suspended':'restored');
    }
    const now = Math.max(Date.now(),row.updated_at+1);
    db.prepare('UPDATE ugc_reports SET status=?,updated_at=?,reviewed_by=?,review_note=? WHERE id=?').run(status,now,actor.id,note,row.id);
    audit(db,actor.id,'ugc_report_'+action,row.id);
    return {report:adminView(db,findReport(db,row.id))};
  });
}

export function ugcModerationRoute(db,user,method,path,params,data={}) {
  const state=db.prepare('SELECT state FROM user_account_state WHERE user_id=?').get(user.id)?.state||'active';
  if(state==='deleted')throw new ApiError('This account has been deleted.',401);
  if(state!=='active' && !(method==='GET' && path==='/api/safety/notices'))throw new ApiError('This account is suspended. Contact support for help.',403);
  if (path.startsWith('/api/staff/reports')) {
    requireAdmin(db,user);
    limit(db,`ugc-moderation:${user.id}`,120,60000);
    if (method === 'GET' && path === '/api/staff/reports') return queue(db,params);
    const match = /^\/api\/staff\/reports\/([a-f0-9]{32})(?:\/(action))?$/.exec(path);
    if (match) {
      if (method === 'GET' && !match[2]) {
        const row=findReport(db,match[1]);audit(db,user.id,'ugc_evidence_viewed',row.id);
        return {report:adminView(db,row)};
      }
      if (method === 'POST' && match[2]) return actionReport(db,user,match[1],data);
    }
    throw new ApiError('Endpoint not found.',404);
  }
  if (method === 'POST' && path === '/api/safety/reports') return createReport(db,user,data);
  if (method === 'GET' && path === '/api/safety/notices') {
    return {notices:db.prepare('SELECT id,kind,message,created_at FROM ugc_notices WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 50').all(user.id)};
  }
  throw new ApiError('Endpoint not found.',404);
}
