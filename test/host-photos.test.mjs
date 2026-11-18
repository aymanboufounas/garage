import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeApp } from '../server/app.mjs';

const origin='http://localhost', password='Only a host photo test password 123!';
const image=readFileSync(new URL('../web/assets/garages/garage-01.webp',import.meta.url)).toString('base64');
const secondImage=readFileSync(new URL('../web/assets/garages/garage-02.webp',import.meta.url)).toString('base64');
const details={name:'Host photo test garage',city:'Casablanca',area:'Centre',address:'Private entrance 42',latitude:33.57,longitude:-7.58,hourly_cents:1000,monthly_cents:95000,height_cm:230,vehicle_size:'suv',covered:true,description:'An accurate garage listing used only for tests.'};
async function setup(t) {
  const web=mkdtempSync(join(tmpdir(),'garage-host-photo-'));mkdirSync(join(web,'assets'));
  const app=makeApp({database:':memory:',web,origin});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.db.close();rmSync(web,{recursive:true,force:true});});
  function client(){return {cookie:'',csrf:'',user:null,async call(path,data,extra={}){
    const r=await fetch(base+'/api'+path,{method:data===undefined?'GET':'POST',headers:{Cookie:this.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':this.csrf,...extra},body:data===undefined?undefined:JSON.stringify(data)});
    if(r.headers.has('set-cookie'))this.cookie=r.headers.get('set-cookie').split(';')[0];const json=await r.json();if(json.csrf)this.csrf=json.csrf;return {status:r.status,json};
  },async register(name,role){await this.call('/session');const r=await this.call('/register',{name,email:name+'@example.com',password});assert.equal(r.status,201);this.user=r.json.user;if(role)app.db.prepare('INSERT INTO staff_members VALUES (?,?)').run(this.user.id,role);return this;}};}
  const host=await client().register('Host'),other=await client().register('Other'),admin=await client().register('Admin','admin'),anonymous=client();await anonymous.call('/session');
  async function create(photo=image){const data={...details};if(photo!==null)data.photo_base64=photo;const r=await host.call('/host/garages',data);assert.equal(r.status,201);return r.json;}
  function photoData(row,photo=secondImage){return {photo_base64:photo,expected_status:row.status,expected_image:row.image};}
  function approval(row){return {confirmed:true,expected_status:row.status,expected_image:row.image};}
  return {app,web,base,host,other,admin,anonymous,create,photoData,approval};
}

test('host photo and listing are created together pending; admin approves the existing photo',async t=>{
  const {app,web,base,host,admin,create,approval}=await setup(t),row=await create();
  assert.equal(row.status,'pending');assert.match(row.image,/^\/assets\/host-photos\/[a-f0-9]{32}\.webp$/);
  const owned=(await host.call('/host/garages')).json.garages[0];assert.equal(owned.image,row.image);
  assert.equal((await fetch(base+'/api/garages').then(r=>r.json())).garages.length,0);
  const result=await admin.call(`/staff/garages/${row.id}/approve`,approval(row));assert.equal(result.status,200);assert.equal(result.json.image,row.image);
  assert.equal((await fetch(base+'/api/garages').then(r=>r.json())).garages[0].id,row.id);
  assert.equal(readdirSync(join(web,'assets/host-photos')).length,1);
  assert.equal(app.db.prepare("SELECT actor_id FROM audit WHERE action='moderator_approved'").get().actor_id,admin.user.id);
});

test('only the listing owner can upload and POST still enforces origin and CSRF',async t=>{
  const {web,host,other,admin,anonymous,create,photoData}=await setup(t),row=await create(),path=`/host/garages/${row.id}/photo`;
  assert.equal((await anonymous.call(path,photoData(row))).status,401);
  assert.equal((await other.call(path,photoData(row))).status,404);
  assert.equal((await admin.call(path,photoData(row))).status,404);
  assert.equal((await host.call(path,photoData(row),{Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await host.call(path,photoData(row),{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await anonymous.call('/host/garages',{...details,photo_base64:image})).status,401);
  assert.equal(readdirSync(join(web,'assets/host-photos')).length,1);
});

test('photo replacement invalidates a stale review and resets rejected or approved listings to pending',async t=>{
  const {app,host,admin,create,photoData,approval}=await setup(t),row=await create();
  const updated=await host.call(`/host/garages/${row.id}/photo`,photoData(row));assert.equal(updated.status,200);assert.notEqual(updated.json.image,row.image);
  assert.equal((await admin.call(`/staff/garages/${row.id}/approve`,approval(row))).status,409);
  assert.equal((await host.call(`/host/garages/${row.id}/photo`,photoData(row))).status,409);
  assert.equal((await admin.call(`/staff/garages/${row.id}/approve`,approval(updated.json))).status,200);
  const replacement=await host.call(`/host/garages/${row.id}/photo`,photoData({...updated.json,status:'approved'},image));assert.equal(replacement.status,200);assert.equal(replacement.json.status,'pending');
  app.db.prepare("UPDATE garages SET status='rejected' WHERE id=?").run(row.id);
  const resubmission=await host.call(`/host/garages/${row.id}/photo`,photoData({...replacement.json,status:'rejected'}));assert.equal(resubmission.status,200);assert.equal(resubmission.json.status,'pending');
  app.db.prepare("UPDATE garages SET status='archived' WHERE id=?").run(row.id);
  assert.equal((await host.call(`/host/garages/${row.id}/photo`,photoData({...resubmission.json,status:'archived'}))).status,409);
});

test('draft listings without a host photo cannot be approved and unsafe or missing files cannot substitute',async t=>{
  const {app,web,admin,create,approval}=await setup(t),row=await create(null);
  assert.equal(row.image,'/assets/garage-placeholder.svg');
  assert.equal((await admin.call(`/staff/garages/${row.id}/approve`,approval(row))).status,422);
  for(const path of ['/assets/host-photos/../../server/index.mjs','/assets/garages/garage-01.webp','https://example.com/photo.webp']){
    app.db.prepare('UPDATE garages SET image=? WHERE id=?').run(path,row.id);
    assert.equal((await admin.call(`/staff/garages/${row.id}/approve`,approval({...row,image:path}))).status,422);
  }
  const valid=await create();unlinkSync(join(web,valid.image));
  assert.equal((await admin.call(`/staff/garages/${valid.id}/approve`,approval(valid))).status,409);
  symlinkSync(new URL('../web/assets/garages/garage-01.webp',import.meta.url),join(web,valid.image));
  assert.equal((await admin.call(`/staff/garages/${valid.id}/approve`,approval(valid))).status,409);
});

test('host photo writes are bounded and invalid input or database failure leaves no new listing or file',async t=>{
  const {app,web,host}=await setup(t);
  for(const photo of ['PHN2Zz48L3N2Zz4=',image.slice(0,24),'A'.repeat(6990512)]){
    assert.equal((await host.call('/host/garages',{...details,photo_base64:photo})).status,422);
  }
  assert.equal((await host.call('/host/garages',{...details,photo_base64:'A'.repeat(7*1024*1024)})).status,413);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM garages').get().n,0);assert.deepEqual(readdirSync(join(web,'assets')),[]);
  app.db.exec("CREATE TRIGGER fail_fixture_listing BEFORE INSERT ON garages BEGIN SELECT RAISE(ABORT,'fixture photo rollback'); END");
  assert.equal((await host.call('/host/garages',{...details,photo_base64:image})).status,500);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM garages').get().n,0);assert.deepEqual(readdirSync(join(web,'assets/host-photos')),[]);
});

test('photo changes preserve a booked approved listing and reject storage failure without changing its snapshot',async t=>{
  const {app,web,host,other,admin,create,photoData,approval}=await setup(t),row=await create();
  assert.equal((await admin.call(`/staff/garages/${row.id}/approve`,approval(row))).status,200);
  const booking=await other.call('/reservations',{garage_id:row.id,action:'book',mode:'hourly',units:1,starts_at:new Date(Date.now()+86400000).toISOString(),request_key:'host-photo-booking-key-123'});assert.equal(booking.status,201);
  assert.equal((await host.call(`/host/garages/${row.id}/photo`,photoData({...row,status:'approved'}))).status,409);
  assert.equal(app.db.prepare('SELECT image FROM garages WHERE id=?').get(row.id).image,row.image);
  app.db.prepare("UPDATE reservations SET status='cancelled' WHERE garage_id=?").run(row.id);
  app.db.exec("CREATE TRIGGER fail_fixture_photo BEFORE UPDATE OF image ON garages BEGIN SELECT RAISE(ABORT,'fixture photo rollback'); END");
  assert.equal((await host.call(`/host/garages/${row.id}/photo`,photoData({...row,status:'approved'}))).status,500);
  const stored=app.db.prepare('SELECT image,status FROM garages WHERE id=?').get(row.id);assert.equal(stored.image,row.image);assert.equal(stored.status,'approved');
  assert.equal(readdirSync(join(web,'assets/host-photos')).length,1);
});
