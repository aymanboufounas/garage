// Actual isolated browser regression for account and deletion navigation.
// Playwright is optional: set NODE_PATH and, if needed, BROWSER_EXECUTABLE.
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeApp} from '../server/app.mjs';
import {id} from '../server/core.mjs';
import {googleFixture} from '../test/helpers/google.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const web=mkdtempSync(join(tmpdir(),'garage-account-gui-'));
cpSync(join(project,'web'),web,{recursive:true});
const port=Number(process.env.UI_PORT||3040),origin=`http://127.0.0.1:${port}`;
const provider=googleFixture(),password='Account GUI fixture password 123!';
const app=makeApp({database:':memory:',web,origin,google:provider.config,googleFetch:provider.fetch});
await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(port,'127.0.0.1',resolve);});
let browser,currentPage;
const errors=[],results=join(project,'test-results');mkdirSync(results,{recursive:true});
async function register(name,email,role){
 let cookie='',csrf='';
 async function call(path,data){
  const response=await fetch(origin+'/api'+path,{method:data===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:data===undefined?undefined:JSON.stringify(data)});
  if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  const json=await response.json();if(json.csrf)csrf=json.csrf;assert.ok(response.ok,JSON.stringify(json));return json;
 }
 await call('/session');const {user}=await call('/register',{name,email,password});
 if(role)app.db.prepare('INSERT INTO staff_members VALUES (?,?)').run(user.id,role);
 return {user,cookie,call};
}
async function pageFor(client,lang='en',width=390){
 const context=await browser.newContext({viewport:{width,height:844}});
 await context.addInitScript(value=>{try{localStorage.setItem('garageshare-language',value);}catch{}},lang);
 await context.route('https://tile.openstreetmap.org/**',route=>route.abort());
 // Only the external provider's consent hop is simulated. The actual browser
 // redirects, state/cookies, server signature checks, proof and session rotation run.
 await context.route('https://accounts.google.com/o/oauth2/v2/auth**',async route=>{
  const callback=provider.authorize(route.request().url(),{sub:'account-gui-google',email:'gui.google@example.test',name:'Google GUI fixture'});
  await route.fulfill({status:302,headers:{location:callback.href},body:''});
 });
 if(client){const n=client.cookie.indexOf('=');await context.addCookies([{name:client.cookie.slice(0,n),value:client.cookie.slice(n+1),url:origin}]);}
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));currentPage=page;return page;
}
async function login(page,email){
 await page.locator('#auth-form [name=email]').fill(email);await page.locator('#auth-form [name=password]').fill(password);
 await page.locator('#auth-form [type=submit]').click();
}
async function screenshot(page,name){await page.screenshot({path:join(results,name+'.png')});}
try{
 browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const cancelled=await register('Cancelled GUI','gui.cancelled@example.test');
 const returning=await register('Returning GUI','gui.returning@example.test');
 const host=await register('Account GUI host','gui.host@example.test');
 const long=await register('GUI'+'A'.repeat(65),'gui.'+'a'.repeat(120)+'@example.test');
 const admin=await register('Account GUI admin','gui.admin@example.test','admin');
 const gid=id(),rid=id(),now=Date.now();
 app.db.prepare('INSERT INTO garages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(gid,host.user.id,'Account GUI parking','Casablanca','Centre','Private fixture entrance',33.57,-7.58,1200,95000,230,'suv',1,'An isolated GUI fixture.','/assets/garages/garage-01.webp','approved',now);
 app.db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,gid,long.user.id,'hourly',now+86400000,now+90000000,1,1200,'confirmed',null,now,now,id());

 const localePage=await pageFor(null);await localePage.goto(origin+'/?lang=ar');await localePage.waitForFunction(()=>document.documentElement.lang==='ar');
 await localePage.locator('#language').selectOption('fr');await localePage.waitForFunction(()=>document.documentElement.lang==='fr');
 assert.equal(new URL(localePage.url()).searchParams.get('lang'),'fr');await localePage.reload();await localePage.waitForFunction(()=>document.documentElement.lang==='fr');await localePage.context().close();
 console.log('PASS account GUI: changing an incoming URL language persists after reload');

 const page=await pageFor(null,'fr',320);await page.goto(origin+'/?delete-account=1&lang=fr');await page.locator('#auth-form').waitFor();
 await page.locator('#auth-form [name=email]').fill(cancelled.user.email);
 const policyLink=page.locator('#auth-form a[href^="/privacy-policy"]');assert.equal(await policyLink.getAttribute('target'),'_blank');
 const popupPromise=page.waitForEvent('popup');await policyLink.click();const popup=await popupPromise;await popup.locator('.policy-main h1').waitFor();assert.equal(await popup.locator('html').getAttribute('lang'),'fr');await popup.close();
 assert.equal(await page.locator('#auth-form [name=email]').inputValue(),cancelled.user.email,'Reading privacy preserves sign-in form');
 await page.keyboard.press('Escape');assert.equal(new URL(page.url()).searchParams.has('delete-account'),false);
 await page.locator('#avatar').click();await page.locator('[data-action=auth]').click();await login(page,cancelled.user.email);
 await page.waitForFunction(()=>!document.querySelector('#auth-form'));
 assert.equal(await page.locator('#account-deletion-form').count(),0,'Cancelled deletion cannot hijack a later normal sign-in');
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('garageshare-auth-intent')),null);
 console.log('PASS account GUI: full public policy opens without losing form; cancelled deletion stays cancelled after ordinary login');

 const race=await pageFor(null);await race.goto(origin+'/');await race.locator('#avatar').click();await race.locator('[data-action=auth]').click();
 let releaseLogin,loginStarted;const loginGate=new Promise(resolve=>{releaseLogin=resolve;}),started=new Promise(resolve=>{loginStarted=resolve;});
 await race.route('**/api/login',async route=>{loginStarted();await loginGate;await route.continue();});
 await login(race,cancelled.user.email);await started;await race.keyboard.press('Escape');
 await race.locator('.card-image-button').first().click();await race.locator('[data-action=book-form]').click();
 await race.locator('#auth-form [name=email]').fill(returning.user.email);
 const completed=race.waitForResponse(response=>response.url().endsWith('/api/login'));releaseLogin();await completed;
 await race.waitForFunction(()=>document.querySelector('#avatar')?.textContent.trim()==='C');
 assert.equal(await race.locator('#auth-form [name=email]').inputValue(),returning.user.email,'An older login cannot replace a newer flow or use its callback');
 assert.equal(await race.locator('#booking-form').count(),0);
 await race.context().close();
 console.log('PASS account GUI: delayed sign-in cannot close a newer dialog or resume its booking callback');

 const returnPage=await pageFor(null);await returnPage.goto(origin+'/?delete-account=1');await returnPage.locator('#auth-form').waitFor();
 await returnPage.locator('[data-action=auth-toggle]').click();assert.equal(await returnPage.locator('#auth-form').getAttribute('data-register'),'true');
 await returnPage.locator('[data-action=auth-toggle]').click();await login(returnPage,returning.user.email);await returnPage.locator('#account-deletion-form').waitFor();
 assert.equal(await returnPage.locator('[name=password]').count(),1,'Intended password sign-in resumes owner-verified deletion');
 await screenshot(returnPage,'account-gui-password-deletion');

 for(const lang of ['en','fr','ar'])for(const width of [320,1440]){
  const account=await pageFor(long,lang,width);await account.goto(origin+'/');await account.locator('#avatar').click();await account.locator('.account-menu').waitFor();
  assert.ok(await account.locator('.sheet').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Long name/email must wrap within modal');
  assert.equal(await account.locator('.account-menu [data-action=safety-guidelines]').count(),1);
  assert.equal(await account.locator('.account-menu a[href="/community-guidelines"]').count(),0,'One guidelines entry for signed-in users');
  await screenshot(account,`account-gui-profile-${lang}-${width}`);
  await account.locator('[data-action=safety-delete]').click();await account.locator('#account-deletion-form').waitFor();
  assert.equal(await account.locator('#account-deletion-form [type=submit]').isDisabled(),true);
  assert.equal(await account.locator('.safety-delete-help [data-page=trips]').count(),1);assert.equal(await account.locator('.safety-delete-help [data-page=support]').count(),1);
  assert.ok(await account.locator('.sheet').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  await screenshot(account,`account-gui-blocker-${lang}-${width}`);
  if(lang==='en'&&width===320){await account.locator('.safety-delete-help [data-page=trips]').click();await account.locator('#reservation-'+rid).waitFor();}
  await account.context().close();
 }
 const adminPage=await pageFor(admin);await adminPage.goto(origin+'/?delete-account=1');await adminPage.locator('#account-deletion-form').waitFor();
 assert.equal(await adminPage.locator('a[href="/admin.html#accounts"]').count(),1);assert.equal(await adminPage.locator('#account-deletion-form [type=submit]').isDisabled(),true);
 console.log('PASS account GUI: EN/FR/AR mobile/desktop long text, one rules entry, booking blocker links and last-admin guidance');

 const google=await pageFor(null,'ar');await google.goto(origin+'/?delete-account=1&lang=ar');await google.locator('.google-button[href]').waitFor();await google.locator('.google-button').click();
 await google.locator('#account-deletion-form').waitFor();assert.match(google.url(),/\/index\.html/);
 const googleId=app.db.prepare('SELECT id FROM users WHERE email=?').get('gui.google@example.test').id;
 assert.equal(await google.locator('#account-deletion-form [name=password]').count(),0);
 assert.equal(await google.locator('#account-deletion-form [type=submit]').isDisabled(),false,'OAuth redirect must return to fresh deletion form');
 app.db.prepare('UPDATE sessions SET created_at=? WHERE user_id=?').run(Date.now()-6*60000,googleId);
 // Freshness expires while the form is already open, rather than only before load.
 await google.locator('[name=confirmation]').fill('DELETE');await google.locator('[name=confirmed]').check();await google.locator('#account-deletion-form [type=submit]').click();
 await google.locator('.safety-delete-help .google-button[href]').waitFor();
 assert.equal(await google.locator('#account-deletion-form [type=submit]').isDisabled(),true,'Stale Google sign-in gets a useful reauthentication action');
 await screenshot(google,'account-gui-google-reauth-ar');
 await google.locator('.safety-delete-help .google-button').click();await google.locator('#account-deletion-form [type=submit]:enabled').waitFor();
 app.db.prepare('DELETE FROM sessions WHERE user_id=?').run(googleId);
 await google.locator('[name=confirmation]').fill('DELETE');await google.locator('[name=confirmed]').check();await google.locator('#account-deletion-form [type=submit]').click();
 await google.locator('#auth-form').waitFor();await google.locator('.google-button[href]').waitFor();
 assert.notEqual(app.db.prepare('SELECT state FROM user_account_state WHERE user_id=?').get(googleId)?.state,'deleted','A revoked session must not delete the account');
 await google.locator('.google-button').click();await google.locator('#account-deletion-form [type=submit]:enabled').waitFor();
 assert.equal(await google.locator('[name=confirmation]').inputValue(),'');assert.equal(await google.locator('[name=confirmed]').isChecked(),false,'Reauthentication does not reuse an old deletion confirmation');
 await google.locator('[name=confirmation]').fill('DELETE');await google.locator('[name=confirmed]').check();await google.locator('#account-deletion-form [type=submit]').click();
 await google.waitForFunction(()=>!document.querySelector('#account-deletion-form'));
 assert.equal(app.db.prepare('SELECT state FROM user_account_state WHERE user_id=?').get(googleId).state,'deleted');
 assert.equal(await google.evaluate(()=>sessionStorage.getItem('garageshare-auth-intent')),null);
 console.log('PASS account GUI: OAuth redirect resumes deletion, expired freshness and revoked sessions offer sign-in, a new explicit confirmation is required, owner deletion succeeds and clears intent');
 assert.deepEqual(errors,[]);
}catch(error){if(currentPage&&!currentPage.isClosed())console.error(await currentPage.locator('body').innerText());throw error;}
finally{if(browser)await browser.close();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.db.close();rmSync(web,{recursive:true,force:true});}
