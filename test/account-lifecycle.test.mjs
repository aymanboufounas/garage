import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountDeletionRoute, accountState, assertAccountActive, cleanupDeletedAccountPhotos } from '../server/account-lifecycle.mjs';
import { openDatabase, id, hash, passwordHash } from '../server/core.mjs';

const password = 'Only a lifecycle test password 123!';
async function setup(t) {
  const db = openDatabase(':memory:');
  const web = mkdtempSync(join(tmpdir(),'garage-account-delete-'));
  mkdirSync(join(web,'assets/host-photos'),{recursive:true});
  t.after(()=>{db.close();rmSync(web,{recursive:true,force:true});});
  const now = Date.now(), owner={id:id(),name:'Private owner',email:'owner@example.com'}, other={id:id(),name:'Other participant',email:'other@example.com'};
  const password_hash = await passwordHash(password);
  for (const user of [owner,other]) db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.id,user.name,user.email,password_hash,now);
  const session={token_hash:hash(id()),user_id:owner.id,csrf:hash(id()),expires_at:now+12*3600000,created_at:now,last_seen:now};
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(session.token_hash,session.user_id,session.csrf,session.expires_at,session.created_at,session.last_seen);
  function garage(user=owner,withPhoto=true) {
    const gid=id(),image=withPhoto?'/assets/host-photos/'+id()+'.webp':'/assets/garage-placeholder.svg';
    if(withPhoto)writeFileSync(join(web,image),readFileSync(new URL('../web/assets/garages/garage-01.webp',import.meta.url)));
    db.prepare('INSERT INTO garages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(gid,user.id,'Private garage','Casablanca','Private area','Private address 42',33.57,-7.58,1000,95000,230,'suv',1,'Private garage description',image,'approved',now);
    return {id:gid,image,owner_id:user.id};
  }
  function booking(g,guest=other,status='confirmed',offset=-86400000) {
    const rid=id(),start=now+offset,end=start+3600000;
    db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,g.id,guest.id,'hourly',start,end,1,1000,status,status==='requested'?now+3600000:null,now,now,id());
    return {id:rid,starts_at:start,ends_at:end};
  }
  const get = ()=>accountDeletionRoute(db,web,owner,session,'GET','/api/account/deletion',{});
  const remove = (data={confirmation:'DELETE',password})=>accountDeletionRoute(db,web,owner,session,'POST','/api/account/delete',data);
  return {db,web,owner,other,session,now,garage,booking,get,remove};
}

const errorStatus = (status, pattern) => error => error.status===status && (!pattern||pattern.test(error.message));

test('deletion requires explicit owner confirmation, correct password, and an active matching session',async t=>{
  const {db,owner,other,session,remove,get}=await setup(t);
  assert.equal(accountState(db,owner.id),'active');assert.doesNotThrow(()=>assertAccountActive(db,owner.id));
  const info=await get();assert.equal(info.can_delete,true);assert.equal(info.requires_password,true);
  await assert.rejects(remove({confirmation:'delete',password}),errorStatus(422));
  await assert.rejects(remove({confirmation:'DELETE',password:'wrong password'}),errorStatus(403));
  await assert.rejects(remove({confirmation:'DELETE',password,user_id:other.id}),errorStatus(422));
  session.user_id=other.id; // The DB session, not the caller object's claimed user_id, is authoritative.
  db.prepare('UPDATE sessions SET user_id=? WHERE token_hash=?').run(other.id,session.token_hash);
  await assert.rejects(remove(),errorStatus(401));
  assert.equal(db.prepare('SELECT name FROM users WHERE id=?').get(owner.id).name,owner.name);
});

test('both renter and host active bookings block deletion; completed stays do not',async t=>{
  const {db,owner,other,garage,booking,get,remove}=await setup(t);
  const own=garage(),theirs=garage(other);const hosted=booking(own,other,'confirmed',3600000),rented=booking(theirs,owner,'confirmed',7200000);
  const info=await get();assert.equal(info.can_delete,false);assert.deepEqual(info.blockers,[{code:'active_bookings',count:2}]);
  await assert.rejects(remove(),errorStatus(409,/bookings/));
  db.prepare("UPDATE reservations SET status='cancelled' WHERE id IN (?,?)").run(hosted.id,rented.id);
  booking(own);assert.equal((await remove()).deleted,true);
});

