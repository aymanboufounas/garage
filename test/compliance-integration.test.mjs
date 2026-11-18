import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { makeApp } from '../server/app.mjs';
import { id } from '../server/core.mjs';
import { googleFixture } from './helpers/google.mjs';

const origin = 'https://app.example.com';
const password = 'Compliance integration fixture password 123!';
const day = 86400000;
const listing = { name:'Compliance garage', city:'Nador', area:'Centre', address:'Private fixture entrance 42',
  latitude:35.168126, longitude:-2.929126, hourly_cents:1800, monthly_cents:95000,
  height_cm:230, vehicle_size:'suv', covered:true, description:'A garage used only by local integration fixtures.' };

async function setup(t, withGoogle = false) {
  const provider = withGoogle ? googleFixture() : null;
  const app = makeApp({ database:':memory:', origin, production:true,
    ...(provider ? { google:provider.config, googleFetch:provider.fetch } : {}) });
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{ app.server.closeAllConnections(); await new Promise(resolve=>app.server.close(resolve)); app.db.close(); });
  function client() {
    return { cookies:new Map(), csrf:'', user:null,
      cookie() { return [...this.cookies].map(([key,value])=>`${key}=${value}`).join('; '); },
      async call(path,data) {
        const response = await fetch(base+path,{ method:data===undefined?'GET':'POST',redirect:'manual',
          headers:{Cookie:this.cookie(),Origin:origin,...(data===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':this.csrf})},
          body:data===undefined?undefined:JSON.stringify(data) });
        for(const cookie of response.headers.getSetCookie()) {
          const pair=cookie.split(';')[0],separator=pair.indexOf('='),key=pair.slice(0,separator),value=pair.slice(separator+1);
          if(value)this.cookies.set(key,value);else this.cookies.delete(key);
        }
        const json=response.headers.get('content-type')?.includes('application/json')?await response.json():null;
        if(json?.csrf)this.csrf=json.csrf;
        return {status:response.status,json,headers:response.headers};
      },
      async register(name,role) {
        await this.call('/api/session');
        const result=await this.call('/api/register',{name,email:name.toLowerCase()+'@example.com',password});
        assert.equal(result.status,201);this.user=result.json.user;
        assert.equal((await this.call('/api/safety/guidelines/accept',{version:'2026-11-18',accepted:true})).status,200);
        if(role)app.db.prepare('INSERT INTO staff_members VALUES (?,?)').run(this.user.id,role);
        return this;
      }
    };
  }
  async function garage(host,name='Compliance garage') {
    const result=await host.call('/api/host/garages',{...listing,name});
    assert.equal(result.status,201);app.db.prepare("UPDATE garages SET status='approved' WHERE id=?").run(result.json.id);
    return result.json.id;
  }
  function period(days=2) { return {mode:'hourly',units:2,starts_at:new Date(Date.now()+days*day).toISOString(),request_key:id()}; }
  async function googleSignIn(browser) {
    await browser.call('/api/session');
    const prepared=await browser.call('/api/auth/google/start',{channel:'web'});assert.equal(prepared.status,200);
    const launch=await browser.call(prepared.json.url);assert.equal(launch.status,303);
    const callback=provider.authorize(launch.headers.get('location'));
    const approved=await browser.call(callback.pathname+callback.search);assert.equal(approved.status,303);
    const proof=approved.headers.get('location')?.match(/^\/index\.html#google=([a-f0-9]{64})$/)?.[1];assert.ok(proof);
    const finished=await browser.call('/api/auth/google/finish',{proof});assert.equal(finished.status,200);browser.user=finished.json.user;
    return browser;
  }
  return {app,base,client,garage,period,googleSignIn};
}

test('suspended owners can reauthenticate for notices, support and secure deletion while ordinary app writes remain denied',async t=>{
  const f=await setup(t),host=await f.client().register('SuspendedHost'),guest=await f.client().register('SuspensionGuest'),admin=await f.client().register('SuspensionAdmin','admin');
  const gid=await f.garage(host),booked=await guest.call('/api/reservations',{...f.period(),garage_id:gid,action:'book'});
  assert.equal(booked.status,201);const booking=booked.json.reservation;
  const conversation=`/api/chat/reservation/${booking.id}`;
  assert.equal((await host.call(conversation+'/send',{message:'A fixture message before suspension',request_key:id()})).status,200);
  const report=await guest.call('/api/safety/reports',{target_type:'user',target_id:host.user.id,reason:'harassment',request_key:id()});
  assert.equal(report.status,200);
  assert.equal((await admin.call(`/api/staff/reports/${report.json.report.id}/action`,{action:'suspend',expected_status:'pending',note:'Reviewed local fixture evidence.'})).status,200);
  assert.equal((await host.call('/api/host/garages')).status,401);
  await host.call('/api/session');
  const signed=await host.call('/api/login',{email:host.user.email,password});assert.equal(signed.status,200);
  assert.equal(signed.json.user.account_state,'suspended');assert.equal(signed.json.user.staff_role,undefined);
  assert.equal((await host.call('/api/session')).json.user.account_state,'suspended');
  assert.equal((await host.call('/api/host/garages')).status,403);
  assert.equal((await host.call('/api/host/garages',listing)).status,403);
  assert.equal((await host.call(conversation+'/send',{message:'Suspended message must fail',request_key:id()})).status,403);
  assert.equal((await host.call('/api/safety/notices')).json.notices[0].kind,'suspended');
  const opened=await host.call('/api/support/tickets',{category:'account',subject:'Account suspension appeal',message:'Please review my suspended test account.',request_key:id()});
  assert.equal(opened.status,200);assert.equal((await host.call('/api/support/tickets')).json.tickets.length,1);
  const status=await host.call('/api/account/deletion');assert.equal(status.status,200);assert.equal(status.json.can_delete,false);
  assert.ok(status.json.blockers.some(row=>row.code==='active_bookings'));
  assert.equal((await host.call('/api/account/delete',{confirmation:'DELETE',password})).status,409);
  assert.equal((await admin.call(`/api/staff/reservations/${booking.id}/cancel`,{expected_updated_at:booking.updated_at,reason:'Resolve fixture booking before owner deletion.'})).status,200);
  assert.equal((await host.call('/api/account/delete',{confirmation:'DELETE',password:'incorrect password'})).status,403);
  assert.equal((await host.call('/api/account/delete',{confirmation:'DELETE',password,user_id:guest.user.id})).status,422);
  assert.equal((await host.call('/api/account/delete',{confirmation:'DELETE',password})).json.deleted,true);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(host.user.id).n,0);
  assert.equal((await host.call('/api/account/deletion')).status,401);
  await host.call('/api/session');assert.equal((await host.call('/api/login',{email:host.user.email,password})).status,401);
  assert.equal(f.app.db.prepare('SELECT status FROM reservations WHERE id=?').get(booking.id).status,'cancelled');
  assert.equal((await guest.call('/api/session')).json.user.id,guest.user.id);
});

test('a block prevents new direct bookings, offer acceptance and the blocked quote without affecting another host or confirmed history',async t=>{
  const f=await setup(t),guest=await f.client().register('BlockedGuest'),hostA=await f.client().register('BlockedHost'),hostB=await f.client().register('OtherHost');
  const a=await f.garage(hostA,'Garage Alpha'),b=await f.garage(hostB,'Garage Beta');
  const confirmed=await guest.call('/api/reservations',{...f.period(2),garage_id:a,action:'book'});assert.equal(confirmed.status,201);
  const booking=confirmed.json.reservation,conversation=`/api/chat/reservation/${booking.id}`;
  assert.equal((await hostA.call(conversation+'/send',{message:'History remains visible after a block',request_key:id()})).status,200);
  const offer=await guest.call('/api/reservations',{...f.period(4),garage_id:a,action:'offer',total_cents:3000});assert.equal(offer.status,201);
  const deals=await guest.call('/api/deals',{...f.period(6),city:'Nador',garage_ids:[a,b],proposed_cents:3000});assert.equal(deals.status,200);
  const request=deals.json.request,qa=request.quotes.find(q=>q.garage_id===a),qb=request.quotes.find(q=>q.garage_id===b);
  assert.equal((await hostA.call(`/api/host/deals/${qa.id}/respond`,{action:'match'})).status,200);
  assert.equal((await guest.call('/api/safety/blocks',{user_id:hostA.user.id})).status,200);
  assert.equal((await guest.call('/api/reservations',{...f.period(8),garage_id:a,action:'book'})).status,403);
  assert.equal((await hostA.call(`/api/reservations/${offer.json.reservation.id}/accept`,{})).status,403);
  assert.equal((await hostA.call(`/api/reservations/${offer.json.reservation.id}/counter`,{total_cents:3200})).status,403);
  assert.equal((await hostA.call(`/api/host/deals/${qa.id}/respond`,{action:'match'})).status,403);
  assert.equal((await guest.call(`/api/deals/${request.id}/select`,{quote_id:qa.id,total_cents:3000})).status,403);
  assert.equal((await guest.call(conversation+'/send',{message:'New blocked message',request_key:id()})).status,403);
  assert.equal((await hostA.call(conversation+'/send',{message:'New message in opposite direction',request_key:id()})).status,403);
  const history=await guest.call(conversation);assert.equal(history.status,200);assert.equal(history.json.messages.length,1);assert.equal(history.json.conversation.writable,false);
  assert.equal((await guest.call(`/api/reservations/${booking.id}/arrival`)).status,200);
  assert.equal(f.app.db.prepare('SELECT status FROM reservations WHERE id=?').get(booking.id).status,'confirmed');
  assert.equal((await hostB.call(`/api/host/deals/${qb.id}/respond`,{action:'match'})).status,200);
  const selected=await guest.call(`/api/deals/${request.id}/select`,{quote_id:qb.id,total_cents:3000});assert.equal(selected.status,200);
  assert.equal(f.app.db.prepare('SELECT garage_id FROM reservations WHERE id=?').get(selected.json.reservation_id).garage_id,b);
  assert.equal((await guest.call(`/api/reservations/${offer.json.reservation.id}/cancel`,{})).status,200);
  assert.equal((await guest.call(`/api/safety/blocks/${hostA.user.id}/remove`,{})).status,200);
  assert.equal((await guest.call('/api/reservations',{...f.period(8),garage_id:a,action:'book'})).status,201);
});

test('Google-only account deletion over HTTP requires fresh provider sign-in and revokes the resulting session',async t=>{
  const f=await setup(t,true),browser=await f.googleSignIn(f.client()),uid=browser.user.id;
  assert.equal(browser.user.google_connected,true);
  const status=await browser.call('/api/account/deletion');assert.equal(status.status,200);assert.equal(status.json.requires_password,false);assert.equal(status.json.recent_sign_in,true);
  f.app.db.prepare('UPDATE sessions SET created_at=? WHERE user_id=?').run(Date.now()-6*60000,uid);
  assert.equal((await browser.call('/api/account/delete',{confirmation:'DELETE'})).status,401);
  assert.equal((await browser.call('/api/logout',{})).status,200);
  await f.googleSignIn(browser);assert.equal(browser.user.id,uid);
  const result=await browser.call('/api/account/delete',{confirmation:'DELETE'});assert.equal(result.status,200);assert.equal(result.json.deleted,true);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM google_identities WHERE user_id=?').get(uid).n,0);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(uid).n,0);
  assert.equal((await browser.call('/api/account/deletion')).status,401);
});

test('session revocation during an unfinished authenticated HTTP body prevents the pending write',async t=>{
  const f=await setup(t),host=await f.client().register('InflightHost');
  let observe;
  const observed=new Promise(resolve=>{observe=resolve;});
  f.app.server.on('request',req=>{
    if(req.method==='POST'&&req.url==='/api/host/garages')req.once('data',()=>{
      f.app.db.prepare('DELETE FROM sessions WHERE user_id=?').run(host.user.id);observe();
    });
  });
  const payload=JSON.stringify(listing),split=Math.floor(payload.length/2);
  let pending;
  const result=new Promise((resolve,reject)=>{
    pending=httpRequest(f.base+'/api/host/garages',{method:'POST',headers:{Cookie:host.cookie(),Origin:origin,
      'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),'X-CSRF-Token':host.csrf}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(Buffer.concat(chunks))}));
    });pending.on('error',reject);pending.write(payload.slice(0,split));
  });
  await observed;pending.end(payload.slice(split));
  assert.equal((await result).status,401);
  assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM garages WHERE owner_id=?').get(host.user.id).n,0);
  assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM audit WHERE actor_id=? AND action='listing_submitted'").get(host.user.id).n,0);
});
