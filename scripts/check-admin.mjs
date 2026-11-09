// Optional isolated browser QA. Set NODE_PATH to a Playwright installation.
import { createRequire } from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeApp} from '../server/app.mjs';
const project=fileURLToPath(new URL('../',import.meta.url)), web=mkdtempSync(join(tmpdir(),'garage-admin-qa-'));
cpSync(join(project,'web'),web,{recursive:true});
const port=Number(process.env.UI_PORT||3018),origin=`http://127.0.0.1:${port}`,password='Admin QA fixture password only 123!';
const app=makeApp({database:':memory:',web,origin});
await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
let browser,page;
try {
 function client() {return {cookie:'',csrf:'',async call(path,data) {
  const r=await fetch(origin+'/api'+path,{method:data===undefined?'GET':'POST',headers:{Cookie:this.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':this.csrf},body:data===undefined?undefined:JSON.stringify(data)});
  if(r.headers.has('set-cookie'))this.cookie=r.headers.get('set-cookie').split(';')[0];
  const json=await r.json();if(json.csrf)this.csrf=json.csrf;assert.ok(r.ok,JSON.stringify(json));return json;
 }};}
 async function register(c,name,email){await c.call('/session');return (await c.call('/register',{name,email,password})).user;}
 const owner=client(),admin=client(),guest=client();
 const ownerUser=await register(owner,'Sample host','host@example.com');
 const adminUser=await register(admin,'Sample administrator','admin@example.com');
 app.db.prepare("INSERT INTO staff_members VALUES (?,'admin')").run(adminUser.id);
 const guestUser=await register(guest,'Sample renter','renter@example.com');
 const garage=await owner.call('/host/garages',{name:'Palm district garage',city:'Casablanca',area:'Maârif',address:'Private garage entrance 42',latitude:33.57,longitude:-7.58,hourly_cents:1200,monthly_cents:95000,height_cm:230,vehicle_size:'suv',covered:true,description:'Covered parking for the isolated browser fixture.'});
 const pending=await owner.call('/host/garages',{name:'New listing to review',city:'Rabat',area:'Agdal',address:'Private entrance 27',latitude:34,longitude:-6.8,hourly_cents:1500,monthly_cents:120000,height_cm:220,vehicle_size:'compact',covered:true,description:'Second sample garage for pending queue testing.'});
 // Fixture only: the QA process is in-memory and does not touch the live database.
 app.db.prepare("UPDATE garages SET status='approved' WHERE id=?").run(garage.id);
 const booking=(await guest.call('/reservations',{garage_id:garage.id,action:'book',mode:'hourly',units:2,starts_at:new Date(Date.now()+86400000).toISOString(),request_key:'admin-browser-booking-123'})).reservation;
 // Seed unused accounts to exercise >25-row pagination without repeated password hashing.
 const hash=app.db.prepare('SELECT password_hash FROM users WHERE id=?').get(ownerUser.id).password_hash;
 for(let n=0;n<26;n++)app.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run((n+1).toString(16).padStart(32,'0'),'Fixture account '+n,'fixture'+n+'@example.com',hash,Date.now()-n);
 browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(()=>localStorage.setItem('garageshare-language','en'));
 page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 await page.goto(origin+'/admin.html');await page.locator('[name=email]').fill('admin@example.com');await page.locator('[name=password]').fill(password);await page.locator('#staff-login-form [type=submit]').click();
 await page.locator('.admin-metric').first().waitFor();assert.equal(await page.locator('.admin-metric').count(),5);
 assert.match(await page.locator('[data-overview-content]').innerText(),/50/);
 mkdirSync(join(project,'test-results'),{recursive:true});
 await page.screenshot({path:join(project,'test-results/admin-overview.png'),fullPage:true});
 await page.locator('[data-admin-view=accounts]').click();await page.locator('[data-management-action=next]').waitFor({state:'visible'});
 await page.waitForFunction(()=>!document.querySelector('[data-management-action=next]').disabled);
 await page.locator('[data-management-action=next]').click();await page.waitForFunction(()=>document.querySelector('[data-page-label]').textContent.includes('2'));
 await page.locator('[data-management-action=previous]').click();await page.waitForFunction(()=>document.querySelector('[data-page-label]').textContent.includes('1'));
 await page.locator('[data-management-action=create]').click();await page.locator('[data-account-form] [name=name]').fill('New managed customer');await page.locator('[data-account-form] [name=email]').fill('managed@example.com');await page.locator('[data-account-form] [name=password]').fill(password);await page.locator('[data-account-form] [type=submit]').click();
 await page.waitForFunction(()=>!document.querySelector('[data-account-form]'));
 assert.ok(app.db.prepare('SELECT id FROM users WHERE email=?').get('managed@example.com'));
 await page.locator('[data-account-search] [name=q]').fill('managed@example.com');await page.locator('[data-account-search] [type=submit]').click();await page.locator('.admin-table tbody tr').filter({hasText:'managed@example.com'}).waitFor();
 const row=page.locator('.admin-table tbody tr').filter({hasText:'managed@example.com'});
 await row.locator('[data-management-action=edit]').click();await page.locator('[data-account-form] [name=name]').fill('Edited customer');await page.locator('[data-account-form] [type=submit]').click();await page.getByText('Edited customer',{exact:true}).waitFor();
 await row.locator('[data-account-role]').selectOption('support');await page.waitForFunction(()=>document.querySelector('[data-account-role]')?.value==='support'&&!document.querySelector('#admin-view').getAttribute('aria-busy').includes('true'));
 const managed=app.db.prepare('SELECT id FROM users WHERE email=?').get('managed@example.com');assert.equal(app.db.prepare('SELECT role FROM staff_members WHERE user_id=?').get(managed.id).role,'support');
 await row.locator('[data-management-action=remove]').click();await page.getByText('No accounts match your search.',{exact:true}).waitFor();assert.equal(app.db.prepare('SELECT id FROM users WHERE id=?').get(managed.id),undefined);
 await page.locator('[data-admin-view=reservations]').click();await page.locator('[data-management-action=cancel]').waitFor();await page.locator('[data-management-action=cancel]').click();await page.locator('[name=reason]').fill('Customer requested cancellation in browser QA.');await page.locator('[data-reservation-cancel] [type=submit]').click();await page.locator('.admin-status-cancelled').waitFor();assert.equal(app.db.prepare('SELECT status FROM reservations WHERE id=?').get(booking.id).status,'cancelled');assert.equal(app.db.prepare('SELECT reason FROM admin_reservation_decisions WHERE reservation_id=?').get(booking.id).reason,'Customer requested cancellation in browser QA.');
 await page.locator('[data-admin-view=support]').click();await page.locator('#staff-filter-form').waitFor();
 await page.locator('[data-admin-view=garages]').click();await page.locator('.moderation-card').waitFor();
 // Simulate Nginx's non-JSON 413 response, which used to be hidden as a generic error.
 await page.route('**/api/staff/garages/*/approve',route=>route.fulfill({status:413,contentType:'text/html',body:'<h1>413 Request Entity Too Large</h1>'}));
 await page.locator('[name=photo]').setInputFiles(join(project,'web/assets/garages/garage-01.webp'));await page.locator('[name=confirmed]').check();await page.locator('.moderation-form [type=submit]').click();await page.waitForFunction(()=>document.querySelector('#moderation-notice')?.textContent.includes('upload limit'));assert.equal(await page.locator('[name=photo]').evaluate(el=>el.files.length),1);assert.equal(app.db.prepare('SELECT status FROM garages WHERE id=?').get(pending.id).status,'pending');
 await page.setViewportSize({width:390,height:844});await page.locator('[data-admin-view=overview]').click();await page.locator('.admin-metric').first().waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:join(project,'test-results/admin-overview-mobile.png'),fullPage:true});
 await page.locator('#staff-language').selectOption('ar');await page.locator('.admin-metric').first().waitFor();assert.equal(await page.locator('html').getAttribute('dir'),'rtl');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 console.log('PASS: overview percentages, account pagination/create/edit/role/remove, recorded cancellation, support navigation, actionable HTML413 preserving photo, mobile and Arabic RTL');
} catch(error) {console.error(await page?.locator('body').innerText());throw error;}
finally {if(browser)await browser.close();await new Promise(r=>app.server.close(r));app.db.close();rmSync(web,{recursive:true,force:true});}