test('the last active administrator cannot delete their account, including when other admins are suspended',async t=>{
  const {db,owner,other,now,remove,get}=await setup(t);
  db.prepare("INSERT INTO staff_members VALUES (?,'admin')").run(owner.id);
  db.prepare("INSERT INTO staff_members VALUES (?,'admin')").run(other.id);
  db.prepare("INSERT INTO user_account_state VALUES (?,'suspended','fixture',?)").run(other.id,now);
  assert.ok((await get()).blockers.some(row=>row.code==='last_administrator'));
  await assert.rejects(remove(),errorStatus(409,/administrator/));
  db.prepare("UPDATE user_account_state SET state='active' WHERE user_id=?").run(other.id);
  assert.equal((await remove()).deleted,true);assert.ok(db.prepare('SELECT 1 FROM staff_members WHERE user_id=?').get(other.id));
});

test('deletion scrubs owner content and credentials while preserving another participant and transactional rows',async t=>{
  const {db,web,owner,other,now,garage,booking,remove}=await setup(t);
  const own=garage(),stay=booking(own),offer=booking(own,other,'requested',3600000),thread=id(),ticket=id();
  db.prepare('INSERT INTO chat_threads VALUES (?,?,?,?,?,?)').run(thread,other.id,owner.id,stay.id,null,now);
  db.prepare('INSERT INTO chat_messages(thread_id,sender_id,message,created_at,request_key) VALUES (?,?,?,?,?)').run(thread,owner.id,'My private chat text',now,id());
  db.prepare('INSERT INTO chat_messages(thread_id,sender_id,message,created_at,request_key) VALUES (?,?,?,?,?)').run(thread,other.id,'Other participant message',now,id());
  db.prepare('INSERT INTO stay_reviews VALUES (?,?,?,?,?,?,?)').run(stay.id,owner.id,'host',5,'My private review comment',now,now);
  db.prepare('INSERT INTO support_tickets VALUES (?,?,?,?,?,?,?,?,?,?)').run(ticket,owner.id,stay.id,'account','My private support subject','open',null,now,now,id());
  db.prepare('INSERT INTO support_messages VALUES (?,?,?,?,?,?,?)').run(id(),ticket,owner.id,'customer','My private support message',now,id());
  db.prepare('INSERT INTO support_messages VALUES (?,?,?,?,?,?,?)').run(id(),ticket,other.id,'staff','Other staff reply retained',now,id());
  db.prepare('INSERT INTO google_identities VALUES (?,?,?)').run('google-subject',owner.id,now);
  db.prepare('INSERT INTO garage_blocks VALUES (?,?,?,?,?,?,?)').run(id(),own.id,now+9999999,now+19999999,'Private block note',id(),now);
  const result=await remove();assert.equal(result.deleted,true);assert.equal(result.retained_history,true);assert.equal(result.photo_cleanup_pending,false);
  const deleted=db.prepare('SELECT * FROM users WHERE id=?').get(owner.id);assert.equal(deleted.name,'Deleted account');assert.equal(deleted.password_hash,'');assert.match(deleted.email,/@deleted\.invalid$/);
  assert.equal(accountState(db,owner.id),'deleted');assert.throws(()=>assertAccountActive(db,owner.id),errorStatus(401));
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(owner.id).n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM google_identities WHERE user_id=?').get(owner.id).n,0);
  const scrubbed=db.prepare('SELECT * FROM garages WHERE id=?').get(own.id);assert.equal(scrubbed.status,'archived');assert.equal(scrubbed.address,'');assert.equal(scrubbed.latitude,0);assert.equal(scrubbed.longitude,0);assert.equal(scrubbed.description,'');
  assert.equal(existsSync(join(web,own.image)),false);assert.equal(db.prepare('SELECT count(*) AS n FROM garage_blocks').get().n,0);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id=?').get(offer.id).status,'cancelled');assert.equal(db.prepare('SELECT total_cents FROM reservations WHERE id=?').get(stay.id).total_cents,1000);
  assert.equal(db.prepare('SELECT comment FROM stay_reviews WHERE author_id=?').get(owner.id).comment,'');
  assert.match(db.prepare('SELECT message FROM chat_messages WHERE sender_id=?').get(owner.id).message,/removed/);assert.equal(db.prepare('SELECT message FROM chat_messages WHERE sender_id=?').get(other.id).message,'Other participant message');
  assert.equal(db.prepare('SELECT message FROM support_messages WHERE author_id=?').get(other.id).message,'Other staff reply retained');
  assert.equal(db.prepare('SELECT name FROM users WHERE id=?').get(other.id).name,other.name);assert.equal(db.prepare('SELECT count(*) AS n FROM account_deletion_events').get().n,1);
});

