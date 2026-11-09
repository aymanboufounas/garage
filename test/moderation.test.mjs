import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server/app.mjs';

const origin = 'http://localhost';
const password = 'Moderation fixture password 123!';
async function setup(t) {
  const web = mkdtempSync(join(tmpdir(), 'garage-moderation-'));
  mkdirSync(join(web, 'assets'));
  const app = makeApp({ database: ':memory:', web, origin });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); app.db.close(); rmSync(web, {recursive:true,force:true}); });
  function client() {
    return { cookie:'', csrf:'', user:null,
      async call(path, data, extra={}) {
        const headers = {Cookie:this.cookie, Origin:origin, ...extra};
        if (data !== undefined) { headers['Content-Type']='application/json'; headers['X-CSRF-Token']=extra['X-CSRF-Token'] ?? this.csrf; }
        const response = await fetch(base+'/api'+path, {method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:JSON.stringify(data)});
        if (response.headers.has('set-cookie')) this.cookie=response.headers.get('set-cookie').split(';')[0];
        const json=await response.json(); if(json.csrf)this.csrf=json.csrf;
        return {status:response.status,json};
      },
      async register(name, role) {
        await this.call('/session');
        const r=await this.call('/register',{email:name+'@example.com',name,password,staff_role:'admin'});
        assert.equal(r.status,201); this.user=r.json.user;
        assert.equal(this.user.staff_role,undefined);
        if(role)app.db.prepare('INSERT INTO staff_members(user_id,role) VALUES (?,?)').run(this.user.id,role);
        return this;
      }
    };
  }
  const host=await client().register('Host');
  const admin=await client().register('Admin','admin');
  const support=await client().register('Support','support');
  async function listing() {
    const r=await host.call('/host/garages',{name:'Review <img src=x> Garage',city:'Casablanca',area:'Centre',address:'Private entrance 42',latitude:33.57,longitude:-7.58,hourly_cents:1000,monthly_cents:95000,height_cm:230,vehicle_size:'suv',covered:true,description:'A covered garage for moderation testing.'});
    assert.equal(r.status,201);return r.json.id;
  }
  const photo=readFileSync(new URL('../web/assets/garages/garage-01.webp',import.meta.url)).toString('base64');
  const approval={expected_status:'pending',confirmed:true,photo_base64:photo};
  return {app,base,web,host,admin,support,anonymous:client(),listing,approval};
}

