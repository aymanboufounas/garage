// Optional browser QA: install Playwright outside the checkout, then set NODE_PATH.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync,mkdirSync} from 'node:fs';
import {makeApp} from '../server/app.mjs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const project=fileURLToPath(new URL('../',import.meta.url));
const web=mkdtempSync(join(tmpdir(),'garage-admin-web-'));cpSync(join(project,'web'),web,{recursive:true});
const port=Number(process.env.UI_PORT||3017),origin=`http://127.0.0.1:${port}`,password='Admin browser fixture password 123!';
const app=makeApp({database:':memory:',web,origin});
await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
let browser, page;
try {
 let cookie='',csrf='';
 async function call(path,data){const r=await fetch(origin+'/api'+path,{method:data?'POST':'GET',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:data?JSON.stringify(data):undefined});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const j=await r.json();if(j.csrf)csrf=j.csrf;assert.ok(r.ok,JSON.stringify(j));return j;}
 await call('/session');const host=await call('/register',{name:'Fixture owner',email:'owner@example.com',password});
 const listing=await call('/host/garages',{name:'Browser <img src=x> Garage',city:'Casablanca',area:'Centre',address:'Private entrance 42',latitude:33.57,longitude:-7.58,hourly_cents:1000,monthly_cents:95000,height_cm:230,vehicle_size:'suv',covered:true,description:'Garage listing for browser testing.'});
 await call('/logout',{}); await call('/session');const admin=await call('/register',{name:'Fixture admin',email:'admin@example.com',password});app.db.prepare("INSERT INTO staff_members(user_id,role) VALUES (?,'admin')").run(admin.user.id);
 browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:390,height:844}});await context.addInitScript(()=>localStorage.setItem('garageshare-language','en'));
 page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/admin.html');await page.locator('[name=email]').fill('admin@example.com');await page.locator('[name=password]').fill(password);await page.locator('#staff-login-form [type=submit]').click();
 await page.locator('.moderation-card').waitFor();assert.match(await page.locator('.moderation-card').innerText(),/Browser <img src=x> Garage/);assert.equal(await page.locator('img[src=x]').count(),0);
 await page.locator('[name=photo]').setInputFiles(join(project,'web/assets/garages/garage-01.webp'));await page.locator('.moderation-photo').waitFor({state:'visible'});
 assert.ok(await page.locator('.moderation-photo').evaluate(img=>img.complete&&img.naturalWidth>0));
 await page.locator('[name=confirmed]').check();await page.locator('.moderation-form [type=submit]').click();await page.getByText('Listing updated.',{exact:true}).waitFor();
 assert.equal(app.db.prepare('SELECT status FROM garages WHERE id=?').get(listing.id).status,'approved');
 await page.locator('#moderation-status').selectOption('approved');await page.locator('.moderation-card').waitFor();
 mkdirSync(join(project,'test-results'),{recursive:true});
 await page.screenshot({path:join(project,'test-results/admin-moderation.png'),fullPage:true});
 page.on('dialog',dialog=>dialog.accept());await page.locator('[data-mod-action=archive]').click();await page.getByText('Listing updated.',{exact:true}).waitFor();
 assert.equal(app.db.prepare('SELECT status FROM garages WHERE id=?').get(listing.id).status,'archived');
 // Changing language rebuilds both dashboard sections without exposing template keys.
 await page.locator('#staff-language').selectOption('ar');await page.locator('#moderation-status').waitFor();assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 console.log('PASS: admin sign-in, escaped listing text, image preview/re-encoding/upload, approval, archive, Arabic RTL, mobile layout, no browser errors');
} catch(error) { console.log(await page?.locator('body').innerText()); console.log(await page?.evaluate(()=>document.querySelector('#moderation-notice')?.textContent)); throw error; } finally {if(browser)await browser.close();await new Promise(r=>app.server.close(r));app.db.close();rmSync(web,{recursive:true,force:true});}
