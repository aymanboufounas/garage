import test from 'node:test';
import assert from 'node:assert/strict';
import { id, openDatabase } from '../server/core.mjs';
import { reviewsRoute, garageReviews } from '../server/reviews.mjs';
import { ugcModerationRoute, isContentRemoved, purgeClosedReportEvidence } from '../server/ugc-moderation.mjs';

function setup(t) {
  const db=openDatabase(':memory:');t.after(()=>db.close());
  function user(name,role){const row={id:id(),name,email:name.toLowerCase()+'@example.com'};db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(row.id,row.name,row.email,'unused fixture password hash',Date.now());if(role)db.prepare('INSERT INTO staff_members VALUES (?,?)').run(row.id,role);return row;}
  const renter=user('Renter'),host=user('Host'),stranger=user('Stranger'),admin=user('Admin','admin'),support=user('Support','support'),isolated=user('Isolated');
  function garage(owner=host,status='approved') {const gid=id();db.prepare('INSERT INTO garages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(gid,owner.id,'Garage '+gid.slice(0,6),'Casablanca','Centre','Private entrance 42',33.57,-7.58,1000,95000,230,'suv',1,'A garage listing for moderation evidence.','/assets/host-photos/'+id()+'.webp',status,Date.now());return gid;}
  const gid=garage();
  let sequence=0;
  function booking(garageId=gid,guest=renter,past=false){const rid=id(),now=Date.now(),start=past?now-86400000*5:now+86400000*(++sequence);db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,garageId,guest.id,'hourly',start,start+3600000,1,1000,'confirmed',null,now,now,id());return rid;}
  const rid=booking();
  function thread(bookingId=rid,guest=renter,owner=host){const tid=id();db.prepare('INSERT INTO chat_threads VALUES (?,?,?,?,?,?)').run(tid,guest.id,owner.id,bookingId,null,Date.now());return tid;}
  const tid=thread();
  function message(sender=host,threadId=tid,value='Reported chat message'){return Number(db.prepare('INSERT INTO chat_messages(thread_id,sender_id,message,created_at,request_key) VALUES (?,?,?,?,?)').run(threadId,sender.id,value,Date.now(),id()).lastInsertRowid);}
  function call(actor,method,path,data={},query=''){return ugcModerationRoute(db,actor,method,path,new URLSearchParams(query),data);}
  function report(type,target,actor=renter,extra={}){return call(actor,'POST','/api/safety/reports',{target_type:type,target_id:String(target),reason:'harassment',explanation:'Please review this content.',request_key:id(),...extra}).report;}
  function act(caseId,action,expected='pending',actor=admin,extra={}){return call(actor,'POST',`/api/staff/reports/${caseId}/action`,{action,expected_status:expected,note:'Reviewed the reported evidence.',...extra}).report;}
  return {db,renter,host,stranger,admin,support,isolated,gid,rid,tid,user,garage,booking,thread,message,call,report,act};
}
function status(expected,work){assert.throws(work,error=>error.status===expected);}

test('reports require visible targets, reject self reports and cannot enumerate private messages or accounts',t=>{
  const f=setup(t),seq=f.message();
  status(404,()=>f.report('message',seq,f.stranger));
  status(404,()=>f.report('user',f.isolated.id));
  status(422,()=>f.report('message',seq,f.host));
  status(422,()=>f.report('garage',f.gid,f.host));
  const pending=f.garage(f.isolated,'pending');
  status(404,()=>f.report('garage',pending));
  f.booking(pending,f.renter);
  assert.equal(f.report('garage',pending).status,'pending');
  assert.equal(f.report('user',f.host.id,f.stranger).status,'pending');
  status(404,()=>f.report('message','0001'));
  status(422,()=>f.report('garage',f.gid,f.renter,{reason:'unknown'}));
});

test('report retries and active duplicates are idempotent without exposing reporter identity',t=>{
  const f=setup(t),seq=f.message(),request_key=id();
  const first=f.report('message',seq,f.renter,{request_key});
  assert.deepEqual(f.report('message',seq,f.renter,{request_key}),first);
  assert.equal(f.report('message',seq).id,first.id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM ugc_reports').get().n,1);
  status(409,()=>f.report('garage',f.gid,f.renter,{request_key}));
  assert.equal('reporter_id' in first,false);
  assert.equal('evidence' in first,false);
  assert.equal('subject_user_id' in first,false);
});

test('only published public renter reviews or published partner reviews can be reported',t=>{
  const f=setup(t),rid=f.booking(f.gid,f.renter,true),now=Date.now();
  f.db.prepare('INSERT INTO stay_reviews VALUES (?,?,?,?,?,?,?)').run(rid,f.renter.id,'renter',3,'A public review comment',now-1000,now-1000);
  f.db.prepare('INSERT INTO stay_reviews VALUES (?,?,?,?,?,?,?)').run(rid,f.host.id,'host',4,'A private partner review',now-1000,now+86400000);
  assert.equal(f.report('review',rid+':renter',f.stranger).status,'pending');
  status(422,()=>f.report('review',rid+':renter',f.renter));
  status(404,()=>f.report('review',rid+':host',f.renter));
  f.db.prepare("UPDATE stay_reviews SET publish_at=? WHERE reservation_id=? AND role='host'").run(now-1000,rid);
  status(404,()=>f.report('review',rid+':host',f.stranger));
  assert.equal(f.report('review',rid+':host',f.renter).status,'pending');
});

test('admin case access is audited and snapshots only bounded reported-thread context',t=>{
  const f=setup(t);for(let n=0;n<8;n++)f.message(f.renter,f.tid,'Prior context '+n);const seq=f.message();for(let n=0;n<8;n++)f.message(f.host,f.tid,'Following context '+n);
  const otherGarage=f.garage(f.isolated),otherBooking=f.booking(otherGarage,f.stranger),otherThread=f.thread(otherBooking,f.stranger,f.isolated);f.message(f.isolated,otherThread,'Unrelated private secret');
  const row=f.report('message',seq);
  for(const actor of [f.renter,f.host,f.support]){
    status(403,()=>f.call(actor,'GET','/api/staff/reports'));
    status(403,()=>f.call(actor,'GET',`/api/staff/reports/${row.id}`));
    status(403,()=>f.act(row.id,'dismiss','pending',actor));
  }
  const detail=f.call(f.admin,'GET',`/api/staff/reports/${row.id}`).report;
  assert.equal(detail.evidence.seq,seq);assert.equal(detail.evidence.context.length,7);
  assert.equal(detail.evidence.thread_id,f.tid);assert.ok(!JSON.stringify(detail).includes('Unrelated private secret'));
  assert.equal(detail.reporter.id,f.renter.id);
  const audit=f.db.prepare("SELECT * FROM audit WHERE action='ugc_evidence_viewed'").get();assert.equal(audit.actor_id,f.admin.id);assert.equal(audit.target_id,row.id);
  const queued=f.call(f.admin,'GET','/api/staff/reports').reports[0];assert.equal('evidence' in queued,false);
  f.db.prepare('DELETE FROM staff_members WHERE user_id=?').run(f.admin.id);
  status(403,()=>f.call(f.admin,'GET',`/api/staff/reports/${row.id}`));
});

test('message removal leaves transaction records intact and notices never reveal reporters or internal notes',t=>{
  const f=setup(t),seq=f.message(),report=f.report('message',seq);
  const result=f.act(report.id,'remove_content');assert.equal(result.status,'resolved');
  assert.equal(isContentRemoved(f.db,'message',seq),true);
  assert.equal(f.db.prepare('SELECT message FROM chat_messages WHERE seq=?').get(seq).message,'Reported chat message');
  const notice=f.call(f.host,'GET','/api/safety/notices').notices[0];assert.equal(notice.kind,'removed');
  assert.equal('reporter_id' in notice,false);assert.equal('report_id' in notice,false);assert.ok(!JSON.stringify(notice).includes(f.renter.email));assert.ok(!JSON.stringify(notice).includes('Reviewed the reported evidence'));
  assert.deepEqual(f.call(f.stranger,'GET','/api/safety/notices').notices,[]);
  assert.equal(f.db.prepare('SELECT status FROM reservations WHERE id=?').get(f.rid).status,'confirmed');
  status(409,()=>f.act(report.id,'warn','pending'));
});

test('safety removal archives a garage despite upcoming booking but preserves booking, dates and participants',t=>{
  const f=setup(t),before=f.db.prepare('SELECT * FROM reservations WHERE id=?').get(f.rid),report=f.report('garage',f.gid);
  f.act(report.id,'remove_content');assert.equal(f.db.prepare('SELECT status FROM garages WHERE id=?').get(f.gid).status,'archived');
  assert.deepEqual(f.db.prepare('SELECT * FROM reservations WHERE id=?').get(f.rid),before);
  assert.equal(isContentRemoved(f.db,'garage',f.gid),true);
});

test('suspension revokes sessions and hides listings; restoration does not republish or restore deleted accounts',t=>{
  const f=setup(t),report=f.report('user',f.host.id);
  f.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(id(),f.host.id,id(),Date.now()+3600000,Date.now(),Date.now());
  f.act(report.id,'suspend');assert.equal(f.db.prepare('SELECT state FROM user_account_state WHERE user_id=?').get(f.host.id).state,'suspended');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(f.host.id).n,0);assert.equal(f.db.prepare('SELECT status FROM garages WHERE id=?').get(f.gid).status,'archived');
  assert.equal(f.call(f.host,'GET','/api/safety/notices').notices[0].kind,'suspended');
  status(403,()=>f.call(f.host,'POST','/api/safety/reports',{target_type:'user',target_id:f.renter.id,reason:'other',request_key:id()}));
  f.act(report.id,'restore','resolved');assert.equal(f.db.prepare('SELECT state FROM user_account_state WHERE user_id=?').get(f.host.id).state,'active');assert.equal(f.db.prepare('SELECT status FROM garages WHERE id=?').get(f.gid).status,'archived');
  f.db.prepare("UPDATE user_account_state SET state='deleted' WHERE user_id=?").run(f.host.id);
  status(409,()=>f.act(report.id,'restore','resolved'));
  status(401,()=>f.call(f.host,'GET','/api/safety/notices'));
  assert.equal(f.db.prepare('SELECT status FROM reservations WHERE id=?').get(f.rid).status,'confirmed');
});

test('administrators cannot suspend themselves and role/status checks are live on every operation',t=>{
  const f=setup(t),adminGarage=f.garage(f.admin),report=f.report('garage',adminGarage);
  status(409,()=>f.act(report.id,'suspend'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM user_account_state WHERE user_id=?').get(f.admin.id).n,0);
  f.db.prepare("INSERT INTO user_account_state VALUES (?,'suspended','fixture',?)").run(f.admin.id,Date.now());
  status(403,()=>f.call(f.admin,'GET','/api/staff/reports'));
});

test('status transitions require a review note and stale expectations cannot overwrite another decision',t=>{
  const f=setup(t),report=f.report('garage',f.gid);
  status(422,()=>f.act(report.id,'review','pending',f.admin,{note:''}));
  assert.equal(f.act(report.id,'review').status,'under_review');
  status(409,()=>f.act(report.id,'dismiss','pending'));
  assert.equal(f.act(report.id,'dismiss','under_review').status,'dismissed');
  status(409,()=>f.act(report.id,'warn','dismissed'));
  assert.equal(f.db.prepare('SELECT status FROM garages WHERE id=?').get(f.gid).status,'approved');
});

test('report evidence expires after closed retention or the hard limit while case metadata remains',t=>{
  const f=setup(t),report=f.report('garage',f.gid);f.act(report.id,'dismiss');
  const now=Date.now();f.db.prepare('UPDATE ugc_reports SET updated_at=? WHERE id=?').run(now-91*86400000,report.id);
  const pending=f.report('user',f.host.id);f.db.prepare('UPDATE ugc_reports SET created_at=? WHERE id=?').run(now-181*86400000,pending.id);
  assert.equal(purgeClosedReportEvidence(f.db,now),2);
  for(const row of f.db.prepare('SELECT * FROM ugc_reports').all()){assert.deepEqual(JSON.parse(row.evidence_json),{expired:true});assert.equal(row.explanation,'');assert.equal(row.review_note,'');assert.ok(row.reporter_id);}
  status(409,()=>f.act(pending.id,'warn'));
  assert.equal(f.act(pending.id,'dismiss').status,'dismissed');
});


test('wrongful content removal is reversible only through its current case; garages return to review',t=>{
  const f=setup(t),seq=f.message(),report=f.report('message',seq);
  const removed=f.act(report.id,'remove_content');assert.equal(removed.content_removed,true);assert.equal(removed.can_restore_content,true);
  const restored=f.act(report.id,'restore_content','resolved');assert.equal(restored.can_restore_content,false);assert.equal(isContentRemoved(f.db,'message',seq),false);
  const newer=f.report('message',seq);f.act(newer.id,'remove_content');
  status(409,()=>f.act(report.id,'restore_content','resolved'));
  assert.equal(isContentRemoved(f.db,'message',seq),true);
  const garageReport=f.report('garage',f.gid);f.act(garageReport.id,'remove_content');
  f.act(garageReport.id,'restore_content','resolved');assert.equal(isContentRemoved(f.db,'garage',f.gid),false);
  assert.equal(f.db.prepare('SELECT status FROM garages WHERE id=?').get(f.gid).status,'pending');
  assert.equal(f.db.prepare('SELECT status FROM reservations WHERE id=?').get(f.rid).status,'confirmed');
  const audit=f.db.prepare("SELECT * FROM audit WHERE action='ugc_report_restore_content'").all();assert.equal(audit.length,2);
});


test('a removed review stays hidden for its author and cannot be reposted through the normal review endpoint',t=>{
  const f=setup(t),rid=f.booking(f.gid,f.renter,true),now=Date.now();
  f.db.prepare('INSERT INTO stay_reviews VALUES (?,?,?,?,?,?,?)').run(rid,f.renter.id,'renter',2,'Original reported review',now-1000,now-1000);
  const report=f.report('review',rid+':renter',f.stranger);f.act(report.id,'remove_content');
  assert.deepEqual(garageReviews(f.db,f.gid).reviews,[]);
  const own=reviewsRoute(f.db,f.renter.id,'GET','/api/reviews/'+rid,{});
  assert.equal(own.mine,null);assert.equal(own.can_review,false);
  status(409,()=>reviewsRoute(f.db,f.renter.id,'POST','/api/reviews/'+rid,{rating:5,comment:'Replacement content should not bypass moderation'}));
  f.act(report.id,'restore_content','resolved');
  assert.equal(garageReviews(f.db,f.gid).reviews[0].comment,'Original reported review');
  assert.equal(reviewsRoute(f.db,f.renter.id,'GET','/api/reviews/'+rid,{}).can_review,false);
});

test('expired decision-note copies are erased without replacing newer content or account decisions',t=>{
  const f=setup(t),now=Date.now(),old=now-91*86400000;
  const seq=f.message(),contentCase=f.report('message',seq);
  f.act(contentCase.id,'remove_content','pending',f.admin,{note:'Private report note retained only for the case'});
  const secondSeq=f.message(),oldContentCase=f.report('message',secondSeq);
  f.act(oldContentCase.id,'remove_content');f.act(oldContentCase.id,'restore_content','resolved');
  const newerContentCase=f.report('message',secondSeq);
  f.act(newerContentCase.id,'remove_content','pending',f.admin,{note:'Newer removal decision must survive old case cleanup'});
  const suspendCase=f.report('user',f.host.id);
  f.act(suspendCase.id,'suspend','pending',f.admin,{note:'Private suspension explanation'});
  const otherGarage=f.garage(f.isolated),otherCase=f.report('user',f.isolated.id);
  f.act(otherCase.id,'suspend','pending',f.admin,{note:'Text reused by a newer account decision'});
  for(const report of [contentCase,oldContentCase,suspendCase,otherCase])f.db.prepare('UPDATE ugc_reports SET updated_at=? WHERE id=?').run(old,report.id);
  f.db.prepare('UPDATE content_moderation SET removed_at=? WHERE report_id=?').run(old,contentCase.id);
  f.db.prepare('UPDATE user_account_state SET updated_at=? WHERE user_id=?').run(old,f.host.id);
  // Same text alone must not erase an account restriction updated after that case.
  f.db.prepare('UPDATE user_account_state SET updated_at=? WHERE user_id=?').run(now,f.isolated.id);
  assert.equal(purgeClosedReportEvidence(f.db,now),4);
  assert.equal(f.db.prepare('SELECT note FROM content_moderation WHERE target_id=?').get(String(seq)).note,'');
  assert.equal(isContentRemoved(f.db,'message',seq),true);
  assert.equal(f.db.prepare('SELECT note FROM content_moderation WHERE target_id=?').get(String(secondSeq)).note,'Newer removal decision must survive old case cleanup');
  const hostState=f.db.prepare('SELECT state,reason FROM user_account_state WHERE user_id=?').get(f.host.id);assert.equal(hostState.state,'suspended');assert.equal(hostState.reason,'');
  assert.equal(f.db.prepare('SELECT reason FROM user_account_state WHERE user_id=?').get(f.isolated.id).reason,'Text reused by a newer account decision');
  assert.equal(f.db.prepare('SELECT review_note FROM ugc_reports WHERE id=?').get(newerContentCase.id).review_note,'Newer removal decision must survive old case cleanup');
});

test('optional report revision rejects stale same-status decisions and legacy callers remain valid',t=>{
  const f=setup(t),report=f.report('garage',f.gid);
  const first=f.act(report.id,'review','pending',f.admin,{expected_updated_at:report.updated_at});
  const second=f.act(report.id,'review','under_review',f.admin,{expected_updated_at:first.updated_at});
  assert.ok(second.updated_at>first.updated_at);
  status(409,()=>f.act(report.id,'dismiss','under_review',f.admin,{expected_updated_at:first.updated_at}));
  assert.equal(f.act(report.id,'dismiss','under_review').status,'dismissed');
});
