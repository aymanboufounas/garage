// Install Playwright and Chromium to run this workflow against local test servers.
const { chromium, request } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const { makeApp } = await import('../server/app.mjs');
  const { id, passwordHash } = await import('../server/core.mjs');
  const { moroccoInput } = await import('../web/icons.js');
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
  let browser, peerApi;
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
    async function authenticate(client, name) {
      const session = await (await client.get(live + '/api/session')).json();
      const login = await client.post(live + '/api/login', {
        headers: { Origin: live, 'X-CSRF-Token': session.csrf },
        data: { email: `${name.toLowerCase()}@example.com`, password }
      });
      assert.equal(login.status(), 200);
      return (await login.json()).csrf;
    }
    async function signIn(name) {
      await context.clearCookies();
      return authenticate(context.request, name);
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
    const beta = page.locator('.deal-quote').filter({ hasText: 'Garage Beta' });
    const quoteId = await beta.locator('[data-action="chat-open"]').getAttribute('data-id');
    const chatPath = `/api/chat/quote/${quoteId}`;
    const guestMessage = 'Will an SUV fit? <img src=x onerror=alert(1)>';
    await beta.locator('[data-action="chat-open"]').click();
    await page.locator('#chat-form textarea').fill(guestMessage);
    await submit('#chat-form');
    await page.locator('#chat-messages .chat-message.own').waitFor();
    await page.locator('#chat-form textarea').fill('Draft while waiting');
    peerApi = await request.newContext();
    const peerCsrf = await authenticate(peerApi, 'HostB');
    const hostMessage = 'Yes, an SUV fits. Let me know your arrival time.';
    const reply = await peerApi.post(live + chatPath + '/send', {
      headers: { Origin: live, 'X-CSRF-Token': peerCsrf },
      data: { message: hostMessage, request_key: id() }
    });
    assert.equal(reply.status(), 200);
    await page.locator('#chat-messages').getByText(hostMessage, { exact: true }).waitFor({ timeout: 9000 });
    check('Chat refreshes automatically and preserves the message draft', await page.locator('#chat-form textarea').inputValue() === 'Draft while waiting');
    await page.locator('.sheet-close').click();
    await signIn('HostB');
    await page.goto(live);
    await nav('host');
    await page.locator('main [data-page="messages"]').click();
    await page.locator('#chat-inbox .chat-unread').waitFor();
    check('The host sees the renter’s unread message in Messages', (await page.locator('#chat-inbox .chat-unread').innerText()).includes('1 unread'));
    const receipt = page.waitForResponse(response => response.url() === live + chatPath + '/read' && response.status() === 200);
    await page.locator('#chat-inbox [data-action="chat-open"]').click();
    await receipt;
    check('Chat displays user markup as plain text', await page.locator('#chat-messages').getByText(guestMessage, { exact: true }).count() === 1 && await page.locator('#chat-messages img').count() === 0);
    await page.locator('.sheet-close').click();
    await signIn('Renter');
    await page.goto(live);
    await nav('trips');
    await beta.locator('[data-action="chat-open"]').click();
    await page.locator('#chat-messages .own small').filter({ hasText: 'Seen' }).waitFor();
    checks.push('The renter sees a read receipt after the host reads the message');
    await page.locator('.sheet-close').click();
    await beta.locator('[data-action="price-select"]').click();
    await submit('#price-select-form');
    await page.locator('#trip-list .booking-card').waitFor();
    check('Selecting the counter quote creates one booking at 875 DH',
      await page.locator('#trip-list .booking-card').count() === 1 && (await page.locator('.booking-amount').innerText()).includes('875'));
    const directionsButton = page.locator('#trip-list [data-action="arrival"]');
    await page.setViewportSize({ width: 320, height: 520 });
    await directionsButton.click();
    const directionsLink = page.locator('#arrival-directions');
    await directionsLink.waitFor();
    const destination = new URL(await directionsLink.getAttribute('href'));
    check('Arrival opens driving directions to the exact booked entrance',
      (await page.locator('.arrival-address').innerText()).trim() === 'Private test entrance Beta' &&
      destination.pathname === '/maps/dir/' && destination.searchParams.get('destination') === '33.584,-7.632' &&
      destination.searchParams.get('travelmode') === 'driving' && destination.searchParams.get('dir_action') === 'navigate' &&
      await directionsLink.getAttribute('target') === null);
    await page.locator('#arrival-map-status').waitFor();
    await directionsLink.scrollIntoViewIfNeeded();
    check('Driving link stays reachable on a small phone when map tiles fail', await directionsLink.evaluate(link => {
      const box = link.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && box.height >= 44;
    }));
    await page.locator('.sheet-close').click();
    check('Closing arrival restores focus to the booking directions button',
      await directionsButton.evaluate(button => document.activeElement === button));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#trip-list [data-action="chat-open"]').click();
    await page.locator('#chat-messages').getByText(hostMessage, { exact: true }).waitFor();
    check('Confirmed booking opens the original quote conversation', await page.locator('#chat-messages .chat-message').count() === 2);
    await page.screenshot({ path: path.join(output, 'mobile-chat.png') });
    await page.locator('.sheet-close').click();
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
    const future = Math.ceil((Date.now() + 45 * 86400000) / 3600000) * 3600000;
    const starts = moroccoInput(future);
    const ends = moroccoInput(future + 2 * 3600000);
    await signIn('HostA');
    await page.goto(live);
    await nav('host');
    await page.locator('[data-tab="calendar"]').click();
    await action('calendar-block').click();
    await page.locator('#calendar-block-form [name="start"]').fill(starts);
    await page.locator('#calendar-block-form [name="end"]').fill(ends);
    await page.locator('#calendar-block-form [name="note"]').fill('Workshop visit');
    await submit('#calendar-block-form');
    await page.locator('#calendar-agenda .calendar-event.blocked').waitFor();
    check('Host calendar displays the blocked time and private note',
      (await page.locator('#calendar-agenda .calendar-event.blocked').innerText()).includes('Workshop visit'));
    await page.setViewportSize({ width: 320, height: 750 });
    await page.locator('#language').selectOption('ar');
    await page.locator('#calendar-agenda .calendar-event.blocked').waitFor();
    check('Arabic calendar fits a compact phone', await page.evaluate(() =>
      document.documentElement.dir === 'rtl' && document.documentElement.scrollWidth <= innerWidth));
    await page.locator('.calendar-panel').screenshot({ path: path.join(output, 'calendar-ar.png') });
    await page.locator('#language').selectOption('en');
    await page.setViewportSize({ width: 390, height: 844 });

    await signIn('Renter');
    await page.goto(live);
    await page.locator('#city').selectOption('Nador');
    await action('availability-form').click();
    await page.locator('#availability-form [name="start"]').fill(starts);
    await page.locator('#availability-form [name="units"]').fill('2');
    await submit('#availability-form');
    await action('availability-clear').waitFor();
    const nearMe = page.locator('.explore-main [data-action="locate"]');
    await context.grantPermissions(['geolocation'], { origin: live });
    await context.setGeolocation({ latitude: 33.586, longitude: -7.636 });
    await nearMe.click();
    await page.waitForFunction(() => document.querySelector('#city').value === 'Casablanca');
    await page.locator('.garage-card').waitFor();
    check('Near me keeps selected dates when changing cities', await action('availability-clear').isVisible());
    check('Date search removes the blocked garage', await page.locator('.garage-card').count() === 1 &&
      (await page.locator('.garage-card').innerText()).includes('Garage Beta'));
    await page.locator('.card-image-button').click();
    await action('book-form').click();
    check('Booking uses the chosen search date and duration', await page.locator('#booking-form [name="start"]').inputValue() === starts &&
      await page.locator('#booking-form [name="units"]').inputValue() === '2');
    await page.locator('.sheet-close').click();
    check('Closing a booking form returns focus to the original garage card',
      await page.locator('.card-image-button').evaluate(button => button === document.activeElement));
    await action('availability-clear').click();
    await page.locator('.garage-card').filter({ hasText: 'Garage Alpha' }).waitFor();
    checks.push('Clearing dates restores discovery');

    const completed = app.db.prepare('SELECT id FROM reservations WHERE guest_id=?').get(users.Renter);
    const endOfStay = Date.now() - 86400000;
    app.db.prepare('UPDATE reservations SET starts_at=?,ends_at=? WHERE id=?').run(endOfStay - 31 * 86400000, endOfStay, completed.id);
    await nav('trips');
    await page.locator('#trip-list .booking-card').waitFor();
    check('A completed booking no longer shows directions or the private address',
      await directionsButton.count() === 0 && !(await page.locator('#trip-list').innerText()).includes('Private test entrance'));
    await action('stay-review').click();
    await page.locator('#stay-review-form [name="rating"][value="5"]').check();
    const reviewComment = 'Easy garage access. <img src=x onerror=alert(1)>';
    await page.locator('#stay-review-form textarea').fill(reviewComment);
    await submit('#stay-review-form');
    await page.locator('#review-status').filter({ hasText: 'private until' }).waitFor();
    checks.push('A renter can review a completed booking privately');

    await signIn('HostB');
    await page.goto(live);
    await nav('host');
    await page.locator('[data-tab="requests"]').click();
    await action('stay-review').click();
    await page.locator('#stay-review-form').waitFor();
    check('The host cannot see the pending renter review before submitting', await page.locator('.sheet .review-card').count() === 0);
    await page.locator('#stay-review-form [name="rating"][value="4"]').check();
    await page.locator('#stay-review-form textarea').fill('A smooth rental.');
    await submit('#stay-review-form');
    await page.locator('#review-status').filter({ hasText: 'Review published.' }).waitFor();
    check('Both reviews appear after both people submit', await page.locator('.sheet .review-card').count() === 2);
    await page.locator('.sheet-close').click();
    await nav('explore');
    const reviewed = page.locator('.garage-card').filter({ hasText: 'Garage Beta' });
    await reviewed.locator('.rating-badge').waitFor();
    await reviewed.locator('.card-image-button').click();
    await action('garage-reviews').click();
    await page.locator('.sheet .review-card').waitFor();
    check('The public garage rating shows verified renter feedback as plain text',
      await page.locator('.sheet .review-card').count() === 1 &&
      await page.locator('.sheet .review-card img').count() === 0 &&
      (await page.locator('.sheet .review-comment').innerText()) === reviewComment);

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
    await directionsButton.click();
    await directionsLink.waitFor();
    check('Preview directions label the sample destination',
      (await directionsLink.innerText()).includes('sample') && await page.locator('.arrival-address').count() === 0);
    await page.locator('.sheet-close').click();
    await page.locator('#trip-list [data-action="chat-open"]').click();
    await action('chat-prompt').first().click();
    check('A quick message fills the composer', (await page.locator('#chat-form textarea').inputValue()).includes('SUV'));
    await submit('#chat-form');
    await page.locator('#chat-messages .own').waitFor();
    await action('chat-sample').click();
    await page.locator('#chat-messages .chat-message:not(.own)').waitFor();
    check('The preview can simulate a private reply', await page.locator('#chat-messages .chat-message').count() === 2);
    await page.locator('.sheet-close').click();
    await page.setViewportSize({ width: 320, height: 520 });
    await page.locator('#language').selectOption('ar');
    await page.locator('#trip-list [data-action="chat-open"]').click();
    await page.locator('#chat-form [type="submit"]').scrollIntoViewIfNeeded();
    const composerFits = await page.locator('#chat-form [type="submit"]').evaluate(button => {
      const box = button.getBoundingClientRect();
      return document.documentElement.dir === 'rtl' && document.documentElement.scrollWidth <= innerWidth &&
        box.top >= 0 && box.bottom <= innerHeight;
    });
    check('Arabic chat keeps the send button reachable on a compact phone', composerFits);
    await page.locator('.sheet-close').click();
    await page.locator('#language').selectOption('en');
    await page.setViewportSize({ width: 390, height: 844 });
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
    await page.locator('[data-tab="calendar"]').click();
    await action('calendar-block').click();
    await page.locator('#calendar-block-form [name="start"]').fill(starts);
    await page.locator('#calendar-block-form [name="end"]').fill(ends);
    await submit('#calendar-block-form');
    await page.locator('#calendar-agenda .calendar-event.blocked').waitFor();
    await action('calendar-unblock').click();
    await page.locator('#calendar-agenda .calendar-event.blocked').waitFor({ state: 'detached' });
    checks.push('The preview can block and unblock calendar time');
    await nav('trips');
    await action('review-sample-stay').click();
    await page.locator('#stay-review-form [name="rating"][value="5"]').check();
    await submit('#stay-review-form');
    await action('review-sample-reply').click();
    await page.locator('#review-status').filter({ hasText: 'Review published.' }).waitFor();
    check('The preview can publish both sample reviews', await page.locator('.sheet .review-card').count() === 2);
    check('No uncaught browser errors', errors.length === 0);
    console.log(JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
  } finally {
    if (peerApi) await peerApi.dispose();
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
