// Install Playwright and Chromium to run this workflow against local test servers.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { makeApp } = await import('../server/app.mjs');
  const { id, passwordHash } = await import('../server/core.mjs');
  const live = 'http://127.0.0.1:3008';
  const preview = 'http://127.0.0.1:3009';
  const app = makeApp({ database: ':memory:', origin: live });
  const demo = makeApp({ demo: true, database: ':memory:', origin: preview });
  const password = 'Local browser fixture password 123!';
  const secret = await passwordHash(password);
  const output = path.resolve(__dirname, '../dist');
  fs.mkdirSync(output, { recursive: true });
  const checks = [], errors = [];
  function check(label, value) {
    assert.ok(value, label);
    checks.push(label);
  }
  const users = {};
  for (const name of ['Renter', 'HostA', 'HostB', 'Staff']) {
    users[name] = id();
    app.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(users[name], name, `${name.toLowerCase()}@example.com`, secret, Date.now());
  }
  app.db.prepare("INSERT INTO staff_members VALUES (?,'admin')").run(users.Staff);
  for (const [host, label, hourly, monthly] of [['HostA', 'Alpha', 1500, 90000], ['HostB', 'Beta', 1700, 95000]]) {
    app.db.prepare('INSERT INTO garages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id(), users[host], `Garage ${label}`, 'Casablanca', 'Maârif', `Private test entrance ${label}`,
      33.584, -7.632, hourly, monthly, 230, 'suv', 1, 'Local UI fixture garage.',
      '/assets/garages/garage-01.webp', 'approved', Date.now()
    );
  }
  await Promise.all([app, demo].map((service, i) => new Promise(resolve => service.server.listen(3008 + i, '127.0.0.1', resolve))));
  let browser;
  try {
    const args = ['--no-sandbox', '--disable-dev-shm-usage'];
    if (process.env.BROWSER_SINGLE_PROCESS === '1') args.push('--single-process', '--no-zygote');
    if (process.env.BROWSER_EXTRA_ARGS) args.push(...JSON.parse(process.env.BROWSER_EXTRA_ARGS));
    browser = await chromium.launch({ headless: true, args,
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => {
      if (!localStorage.getItem('garageshare-language')) localStorage.setItem('garageshare-language', 'en');
    });
    await context.route('https://tile.openstreetmap.org/**', route => route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    async function signIn(name) {
      await context.clearCookies();
      const session = await (await context.request.get(live + '/api/session')).json();
      const login = await context.request.post(live + '/api/login', {
        headers: { Origin: live, 'X-CSRF-Token': session.csrf },
        data: { email: `${name.toLowerCase()}@example.com`, password }
      });
      assert.equal(login.status(), 200);
    }
    const nav = name => page.locator(`.bottom-nav [data-page="${name}"]`).click();
    const action = name => page.locator(`[data-action="${name}"]`);
    const submit = form => page.locator(`${form} [type="submit"]`).click();
    async function openHostOffers(name) {
      await signIn(name);
      await page.goto(live);
      await nav('host');
      await page.locator('[data-tab="prices"]').click();
      await action('price-counter').waitFor();
    }
    await signIn('Renter');
    await page.goto(live);
    await page.locator('[data-mode="monthly"]').click();
    await action('price-request').click();
    const form = page.locator('#price-request-form');
    await form.waitFor();
    check('Monthly request presents two selectable garages', await form.locator('[name="garage_ids"]:checked').count() === 2);
    await form.locator('[name="total"]').fill('850');
    const invalid = await form.evaluate(el => [...el.querySelectorAll(':invalid')].map(input => ({ name: input.name, error: input.validationMessage })));
    assert.deepEqual(invalid, []);
    const [sent] = await Promise.all([
      page.waitForResponse(response => response.url() === live + '/api/deals' && response.request().method() === 'POST'),
      submit('#price-request-form')
    ]);
    assert.equal(sent.status(), 200, (await sent.json()).error);
    await page.locator('#price-requests .deal-quote').first().waitFor();
    check('The renter sees one request with two pending replies', await page.locator('#price-requests .deal-quote').count() === 2);
    await openHostOffers('HostA');
    await page.locator('[data-response="match"]').click();
    await action('price-respond').filter({ hasText: 'Withdraw' }).waitFor();
    checks.push('One host matches the renter’s price');
    await openHostOffers('HostB');
    await action('price-counter').click();
    await page.locator('#price-counter-form [name="total"]').fill('875');
    await submit('#price-counter-form');
    await action('price-respond').filter({ hasText: 'Withdraw' }).waitFor();
    checks.push('Another host sends a counter quote');
    await signIn('Renter');
    await page.goto(live);
    await nav('trips');
    await action('price-select').first().waitFor();
    check('The renter can compare two prices', await action('price-select').count() === 2);
    await page.locator('.deal-quote').filter({ hasText: 'Garage Beta' }).locator('button').click();
    await submit('#price-select-form');
    await page.locator('#trip-list .booking-card').waitFor();
    check('Selecting the counter quote creates one booking at 875 DH',
      await page.locator('#trip-list .booking-card').count() === 1 && (await page.locator('.booking-amount').innerText()).includes('875'));
    await action('support-new').click();
    await page.locator('#support-create-form [name="subject"]').fill('Access question');
    await page.locator('#support-create-form [name="message"]').fill('Please check the entrance. <img src=x onerror=alert(1)>');
    await submit('#support-create-form');
    await page.locator('.support-message').waitFor();
    check('Booking support includes context and renders user text safely', await page.locator('.support-booking').isVisible() && await page.locator('.support-message img').count() === 0);
    await page.goto(live + '/admin.html');
    await page.getByText('Staff access is required.', { exact: true }).waitFor();
    check('A renter cannot open the staff dashboard', await page.locator('#staff-queue').count() === 0);
    await context.clearCookies();
    await page.setViewportSize({ width: 1180, height: 950 });
    await page.goto(live + '/admin.html');
    await page.locator('#staff-login-form [name="email"]').fill('staff@example.com');
    await page.locator('#staff-login-form [name="password"]').fill(password);
    await submit('#staff-login-form');
    await page.locator('#staff-queue .ticket-row').click();
    await page.locator('#staff-update-form [name="assignee_id"]').selectOption(users.Staff);
    await submit('#staff-update-form');
    await page.locator('#staff-queue .ticket-row').getByText(/Staff ·/).waitFor();
    await page.locator('#staff-reply-form textarea').fill('We can confirm your booking. Please follow the access details in Trips.');
    await submit('#staff-reply-form');
    await page.locator('.staff-message').waitFor();
    check('Staff can assign the ticket and reply', await page.locator('#staff-thread .service-badge.waiting').isVisible());
    await page.locator('#staff-update-form [name="status"]').selectOption('resolved');
    await submit('#staff-update-form');
    await page.locator('#staff-thread .service-badge.resolved').waitFor();
    check('Staff can resolve tickets', await page.locator('#staff-thread .support-message').count() === 2);
    await page.screenshot({ path: path.join(output, 'support-dashboard.png'), fullPage: true });
    await page.setViewportSize({ width: 320, height: 750 });
    await page.locator('#staff-language').selectOption('ar');
    check('The Arabic dashboard fits a 320 px phone', await page.evaluate(() => document.documentElement.dir === 'rtl' && document.documentElement.scrollWidth <= innerWidth));
    await signIn('Renter');
    await page.goto(live);
    await page.locator('#language').selectOption('en');
    await action('profile').click();
    await page.locator('.sheet [data-page="support"]').click();
    await action('support-ticket').click();
    await page.locator('#support-reply-form textarea').fill('Thanks, I still have a question.');
    await submit('#support-reply-form');
    await page.locator('.sheet .service-badge.open').waitFor();
    check('A customer reply reopens their ticket', await page.locator('.sheet .support-message').count() === 3);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(preview);
    await action('price-request').click();
    await submit('#price-request-form');
    await action('price-sample-replies').click();
    await action('price-select').first().waitFor();
    check('The Android-style preview can simulate competing quotes', await action('price-select').count() === 2);
    await action('price-select').first().click();
    await submit('#price-select-form');
    await page.locator('#trip-list .booking-card').waitFor();
    check('The preview saves the chosen booking', await page.locator('#trip-list .status.confirmed').count() === 1);
    await action('support-new').click();
    await page.locator('#support-create-form [name="subject"]').fill('Sample support question');
    await page.locator('#support-create-form [name="message"]').fill('Where do I see my sample booking details?');
    await submit('#support-create-form');
    await action('support-sample-reply').click();
    await page.locator('.sheet .staff-message').waitFor();
    check('The preview shows a local sample support conversation', await page.locator('.sheet .support-message').count() === 2);
    await page.locator('.sheet-close').click();
    await nav('host');
    await page.locator('[data-tab="prices"]').click();
    await action('price-sample-invitation').click();
    await page.locator('[data-response="match"]').click();
    await action('price-respond').filter({ hasText: 'Withdraw' }).waitFor();
    checks.push('The preview lets a host answer a sample price request');
    check('No uncaught browser errors', errors.length === 0);
    console.log(JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
  } finally {
    if (browser) await browser.close();
    for (const service of [app, demo]) {
      await new Promise(resolve => service.server.close(resolve));
      service.db.close();
    }
  }
})().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
