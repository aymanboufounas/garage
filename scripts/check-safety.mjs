// Optional isolated live-app safety QA. No production database or user data is used.
// Set NODE_PATH to Playwright and BROWSER_EXECUTABLE to an installed Chromium.
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeApp} from '../server/app.mjs';
import {id} from '../server/core.mjs';
import {isContentRemoved} from '../server/ugc-moderation.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const web=mkdtempSync(join(tmpdir(),'garage-safety-qa-'));
cpSync(join(project,'web'),web,{recursive:true});
const port=Number(process.env.UI_PORT||3032),origin=`http://127.0.0.1:${port}`;
const password='Safety browser fixture password 123!';
const app=makeApp({database:':memory:',web,origin});
await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(port,'127.0.0.1',resolve);});
let browser,page,adminPage,deletePage;
const errors=[];
function apiClient(){return {cookie:'',csrf:'',user:null,async call(path,data){
 const response=await fetch(origin+'/api'+path,{method:data===undefined?'GET':'POST',headers:{Cookie:this.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':this.csrf},body:data===undefined?undefined:JSON.stringify(data)});
 if(response.headers.has('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];
 const json=await response.json();if(json.csrf)this.csrf=json.csrf;
 return {status:response.status,json};
}};}
async function register(name,role){const client=apiClient();await client.call('/session');const result=await client.call('/register',{name,email:name.toLowerCase()+'@example.test',password});assert.equal(result.status,201,JSON.stringify(result.json));client.user=result.json.user;if(role)app.db.prepare('INSERT INTO staff_members VALUES (?,?)').run(client.user.id,role);return client;}
async function contextFor(client){
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.addInitScript(()=>{if(!localStorage.getItem('garageshare-language'))localStorage.setItem('garageshare-language','en');});
 // Test local layouts without relying on an external tile provider.
 await context.route('https://tile.openstreetmap.org/**',route=>route.abort());
 const separator=client.cookie.indexOf('=');
 await context.addCookies([{name:client.cookie.slice(0,separator),value:client.cookie.slice(separator+1),url:origin,httpOnly:true,sameSite:'Strict'}]);
 return context;
}
function monitor(target){target.on('pageerror',error=>errors.push(error.message));target.on('dialog',dialog=>dialog.accept());}
async function closeSheet(target){const button=target.locator('[data-action="close-modal"]');if(await button.count())await button.click();}
async function bookingChat(target,booking){await closeSheet(target);await target.locator('.bottom-nav [data-page="trips"]').click();await target.locator(`[data-action="chat-open"][data-id="${booking}"]`).click();await target.locator('#chat-form').waitFor();}
try {
 const host=await register('SafetyHost'),renter=await register('SafetyRenter'),admin=await register('SafetyAdmin','admin'),unused=await register('SafetyUnused');
 assert.equal((await host.call('/safety/guidelines/accept',{version:'2026-11-18',accepted:true})).status,200);
 const gid=id(),rid=id(),now=Date.now();
 app.db.prepare('INSERT INTO garages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(gid,host.user.id,'Safety browser garage','Casablanca','Centre','Private fixture entrance 42',33.57,-7.58,1200,95000,230,'suv',1,'Isolated fixture listing for safety browser checks.','/assets/garages/garage-01.webp','approved',now);
 app.db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,gid,renter.user.id,'hourly',now+86400000,now+90000000,1,1200,'confirmed',null,now,now,id());
 browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const renterContext=await contextFor(renter);page=await renterContext.newPage();monitor(page);await page.goto(origin+'/');
 await bookingChat(page,rid);
 assert.equal(await page.locator('#chat-form').evaluate(form=>form.reportValidity()),false,'Message and guideline consent are required');
 await page.locator('#chat-form [name=message]').fill('I plan to arrive at noon. Is the garage entrance open?');
 assert.equal(await page.locator('#chat-form').evaluate(form=>form.reportValidity()),false,'Consent cannot be omitted');
 await page.locator('#chat-form [name=guidelines_accepted]').check();
 await page.locator('#chat-form [type=submit]').click();await page.getByText('I plan to arrive at noon. Is the garage entrance open?',{exact:true}).waitFor();
 assert.ok(app.db.prepare('SELECT 1 FROM user_guideline_acceptances WHERE user_id=?').get(renter.user.id));
 const incoming=await host.call(`/chat/reservation/${rid}/send`,{message:'Reported message from the host, for this isolated safety test.',request_key:id()});assert.equal(incoming.status,200);
 const seq=incoming.json.message.seq;
 await page.locator('[data-action=chat-refresh]').click();await page.locator(`.chat-message[data-seq="${seq}"]`).waitFor();
 await page.locator(`.chat-message[data-seq="${seq}"] [data-action=safety-report]`).click();
 await page.locator('#safety-report-form [name=reason]').selectOption('harassment');await page.locator('#safety-report-form [name=explanation]').fill('Please review the reported message in this fixture.');
 await page.locator('#safety-report-form [type=submit]').click();await page.getByText('Your report was sent to the moderation team.',{exact:true}).waitFor();
 const messageReport=app.db.prepare("SELECT * FROM ugc_reports WHERE target_type='message' AND target_id=?").get(String(seq));assert.equal(messageReport.reporter_id,renter.user.id);assert.equal(messageReport.status,'pending');
 await bookingChat(page,rid);await page.locator('[data-action=safety-profile]').click();await page.locator('[data-action=safety-block]').click();await page.locator('.safety-block-row').waitFor();
 assert.equal(app.db.prepare('SELECT count(*) AS n FROM user_blocks WHERE blocker_id=? AND blocked_id=?').get(renter.user.id,host.user.id).n,1);
 const refused=await host.call(`/chat/reservation/${rid}/send`,{message:'This blocked send must not be stored.',request_key:id()});assert.equal(refused.status,403);
 assert.equal((await renter.call(`/reservations/${rid}/arrival`)).status,200);assert.equal(app.db.prepare('SELECT status FROM reservations WHERE id=?').get(rid).status,'confirmed');
 mkdirSync(join(project,'test-results'),{recursive:true});await page.screenshot({path:join(project,'test-results/safety-blocked-users.png'),fullPage:true});
 await page.locator('.safety-block-row [data-action=safety-unblock]').click();await page.getByText('You have not blocked anyone.',{exact:true}).waitFor();
 const allowed=await host.call(`/chat/reservation/${rid}/send`,{message:'Messaging works again after unblocking.',request_key:id()});assert.equal(allowed.status,200);
 await closeSheet(page);await page.locator('.bottom-nav [data-page=explore]').click();await page.locator('.card-image-button').first().click();await page.locator('[data-action=safety-report][data-target-type=garage]').click();
 await page.locator('#safety-report-form [name=reason]').selectOption('misleading');await page.locator('#safety-report-form [type=submit]').click();await page.getByText('Your report was sent to the moderation team.',{exact:true}).waitFor();
 assert.ok(app.db.prepare("SELECT id FROM ugc_reports WHERE target_type='garage' AND target_id=?").get(gid));
 assert.equal((await renter.call('/staff/reports')).status,403,'Ordinary user cannot access moderation evidence');
 await bookingChat(page,rid);await page.locator(`.chat-message[data-seq="${seq}"]`).waitFor();
 const adminContext=await contextFor(admin);adminPage=await adminContext.newPage();monitor(adminPage);await adminPage.goto(origin+'/admin.html#reports');
 await adminPage.locator(`[data-report-action=open][data-id="${messageReport.id}"]`).click();await adminPage.locator('#report-decision-form').waitFor();
 await adminPage.locator('#report-decision-form [name=action]').selectOption('remove_content');await adminPage.locator('#report-decision-form [name=note]').fill('The reported fixture message is inappropriate and has been reviewed.');await adminPage.locator('#report-decision-form [type=submit]').click();await adminPage.getByText('Moderation decision recorded.',{exact:true}).waitFor();
 assert.equal(isContentRemoved(app.db,'message',seq),true);
 await page.locator('[data-action=chat-refresh]').click();await page.waitForFunction(sequence=>document.querySelector(`.chat-message[data-seq="${sequence}"] p`)?.textContent==='This message was removed by moderation.',seq);
 assert.equal(await page.locator(`.chat-message[data-seq="${seq}"] [data-action=safety-report]`).count(),0);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(project,'test-results/safety-chat-mobile.png'),fullPage:true});
 await page.evaluate(()=>localStorage.setItem('garageshare-language','ar'));await page.reload();await bookingChat(page,rid);assert.equal(await page.locator('html').getAttribute('dir'),'rtl');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(project,'test-results/safety-chat-ar.png'),fullPage:true});
 const deleteContext=await contextFor(unused);deletePage=await deleteContext.newPage();monitor(deletePage);await deletePage.goto(origin+'/?delete-account=1');await deletePage.locator('#account-deletion-form').waitFor();
 await deletePage.locator('[name=confirmation]').fill('DELETE');await deletePage.locator('[name=password]').fill('Wrong fixture password 123!');await deletePage.locator('[name=confirmed]').check();await deletePage.locator('#account-deletion-form [type=submit]').click();await deletePage.locator('#account-deletion-form .form-error').waitFor({state:'visible'});
 assert.equal(app.db.prepare('SELECT email FROM users WHERE id=?').get(unused.user.id).email,unused.user.email,'Wrong password must preserve the real account');
 await deletePage.screenshot({path:join(project,'test-results/safety-delete-form.png'),fullPage:true});
 await deletePage.locator('[name=password]').fill(password);await deletePage.locator('#account-deletion-form [type=submit]').click();await deletePage.getByText('Your account has been deleted and you are signed out.',{exact:true}).waitFor();
 assert.equal(app.db.prepare('SELECT state FROM user_account_state WHERE user_id=?').get(unused.user.id).state,'deleted');const scrubbed=app.db.prepare('SELECT * FROM users WHERE id=?').get(unused.user.id);assert.equal(scrubbed.name,'Deleted account');assert.notEqual(scrubbed.email,unused.user.email);assert.equal(scrubbed.password_hash,'');assert.equal(app.db.prepare('SELECT count(*) AS n FROM sessions WHERE user_id=?').get(unused.user.id).n,0);
 assert.equal((await unused.call('/session')).json.user,null);
 assert.deepEqual(errors,[]);
 console.log('PASS: ordinary user accepts guidelines and sends, reports message/listing, blocks via peer profile, blocked host send denied with booking/arrival preserved, unblock restores send, admin removes reported message, cached chat redacts removal, owner deletion rejects wrong password then scrubs/signs out, mobile EN/AR fit and no page errors');
} catch(error) {console.error(await page?.locator('body').innerText());if(deletePage)console.error(await deletePage.locator('body').innerText());throw error;}
finally {if(browser)await browser.close();await new Promise(resolve=>app.server.close(resolve));app.db.close();rmSync(web,{recursive:true,force:true});}
