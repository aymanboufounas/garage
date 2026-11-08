// Uses signed local Google fixtures and real browser cookie handling.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { chromium } = require('playwright');

(async () => {
  const { makeApp } = await import('../server/app.mjs');
  const { googleFixture } = await import('../test/helpers/google.mjs');
  const provider = googleFixture();
  const port = Number(process.env.GOOGLE_UI_PORT || 3017);
  const origin = `http://127.0.0.1:${port}`;
  const app = makeApp({ origin, database: ':memory:', google: provider.config, googleFetch: provider.fetch });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  let claims = { sub: 'new-user', email: 'google-only@example.com' }, cancelled = false;
  const mockGoogle = createServer((req, res) => {
    if (!req.url?.startsWith('/o/oauth2/v2/auth?')) return res.writeHead(404).end();
    const callback = provider.authorize(`https://accounts.google.com${req.url}`, claims);
    if (cancelled) {
      callback.searchParams.delete('code');
      callback.searchParams.set('error', 'access_denied');
    }
    res.writeHead(303, { Location: callback.href });
    res.end();
  });
  await new Promise(resolve => mockGoogle.listen(0, '127.0.0.1', resolve));
  const errors = [], checks = [];
  const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
  let browser;
  try {
    const args = ['--no-sandbox', '--disable-dev-shm-usage'];
    if (process.env.BROWSER_SINGLE_PROCESS === '1') args.push('--single-process', '--no-zygote');
    if (process.env.BROWSER_EXTRA_ARGS) args.push(...JSON.parse(process.env.BROWSER_EXTRA_ARGS));
    browser = await chromium.launch({ headless: true, args,
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 320, height: 650 } });
    await context.route('https://tile.openstreetmap.org/**', route => route.abort());
    await context.route(`${origin}/auth/google/start?flow=*`, async route => {
      const response = await route.fetch({ maxRedirects: 0 });
      if (response.status() !== 303) return route.fulfill({ response });
      const google = new URL(response.headers().location);
      assert.equal(google.origin, 'https://accounts.google.com');
      // localhost and 127.0.0.1 are separate sites for cookie policy.
      const location = `http://localhost:${mockGoogle.address().port}${google.pathname}${google.search}`;
      return route.fulfill({ response, headers: { ...response.headers(), location } });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const account = page.locator('#avatar');
    const choice = page.locator('.google-button[href]');
    async function openAuth() {
      await account.click();
      await page.locator('.sheet [data-action="auth"]').click();
      await choice.waitFor();
    }
    async function signOut() {
      await account.click();
      await page.locator('.sheet [data-action="signout"]').click();
      await page.locator('.sheet').waitFor({ state: 'hidden' });
    }
    async function session() { return (await (await context.request.get(origin + '/api/session')).json()).user; }
    await page.goto(origin);
    await page.locator('#language').selectOption('en');
    await openAuth();
    check('Google and email sign-in are both reachable', await choice.innerText() === 'Continue with Google' &&
      await page.locator('#auth-form [name="password"]').isVisible());
    await choice.click();
    await page.locator('#avatar').filter({ hasText: 'G' }).waitFor();
    check('Cross-site OAuth creates a signed-in account and removes the proof from the URL',
      (await session())?.email === 'google-only@example.com' && !new URL(page.url()).hash);
    await signOut();
    await page.locator('#language').selectOption('ar');
    await openAuth();
    check('Google sign-in fits an Arabic phone layout', (await choice.innerText()).includes('المتابعة') &&
      await page.evaluate(() => document.documentElement.dir === 'rtl' && document.documentElement.scrollWidth <= innerWidth));
    cancelled = true;
    await choice.click();
    await page.locator('.sheet [role="alert"]').waitFor();
    await choice.waitFor();
    check('Cancelling Google returns to a usable sign-in sheet', !(await session()) && await choice.isVisible());
    await page.locator('.sheet-close').click();
    await page.locator('#language').selectOption('fr');
    await openAuth();
    check('French uses the localized Google sign-in label', await choice.innerText() === 'Continuer avec Google');
    await page.locator('.sheet-close').click();
    await page.locator('#language').selectOption('en');
    const csrf = (await (await context.request.get(origin + '/api/session')).json()).csrf;
    const register = await context.request.post(origin + '/api/register', { headers: { Origin: origin, 'X-CSRF-Token': csrf },
      data: { email: 'existing@example.com', name: 'Existing Renter', password: 'Fixture password for browser checks' } });
    assert.equal(register.status(), 201);
    const existing = (await register.json()).user;
    await page.reload();
    await page.locator('#avatar').filter({ hasText: 'E' }).waitFor();
    await account.click();
    await choice.waitFor();
    assert.equal(await choice.innerText(), 'Connect Google');
    cancelled = false;
    claims = { sub: 'existing-user', email: 'existing@example.com' };
    await choice.click();
    await page.getByText('Google is connected to your account.', { exact: true }).waitFor();
    check('Connecting Google preserves the existing password account',
      (await session())?.id === existing.id && (await session())?.google_connected);
    check('No uncaught browser errors', errors.length === 0);
    console.log(JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => mockGoogle.close(resolve));
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
