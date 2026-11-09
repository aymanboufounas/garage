import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from '../server/app.mjs';
import { passwordMatches } from '../server/core.mjs';
const origin='http://localhost', password='Only a fixture password 123!';
async function setup(t) {
  const app=makeApp({database:':memory:',origin});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.db.close();});
  function client(){return {cookie:'',csrf:'',user:null,
    async call(path,data,extra={}) {
      const response=await fetch(base+'/api'+path,{method:data===undefined?'GET':'POST',headers:{Cookie:this.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':this.csrf,...extra},body:data===undefined?undefined:JSON.stringify(data)});
      if(response.headers.has('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];
      const json=await response.json();if(json.csrf)this.csrf=json.csrf;
      return {status:response.status,json};
    },
    async register(name,role){await this.call('/session');const r=await this.call('/register',{name,email:name+'@example.com',password});assert.equal(r.status,201);this.user=r.json.user;if(role)app.db.prepare('INSERT INTO staff_members VALUES (?,?)').run(this.user.id,role);return this;}
  };}
  const admin=await client().register('Admin','admin'),host=await client().register('Host'),renter=await client().register('Renter'),support=await client().register('Support','support');
  const fields={owner_id:host.user.id,name:'Admin managed garage',city:'Casablanca',area:'Centre',address:'Private gate 42',latitude:33.57,longitude:-7.58,hourly_cents:1000,monthly_cents:95000,height_cm:230,vehicle_size:'suv',covered:true,description:'A clear and accurate test garage description.'};
  async function garage(){const r=await admin.call('/staff/managed-garages',fields);assert.equal(r.status,200);return r.json.garage;}
  async function booking(gid){app.db.prepare("UPDATE garages SET status='approved' WHERE id=?").run(gid);const r=await renter.call('/reservations',{garage_id:gid,action:'book',mode:'hourly',units:1,starts_at:new Date(Date.now()+86400000).toISOString(),request_key:'admin-operation-booking-key'});assert.equal(r.status,201);return r.json.reservation;}
  return {app,admin,host,renter,support,anonymous:client(),base,fields,garage,booking};
}

test('admin operations enforce server role, CSRF and origin; output never exposes credentials',async t=>{
  const {app,admin,host,support,anonymous}=await setup(t);
  for(const path of ['/staff/overview','/staff/users','/staff/reservations']) {
    assert.equal((await anonymous.call(path)).status,401);
    assert.equal((await host.call(path)).status,403);
    assert.equal((await support.call(path)).status,403);
  }
  const data={name:'New User',email:'new@example.com',password};
  assert.equal((await admin.call('/staff/users',data,{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await admin.call('/staff/users',data,{Origin:'https://attacker.invalid'})).status,403);
  const list=await admin.call('/staff/users');assert.equal(list.status,200);assert.equal(list.json.users.length,4);
  assert.equal(JSON.stringify(list.json).includes('password'),false);
  app.db.prepare('DELETE FROM staff_members WHERE user_id=?').run(admin.user.id);
  assert.equal((await admin.call('/staff/overview')).status,403);
});

test('overview percentages and confirmed booking values match recorded all-time totals',async t=>{
  const {app,admin,garage,booking}=await setup(t);
  const empty=await admin.call('/staff/overview');assert.equal(empty.json.percentages.confirmed_bookings,0);
  const g=await garage(),r=await booking(g.id);await garage();
  let result=(await admin.call('/staff/overview')).json;
  assert.equal(result.counts.garages,2);assert.equal(result.counts.pending_garages,1);assert.equal(result.percentages.approved_garages,50);
  assert.equal(result.percentages.confirmed_bookings,100);assert.equal(result.confirmed_booking_value_cents,1000);assert.equal(result.payment_mode,'pay_on_arrival');
  app.db.prepare("UPDATE reservations SET status='cancelled' WHERE id=?").run(r.id);
  result=(await admin.call('/staff/overview')).json;assert.equal(result.percentages.cancelled_bookings,100);assert.equal(result.confirmed_booking_value_cents,0);
  assert.ok(result.recent_activity.some(row=>row.action==='admin_listing_created'));
});

test('account creation hashes credentials; edits and role changes are stale-safe and revoke sessions',async t=>{
  const {app,admin,host}=await setup(t);
  const created=await admin.call('/staff/users',{name:'Created User',email:'CREATED@example.com',password,role:'admin'});assert.equal(created.status,200);assert.equal(created.json.user.role,'customer');
  assert.equal(created.json.user.email,'created@example.com');assert.ok(await passwordMatches(password,app.db.prepare('SELECT password_hash FROM users WHERE id=?').get(created.json.user.id).password_hash));
  assert.equal((await admin.call('/staff/users',{name:'Duplicate User',email:'created@example.com',password})).status,409);
  assert.equal((await admin.call(`/staff/users/${host.user.id}/update`,{name:'Changed',email:'changed@example.com',expected_name:'Wrong',expected_email:host.user.email})).status,409);
  const changed=await admin.call(`/staff/users/${host.user.id}/update`,{name:'Changed',email:'changed@example.com',expected_name:host.user.name,expected_email:host.user.email});assert.equal(changed.status,200);
  assert.equal((await host.call('/host/garages')).status,401);
  const promoted=await admin.call(`/staff/users/${created.json.user.id}/role`,{role:'support',expected_role:'customer'});assert.equal(promoted.json.user.role,'support');
  assert.equal((await admin.call(`/staff/users/${created.json.user.id}/role`,{role:'admin',expected_role:'customer'})).status,409);
  assert.equal((await admin.call(`/staff/users/${admin.user.id}/role`,{role:'customer',expected_role:'admin'})).status,409);
  assert.equal((await admin.call(`/staff/users/${admin.user.id}/remove`,{expected_email:admin.user.email})).status,409);
});

test('account removal preserves records and only removes unused nonself accounts',async t=>{
  const {app,admin,host,renter,garage}=await setup(t);await garage();
  assert.equal((await admin.call(`/staff/users/${host.user.id}/remove`,{expected_email:host.user.email})).status,409);
  const removed=await admin.call(`/staff/users/${renter.user.id}/remove`,{expected_email:renter.user.email});assert.equal(removed.status,200);
  assert.equal(app.db.prepare('SELECT id FROM users WHERE id=?').get(renter.user.id),undefined);
  assert.equal((await renter.call('/reservations')).status,401);
  assert.ok(app.db.prepare("SELECT id FROM audit WHERE action='admin_account_removed' AND target_id=?").get(renter.user.id));
});

test('admin garage changes require valid data and review and protect existing bookings',async t=>{
  const {app,admin,fields,garage,booking}=await setup(t);
  assert.equal((await admin.call('/staff/managed-garages',{...fields,latitude:90})).status,422);
  const g=await garage();assert.equal(g.status,'pending');
  assert.equal((await admin.call(`/staff/managed-garages/${g.id}/update`,{...fields,expected_status:'approved'})).status,409);
  app.db.prepare("UPDATE garages SET status='approved' WHERE id=?").run(g.id);
  const changed=await admin.call(`/staff/managed-garages/${g.id}/update`,{...fields,name:'Edited Garage',expected_status:'approved'});assert.equal(changed.json.garage.status,'pending');
  await booking(g.id);
  assert.equal((await admin.call(`/staff/managed-garages/${g.id}/update`,{...fields,expected_status:'approved'})).status,409);
});

test('admin cancellation is stale-safe and preserves booking history',async t=>{
  const {app,admin,garage,booking}=await setup(t);const g=await garage(),r=await booking(g.id);
  const list=await admin.call('/staff/reservations?q=Admin%20managed');assert.equal(list.json.reservations[0].id,r.id);assert.equal(list.json.reservations[0].guest_email,'renter@example.com');
  assert.equal((await admin.call(`/staff/reservations/${r.id}/cancel`,{expected_updated_at:r.updated_at-1,reason:'Resolve host request'})).status,409);
  const cancelled=await admin.call(`/staff/reservations/${r.id}/cancel`,{expected_updated_at:r.updated_at,reason:'Resolve host request'});assert.equal(cancelled.status,200);assert.equal(cancelled.json.status,'cancelled');
  assert.ok(app.db.prepare('SELECT id FROM reservations WHERE id=?').get(r.id));
  const decision=app.db.prepare('SELECT * FROM admin_reservation_decisions WHERE reservation_id=?').get(r.id);
  assert.equal(decision.actor_id,admin.user.id);assert.equal(decision.reason,'Resolve host request');
  const recorded=(await admin.call('/staff/reservations')).json.reservations[0];
  assert.equal(recorded.last_cancel_reason,'Resolve host request');assert.ok(recorded.cancelled_at);
  assert.equal((await admin.call(`/staff/reservations/${r.id}/cancel`,{expected_updated_at:cancelled.json.updated_at,reason:'Again'})).status,409);
});


test('started bookings cannot be cancelled and historical ownership cannot be reassigned',async t=>{
  const {app,admin,renter,fields,garage,booking}=await setup(t);const g=await garage(),r=await booking(g.id);
  const now=Date.now();
  app.db.prepare('UPDATE reservations SET starts_at=?,ends_at=? WHERE id=?').run(now-3600000,now+3600000,r.id);
  assert.equal((await admin.call(`/staff/reservations/${r.id}/cancel`,{expected_updated_at:r.updated_at,reason:'Ongoing stay test'})).status,409);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM admin_reservation_decisions').get().n,0);
  app.db.prepare('UPDATE reservations SET starts_at=?,ends_at=? WHERE id=?').run(now-7200000,now-3600000,r.id);
  const change=await admin.call(`/staff/managed-garages/${g.id}/update`,{...fields,owner_id:renter.user.id,expected_status:'approved'});
  assert.equal(change.status,409);
  assert.equal(app.db.prepare('SELECT owner_id FROM garages WHERE id=?').get(g.id).owner_id,fields.owner_id);
});
