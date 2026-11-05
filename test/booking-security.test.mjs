import test from 'node:test';
import assert from 'node:assert/strict';
import {makeApp} from '../server/app.mjs';
import {openDatabase,addCalendarMonths,interval,id} from '../server/core.mjs';

test('calendar-month billing clamps month ends and keeps Morocco wall time',()=>{
 assert.equal(new Date(addCalendarMonths(Date.parse('2027-01-31T09:00:00Z'),1)).toISOString(),'2027-02-28T09:00:00.000Z');
 assert.equal(new Date(addCalendarMonths(Date.parse('2028-01-31T09:00:00Z'),1)).toISOString(),'2028-02-29T09:00:00.000Z');
 assert.equal(new Date(addCalendarMonths(Date.parse('2026-12-15T09:00:00Z'),2)).toISOString().slice(0,10),'2027-02-15');
 const zone=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Casablanca',hour:'numeric',hourCycle:'h23'});
 const start=Date.parse('2027-01-20T09:00:00Z');
 assert.equal(zone.format(addCalendarMonths(start,3)),zone.format(start));
 assert.throws(()=>interval({mode:'hourly',units:-3,starts_at:new Date(Date.now()+86400000).toISOString()}));
 assert.throws(()=>interval({mode:'monthly',units:13,starts_at:new Date(Date.now()+86400000).toISOString()}));
 assert.throws(()=>interval({mode:'hourly',units:1,starts_at:'2027-02-31T10:00:00Z'}),/calendar/);
});

test('production requires HTTPS and authentication limits ignore forged proxy IP headers',async t=>{
 assert.throws(()=>makeApp({db:openDatabase(':memory:'),production:true,origin:'http://example.com'}),/HTTPS/);
 const db=openDatabase(':memory:'),app=makeApp({db,origin:'http://localhost'});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>app.server.close(r));db.close();});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const start=await fetch(base+'/api/session'),session=await start.json(),cookie=start.headers.get('set-cookie').split(';')[0];
 let last;
 for(let i=0;i<21;i++){
  last=await fetch(base+'/api/login',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json','X-CSRF-Token':session.csrf,Cookie:cookie,'X-Real-IP':`192.0.2.${i+1}`},body:JSON.stringify({email:`missing${i}@example.com`,password:'A deliberately incorrect password!'})});
  if(i<20)assert.equal(last.status,401);
 }
 assert.equal(last.status,429);
});