test('password reauthentication does not outlive session revocation or password changes',async t=>{
  const {db,owner,session,remove}=await setup(t);
  const deleting=remove();db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash);
  await assert.rejects(deleting,errorStatus(401));assert.equal(accountState(db,owner.id),'active');
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(session.token_hash,session.user_id,session.csrf,session.expires_at,session.created_at,session.last_seen);
  const changing=remove();db.prepare("UPDATE users SET password_hash='changed concurrently' WHERE id=?").run(owner.id);
  await assert.rejects(changing,errorStatus(409));assert.equal(accountState(db,owner.id),'active');
});

test('Google-only deletion requires a linked identity and a recent authenticated session',async t=>{
  const {db,owner,session,now,remove}=await setup(t);
  db.prepare("UPDATE users SET password_hash='' WHERE id=?").run(owner.id);
  await assert.rejects(remove({confirmation:'DELETE'}),errorStatus(401));
  db.prepare('INSERT INTO google_identities VALUES (?,?,?)').run('only-google-subject',owner.id,now);
  db.prepare('UPDATE sessions SET created_at=? WHERE token_hash=?').run(now-6*60000,session.token_hash);
  await assert.rejects(remove({confirmation:'DELETE'}),errorStatus(401));
  db.prepare('UPDATE sessions SET created_at=? WHERE token_hash=?').run(Date.now(),session.token_hash);
  assert.equal((await remove({confirmation:'DELETE'})).deleted,true);
});

