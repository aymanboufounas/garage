import test from 'node:test';
import assert from 'node:assert/strict';
import {makeApp} from '../server/app.mjs';
import {id} from '../server/core.mjs';
import {GUIDELINES_VERSION,hasBlock,requireGuidelines,requireInteractionAllowed} from '../server/user-safety.mjs';

const ORIGIN='http://localhost';
const PASSWORD='Safety fixture password only 123!';
async function setup(t) {
 const app=makeApp({database:':memory:',origin:ORIGIN});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}/api`;
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.db.close();});
 function client() {
  return {cookie:'',csrf:'',user:null,
   async call(path,data,overrides={}) {
    const headers={Cookie:this.cookie,Origin:ORIGIN,...overrides};
    if(data!==undefined){headers['Content-Type']='application/json';headers['X-CSRF-Token']=overrides['X-CSRF-Token']??this.csrf;}
    const response=await fetch(base+path,{method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:JSON.stringify(data)});
    if(response.headers.has('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];
    const json=await response.json();if(json.csrf)this.csrf=json.csrf;
    return {status:response.status,json};
   },
   async register(name,accept=true) {
    await this.call('/session');const r=await this.call('/register',{name,email:name.toLowerCase()+'@example.com',password:PASSWORD});
    assert.equal(r.status,201);this.user=r.json.user;
    if(accept)assert.equal((await this.call('/safety/guidelines/accept',{version:GUIDELINES_VERSION,accepted:true})).status,200);
    return this;
   }
  };
 }
 const host=await client().register('Host'),renter=await client().register('Renter'),stranger=await client().register('Stranger');
 const garage=id(),booking=id(),now=Date.now();
 app.db.prepare('INSERT INTO garages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(garage,host.user.id,'Safety fixture garage','Casablanca','Centre','Private entrance 42',33.57,-7.58,1200,95000,220,'compact',1,'Garage for real participant authorization tests.','/assets/garage-placeholder.svg','approved',now);
 app.db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(booking,garage,renter.user.id,'hourly',now+86400000,now+90000000,1,1200,'confirmed',null,now,now,'safety-booking-fixture-123');
 return {app,host,renter,stranger,anonymous:client(),client,garage,booking};
}

test('users block and unblock only their own list; identity overrides and CSRF cannot modify it',async t=>{
 const {app,host,renter,stranger,anonymous}=await setup(t);
 assert.equal((await anonymous.call('/safety/blocks')).status,401);
 assert.equal((await host.call('/safety/blocks',{user_id:renter.user.id},{'X-CSRF-Token':'wrong'})).status,403);
 assert.equal((await host.call('/safety/blocks',{user_id:renter.user.id},{Origin:'https://attacker.invalid'})).status,403);
 assert.equal((await host.call('/safety/blocks',{user_id:renter.user.id,blocker_id:stranger.user.id})).status,403);
 assert.equal((await host.call('/safety/blocks',{user_id:host.user.id})).status,422);
 assert.equal((await host.call('/safety/blocks',{user_id:stranger.user.id})).status,404,'unknown private account cannot be enumerated');
 assert.equal((await host.call('/safety/blocks',{user_id:renter.user.id})).status,200);
 assert.equal((await host.call('/safety/blocks',{user_id:renter.user.id})).status,200,'duplicate block is idempotent');
 const list=await host.call('/safety/blocks');assert.equal(list.json.blocked_users.length,1);
 assert.deepEqual(Object.keys(list.json.blocked_users[0]).sort(),['created_at','id','name']);
 assert.equal((await renter.call('/safety/blocks')).json.blocked_users.length,0);
 await stranger.call(`/safety/blocks/${renter.user.id}/remove`,{});
 assert.equal(hasBlock(app.db,host.user.id,renter.user.id),true,'another account cannot remove the host block');
 assert.equal((await host.call(`/safety/blocks/${renter.user.id}/remove`,{})).status,200);
 assert.equal(hasBlock(app.db,host.user.id,renter.user.id),false);
 assert.equal(app.db.prepare("SELECT count(*) AS n FROM audit WHERE action='user_blocked'").get().n,1);
});

test('blocking stops both directions of new messages and retries, retains read history and booking information, then unblocks',async t=>{
 const {app,host,renter,booking}=await setup(t);
 const path=`/chat/reservation/${booking}`;
 const original={message:'What time will you arrive at the garage?',request_key:'safety-message-first-123'};
 assert.equal((await host.call(path+'/send',original)).status,200);
 await host.call('/safety/blocks',{user_id:renter.user.id});
 assert.equal((await renter.call(path+'/send',{message:'I will arrive at noon.',request_key:'safety-message-second-123'})).status,403);
 assert.equal((await host.call(path+'/send',original)).status,403,'a cached send retry is still blocked');
 const conversation=await renter.call(path);assert.equal(conversation.status,200);assert.equal(conversation.json.messages.length,1);
 assert.equal(conversation.json.conversation.writable,false);assert.equal(conversation.json.conversation.peer_id,host.user.id);
 assert.equal(conversation.json.conversation.interaction_blocked,true);
 assert.equal(conversation.json.conversation.blocked_by_you,false,'the response does not invent an own block');
 const ownView=await host.call(path);assert.equal(ownView.json.conversation.blocked_by_you,true);
 assert.equal((await renter.call(`/reservations/${booking}/arrival`)).status,200,'confirmed renter retains transactional entrance access');
 assert.equal(app.db.prepare('SELECT status FROM reservations WHERE id=?').get(booking).status,'confirmed');
 await host.call(`/safety/blocks/${renter.user.id}/remove`,{});
 assert.equal((await renter.call(path+'/send',{message:'I will arrive at noon.',request_key:'safety-message-second-123'})).status,200);
 assert.equal((await renter.call(path)).json.conversation.writable,true);
 app.db.prepare("INSERT INTO user_account_state(user_id,state,updated_at) VALUES (?,'suspended',?)").run(renter.user.id,Date.now());
 assert.equal((await host.call(path+'/send',{message:'A suspended peer cannot receive new chat.',request_key:'suspended-peer-message-123'})).status,403);
 assert.equal((await host.call(path)).json.conversation.writable,false);
 assert.equal(app.db.prepare('SELECT status FROM reservations WHERE id=?').get(booking).status,'confirmed');
});

test('each direction has its own block record and removing one does not remove the other',async t=>{
 const {app,host,renter}=await setup(t);
 await host.call('/safety/blocks',{user_id:renter.user.id});await renter.call('/safety/blocks',{user_id:host.user.id});
 await host.call(`/safety/blocks/${renter.user.id}/remove`,{});
 assert.equal(hasBlock(app.db,host.user.id,renter.user.id),true);
 assert.throws(()=>requireInteractionAllowed(app.db,host.user.id,renter.user.id),error=>error.status===403);
 assert.equal((await host.call('/safety/blocks')).json.blocked_users.length,0);
 assert.equal((await renter.call('/safety/blocks')).json.blocked_users.length,1);
 await renter.call(`/safety/blocks/${host.user.id}/remove`,{});
 assert.doesNotThrow(()=>requireInteractionAllowed(app.db,host.user.id,renter.user.id));
});

test('community guideline acceptance is explicit, current, scoped to the authenticated account and required for a new message',async t=>{
 const {app,host,renter,booking}=await setup(t);
 app.db.prepare('DELETE FROM user_guideline_acceptances WHERE user_id=?').run(host.user.id);
 assert.equal((await host.call('/safety/guidelines')).json.accepted,false);
 assert.throws(()=>requireGuidelines(app.db,host.user.id),error=>error.status===428);
 assert.equal((await host.call(`/chat/reservation/${booking}/send`,{message:'Checking the entrance size.',request_key:'guideline-message-fixture-123'})).status,428);
 assert.equal((await host.call('/safety/guidelines/accept',{version:'old',accepted:true})).status,422);
 assert.equal((await host.call('/safety/guidelines/accept',{version:GUIDELINES_VERSION,accepted:false})).status,422);
 assert.equal((await host.call('/safety/guidelines/accept',{version:GUIDELINES_VERSION,accepted:true,user_id:renter.user.id})).status,422);
 const acceptance=await host.call('/safety/guidelines/accept',{version:GUIDELINES_VERSION,accepted:true});assert.equal(acceptance.status,200);
 assert.equal((await host.call('/safety/guidelines/accept',{version:GUIDELINES_VERSION,accepted:true})).json.accepted_at,acceptance.json.accepted_at);
 assert.equal((await host.call(`/chat/reservation/${booking}/send`,{message:'Checking the entrance size.',request_key:'guideline-message-fixture-123'})).status,200);
});

test('profile safety actions disclose only a known peer identity and never private email',async t=>{
 const {host,renter,stranger}=await setup(t);
 const profile=await renter.call('/safety/profile/'+host.user.id);assert.equal(profile.status,200);
 assert.equal(profile.json.user.name,'Host');assert.equal(profile.json.user.email,undefined);
 assert.equal((await host.call('/safety/profile/'+stranger.user.id)).status,404);
 await renter.call('/safety/blocks',{user_id:host.user.id});
 assert.equal((await renter.call('/safety/profile/'+host.user.id)).json.user.blocked_by_you,true);
});

test('removed messages stay redacted in participant history, inbox previews and idempotent retries',async t=>{
 const {app,host,renter,stranger,booking}=await setup(t);
 const path=`/chat/reservation/${booking}`,data={message:'Reported content retained only for authorized moderation.',request_key:'reported-message-fixture-123'};
 const sent=await host.call(path+'/send',data);assert.equal(sent.status,200);
 const report=await renter.call('/safety/reports',{target_type:'message',target_id:String(sent.json.message.seq),reason:'harassment',request_key:'safety-report-fixture-123'});
 assert.equal(report.status,200);
 const reportId=report.json.report?.id||report.json.id;assert.ok(reportId);
 app.db.prepare("INSERT INTO staff_members(user_id,role) VALUES (?,'admin')").run(stranger.user.id);
 const action=await stranger.call(`/staff/reports/${reportId}/action`,{action:'remove_content',expected_status:'pending',note:'Confirmed inappropriate message.'});
 assert.equal(action.status,200);
 for(const actor of [host,renter]){
  const history=await actor.call(path);assert.equal(history.json.messages[0].removed,true);assert.equal(history.json.messages[0].message,'');
  const inbox=await actor.call('/chat');assert.equal(inbox.json.conversations[0].latest.removed,true);assert.equal(inbox.json.conversations[0].latest.message,'');
 }
 const repeated=await host.call(path+'/send',data);assert.equal(repeated.status,200);assert.equal(repeated.json.message.message,'');assert.equal(repeated.json.message.removed,true);
 const incremental=await renter.call(path+'?after='+sent.json.message.seq);
 assert.equal(incremental.json.messages.length,0);
 assert.deepEqual(incremental.json.removed_sequences,[sent.json.message.seq],'removal invalidates earlier cached content even when the after cursor has passed it');
 assert.equal((await stranger.call(path)).status,404,'administrator status does not grant unrestricted conversation access');
});