test('API protects accounts, prices, entrances, and booking state transitions',async t=>{
 const db=openDatabase(':memory:'),app=makeApp({db,origin:'http://localhost'});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));db.close();});
 function client(){
  return {cookie:'',csrf:'',async request(path,method='GET',body,headers={}){
   const res=await fetch(base+'/api'+path,{method,headers:{Cookie:this.cookie,Origin:'http://localhost',...(method==='POST'?{'Content-Type':'application/json','X-CSRF-Token':this.csrf}:{}),...headers},body:body?JSON.stringify(body):undefined});
   if(res.headers.get('set-cookie'))this.cookie=res.headers.get('set-cookie').split(';')[0];
   const result=await res.json();if(result.csrf)this.csrf=result.csrf;
   return {status:res.status,data:result,headers:res.headers};
  },async register(name){await this.request('/session');return this.request('/register','POST',{name,email:name.toLowerCase()+'@example.com',password:'A long secure test password!'});}};
 }
 const host=client(),guest=client(),other=client();
 await t.test('registration rotates session IDs and never exposes password hashes',async()=>{
  await host.request('/session');const before=host.cookie;
  const signed=await host.request('/register','POST',{name:'Host',email:'host@example.com',password:'A long secure test password!'});
  assert.equal(signed.status,201);assert.notEqual(host.cookie,before);assert.equal(signed.data.user.password_hash,undefined);
  const cookie=signed.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
  assert.equal((await guest.register('Guest')).status,201);assert.equal((await other.register('Other')).status,201);
 });
 let gid,guestReservation,offerId;
 const firstStart=Date.now()+10*86400000;
 const data=(offset=0)=>({garage_id:gid,starts_at:new Date(firstStart+offset).toISOString(),mode:'hourly',units:3,action:'book',total_cents:1,request_key:id()});
 await t.test('CSRF and foreign origins are rejected',async()=>{
  assert.equal((await host.request('/host/garages','POST',{}, {'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await host.request('/host/garages','POST',{}, {Origin:'https://evil.example'})).status,403);
  assert.equal((await host.request('/host/garages','POST',{}, {'X-CSRF-Token':'é'.repeat(64)})).status,403);
 });
 await t.test('host submissions require moderation and hide their entrance in public search',async()=>{
  const r=await host.request('/host/garages','POST',{name:'Private test garage',city:'Nador',area:'Centre',address:'Secret gate 147, private street',description:'A covered private garage with an entrance that fits an SUV.',latitude:35.1681234,longitude:-2.9291234,hourly_cents:1200,monthly_cents:95000,height_cm:220,vehicle_size:'suv',covered:true});
  assert.equal(r.status,201);gid=r.data.id;
  assert.equal((await guest.request('/garages')).data.garages.length,0);
  db.prepare("UPDATE garages SET status='approved' WHERE id=?").run(gid);
  const pub=(await guest.request('/garages')).data.garages[0];
  assert.equal(pub.address,undefined);assert.equal(pub.owner_id,undefined);assert.notEqual(pub.latitude,35.1681234);
  assert.equal(JSON.stringify(pub).includes('Secret gate'),false);
  assert.equal((await other.request('/host/garages')).data.garages.length,0);
 });
 await t.test('host cannot book their own garage',async()=>{assert.equal((await host.request('/reservations','POST',data())).status,409);});
 await t.test('simultaneous overlapping bookings yield one success and one conflict',async()=>{
  const [a,b]=await Promise.all([guest.request('/reservations','POST',data()),other.request('/reservations','POST',data())]);
  assert.deepEqual([a.status,b.status].sort(),[201,409]);
  const winner=a.status===201?a:b;guestReservation=winner.data.reservation;
  assert.equal(winner.data.reservation.total_cents,3600,'price must be computed by server');
  if(a.status!==201){const r=await guest.request('/reservations','POST',data(5*86400000));assert.equal(r.status,201);guestReservation=r.data.reservation;}
 });
 await t.test('duplicate request keys do not create extra reservations',async()=>{
  const value=data(20*86400000);const a=await guest.request('/reservations','POST',value),b=await guest.request('/reservations','POST',value);
  assert.equal(a.status,201);assert.equal(b.status,200);assert.equal(a.data.reservation.id,b.data.reservation.id);
 });
 await t.test('only the renter and the correct host see a reservation and exact entrance',async()=>{
  const r=(await guest.request('/reservations')).data.reservations.find(r=>r.id===guestReservation.id);
  assert.equal(r.address,'Secret gate 147, private street');
  const stranger=await other.request(`/reservations/${guestReservation.id}/cancel`,'POST',{});assert.equal(stranger.status,404);
  assert.equal((await other.request('/host/reservations')).data.reservations.length,0);
 });
 await t.test('pending offers hide access details; counters require guest consent',async()=>{
  const input={...data(40*86400000),action:'offer',total_cents:3000};
  let r=await guest.request('/reservations','POST',input);assert.equal(r.status,201);offerId=r.data.reservation.id;
  assert.equal((await guest.request('/reservations')).data.reservations.find(r=>r.id===offerId).address,undefined);
  assert.equal((await guest.request(`/reservations/${offerId}/accept`,'POST',{})).status,403);
  assert.equal((await other.request(`/reservations/${offerId}/counter`,'POST',{total_cents:3200})).status,404);
  assert.equal((await host.request(`/reservations/${offerId}/counter`,'POST',{total_cents:3200})).status,200);
  assert.equal((await host.request(`/reservations/${offerId}/accept`,'POST',{})).status,403);
  const accepted=await guest.request(`/reservations/${offerId}/accept`,'POST',{});assert.equal(accepted.status,200);assert.equal(accepted.data.reservation.total_cents,3200);assert.equal(accepted.data.reservation.status,'confirmed');
  assert.equal((await guest.request(`/reservations/${offerId}/accept`,'POST',{})).status,403);
 });
 await t.test('offer acceptance rechecks availability against intervening bookings',async()=>{
  const input={...data(60*86400000),action:'offer',total_cents:3000};
  const proposed=await guest.request('/reservations','POST',input);assert.equal(proposed.status,201);
  assert.equal((await other.request('/reservations','POST',data(60*86400000))).status,201);
  assert.equal((await host.request(`/reservations/${proposed.data.reservation.id}/accept`,'POST',{})).status,409);
 });
 await t.test('monthly price is distinct from hours and server controls the end date',async()=>{
  const result=await guest.request('/reservations','POST',{...data(90*86400000),mode:'monthly',units:2,ends_at:0,total_cents:1});
  assert.equal(result.status,201);assert.equal(result.data.reservation.total_cents,190000);
  assert.equal(result.data.reservation.ends_at,addCalendarMonths(result.data.reservation.starts_at,2));
 });
 await t.test('cancellation frees availability and removes access details',async()=>{
  const result=await guest.request(`/reservations/${guestReservation.id}/cancel`,'POST',{});assert.equal(result.status,200);
  assert.equal((await guest.request('/reservations')).data.reservations.find(r=>r.id===guestReservation.id).address,undefined);
  const available=await other.request('/reservations','POST',{...data(),starts_at:new Date(guestReservation.starts_at).toISOString()});assert.equal(available.status,201);
 });
 await t.test('expired offers cannot be accepted',async()=>{
  const proposed=await guest.request('/reservations','POST',{...data(200*86400000),action:'offer',total_cents:3000});assert.equal(proposed.status,201);
  db.prepare('UPDATE reservations SET expires_at=? WHERE id=?').run(Date.now()-1000,proposed.data.reservation.id);
  assert.equal((await host.request(`/reservations/${proposed.data.reservation.id}/accept`,'POST',{})).status,403);
 });
 await t.test('DB trigger independently rejects confirmed overlaps',()=>{
  const source=db.prepare("SELECT * FROM reservations WHERE status='confirmed' LIMIT 1").get();
  assert.throws(()=>db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id(),source.garage_id,source.guest_id,source.mode,source.starts_at,source.ends_at,source.units,source.total_cents,'confirmed',null,Date.now(),Date.now(),id()),/reservation_overlap/);
 });
 await t.test('responses include security headers and block access to server files',async()=>{
  const res=await fetch(base+'/server/schema.sql');assert.equal(res.status,404);
  assert.match(res.headers.get('content-security-policy'),/object-src 'none'/);
  assert.equal(res.headers.get('x-content-type-options'),'nosniff');
  assert.equal((await fetch(base+'/assets/%2e%2e%2f%2e%2e%2fserver/app.mjs')).status,404);
 });
 await t.test('logout revokes the session on the server',async()=>{
  const stolen=guest.cookie;assert.equal((await guest.request('/logout','POST',{})).status,200);
  guest.cookie=stolen;assert.equal((await guest.request('/reservations')).status,401);
 });
});
