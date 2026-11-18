// Optional isolated browser QA. Install Playwright outside the checkout and set NODE_PATH.
import { createRequire } from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeApp} from '../server/app.mjs';
import {id} from '../server/core.mjs';
import {ugcModerationRoute,isContentRemoved} from '../server/ugc-moderation.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),web=mkdtempSync(join(tmpdir(),'garage-report-qa-'));
cpSync(join(project,'web'),web,{recursive:true});
writeFileSync(join(web,'report-qa.html'),`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/admin.css"></head><body><main class="staff-main" id="report-qa"></main><script type="module" src="/report-qa.js"></script></body></html>`);
writeFileSync(join(web,'report-qa.js'),`import {mountReports} from '/admin-reports.js';import {api} from '/data.js';import {adminReportsCopy} from '/admin-reports-copy.js';import {translationCatalog} from '/i18n.js';Object.assign(translationCatalog,adminReportsCopy);await api('/session');mountReports(document.querySelector('#report-qa'),api);`);
const port=Number(process.env.UI_PORT||3031),origin=`http://127.0.0.1:${port}`,password='Reports QA fixture password only 123!';
const app=makeApp({database:':memory:',web,origin});
await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
let browser,page;
try {
 function client(){return {cookie:'',csrf:'',async call(path,data){const response=await fetch(origin+'/api'+path,{method:data===undefined?'GET':'POST',headers:{Cookie:this.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':this.csrf},body:data===undefined?undefined:JSON.stringify(data)});if(response.headers.has('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];const json=await response.json();if(json.csrf)this.csrf=json.csrf;assert.ok(response.ok,JSON.stringify(json));return json;}};}
 async function user(name,role){const c=client();await c.call('/session');const result=await c.call('/register',{name,email:name.toLowerCase()+'@example.com',password});if(role)app.db.prepare('INSERT INTO staff_members VALUES (?,?)').run(result.user.id,role);return {client:c,user:result.user};}
 const host=await user('Host'),renter=await user('Renter'),admin=await user('Admin','admin');
 const gid=id(),rid=id(),tid=id(),now=Date.now();
 app.db.prepare('INSERT INTO garages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(gid,host.user.id,'Garage report fixture','Casablanca','Centre','Private entrance 42',33.57,-7.58,1000,95000,230,'suv',1,'Fixture garage for report QA.','/assets/garage-placeholder.svg','approved',now);
 app.db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,gid,renter.user.id,'hourly',now+86400000,now+86400000+3600000,1,1000,'confirmed',null,now,now,id());
 app.db.prepare('INSERT INTO chat_threads VALUES (?,?,?,?,?,?)').run(tid,renter.user.id,host.user.id,rid,null,now);
 let reportedSeq;
 for(let index=0;index<11;index++){
   const seq=Number(app.db.prepare('INSERT INTO chat_messages(thread_id,sender_id,message,created_at,request_key) VALUES (?,?,?,?,?)').run(tid,index%2?renter.user.id:host.user.id,index===6?'Reported <img src=x onerror=alert(1)> message':'Nearby fixture message '+index,now+index,id()).lastInsertRowid);
   if(index===6)reportedSeq=seq;
 }
 const first=ugcModerationRoute(app.db,renter.user,'POST','/api/safety/reports',new URLSearchParams(),{target_type:'message',target_id:String(reportedSeq),reason:'harassment',explanation:'Please review this message.',request_key:id()}).report;
 // A larger fixture queue exercises the actual pagination state without production data.
 for(let n=0;n<26;n++){
   const message='Additional queue fixture '+n,createdAt=now+20+n;
   const seq=Number(app.db.prepare('INSERT INTO chat_messages(thread_id,sender_id,message,created_at,request_key) VALUES (?,?,?,?,?)').run(tid,host.user.id,message,createdAt,id()).lastInsertRowid);
   const snapshot={seq,message,sender_id:host.user.id,created_at:createdAt,thread_id:tid,context:[{seq,message,sender_id:host.user.id,created_at:createdAt}]};
   app.db.prepare(`INSERT INTO ugc_reports(id,reporter_id,target_type,target_id,subject_user_id,reason,explanation,status,evidence_json,created_at,updated_at,request_key)
 SELECT ?,reporter_id,target_type,?,subject_user_id,reason,explanation,status,?,created_at+?,updated_at,? FROM ugc_reports WHERE id=?`).run(id(),String(seq),JSON.stringify(snapshot),n+1,id(),first.id);
 }
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1400,height:1000}});
 const [cookieName,cookieValue]=admin.client.cookie.split('=');await context.addCookies([{name:cookieName,value:cookieValue,url:origin}]);
 page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>localStorage.setItem('garageshare-language','en'));
 await page.goto(origin+'/report-qa.html');await page.locator('[data-reports-queue] [data-report-action=open]').first().waitFor();
 assert.equal(await page.locator('[data-reports-queue] [data-report-action=open]').count(),25);
 assert.equal(await page.locator('[data-report-action=next]').isEnabled(),true);
 await page.locator('[data-report-action=next]').click();await page.getByText('Page 2',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-reports-queue] [data-report-action=open]').count(),2);
 assert.equal(await page.locator('[data-report-action=next]').isEnabled(),false);assert.equal(await page.locator('[data-report-action=previous]').isEnabled(),true);
 await page.locator('[data-report-action=previous]').click();await page.getByText('Page 1',{exact:true}).waitFor();
 await page.locator(`[data-report-action=open][data-id="${first.id}"]`).click();
 await page.locator('#report-decision-form').waitFor();assert.equal(await page.locator('.reports-message-context article').count(),7);
 assert.equal(await page.locator('img[src=x]').count(),0);assert.ok((await page.locator('.reports-message-context').innerText()).includes('Reported <img src=x onerror=alert(1)> message'));
 const decision=page.locator('#report-decision-form');await decision.locator('[name=action]').selectOption('remove_content');await decision.locator('[name=note]').fill('Removed after examining this reported message.');
 page.on('dialog',dialog=>dialog.accept());
 await page.route(`**/api/staff/reports/${first.id}/action`,route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Report changed. Refresh and try again.'})}));
 await decision.locator('[type=submit]').click();await decision.locator('.form-error:not([hidden])').waitFor();assert.equal(await decision.locator('[name=note]').inputValue(),'Removed after examining this reported message.');assert.equal(await decision.locator('[type=submit]').isEnabled(),true);
 await page.unroute(`**/api/staff/reports/${first.id}/action`);
 await decision.locator('[type=submit]').click();await page.getByText('Moderation decision recorded.',{exact:true}).waitFor();assert.equal(isContentRemoved(app.db,'message',String(reportedSeq)),true);
 await page.locator('#report-decision-form [name=action]').selectOption('restore_content');await page.locator('#report-decision-form [name=note]').fill('Restored after reviewing the context again.');await page.locator('#report-decision-form [type=submit]').click();
 await page.waitForFunction(()=>!document.querySelector('#report-decision-form'));assert.equal(isContentRemoved(app.db,'message',String(reportedSeq)),false);
 mkdirSync(join(project,'test-results'),{recursive:true});await page.screenshot({path:join(project,'test-results/reports-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(async()=>{const {setLanguage}=await import('/i18n.js');setLanguage('ar');const old=document.querySelector('#report-qa'),fresh=old.cloneNode(false);old.replaceWith(fresh);const {mountReports}=await import('/admin-reports.js');const {api}=await import('/data.js');mountReports(fresh,api);});
 await page.locator('[data-reports-queue] [data-report-action=open]').first().waitFor();assert.equal(await page.locator('html').getAttribute('dir'),'rtl');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:join(project,'test-results/reports-mobile-ar.png'),fullPage:true});assert.deepEqual(errors,[]);
 console.log('PASS reports browser: pagination, scoped/escaped evidence, retained decision note on error, remove/restore content, Arabic RTL/mobile, no page errors');
} catch(error){if(page)console.error(await page.locator('body').innerText());throw error;}
finally{if(browser)await browser.close();const closed=new Promise(resolve=>app.server.close(resolve));app.server.closeAllConnections();await closed;app.db.close();rmSync(web,{recursive:true,force:true});}
