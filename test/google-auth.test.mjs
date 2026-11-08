import assert from 'node:assert/strict';
import test from 'node:test';
import { makeApp } from '../server/app.mjs';
import { googleFixture } from './helpers/google.mjs';

const ORIGIN = 'https://app.example.com';
const CERT = Array(32).fill('AB').join(':');
const PASSWORD = 'Local password fixture 43!';
const CALLBACK = url => url.pathname + url.search;

async function setup(t, { enabled = true, demo = false, android = false } = {}) {
  const provider = googleFixture();
  const google = enabled ? { ...provider.config, androidCert: android ? CERT : undefined } : undefined;
  const app = makeApp({ database: ':memory:', production: true, origin: ORIGIN, demo, google, googleFetch: provider.fetch });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  function client() {
    return {
      cookies: new Map(), csrf: '',
      async call(path, data, overrides = {}) {
        const headers = { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '), Origin: ORIGIN };
        if (data !== undefined) Object.assign(headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf });
        const r = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', redirect: 'manual',
          headers: { ...headers, ...overrides }, body: data === undefined ? undefined : JSON.stringify(data) });
        for (const cookie of r.headers.getSetCookie()) {
          const [pair] = cookie.split(';'), [key, value] = pair.split('=');
          if (value) this.cookies.set(key, value);
          else this.cookies.delete(key);
        }
        const json = r.headers.get('content-type')?.includes('application/json') ? await r.json() : null;
        if (json?.csrf) this.csrf = json.csrf;
        return { status: r.status, headers: r.headers, json, html: json ? '' : await r.text() };
      },
      async prepare(channel = 'web') {
        if (!this.csrf) await this.call('/api/session');
        const prepared = await this.call('/api/auth/google/start', { channel });
        assert.equal(prepared.status, 200);
        return prepared.json.url;
      },
      async finish(proof) { return this.call('/api/auth/google/finish', { proof }); }
    };
  }
  async function approve(browser, launch, claims, badSignature) {
    const started = await browser.call(launch);
    assert.equal(started.status, 303);
    const callback = provider.authorize(started.headers.get('location'), claims, badSignature);
    return browser.call(CALLBACK(callback));
  }
  return { app, provider, client, approve };
}

