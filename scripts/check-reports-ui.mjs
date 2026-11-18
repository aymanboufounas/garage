// Optional isolated browser QA. Install Playwright outside the checkout and set NODE_PATH.
import { createRequire } from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeApp} from '../server/app.mjs';
import {id} from '../server/core.mjs';
import {ugcModerationRoute,isContentRemoved} from '../server/ugc-moderation.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)),web=mkdtempSync(join(tmpdir(),'garage-report-qa-'));
cpSync(join(project,'web'),web,{recursive:true});
const port=Number(process.env.UI_PORT||3041),origin=`http://127.0.0.1:${port}`,password='Reports QA fixture password only 123!';
const app=makeApp({database:':memory:',web,origin});
await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
let browser,page;
try {
 function client(){return {cookie:'',csrf:'',async call(path,data){const response=await fetch(origin+'/api'+path,{method:data===undefined?'GET':'POST',headers:{Cookie:this.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':this.csrf},body:data===undefined?undefined:JSON.stringify(data)});if(response.headers.has('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];const json=await response.json();if(json.csrf)this.csrf=json.csrf;assert.ok(response.ok,JSON.stringify(json));return json;}};}
 async function user(name,role){const c=client();await c.call('/session');const result=await c.call('/register',{name,email:name.toLowerCase()+'@example.com',password});if(role)app.db.prepare('INSERT INTO staff_members VALUES (?,?)').run(result.user.id,role);return {client:c,user:result.user};}
 const host=await user('Host'),renter=await user('Renter'),admin=await user('Admin','admin');
 app.db.prepare('UPDATE users SET name=? WHERE id=?').run('GarageHost_'+ 'A'.repeat(60),host.user.id);
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
 page=await context.newPage();const errors=[],findings=[];page.on('pageerror',error=>errors.push(error.message));
 const resultDir=join(project,'test-results');mkdirSync(resultDir,{recursive:true});
 const check=(label,passed)=>{console.log((passed?'PASS ':'FAIL ')+label);if(!passed)findings.push(label);};
 const idle=()=>page.waitForFunction(()=>document.querySelector('#admin-view')?.getAttribute('aria-busy')==='false');
 async function mountLocale(code){
   await page.locator('#staff-language').selectOption(code);
   await idle();
 }
 async function select(id){await page.locator(`[data-report-action=open][data-id="${id}"]`).click();await idle();}
 await page.addInitScript(()=>localStorage.setItem('garageshare-language','en'));
 await page.goto(origin+'/admin.html');await page.locator('[data-admin-view=reports]').click();await page.locator('[data-reports-queue] [data-report-action=open]').first().waitFor();await idle();
 await select(first.id);
 const draft='Draft decision kept while inspecting this report.';
 await page.locator('#report-decision-form [name=note]').fill(draft);
 await page.locator('[data-report-action=refresh]').click();await idle();
 check('Draft note survives refreshing evidence',await page.locator('#report-decision-form [name=note]').inputValue()===draft);
 check('Active filter exposes pressed state',await page.locator('[data-report-action=status][data-status=pending]').getAttribute('aria-pressed')==='true');
 check('Decision errors are announced',await page.locator('#report-decision-form .form-error').getAttribute('role')==='alert');
 await page.keyboard.press('Tab');
 check('Keyboard reaches report reference after heading',await page.evaluate(()=>document.activeElement?.tagName==='SUMMARY'));
 await page.keyboard.press('Enter');
 check('Keyboard opens report reference',await page.locator('[data-reports-detail]>details').first().evaluate(element=>element.open));
 await page.keyboard.press('Enter');
 await page.screenshot({path:join(resultDir,'reports-gui-en-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await select(first.id);
 const position=await page.locator('[data-report-title]').boundingBox();
 const mobileHeader=await page.locator('.staff-header').boundingBox();
 check('Mobile selection keeps the full heading below the sticky header',position.y>=mobileHeader.y+mobileHeader.height+8&&position.y+position.height<=844);
 await page.screenshot({path:join(resultDir,'reports-gui-en-mobile-viewport.png')});
 await page.screenshot({path:join(resultDir,'reports-gui-en-mobile.png'),fullPage:true});
 // A failed filter must not leave pending cards under a different status selection.
 await page.setViewportSize({width:1400,height:1000});await mountLocale('en');
 await page.route('**/api/staff/reports?**',async route=>{
   if(new URL(route.request().url()).searchParams.get('status')==='resolved')await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Service unavailable. Please try again.'})});
   else await route.continue();
 });
 await page.locator('#reports-filter-form [name=status]').selectOption('resolved');
 await page.locator('#reports-filter-form [type=submit]').click();await idle();
 check('Failed filters clear stale rows',await page.locator('[data-reports-queue] [data-report-action=open]').count()===0);
 await page.screenshot({path:join(resultDir,'reports-gui-filter-error.png'),fullPage:true});
 await page.unroute('**/api/staff/reports?**');
 await page.locator('[data-report-action=retry]').click();await idle();
 check('Refreshing recovers from a failed filter',await page.locator('[data-reports-notice]').isHidden());
 // Review the rendered report in French and Arabic, at desktop and mobile widths.
 for(const code of ['fr','ar']){
   await page.setViewportSize({width:1400,height:1000});await mountLocale(code);await select(first.id);
   check(code+' report decision controls are labelled',await page.locator('#report-decision-form label').count()===2);
   await page.screenshot({path:join(resultDir,`reports-gui-${code}-desktop.png`),fullPage:true});
   await page.setViewportSize({width:390,height:844});await select(first.id);
   check(code+' mobile layout fits viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   const bounds=await page.locator('[data-report-title]').boundingBox(),header=await page.locator('.staff-header').boundingBox();check(code+' mobile detail clears sticky header',bounds.y>=header.y+header.height+8&&bounds.y+bounds.height<=844);
   await page.screenshot({path:join(resultDir,`reports-gui-${code}-mobile-viewport.png`)});
   await page.screenshot({path:join(resultDir,`reports-gui-${code}-mobile.png`),fullPage:true});
 }
 assert.deepEqual(errors,[],'GUI must not raise browser errors');
 assert.deepEqual(findings,[],'Reports GUI findings must be resolved');
 console.log('PASS reports GUI desktop/mobile EN/FR/AR: evidence, drafts, filter errors, recovery, focus and overflow');
} catch(error){if(page)console.error(await page.locator('body').innerText());throw error;}
finally{if(browser)await browser.close();const closed=new Promise(resolve=>app.server.close(resolve));app.server.closeAllConnections();await closed;app.db.close();rmSync(web,{recursive:true,force:true});}