test('unresolved evidence holds a photo, closed evidence redacts, and cleanup removes an orphan only after holds clear',async t=>{
  const {db,web,owner,other,now,garage,remove}=await setup(t);const own=garage();
  const open=id(),closed=id();
  for(const [rid,status] of [[open,'pending'],[closed,'resolved']])db.prepare(`INSERT INTO ugc_reports(id,reporter_id,target_type,target_id,subject_user_id,reason,explanation,status,evidence_json,created_at,updated_at,request_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(rid,other.id,'garage',own.id,owner.id,'misleading','Other participant explanation',status,JSON.stringify({name:'Private garage',image:own.image}),now,now,id());
  assert.equal((await remove()).photo_cleanup_pending,true);assert.equal(existsSync(join(web,own.image)),true);
  assert.equal(JSON.parse(db.prepare('SELECT evidence_json FROM ugc_reports WHERE id=?').get(open).evidence_json).image,own.image);
  assert.equal(db.prepare('SELECT evidence_json FROM ugc_reports WHERE id=?').get(closed).evidence_json,'{}');
  db.prepare("UPDATE ugc_reports SET status='resolved',evidence_json='{}' WHERE id=?").run(open);
  assert.equal(cleanupDeletedAccountPhotos(db,web).pending,0);assert.equal(existsSync(join(web,own.image)),false);
});

test('another listing reference and unsafe photo paths are never removed by cleanup',async t=>{
  const {db,web,other,garage,remove}=await setup(t);const own=garage(),theirs=garage(other,false);
  db.prepare('UPDATE garages SET image=? WHERE id=?').run(own.image,theirs.id);
  assert.equal((await remove()).photo_cleanup_pending,true);assert.equal(existsSync(join(web,own.image)),true);
  const protectedFile=join(web,'private.txt');writeFileSync(protectedFile,'keep');
  db.prepare('INSERT INTO account_photo_cleanup(image,requested_at) VALUES (?,?)').run('/assets/host-photos/../../private.txt',Date.now());
  cleanupDeletedAccountPhotos(db,web);assert.equal(readFileSync(protectedFile,'utf8'),'keep');
});

test('transaction failure rolls back all scrubbing and does not remove photo files',async t=>{
  const {db,web,owner,garage,remove}=await setup(t);const own=garage();
  db.exec("CREATE TRIGGER fail_account_delete BEFORE UPDATE OF email ON users BEGIN SELECT RAISE(ABORT,'fixture deletion rollback'); END");
  await assert.rejects(remove(),/fixture deletion rollback/);
  assert.equal(db.prepare('SELECT name FROM users WHERE id=?').get(owner.id).name,owner.name);
  assert.equal(db.prepare('SELECT status FROM garages WHERE id=?').get(own.id).status,'approved');assert.equal(existsSync(join(web,own.image)),true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM account_deletion_events').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM account_photo_cleanup').get().n,0);
});


test('a freshly authenticated suspended owner can delete their own account without restoring marketplace access',async t=>{
  const {db,owner,now,get,remove}=await setup(t);
  db.prepare("INSERT INTO user_account_state VALUES (?,'suspended','fixture',?)").run(owner.id,now);
  assert.throws(()=>assertAccountActive(db,owner.id),errorStatus(403));
  assert.equal((await get()).state,'suspended');assert.equal((await get()).can_delete,true);
  assert.equal((await remove()).deleted,true);assert.equal(accountState(db,owner.id),'deleted');
});

test('deletion declines outstanding quotes while retaining the selected quote of a completed booking',async t=>{
  const {db,owner,other,now,garage,booking,remove}=await setup(t);
  const own=garage(),stay=booking(own),completedRequest=id(),outstandingRequest=id(),selectedQuote=id(),outstandingQuote=id();
  const insert=db.prepare(`INSERT INTO rental_requests(id,guest_id,city,mode,starts_at,ends_at,units,proposed_cents,status,expires_at,created_at,reservation_id,request_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run(completedRequest,other.id,'Casablanca','hourly',stay.starts_at,stay.ends_at,1,1000,'booked',now-1,now-86400000,stay.id,id());
  insert.run(outstandingRequest,other.id,'Casablanca','hourly',now+3600000,now+7200000,1,1000,'open',now+1800000,now,null,id());
  db.prepare('INSERT INTO rental_quotes VALUES (?,?,?,?,?)').run(selectedQuote,completedRequest,own.id,'quoted',1000);
  db.prepare('INSERT INTO rental_quotes VALUES (?,?,?,?,?)').run(outstandingQuote,outstandingRequest,own.id,'quoted',1000);
  await remove();
  const selected=db.prepare('SELECT status,total_cents FROM rental_quotes WHERE id=?').get(selectedQuote);
  assert.equal(selected.status,'quoted');assert.equal(selected.total_cents,1000);
  const outstanding=db.prepare('SELECT status,total_cents FROM rental_quotes WHERE id=?').get(outstandingQuote);
  assert.equal(outstanding.status,'declined');assert.equal(outstanding.total_cents,null);
  assert.equal(db.prepare('SELECT status FROM rental_requests WHERE id=?').get(completedRequest).status,'booked');
});

test('attributed previous photos are cleaned with current photos and ownership metadata only disappears after cleanup',async t=>{
  const {db,web,owner,garage,remove}=await setup(t);const own=garage(),previous='/assets/host-photos/'+id()+'.webp';
  writeFileSync(join(web,previous),readFileSync(new URL('../web/assets/garages/garage-01.webp',import.meta.url)));
  for(const image of [own.image,previous])db.prepare('INSERT INTO listing_photo_owners VALUES (?,?,?)').run(image,owner.id,Date.now());
  await remove();assert.equal(existsSync(join(web,own.image)),false);assert.equal(existsSync(join(web,previous)),false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM listing_photo_owners WHERE user_id=?').get(owner.id).n,0);
});
