// Isolated Chromium regression for ordinary-user safety and listing actions.
// NODE_PATH points to Playwright. BROWSER_EXECUTABLE selects installed Chromium.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp } from '../server/app.mjs';
import { id } from '../server/core.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const port=Number(process.env.UI_PORT||3043),origin=`http://127.0.0.1:${port}`;
const web=mkdtempSync(join(tmpdir(),'garage-user-actions-gui-'));
cpSync(join(project,'web'),web,{recursive:true});
const app=makeApp({database:':memory:',web,origin});
const password='Ordinary GUI test fixture password!';
const results=join(project,'test-results');
mkdirSync(results,{recursive:true});
await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(port,'127.0.0.1',resolve);});
let browser,currentPage;
const browserErrors=[];
function client(){return {cookie:'',csrf:'',user:null,async call(path,data){
 const response=await fetch(origin+'/api'+path,{method:data===undefined?'GET':'POST',headers:{Cookie:this.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':this.csrf},body:data===undefined?undefined:JSON.stringify(data)});
 if(response.headers.has('set-cookie'))this.cookie=response.headers.get('set-cookie').split(';')[0];
 const json=await response.json();if(json.csrf)this.csrf=json.csrf;
 assert.ok(response.ok,JSON.stringify(json));return json;
}};}
async function register(name){const account=client();await account.call('/session');account.user=(await account.call('/register',{name,email:name.toLowerCase()+'@example.test',password})).user;return account;}
async function openContext(account,language='en',width=390){
 const context=await browser.newContext({viewport:{width,height:844}});
 await context.addInitScript(value=>localStorage.setItem('garageshare-language',value),language);
 // Bundled map geometry can be reviewed without contacting an external tile provider.
 await context.route('https://tile.openstreetmap.org/**',route=>route.abort());
 await context.addCookies([{name:account.cookie.split('=')[0],value:account.cookie.split('=')[1],url:origin,httpOnly:true,sameSite:'Strict'}]);
 const page=await context.newPage();currentPage=page;
 page.on('pageerror',error=>browserErrors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 await page.goto(origin);await page.locator('.garage-card').first().waitFor();
 return {context,page};
}
async function closeSheet(page){const close=page.locator('[data-action=close-modal]');if(await close.count())await close.click();}
async function openListing(page){await page.locator('.card-image-button').first().click();await page.locator('.detail-description').waitFor();}
async function screenshot(page,name){const modal=await page.locator('.sheet').count();await page.screenshot({path:join(results,'user-actions-'+name+'.png'),fullPage:!modal});}
function fitsViewport(page){return page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);}

try{
 const host=await register('UserActionsHost'),renter=await register('UserActionsRenter');
 const garageId=id(),garageName='Garage test <img src=x> · مرآب التجربة';
 app.db.prepare('INSERT INTO garages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(garageId,host.user.id,garageName,'Casablanca','Maarif','Private synthetic entrance 42',33.57,-7.58,1200,95000,230,'suv',1,'An isolated listing for ordinary-user GUI regression testing.','/assets/garages/garage-01.webp','approved',Date.now());
 browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 // A host must not be offered an action which always rejects their own content.
 {
  const {context,page}=await openContext(host,'en',1440);await openListing(page);
  assert.equal(await page.locator('[data-action=safety-report][data-target-type=garage]').count(),0,'Own listing has no report action');
  assert.equal(await page.locator('img[src=x]').count(),0,'User-written listing title must remain plain text');
  await screenshot(page,'owner-no-self-report');await context.close();
 }
 // Blocking from a peer profile is reflected when the same listing is reopened.
 {
  const {context,page}=await openContext(renter);await openListing(page);
  await page.locator('[data-action=safety-profile]').click();await page.locator('.safety-content #sheet-title').waitFor();
  assert.equal(await page.locator('.safety-content [data-action=safety-profile]').count(),0,'A profile must not link back to itself');
  await page.locator('[data-action=safety-block]').click();await page.locator('.safety-block-row').waitFor();
  await closeSheet(page);await openListing(page);await page.locator('[data-action=safety-unblock]').waitFor();
  assert.equal(await page.locator('[data-action=safety-block]').count(),0,'Already blocked host must offer Unblock');
  await page.locator('[data-action=safety-unblock]').click({trial:true});await screenshot(page,'blocked-host-unblock');
  await context.close();
 }
 // A delayed response must not reopen a safety sheet the user already dismissed.
 {
  const {context,page}=await openContext(renter,'fr');await openListing(page);await page.locator('[data-action=safety-unblock]').waitFor();
  let release,markIntercepted,markContinued;
  const gate=new Promise(resolve=>{release=resolve;});
  const intercepted=new Promise(resolve=>{markIntercepted=resolve;});
  const continued=new Promise(resolve=>{markContinued=resolve;});
  await page.route('**/api/safety/profile/*',async route=>{markIntercepted();await gate;try{await route.continue();}finally{markContinued();}});
  await page.locator('[data-action=safety-profile]').click();await intercepted;
  await closeSheet(page);release();await continued;
  // Allow the released local request and the resulting render callback to settle.
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.sheet').count(),0,'Dismissed sheet must stay closed when profile response arrives');
  await screenshot(page,'dismissed-profile-stays-closed');await context.close();
 }
 // Reports clearly identify their target, and remain usable after a proxy error.
 for(const language of ['en','fr','ar']){
  for(const width of [390,1440]){
   const {context,page}=await openContext(renter,language,width);await openListing(page);
   await page.locator('[data-action=safety-report][data-target-type=garage]').click();
   const target=page.locator('[data-report-context]');await target.waitFor();
   const targetText=await target.innerText();assert.ok(targetText.includes(garageName),'Report context must show the target listing name');
   assert.ok(targetText.replace(garageName,'').trim().length>0,'Report context must also show a visible target-type label');
   assert.equal(await page.locator('img[src=x]').count(),0);
   const form=page.locator('#safety-report-form');await form.locator('[name=reason]').selectOption('other');
   await form.locator('[name=explanation]').fill('Relevant synthetic report context without private information.');
   await page.route('**/api/safety/reports',route=>route.fulfill({status:503,contentType:'text/html',body:'Temporary fixture proxy failure'}));
   await form.locator('[type=submit]').click();await form.locator('.form-error:not([hidden])').waitFor();
   assert.equal(await form.locator('[name=reason]').inputValue(),'other');
   assert.equal(await form.locator('[name=explanation]').inputValue(),'Relevant synthetic report context without private information.');
   assert.ok(await form.locator('[type=submit]').isEnabled(),'Failed reports remain retryable');
   assert.ok(await fitsViewport(page),'Report sheet fits desktop/mobile viewport');
   if(language==='ar')assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
   await screenshot(page,`report-${language}-${width}`);
   await closeSheet(page);await page.locator('[data-page=host]:visible').first().click();
   await page.locator('#host-list .empty').waitFor();await screenshot(page,`host-empty-${language}-${width}`);
   await page.locator('[data-action=host-form]').first().click();await page.locator('#host-form').waitFor();
   assert.ok(await fitsViewport(page),'Host form fits desktop/mobile viewport');
   await page.locator('#host-form [name=garage_photo]').scrollIntoViewIfNeeded();await screenshot(page,`host-photo-${language}-${width}`);
   await context.close();
  }
 }
 assert.deepEqual(browserErrors,[],'No uncaught browser errors');
 assert.equal(app.db.prepare('SELECT count(*) AS n FROM ugc_reports').get().n,0,'Simulated failed reports must not reach the database');
 console.log('PASS: owner self-report hidden; blocked listing offers Unblock; profile has no recursive link; dismissed slow profile stays closed; named report targets and retry retention; host empty/photo forms; EN/FR/AR mobile/desktop fit; no browser errors');
}catch(error){
 if(currentPage&&!currentPage.isClosed()){console.error(await currentPage.locator('body').innerText().catch(()=>''));await screenshot(currentPage,'failure').catch(()=>{});}
 throw error;
}finally{
 if(browser)await browser.close();
 const closed=new Promise(resolve=>app.server.close(resolve));app.server.closeAllConnections();await closed;
 app.db.close();rmSync(web,{recursive:true,force:true});
}