function proofFrom(result) {
  assert.equal(result.status, 303);
  const match = result.headers.get('location')?.match(/^\/index\.html#google=([a-f0-9]{64})$/);
  assert.ok(match, 'successful browser callback sends only a one-time proof in the fragment');
  return match[1];
}

test('Google stays disabled without configuration and in the preview', async t => {
  for (const flags of [{ enabled: false }, { demo: true }]) {
    const { client, provider } = await setup(t, flags);
    const browser = client();
    const config = (await browser.call('/api/config')).json;
    assert.equal(config.google_sign_in, false);
    assert.equal(config.google_android, false);
    await browser.call('/api/session');
    assert.equal((await browser.call('/api/auth/google/start', { channel: 'web' })).status, flags.demo ? 409 : 404);
    assert.equal(provider.exchanges, 0);
  }
});

test('web sign-in binds OAuth and the one-time proof to the starting session', async t => {
  const { app, client, provider, approve } = await setup(t);
  const browser = client(), other = client();
  assert.equal((await browser.call('/api/config')).json.google_sign_in, true);
  await browser.call('/api/session');
  assert.equal((await browser.call('/api/auth/google/start', { channel: 'web' }, { 'X-CSRF-Token': '' })).status, 403);
  const launch = await browser.prepare();
  assert.equal((await other.call(launch)).headers.get('location'), null);
  const start = await browser.call(launch);
  assert.equal(start.status, 303);
  assert.match(start.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  assert.equal(start.headers.get('referrer-policy'), 'no-referrer');
  const callback = provider.authorize(start.headers.get('location'));
  assert.equal((await other.call(CALLBACK(callback))).headers.get('location'), null);
  const invalidState = new URL(callback.href);
  invalidState.searchParams.set('state', 'a'.repeat(64));
  assert.equal((await browser.call(CALLBACK(invalidState))).headers.get('location'), null);
  assert.equal(provider.exchanges, 0);
  const proof = proofFrom(await browser.call(CALLBACK(callback)));
  assert.equal((await browser.call(CALLBACK(callback))).headers.get('location'), null);
  assert.equal(provider.exchanges, 1);
  await other.call('/api/session');
  assert.equal((await other.finish(proof)).status, 409);
  const oldCookie = browser.cookies.get('__Host-garageshare');
  const signedIn = await browser.finish(proof);
  assert.equal(signedIn.status, 200);
  const user = signedIn.json.user;
  assert.equal(user.email, 'driver@example.com');
  assert.equal(user.google_connected, true);
  assert.equal(user.staff_role, undefined);
  assert.notEqual(browser.cookies.get('__Host-garageshare'), oldCookie);
  assert.equal((await browser.finish(proof)).status, 409);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM google_attempts').get().n, 0);
  assert.equal((await other.call('/api/login', { email: user.email, password: PASSWORD })).status, 401);
  assert.equal((await browser.call('/api/logout', {})).status, 200);
  await browser.call('/api/session');
  const next = proofFrom(await approve(browser, await browser.prepare(), { email: 'changed@example.com' }));
  assert.equal((await browser.finish(next)).json.user.id, user.id);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
});

test('an existing password account is linked only by its signed-in owner', async t => {
  const { app, client, approve } = await setup(t);
  const owner = client(), guest = client();
  await owner.call('/api/session');
  const registration = await owner.call('/api/register', { email: 'driver@example.com', name: 'Existing Owner', password: PASSWORD });
  assert.equal(registration.status, 201);
  const userId = registration.json.user.id;
  const takeover = proofFrom(await approve(guest, await guest.prepare()));
  assert.equal((await guest.finish(takeover)).status, 409);
  assert.equal((await guest.call('/api/session')).json.user, null);
  const wrongAccount = proofFrom(await approve(owner, await owner.prepare(), { email: 'other@example.com' }));
  assert.equal((await owner.finish(wrongAccount)).status, 409);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM google_identities').get().n, 0);
  const matchingAccount = proofFrom(await approve(owner, await owner.prepare()));
  assert.equal((await owner.finish(matchingAccount)).json.user.id, userId);
  assert.equal((await owner.call('/api/session')).json.user.google_connected, true);
  assert.equal((await owner.call('/api/logout', {})).status, 200);
  await owner.call('/api/session');
  assert.equal((await owner.call('/api/login', { email: 'driver@example.com', password: PASSWORD })).json.user.id, userId);
  const linkedLogin = proofFrom(await approve(guest, await guest.prepare()));
  assert.equal((await guest.finish(linkedLogin)).json.user.id, userId);
});

test('untrusted and expired Google responses cannot create accounts', async t => {
  const { app, client, approve } = await setup(t);
  const browser = client();
  const badClaims = [{ iss: 'https://untrusted.example.com' }, { aud: 'other-client' }, { nonce: 'wrong' },
    { exp: Math.floor(Date.now() / 1000) - 5 }, { email_verified: false }, { azp: 'other-client' }, {}];
  for (const [index, claims] of badClaims.entries()) {
    const result = await approve(browser, await browser.prepare(), claims, index === badClaims.length - 1);
    assert.equal(result.headers.get('location'), '/index.html#google=failed');
  }
  const proof = proofFrom(await approve(browser, await browser.prepare()));
  app.db.prepare('UPDATE google_attempts SET expires_at=?').run(Date.now() - 1);
  assert.equal((await browser.finish(proof)).status, 409);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
});

test('Android returns through its app link and the browser cannot redeem the proof', async t => {
  const { app, client, approve } = await setup(t, { android: true });
  const native = client(), browser = client();
  assert.equal((await native.call('/api/config')).json.google_android, true);
  const links = await browser.call('/.well-known/assetlinks.json');
  assert.deepEqual(links.json, [{ relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'ma.garageshare.app', sha256_cert_fingerprints: [CERT] } }]);
  const launch = await native.prepare('android');
  const result = await approve(browser, launch);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const proof = result.html.match(/https:\/\/app\.example\.com\/auth\/google\/android-return#([a-f0-9]{64})/)?.[1];
  assert.ok(proof);
  await browser.call('/api/session');
  assert.equal((await browser.finish(proof)).status, 409);
  assert.equal((await native.finish(proof)).json.user.name, 'Garage Driver');
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM google_attempts').get().n, 0);
});
