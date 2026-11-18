import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {id,hash} from '../server/core.mjs';
import {makeApp} from '../server/app.mjs';
import {createWebAssets} from '../server/web-assets.mjs';
import {uploadedPhotoAccess} from '../server/photo-access.mjs';

async function setup(t){
 const web=mkdtempSync(join(tmpdir(),'garage-photo-access-'));mkdirSync(join(web,'assets/host-photos'),{recursive:true});
 const app=makeApp({database:':memory:',web,origin:'http://localhost'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${app.server.address().port}`,db=app.db,bytes=readFileSync(new URL('../web/assets/garages/garage-01.webp',import.meta.url));
 t.after(async()=>{await new Promise(r=>app.server.close(r));db.close();rmSync(web,{recursive:true,force:true});});
 function user(name,role){const actor={id:id(),token:id()+id(),name};db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(actor.id,name,name+'@example.com','unused fixture password',Date.now());if(role)db.prepare('INSERT INTO staff_members VALUES (?,?)').run(actor.id,role);db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(hash(actor.token),actor.id,id(),Date.now()+3600000,Date.now(),Date.now());return actor;}
 const owner=user('Owner'),other=user('Other'),admin=user('Admin','admin'),support=user('Support','support');
 function photo(){const image='/assets/host-photos/'+id()+'.webp';writeFileSync(join(web,image),bytes);return image;}
 function garage(status='pending',image=photo(),host=owner){const gid=id();db.prepare('INSERT INTO garages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(gid,host.id,'Photo access garage','Casablanca','Centre','Private entrance 42',33.57,-7.58,1000,95000,230,'suv',1,'A garage listing for photo access tests.',image,status,Date.now());return {id:gid,image};}
 async function get(path,actor,method='GET'){return fetch(base+path,{method,headers:actor?{Cookie:'garageshare_session='+actor.token}:{}});}
 function report(image,garageId,subject=owner){const reportId=id(),now=Date.now();db.prepare(`INSERT INTO ugc_reports(id,reporter_id,target_type,target_id,subject_user_id,reason,status,evidence_json,created_at,updated_at,request_key) VALUES (?,?, 'garage',?,?, 'inappropriate','pending',?,?,?,?)`).run(reportId,other.id,garageId,subject.id,JSON.stringify({id:garageId,image}),now,now,id());return reportId;}
 return {web,app,db,base,bytes,owner,other,admin,support,photo,garage,get,report};
}

test('uploaded current approved photos remain public, use no-store and stop being public immediately after archiving',async t=>{
 const f=await setup(t),row=f.garage('approved');
 const visible=await f.get(row.image);assert.equal(visible.status,200);assert.equal(visible.headers.get('cache-control'),'no-store');assert.equal(visible.headers.get('vary'),'Cookie');assert.deepEqual(Buffer.from(await visible.arrayBuffer()),f.bytes);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM sessions').get().n,4);
 const head=await f.get(row.image,undefined,'HEAD');assert.equal(head.status,200);assert.equal((await head.arrayBuffer()).byteLength,0);assert.equal(head.headers.get('cache-control'),'no-store');
 f.db.prepare("UPDATE garages SET status='archived' WHERE id=?").run(row.id);
 for(const actor of [undefined,f.other,f.support])assert.equal((await f.get(row.image,actor)).status,404);
 assert.equal((await f.get(row.image,f.owner)).status,200);
 assert.equal((await f.get(row.image,f.admin)).status,200);
 assert.equal(f.db.prepare("SELECT actor_id,target_id FROM audit WHERE action='listing_photo_reviewed'").get().target_id,row.id);
 f.db.prepare("UPDATE garages SET status='approved' WHERE id=?").run(row.id);
 for(const state of ['suspended','deleted']){f.db.prepare('INSERT INTO user_account_state VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state').run(f.owner.id,state,'fixture',Date.now());assert.equal((await f.get(row.image)).status,404);}
});

test('pending photo is private to its active owner and administrator; support and other customers cannot fetch it',async t=>{
 const f=await setup(t),row=f.garage();
 for(const actor of [undefined,f.other,f.support])assert.equal((await f.get(row.image,actor)).status,404);
 assert.equal((await f.get(row.image,undefined,'HEAD')).status,404);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM sessions').get().n,4);
 for(const actor of [f.owner,f.admin])assert.equal((await f.get(row.image,actor)).status,200);
 for(const state of ['rejected','archived']){f.db.prepare('UPDATE garages SET status=? WHERE id=?').run(state,row.id);assert.equal((await f.get(row.image,f.owner)).status,200);assert.equal((await f.get(row.image,f.other)).status,404);}
 f.db.prepare("INSERT INTO user_account_state VALUES (?,'suspended','fixture',?)").run(f.owner.id,Date.now());
 assert.equal((await f.get(row.image,f.owner)).status,404);
 f.db.prepare("UPDATE user_account_state SET state='deleted' WHERE user_id=?").run(f.owner.id);
 assert.equal((await f.get(row.image,f.owner)).status,404);
});

test('removed photo is inaccessible to ordinary users but current active admins may inspect audited case evidence',async t=>{
 const f=await setup(t),row=f.garage('approved'),reportId=f.report(row.image,row.id);
 f.db.prepare("INSERT INTO content_moderation VALUES ('garage',?,?,?,?,?)").run(row.id,reportId,f.admin.id,Date.now(),'Removed during human review');
 // The tombstone wins even if an inconsistent legacy record still says approved.
 for(const actor of [undefined,f.owner,f.other,f.support])assert.equal((await f.get(row.image,actor)).status,404);
 assert.equal((await f.get(row.image,f.admin)).status,200);
 const audit=f.db.prepare("SELECT * FROM audit WHERE action='ugc_photo_evidence_viewed'").get();assert.equal(audit.actor_id,f.admin.id);assert.equal(audit.target_id,reportId);
 const restored=f.db.prepare('DELETE FROM content_moderation WHERE target_type=? AND target_id=?').run('garage',row.id);assert.equal(restored.changes,1);
 f.db.prepare("UPDATE garages SET status='pending' WHERE id=?").run(row.id);assert.equal((await f.get(row.image)).status,404);assert.equal((await f.get(row.image,f.owner)).status,200);
 f.db.prepare("UPDATE garages SET status='approved' WHERE id=?").run(row.id);assert.equal((await f.get(row.image)).status,200);
});

test('replaced and deletion-queued files cannot be fetched publicly; retained case evidence stays admin-only',async t=>{
 const f=await setup(t),row=f.garage('pending');
 f.db.prepare('UPDATE garages SET image=? WHERE id=?').run(f.photo(),row.id);
 for(const actor of [undefined,f.owner,f.other,f.admin,f.support])assert.equal((await f.get(row.image,actor)).status,404);
 const reportId=f.report(row.image,row.id);
 assert.equal((await f.get(row.image,f.admin)).status,200);assert.equal((await f.get(row.image,f.owner)).status,404);
 f.db.prepare('INSERT INTO account_photo_cleanup(image,requested_at) VALUES (?,?)').run(row.image,Date.now());
 assert.equal((await f.get(row.image)).status,404);
 f.db.prepare('UPDATE ugc_reports SET evidence_json=? WHERE id=?').run('{"expired":true}',reportId);
 assert.equal((await f.get(row.image,f.admin)).status,404);
});

test('private photo access rechecks session expiry, revocation, role and account state',async t=>{
 const f=await setup(t),row=f.garage('archived');
 assert.equal(uploadedPhotoAccess(f.db,row.image,f.admin.token).public,false);
 f.db.prepare('DELETE FROM staff_members WHERE user_id=?').run(f.admin.id);assert.equal((await f.get(row.image,f.admin)).status,404);
 f.db.prepare("INSERT INTO staff_members VALUES (?,'admin')").run(f.admin.id);
 for(const state of ['suspended','deleted']){
  f.db.prepare('INSERT INTO user_account_state VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state').run(f.admin.id,state,'fixture',Date.now());assert.equal((await f.get(row.image,f.admin)).status,404);
 }
 f.db.prepare("UPDATE user_account_state SET state='active' WHERE user_id=?").run(f.admin.id);
 f.db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(Date.now()-1,f.admin.id);assert.equal((await f.get(row.image,f.admin)).status,404);
 f.db.prepare('UPDATE sessions SET expires_at=?,last_seen=? WHERE user_id=?').run(Date.now()+3600000,Date.now()-31*60000,f.admin.id);assert.equal((await f.get(row.image,f.admin)).status,404);
 f.db.prepare('UPDATE sessions SET last_seen=? WHERE user_id=?').run(Date.now(),f.admin.id);assert.equal((await f.get(row.image,f.admin)).status,200);
 f.db.prepare('DELETE FROM sessions WHERE user_id=?').run(f.admin.id);assert.equal((await f.get(row.image,f.admin)).status,404);
});

test('decoded, duplicate-slash and versioned photo URLs enforce identical access and reject symlink substitutions',async t=>{
 const f=await setup(t),row=f.garage('pending'),prefix=createWebAssets(f.web).prefix;
 for(const path of [row.image,row.image.replace('/assets/','/%61ssets/'),row.image.replace('/host-photos/','/%68ost-photos/'),row.image.replace('/assets/','/assets//'),prefix+row.image.slice(1),prefix+row.image.slice(1).replace('host-photos','%68ost-photos')]){
  assert.equal((await f.get(path)).status,404,path);assert.equal((await f.get(path,f.owner)).status,200,path);
 }
 const linked='/assets/host-photos/'+id()+'.webp';symlinkSync(join(f.web,row.image),join(f.web,linked));f.db.prepare('UPDATE garages SET image=? WHERE id=?').run(linked,row.id);
 assert.equal((await f.get(linked,f.owner)).status,404);
});


test('a removed photo cannot become public through another legacy listing sharing the same image',async t=>{
 const f=await setup(t),row=f.garage('approved'),reportId=f.report(row.image,row.id);
 f.garage('approved',row.image,f.other);
 f.db.prepare("INSERT INTO content_moderation VALUES ('garage',?,?,?,?,?)").run(row.id,reportId,f.admin.id,Date.now(),'Removed photo must not reappear');
 for(const actor of [undefined,f.owner,f.other,f.support])assert.equal((await f.get(row.image,actor)).status,404);
 assert.equal((await f.get(row.image,f.admin)).status,200);
 f.db.prepare('UPDATE garages SET image=? WHERE id=?').run(f.photo(),row.id);
 // Even after replacing the first listing image, its case snapshot still identifies the removed photo.
 for(const actor of [undefined,f.owner,f.other,f.support])assert.equal((await f.get(row.image,actor)).status,404);
 assert.equal((await f.get(row.image,f.admin)).status,200);
});
