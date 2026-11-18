import test from 'node:test';
import assert from 'node:assert/strict';
import {makeApp} from '../server/app.mjs';
import {PUBLIC_POLICY_PAGES,publicPolicyConfig} from '../server/public-policies.mjs';

async function serve(t,legal={}) {
 const app=makeApp({database:':memory:',legal});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.db.close();});
 return `http://127.0.0.1:${app.server.address().port}`;
}

test('public legal metadata flags missing operator review and only exposes explicit safe settings',()=>{
 const empty=publicPolicyConfig({GOOGLE_CLIENT_SECRET:'fixture-not-a-real-secret',password:'not-public'});
 assert.equal(empty.review_required,true);assert.equal(empty.operator_ready,false);
 assert.equal(empty.operator_name,'');assert.equal(empty.contact_email,'');
 assert.deepEqual(empty.retention,{transaction_days:null,moderation_days:null,backup_days:null});
 assert.equal(JSON.stringify(empty).includes('fixture-not-a-real-secret'),false);
 assert.equal(JSON.stringify(empty).includes('not-public'),false);
 const complete=publicPolicyConfig({operatorName:'Fixture operator',contactEmail:'privacy@example.test',policyReviewed:true,transactionRetentionDays:365,moderationRetentionDays:'90',backupRetentionDays:30});
 assert.equal(complete.review_required,false);assert.equal(complete.operator_ready,true);
 assert.equal(complete.retention.moderation_days,90);
 for(const invalid of [-1,0,1.5,36501,'forever',{},true]) {
  assert.equal(publicPolicyConfig({transactionRetentionDays:invalid}).retention.transaction_days,null,String(invalid));
 }
 assert.equal(publicPolicyConfig({contactEmail:'javascript:alert(1)'}).contact_email,'');
 assert.equal(publicPolicyConfig({operatorName:'Name\nwith\rcontrols'}).operator_name,'Namewithcontrols');
});

test('privacy, deletion and community pages are publicly readable without creating a session',async t=>{
 const base=await serve(t);
 for(const [path,file] of Object.entries(PUBLIC_POLICY_PAGES)) {
  const response=await fetch(base+path);
  assert.equal(response.status,200,path);assert.match(response.headers.get('content-type'),/^text\/html/);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('set-cookie'),null);
  const html=await response.text();assert.match(html,/GarageShare/);assert.ok(html.includes(`data-policy="${file.slice(1,-5)}"`));assert.match(html,/policy\.js/);
 }
 const metadata=await fetch(base+'/api/legal');assert.equal(metadata.status,200);assert.equal(metadata.headers.get('set-cookie'),null);
 assert.equal((await metadata.json()).review_required,true);
 const script=await fetch(base+'/policy.js');assert.equal(script.status,200);const source=await script.text();
 assert.match(source,/textContent/);assert.match(source,/\/\?delete-account=1/);assert.match(source,/langCodes = \['en','fr','ar'\]/);
});
