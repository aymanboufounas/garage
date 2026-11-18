// Optional isolated public-policy GUI regression. No production data is used.
// Set NODE_PATH to Playwright, BROWSER_EXECUTABLE to Chromium if needed, and
// UI_PORT to an available local port (default 3042).
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeApp} from '../server/app.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const port=Number(process.env.UI_PORT||3042),origin=`http://127.0.0.1:${port}`;
assert.ok(Number.isInteger(port)&&port>0&&port<=65535,'UI_PORT must be a valid local port');
const results=join(project,'test-results/policy-gui');
const web=mkdtempSync(join(tmpdir(),'garage-policy-gui-'));
const languages=['en','fr','ar'];
const titles={
 'privacy-policy':['Privacy policy','Politique de confidentialité','سياسة الخصوصية'],
 'delete-account':['Delete your account','Supprimer votre compte','حذف حسابك'],
 'community-guidelines':['Community guidelines','Règles de la communauté','إرشادات المجتمع']
};
const navigation=['GarageShare policies','Documents GarageShare','سياسات GarageShare'];
let app,browser;
const errors=[],contrasts=[];
function monitor(page){page.on('pageerror',error=>errors.push(error.message));}
async function open(page,path){
 const response=await page.goto(origin+path);
 assert.equal(response.status(),200,path);
 await page.locator('#policy-main[aria-busy=false]').waitFor();
 await page.waitForLoadState('networkidle');
 return response;
}
async function noOverflow(page,label){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' must fit its viewport');}
async function screenshot(page,name){await page.screenshot({path:join(results,name+'.png')});}
function luminance(rgb){
 const values=rgb.match(/[\d.]+/g).slice(0,3).map(value=>Number(value)/255)
  .map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
 return values.reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
}
function contrast(first,second){const values=[luminance(first),luminance(second)].sort((a,b)=>b-a);return (values[0]+.05)/(values[1]+.05);}
try{
 cpSync(join(project,'web'),web,{recursive:true});mkdirSync(results,{recursive:true});
 // Missing legal metadata must stay visibly incomplete. No real identity,
 // approval flag or invented retention period is supplied to this fixture.
 app=makeApp({database:':memory:',web,origin,legal:{}});
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(port,'127.0.0.1',resolve);});
 browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(const [device,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:320,height:740}]]){
  const context=await browser.newContext({viewport,locale:'en-US'}),page=await context.newPage();monitor(page);
  for(const [slug,translations] of Object.entries(titles))for(const [index,lang] of languages.entries()){
   const label=`${device} ${slug} ${lang}`,response=await open(page,`/${slug}?lang=${lang}`);
   assert.equal(response.headers()['cache-control'],'no-store');assert.equal(response.headers()['set-cookie'],undefined);
   assert.equal(await page.locator('main h1').textContent(),translations[index],label);
   assert.equal(await page.locator('html').getAttribute('lang'),lang);
   assert.equal(await page.locator('html').getAttribute('dir'),lang==='ar'?'rtl':'ltr');
   assert.equal(await page.locator('.policy-footer nav').getAttribute('aria-label'),navigation[index]);
   assert.equal(await page.locator('.policy-review').count(),1,'Unconfigured legal information needs a review notice');
   assert.equal(await page.locator('.policy-contact a[href^="mailto:"]').count(),0);
   assert.equal(await page.locator('.policy-meta bdi').getAttribute('dir'),'ltr','Version identifiers must retain their order in RTL');
   assert.equal(await page.locator('tbody tr').count(),slug==='community-guidelines'?0:3);
   await noOverflow(page,label);await screenshot(page,`${device}-${slug}-${lang}`);
  }
  // The picker must replace a conflicting query parameter before a reload.
  await open(page,'/privacy-policy?lang=fr');await page.locator('#policy-language').selectOption('ar');
  assert.equal(new URL(page.url()).searchParams.get('lang'),'ar');
  assert.equal(await page.evaluate(()=>localStorage.getItem('garageshare-language')),'ar');
  await page.reload();await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('html').getAttribute('lang'),'ar','Language choice survives reloading a previously French URL');
  await context.close();
 }

 const context=await browser.newContext({viewport:{width:320,height:740},locale:'en-US'}),page=await context.newPage();monitor(page);
 for(const lang of languages){
  await open(page,'/delete-account?lang='+lang);
  assert.equal(await page.locator('a[href^="/?delete-account=1"]').getAttribute('href'),'/?delete-account=1&lang='+lang);
  assert.equal(await page.locator('.policy-header .brand').getAttribute('href'),'/?lang='+lang);
  for(const href of await page.locator('.policy-footer a').evaluateAll(links=>links.map(link=>link.href))){
   assert.equal(new URL(href).searchParams.get('lang'),lang);
   const response=await context.request.get(href);assert.equal(response.status(),200);assert.equal(response.headers()['set-cookie'],undefined);
  }
  await page.keyboard.press('Tab');assert.equal(await page.locator('.policy-skip').evaluate(element=>element===document.activeElement),true);
  const skip=await page.locator('.policy-skip').boundingBox();assert.ok(skip.y>=0,'Focused skip link must be visible');
  const outline=await page.locator('.policy-skip').evaluate(element=>getComputedStyle(element).outlineStyle);assert.notEqual(outline,'none');
  await screenshot(page,'mobile-keyboard-skip-'+lang);
  await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'policy-main','Skip link focuses main content');
  await page.locator('.policy-footer').scrollIntoViewIfNeeded();await screenshot(page,'mobile-footer-'+lang);
  const sizes=await page.locator('.policy-footer a,#policy-language,.policy-header .brand').evaluateAll(elements=>elements.map(element=>element.getBoundingClientRect().height));
  assert.ok(sizes.every(size=>size>=44),'Navigation controls need usable touch targets');
  const button=await page.locator('a.primary').evaluate(element=>({foreground:getComputedStyle(element).color,background:getComputedStyle(element).backgroundColor}));
  const meta=await page.locator('.policy-meta').evaluate(element=>({foreground:getComputedStyle(element).color,background:getComputedStyle(element.closest('main')).backgroundColor}));
  const buttonRatio=contrast(button.foreground,button.background),versionRatio=contrast(meta.foreground,meta.background);
  assert.ok(buttonRatio>=4.5,'Deletion link text contrast must be at least 4.5:1');
  assert.ok(versionRatio>=4.5,'Version text contrast must be at least 4.5:1');
  contrasts.push({language:lang,button:Number(buttonRatio.toFixed(2)),version:Number(versionRatio.toFixed(2))});
  await noOverflow(page,'Keyboard/footer '+lang);
 }

 // Synthetic response only: exercise long metadata and literal markup without
 // setting or approving any operator identity in the server configuration.
 const fixtureEmail='privacy'+'a'.repeat(80)+'@example.test';
 await page.route('**/api/legal',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({operator_name:'<img src=x onerror=alert(1)> '+'A'.repeat(170),contact_email:fixtureEmail,review_required:true,retention:{}})}));
 await open(page,'/privacy-policy?lang=ar');await page.locator('.policy-contact').scrollIntoViewIfNeeded();
 assert.equal(await page.locator('img[src=x]').count(),0);assert.equal(await page.locator('.policy-contact a').textContent(),fixtureEmail);
 await noOverflow(page,'Long contact metadata');await screenshot(page,'mobile-long-contact');
 await page.unroute('**/api/legal');
 await page.route('**/api/legal',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
 await open(page,'/delete-account?lang=fr');assert.match(await page.locator('.policy-review').innerText(),/indisponibles/);
 assert.equal(await page.locator('a[href^="/?delete-account=1"]').count(),1,'Metadata failure must not hide the deletion entry point');
 await noOverflow(page,'Unavailable metadata');await screenshot(page,'mobile-metadata-unavailable-fr');await context.close();

 // A direct Arabic public link must keep its language even if storage access
 // itself is denied. This exercises the actual app's validated ?lang handoff.
 const blocked=await browser.newContext({viewport:{width:390,height:844},locale:'en-US'});
 await blocked.addInitScript(()=>{Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Fixture storage unavailable','SecurityError');}});});
 await blocked.route('https://tile.openstreetmap.org/**',route=>route.abort());
 const handoff=await blocked.newPage();monitor(handoff);await open(handoff,'/delete-account?lang=ar');
 await handoff.locator('a[href^="/?delete-account=1"]').click();await handoff.locator('#auth-form').waitFor();
 assert.equal(await handoff.locator('html').getAttribute('lang'),'ar');assert.equal(await handoff.locator('html').getAttribute('dir'),'rtl');
 await noOverflow(handoff,'Storage-unavailable Arabic handoff');await screenshot(handoff,'mobile-ar-deletion-auth-storage-unavailable');await blocked.close();
 assert.deepEqual(errors,[],'Public pages and the app handoff must not throw page errors');
 console.log('PASS policy GUI: 18 EN/FR/AR desktop/mobile views; localized links and language reload; keyboard skip/focus; 44px targets; empty/failed/long safe metadata; no overflow/page errors; storage-unavailable Arabic app handoff. Computed contrasts: '+JSON.stringify(contrasts));
}finally{
 if(browser)await browser.close();
 if(app){if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));app.db.close();}
 rmSync(web,{recursive:true,force:true});
}
