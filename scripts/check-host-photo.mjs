// Optional isolated browser QA. Set NODE_PATH to a Playwright installation.
// BROWSER_EXECUTABLE selects an installed Chromium; otherwise use Playwright's browser.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp } from '../server/app.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.UI_PORT || 3029);
const origin = `http://127.0.0.1:${port}`;
const results = join(project, 'test-results');
const imageOne = join(project, 'web/assets/garages/garage-01.webp');
const imageTwo = join(project, 'web/assets/garages/garage-02.webp');
let browser;

async function runCase(demo) {
  const name = demo ? 'demo' : 'live';
  const web = mkdtempSync(join(tmpdir(), 'garage-host-photo-qa-'));
  cpSync(join(project, 'web'), web, { recursive:true });
  const app = makeApp({ database:':memory:', web, origin, demo });
  let context, page, listening = false;
  try {
    await new Promise((resolve,reject) => {
      app.server.once('error',reject);
      app.server.listen(port,'127.0.0.1',() => { listening=true; resolve(); });
    });
    context = await browser.newContext({ viewport:{ width:390, height:844 } });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror',error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('garageshare-language','en'));
    // Map geometry is bundled. These tests do not depend on the external tile service.
    await page.route('https://tile.openstreetmap.org/**', route => route.abort());
    if (!demo) {
      const session = await page.request.get(origin+'/api/session').then(response => response.json());
      const account = await page.request.post(origin+'/api/register', {
        headers:{ Origin:origin, 'X-CSRF-Token':session.csrf },
        data:{ name:'Host browser fixture', email:'host@example.com', password:'Fixture password only 123!' }
      });
      assert.equal(account.status(),201,'Live test account must be created');
    }
    await page.goto(origin);
    await page.locator('.bottom-nav').waitFor();
    await page.locator('.bottom-nav [data-page=host]').click();
    await page.locator('[data-action=host-form]').first().click();
    const form = page.locator('#host-form');
    for (const [field,value] of Object.entries({
      name:'Photo fixture garage', area:'Centre', address:'Test private entrance 42',
      hourly:'12', monthly:'950', height_cm:'230', description:'A covered garage for a test host photo.'
    })) await form.locator(`[name=${field}]`).fill(value);
    // Select known test coordinates without relying on map tile loading.
    await form.evaluate(element => {
      element.elements.latitude.value='33.57'; element.elements.longitude.value='-7.58';
    });
    assert.equal(await form.locator('[name=garage_photo]').getAttribute('required'),'','Photo is required');
    assert.equal(await form.evaluate(element => element.reportValidity()),false,'Missing photo/consent must prevent submission');
    await form.locator('[name=garage_photo]').setInputFiles(imageOne);
    await form.locator('[data-host-photo-preview]').waitFor({ state:'visible' });
    await form.locator('[name=photo_consent]').check();
    if (!demo) {
      // Reproduce an HTML error from a proxy with an outdated upload limit.
      await page.route('**/api/host/garages',async route => {
        if (route.request().method()==='POST') await route.fulfill({ status:413, contentType:'text/html', body:'Photo too large at proxy' });
        else await route.continue();
      });
      await form.locator('[type=submit]').click();
      await form.locator('.form-error:not([hidden])').waitFor();
      assert.equal(await form.locator('[name=name]').inputValue(),'Photo fixture garage');
      assert.equal(await form.locator('[name=garage_photo]').evaluate(input => input.files.length),1,'Selected file must survive upload rejection');
      assert.equal(await form.locator('[type=submit]').isEnabled(),true);
      assert.equal(await form.locator('[name=garage_photo]').isEnabled(),true);
      assert.equal(await form.locator('[name=photo_consent]').isChecked(),true);
      await page.unroute('**/api/host/garages');
    }
    await form.locator('[type=submit]').click();
    await page.locator('.status.pending').waitFor();
    await page.waitForFunction(() => {
      const image=document.querySelector('.booking-card>img');
      return image?.complete && image.naturalWidth>0;
    });
    const before = await page.locator('.booking-card>img').getAttribute('src');
    assert.ok(demo ? before.startsWith('data:image/webp;base64,') : before.startsWith('/assets/host-photos/'),'Host listing must display the submitted image');
    await page.locator('[data-action=host-photo]').first().click();
    const photoForm = page.locator('#host-photo-form');
    await photoForm.locator('[name=garage_photo]').setInputFiles(imageTwo);
    await photoForm.locator('[data-host-photo-preview]').waitFor({ state:'visible' });
    await photoForm.locator('[name=photo_consent]').check();
    await photoForm.locator('[type=submit]').click();
    await photoForm.waitFor({ state:'detached' });
    await page.locator('.status.pending').waitFor();
    const after = await page.locator('.booking-card>img').getAttribute('src');
    assert.ok(after!==before,'Replacement photo should be stored');
    await page.reload();
    await page.locator('.bottom-nav').waitFor();
    await page.locator('.bottom-nav [data-page=host]').click();
    await page.locator('.booking-card>img').waitFor();
    assert.ok(await page.locator('.booking-card>img').getAttribute('src')===after,'Photo must survive reload');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth),'Mobile layout must fit viewport');
    assert.deepEqual(errors,[],'No uncaught browser errors');
    mkdirSync(results,{ recursive:true });
    await page.screenshot({ path:join(results,`host-photo-${name}.png`), fullPage:true });
    console.log(`PASS ${name}: required photo and consent, preview, create, owner replacement, persistence and mobile layout${demo?'':', HTML 413 retained-form retry'}`);
  } catch (error) {
    if (page) {
      console.error(await page.locator('body').innerText().catch(() => 'No page content'));
      mkdirSync(results,{ recursive:true });
      await page.screenshot({ path:join(results,`host-photo-${name}-failure.png`), fullPage:true }).catch(() => {});
    }
    throw error;
  } finally {
    if (context) await context.close();
    if (listening) {
      const closed=new Promise(resolve => app.server.close(resolve));
      app.server.closeAllConnections();
      await closed;
    }
    app.db.close();
    rmSync(web,{ recursive:true, force:true });
  }
}

try {
  browser = await chromium.launch({
    headless:true,
    args:['--no-sandbox','--disable-dev-shm-usage'],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath:process.env.BROWSER_EXECUTABLE } : {})
  });
  await runCase(false);
  await runCase(true);
} finally { if (browser) await browser.close(); }