test('only administrators can list or moderate garages; origin and CSRF remain required',async t=>{
  const {app,host,admin,support,anonymous,listing,approval}=await setup(t);
  const gid=await listing(), route=`/staff/garages/${gid}/approve`;
  assert.equal((await anonymous.call('/staff/garages')).status,401);
  for(const actor of [host,support]) {
    assert.equal((await actor.call('/staff/garages')).status,403);
    assert.equal((await actor.call(route,approval)).status,403);
    assert.equal((await actor.call(`/staff/garages/${gid}/reject`,{expected_status:'pending'})).status,403);
  }
  assert.equal((await admin.call(route,approval,{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await admin.call(route,approval,{Origin:'https://attacker.invalid'})).status,403);
  app.db.prepare('DELETE FROM staff_members WHERE user_id=?').run(admin.user.id);
  assert.equal((await admin.call(route,approval)).status,403);
  assert.equal(app.db.prepare('SELECT status FROM garages WHERE id=?').get(gid).status,'pending');
});

test('approval stores an authorized photo and audit actor, publishes listing, rejects stale repeats',async t=>{
  const {app,base,web,admin,listing,approval}=await setup(t);
  const gid=await listing();
  const queue=await admin.call('/staff/garages');
  assert.equal(queue.json.garages[0].id,gid);
  assert.equal(queue.json.garages[0].owner_email,'Host@example.com'.toLowerCase());
  assert.equal((await fetch(base+'/api/garages').then(r=>r.json())).garages.length,0);
  const result=await admin.call(`/staff/garages/${gid}/approve`,approval);
  assert.equal(result.status,200);assert.equal(result.json.status,'approved');
  const response=await fetch(base+result.json.image);
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/webp');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(approval.photo_base64,'base64'));
  assert.equal((await fetch(base+'/api/garages').then(r=>r.json())).garages[0].id,gid);
  const audit=app.db.prepare("SELECT * FROM audit WHERE action='moderator_approved'").get();
  assert.equal(audit.actor_id,admin.user.id);
  assert.equal((await admin.call(`/staff/garages/${gid}/approve`,approval)).status,409);
  assert.equal(readdirSync(join(web,'assets/host-photos')).length,1);
});

test('invalid photos and missing review cannot publish or create files',async t=>{
  const {app,web,admin,listing,approval}=await setup(t);
  const gid=await listing(), route=`/staff/garages/${gid}/approve`;
  for(const data of [{...approval,confirmed:false},{...approval,photo_base64:'PHN2Zz48L3N2Zz4='},{...approval,photo_base64:approval.photo_base64.slice(0,24)}, {...approval,photo_base64:'A'.repeat(6990512)}]) {
    const result=await admin.call(route,data);assert.equal(result.status,422);
  }
  assert.equal(app.db.prepare('SELECT status FROM garages WHERE id=?').get(gid).status,'pending');
  assert.deepEqual(readdirSync(join(web,'assets')),[]);
});

test('rejection and archiving respect current status and protect upcoming bookings',async t=>{
  const {app,host,admin,listing,approval}=await setup(t);
  const rejected=await listing();
  assert.equal((await admin.call(`/staff/garages/${rejected}/reject`,{expected_status:'pending'})).json.status,'rejected');
  assert.equal((await admin.call(`/staff/garages/${rejected}/approve`,approval)).status,409);
  const gid=await listing();
  assert.equal((await admin.call(`/staff/garages/${gid}/approve`,approval)).status,200);
  const starts=Date.now()+86400000;
  const booking=await admin.call('/reservations',{garage_id:gid,action:'book',mode:'hourly',units:1,starts_at:new Date(starts).toISOString(),request_key:'moderation-booking-key-123'});
  assert.equal(booking.status,201);
  const blocked=await admin.call(`/staff/garages/${gid}/archive`,{expected_status:'approved'});
  assert.equal(blocked.status,409);
  app.db.prepare("UPDATE reservations SET status='cancelled' WHERE garage_id=?").run(gid);
  assert.equal((await admin.call(`/staff/garages/${gid}/archive`,{expected_status:'approved'})).json.status,'archived');
  assert.equal((await host.call(`/staff/garages/${gid}/archive`,{expected_status:'archived'})).status,403);
});

test('moderation pagination is bounded and other JSON routes keep their smaller body limit',async t=>{
  const {app,admin,listing}=await setup(t);
  const gid=await listing();
  for(let n=0;n<25;n++)app.db.prepare(`INSERT INTO garages SELECT ?,owner_id,name,city,area,address,latitude,longitude,hourly_cents,monthly_cents,height_cm,vehicle_size,covered,description,image,status,created_at FROM garages WHERE id=?`).run((n+1).toString(16).padStart(32,'0'),gid);
  const first=await admin.call('/staff/garages');
  assert.equal(first.json.garages.length,25);assert.equal(first.json.has_more,true);
  const second=await admin.call('/staff/garages?offset=25');assert.equal(second.json.garages.length,1);assert.equal(second.json.has_more,false);
  assert.equal(first.json.garages.some(row=>row.id===second.json.garages[0].id),false);
  assert.equal((await admin.call('/staff/garages?offset=-1')).status,422);
  assert.equal((await admin.call(`/staff/garages/${gid}/reject`,{expected_status:'pending',extra:'x'.repeat(17000)})).status,413);
  assert.equal(app.db.prepare('SELECT status FROM garages WHERE id=?').get(gid).status,'pending');
});

test('photo persistence failure leaves listing pending and unexposed',async t=>{
  const {app,web,admin,listing,approval}=await setup(t);
  const gid=await listing();
  // A file where the directory is expected forces a deterministic filesystem failure.
  const {writeFileSync}=await import('node:fs');
  writeFileSync(join(web,'assets/host-photos'),'not a directory');
  assert.equal((await admin.call(`/staff/garages/${gid}/approve`,approval)).status,500);
  assert.equal(app.db.prepare('SELECT status FROM garages WHERE id=?').get(gid).status,'pending');
  assert.equal(app.db.prepare("SELECT count(*) AS n FROM audit WHERE action='moderator_approved'").get().n,0);
});
