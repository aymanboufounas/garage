// Optional Playwright regression: an old fresh HTTP cache must not break a new admin deployment.
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,cpSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {makeApp} from '../server/app.mjs';
import {id,passwordHash} from '../server/core.mjs';
const web=mkdtempSync(join(tmpdir(),'garage-cache-qa-'));
cpSync(new URL('../web',import.meta.url),web,{recursive:true});
const legacyCatalog=readFileSync(join(web,'i18n.js'),'utf8')
 .replace(/^import \{ adminShellCopy \}.*\n/m,'').replace(/^import \{ adminManagementCopy \}.*\n/m,'')
 .replace(/^ \.\.\.adminShellCopy,\n/m,'').replace(/^ \.\.\.adminManagementCopy,\n/m,'');
writeFileSync(join(web,'prime.html'),'<!doctype html><script type="module" src="/prime.js"></script>');
writeFileSync(join(web,'prime.js'),`import {t} from './i18n.js'; try {t('adminNavigation');} catch(error) {window.oldCatalogError=error.message;}`);
let legacy=true, app, browser, page;
const frontend=createServer((req,res)=>{
 if(legacy&&/^\/[a-z0-9-]+\.js$/.test(req.url)) {
  try {
   const body=req.url==='/i18n.js'?legacyCatalog:readFileSync(join(web,req.url.slice(1)));
   res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'public, max-age=3600'});res.end(body);return;
  } catch {}
 }
 app.server.emit('request',req,res);
});
await new Promise(resolve=>frontend.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${frontend.address().port}`, password='Cache fixture password only 123!';
app=makeApp({database:':memory:',web,origin});
try {
 const uid=id();app.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(uid,'Cache fixture admin','cache-admin@example.com',await passwordHash(password),Date.now());
 app.db.prepare("INSERT INTO staff_members VALUES (?,'admin')").run(uid);
 browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext();await context.addInitScript(()=>localStorage.setItem('garageshare-language','fr'));
 page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin+'/prime.html');await page.waitForFunction(()=>window.oldCatalogError);
 assert.equal(await page.evaluate(()=>window.oldCatalogError),'Unknown translation key: adminNavigation');
 legacy=false;
 await page.goto(origin+'/admin.html');
 await page.locator('[name=email]').fill('cache-admin@example.com');await page.locator('[name=password]').fill(password);await page.locator('#staff-login-form [type=submit]').click();
 await page.locator('.admin-metric').first().waitFor();
 assert.equal(await page.locator('html').getAttribute('lang'),'fr');
 assert.equal(await page.locator('[data-admin-view=overview]').getAttribute('aria-current'),'page');
 // A normal import of the old unversioned URL is still poisoned by the old cache.
 assert.equal(await page.evaluate(async()=>{const old=await import('/i18n.js');try{old.t('adminNavigation');return false;}catch(error){return error.message==='Unknown translation key: adminNavigation';}}),true);
 await page.locator('[data-admin-view=accounts]').click();await page.locator('[data-account-list] table').waitFor();
 await page.locator('#staff-language').selectOption('ar');await page.locator('[data-account-list] table').waitFor();assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
 assert.deepEqual(errors,[]);
 console.log('PASS: reproduced old cached catalog missing adminNavigation; new dashboard loads matching versioned modules and works in French and Arabic without clearing the old cache');
} catch(error){console.error(await page?.locator('body').innerText());throw error;}
finally{if(browser)await browser.close();await new Promise(resolve=>frontend.close(resolve));app.db.close();rmSync(web,{recursive:true,force:true});}
