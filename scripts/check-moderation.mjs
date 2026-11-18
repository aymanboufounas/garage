// Optional browser QA: install Playwright outside the checkout, then set NODE_PATH.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { makeApp } from '../server/app.mjs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const project=fileURLToPath(new URL('../',import.meta.url));
const web=mkdtempSync(join(tmpdir(),'garage-admin-web-'));cpSync(join(project,'web'),web,{recursive:true});
const port=Number(process.env.UI_PORT||3017),origin=`http://127.0.0.1:${port}`,password='Admin browser fixture password 123!';
const app=makeApp({database:':memory:',web,origin});
await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
let browser,page;
function client(){
 let cookie='',csrf='';
 return {async call(path,data){
   const r=await fetch(origin+'/api'+path,{method:data?'POST':'GET',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:data?JSON.stringify(data):undefined});
   if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
   const j=await r.json();if(j.csrf)csrf=j.csrf;assert.ok(r.ok,JSON.stringify(j));return j;
 }};
}
try {
 const host=client();await host.call('/session');await host.call('/register',{name:'Fixture owner',email:'owner@example.com',password});
 const fields={name:'Browser <img src=x> Garage',city:'Casablanca',area:'Centre',address:'Private entrance 42',latitude:33.57,longitude:-7.58,hourly_cents:1000,monthly_cents:95000,height_cm:230,vehicle_size:'suv',covered:true,description:'Garage listing for browser testing.'};
 // Existing listings can be pending without a photo. They must not be approvable.
 const missingPhoto=await host.call('/host/garages',{...fields,name:'Waiting for host photo'});
 const photo_base64=readFileSync(join(project,'web/assets/garages/garage-01.webp')).toString('base64');
 const listing=await host.call('/host/garages',{...fields,photo_base64});
 assert.match(listing.image,/^\/assets\/host-photos\/[a-f0-9]{32}\.webp$/);
 const admin=client();await admin.call('/session');const account=await admin.call('/register',{name:'Fixture admin',email:'admin@example.com',password});
 app.db.prepare("INSERT INTO staff_members(user_id,role) VALUES (?,'admin')").run(account.user.id);
 browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:390,height:844}});await context.addInitScript(()=>localStorage.setItem('garageshare-language','en'));
 page=await context.newPage();const errors=[],approvalBodies=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('request',request=>{if(request.method()==='POST'&&/\/staff\/garages\/[a-f0-9]{32}\/approve$/.test(new URL(request.url()).pathname))approvalBodies.push(request.postDataJSON());});
 await page.goto(origin+'/admin.html');await page.locator('[name=email]').fill('admin@example.com');await page.locator('[name=password]').fill(password);await page.locator('#staff-login-form [type=submit]').click();
 await page.locator('[data-admin-view=garages]').click();await page.locator('.moderation-card').waitFor();
 await page.locator(`[data-mod-action=select][data-id="${missingPhoto.id}"]`).click();
 assert.equal(await page.locator('input[type=file]').count(),0);
 assert.equal(await page.locator('.moderation-form [type=submit]').isDisabled(),true);
 assert.equal(await page.locator('[data-mod-action=reject]').isEnabled(),true);
 await page.getByText('Waiting for the host to upload a garage photo. Approval is unavailable until a photo is submitted.',{exact:true}).waitFor();
 await page.locator(`[data-mod-action=select][data-id="${listing.id}"]`).click();
 assert.match(await page.locator('.moderation-card').innerText(),/Browser <img src=x> Garage/);assert.equal(await page.locator('img[src=x]').count(),0);
 await page.waitForFunction(()=>{const image=document.querySelector('.moderation-current-photo');return image?.complete&&image.naturalWidth>0;});
 assert.equal(await page.locator('.moderation-current-photo').getAttribute('src'),listing.image);
 // A host changes the image after the admin viewed it: the old review must fail.
 const replacement=await host.call(`/host/garages/${listing.id}/photo`,{photo_base64,expected_image:listing.image,expected_status:'pending'});
 assert.notEqual(replacement.image,listing.image);
 await page.locator('[name=confirmed]').check();await page.locator('.moderation-form [type=submit]').click();
 await page.getByText(/Refresh and review the current listing photo again before approving\./).waitFor();
 assert.equal(await page.locator('.moderation-form [type=submit]').isDisabled(),true);
 assert.equal(await page.locator('[name=confirmed]').isChecked(),false);
 assert.equal(app.db.prepare('SELECT status FROM garages WHERE id=?').get(listing.id).status,'pending');
 await page.locator('[data-mod-action=refresh]').click();
 await page.waitForFunction(expected=>{const image=document.querySelector('.moderation-current-photo');return image?.getAttribute('src')===expected&&image.complete&&image.naturalWidth>0;},replacement.image);
 await page.locator('[name=confirmed]').check();await page.locator('.moderation-form [type=submit]').click();await page.getByText('Listing updated.',{exact:true}).waitFor();
 const approved=app.db.prepare('SELECT status,image FROM garages WHERE id=?').get(listing.id);assert.equal(approved.status,'approved');assert.equal(approved.image,replacement.image);
 assert.equal(approvalBodies.length,2);for(const body of approvalBodies){assert.equal(Object.hasOwn(body,'photo_base64'),false);assert.equal(body.confirmed,true);}
 assert.equal(approvalBodies[0].expected_image,listing.image);assert.equal(approvalBodies[1].expected_image,replacement.image);
 await page.locator('#moderation-status').selectOption('approved');await page.locator('.moderation-card').waitFor();
 mkdirSync(join(project,'test-results'),{recursive:true});await page.screenshot({path:join(project,'test-results/admin-moderation.png'),fullPage:true});
 page.on('dialog',dialog=>dialog.accept());await page.locator('[data-mod-action=archive]').click();await page.getByText('Listing updated.',{exact:true}).waitFor();assert.equal(app.db.prepare('SELECT status FROM garages WHERE id=?').get(listing.id).status,'archived');
 await page.locator('#staff-language').selectOption('ar');await page.locator('#moderation-status').waitFor();assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 console.log('PASS: host submits photo, missing-photo approval blocked, admin reviews stored photo without upload, stale photo rejected and refreshed, approval preserves photo, archive, Arabic RTL, mobile layout, no browser errors');
} catch(error){console.log(await page?.locator('body').innerText());console.log(await page?.evaluate(()=>document.querySelector('#moderation-notice')?.textContent));throw error;}
finally{if(browser)await browser.close();await new Promise(r=>app.server.close(r));app.db.close();rmSync(web,{recursive:true,force:true});}
