import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { ApiError, audit, hash, id, transaction } from './core.mjs';
import { esc } from '../web/icons.js';
import { translationCatalog } from '../web/i18n.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ATTEMPT_MS = 10 * 60_000;
const SESSION_IDLE_MS = 30 * 60_000;
const unavailable = () => new ApiError('Google sign-in is unavailable.', 404);
const expired = () => new ApiError('This Google sign-in expired. Start again in GarageShare.', 409);
const validSecret = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const secret = () => randomBytes(32).toString('hex');

function androidAssociations(config) {
  return [
    ['ma.garageshare.app', config.androidCert],
    ['ma.garageshare.app.preview', config.previewCert]
  ].filter(([, fingerprint]) => fingerprint).map(([packageName, fingerprint]) => {
    if (!/^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/i.test(fingerprint)) {
      throw new Error('Use a colon-separated SHA-256 Android signing certificate fingerprint.');
    }
    return {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: packageName,
        sha256_cert_fingerprints: [fingerprint.toUpperCase()] }
    };
  });
}

async function claimsFromToken(token, keysFor, clientId, nonce) {
  if (typeof token !== 'string' || token.length > 16000) throw new Error('Missing Google ID token');
  const [head, body, signature, extra] = token.split('.');
  if (extra !== undefined || ![head, body, signature].every(part => /^[A-Za-z0-9_-]+$/.test(part ?? ''))) {
    throw new Error('Invalid Google ID token encoding');
  }
  const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Invalid Google ID token header');
  const keys = await keysFor(header.kid);
  const key = keys.find(candidate => candidate.kid === header.kid && candidate.kty === 'RSA' &&
    candidate.alg === 'RS256' && candidate.use === 'sig');
  if (!key || !verify('sha256', Buffer.from(`${head}.${body}`),
    createPublicKey({ key, format: 'jwk' }), Buffer.from(signature, 'base64url'))) {
    throw new Error('Invalid Google ID token signature');
  }
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || claims.aud !== clientId ||
      (claims.azp !== undefined && claims.azp !== clientId) || claims.nonce !== nonce ||
      !Number.isInteger(claims.exp) || claims.exp <= now || !Number.isInteger(claims.iat) || claims.iat > now + 60 ||
      typeof claims.sub !== 'string' || !/^[!-~]{1,255}$/.test(claims.sub) ||
      claims.email_verified !== true || typeof claims.email !== 'string' || claims.email.length > 190 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) {
    throw new Error('Invalid Google ID token claims');
  }
  const email = claims.email.toLowerCase();
  const name = (typeof claims.name === 'string' ? claims.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '').slice(0, 80);
  return { subject: claims.sub, email, name: name || email.split('@')[0].slice(0, 80) };
}

function privateHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex');
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function browserPage(res, language, titleKey, noteKey, href) {
  const index = ['en', 'fr', 'ar'].indexOf(language);
  const message = key => esc(translationCatalog[key][Math.max(0, index)]);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="${index < 0 ? 'en' : language}" dir="${language === 'ar' ? 'rtl' : 'ltr'}">
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${message(titleKey)} · GarageShare</title><link rel="stylesheet" href="/style.css"></head>
    <body><main class="google-result"><h1>${message(titleKey)}</h1><p>${message(noteKey)}</p>
    ${href ? `<a class="primary" href="${esc(href)}" rel="noreferrer">${message('googleReturnApp')}</a>` : ''}
    </main></body></html>`);
}

export function makeGoogleAuth({ db, origin, config = {}, request = fetch }) {
  const { clientId, clientSecret } = config;
  if (!clientId && !clientSecret) return null;
  if (!clientSecret || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId ?? '')) {
    throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for a Google Web application client.');
  }
  const parsed = new URL(origin);
  const secure = parsed.protocol === 'https:';
  if (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Google sign-in requires an HTTPS APP_ORIGIN outside localhost.');
  }
  const appLinks = secure ? androidAssociations(config) : [];
  const callback = `${origin}/auth/google/callback`;
  const cookieName = secure ? '__Host-garageshare-google' : 'garageshare_google';
  const setBrowserCookie = (res, token, age) => res.setHeader('Set-Cookie',
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`);
  const activeAttempt = clause => db.prepare(`SELECT a.* FROM google_attempts a
    JOIN sessions s ON s.token_hash=a.session_hash
    WHERE a.expires_at>? AND s.expires_at>? AND s.last_seen>? AND ${clause}`);
  const attempt = (query, ...values) => {
    const now = Date.now();
    return activeAttempt(query).get(now, now, now - SESSION_IDLE_MS, ...values);
  };

  let cachedKeys = [], keysUntil = 0;
  async function googleRequest(url, options = {}) {
    const response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Google authentication request failed');
    return response;
  }
  async function keysFor(keyId) {
    if (Date.now() < keysUntil && cachedKeys.some(key => key.kid === keyId)) return cachedKeys;
    const response = await googleRequest(KEYS_URL);
    const { keys } = await response.json();
    if (!Array.isArray(keys)) throw new Error('Invalid Google public keys');
    const seconds = Number(response.headers.get('cache-control')?.match(/\bmax-age=(\d+)/i)?.[1] ?? 300);
    cachedKeys = keys;
    keysUntil = Date.now() + Math.min(seconds, 3600) * 1000;
    return cachedKeys;
  }
  async function exchange(code, row) {
    const response = await googleRequest(TOKEN_URL, { method: 'POST', body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret, redirect_uri: callback,
      grant_type: 'authorization_code', code_verifier: row.verifier
    }) });
    const { id_token: token } = await response.json();
    return claimsFromToken(token, keysFor, clientId, row.nonce);
  }

  return {
    appLinks,
    prepare(session, data, language) {
      const { channel } = data;
      if (channel !== 'web' && channel !== 'android') throw new ApiError('Choose a Google sign-in channel.');
      if (channel === 'android' && !appLinks.length) throw unavailable();
      const launch = secret();
      transaction(db, () => {
        db.prepare('DELETE FROM google_attempts WHERE session_hash=?').run(session.token_hash);
        db.prepare(`INSERT INTO google_attempts(launch_hash,session_hash,channel,language,expires_at,status)
          VALUES(?,?,?,?,?,'prepared')`).run(hash(launch), session.token_hash, channel, language, Date.now() + ATTEMPT_MS);
      });
      return { url: `/auth/google/start?flow=${launch}` };
    },
    async browser(req, res, url, readCookie, sessionToken, language) {
      privateHeaders(res);
      if (req.method !== 'GET') throw new ApiError('Method not allowed.', 405);
      if (url.pathname === '/auth/google/android-return' && appLinks.length) {
        return browserPage(res, language, 'googleReturnApp', 'googleAppLinkFallback');
      }
      if (url.pathname === '/auth/google/start') {
        const flow = url.searchParams.get('flow');
        const row = validSecret(flow) && attempt("a.launch_hash=? AND a.status='prepared'", hash(flow));
        if (!row || (row.channel === 'web' && (!validSecret(sessionToken) || hash(sessionToken) !== row.session_hash))) {
          return browserPage(res, language, 'googleFailed', 'googleStartAgain');
        }
        const state = secret(), browser = secret(), nonce = secret(), verifier = secret();
        const updated = db.prepare(`UPDATE google_attempts SET status='opened',state_hash=?,browser_hash=?,nonce=?,verifier=?
          WHERE launch_hash=? AND status='prepared'`).run(hash(state), hash(browser), nonce, verifier, row.launch_hash);
        if (!updated.changes) return browserPage(res, row.language, 'googleFailed', 'googleStartAgain');
        const authorize = new URL(AUTH_URL);
        authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code',
          scope: 'openid email profile', state, nonce, prompt: 'select_account', code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
        setBrowserCookie(res, browser, ATTEMPT_MS / 1000);
        return redirect(res, authorize.href);
      }
      if (url.pathname !== '/auth/google/callback') throw unavailable();
      const state = url.searchParams.get('state'), browser = readCookie(req, cookieName);
      const row = validSecret(state) && validSecret(browser) &&
        attempt("a.state_hash=? AND a.browser_hash=? AND a.status='opened'", hash(state), hash(browser));
      if (!row) return browserPage(res, language, 'googleFailed', 'googleStartAgain');
      const changed = db.prepare(`UPDATE google_attempts SET status='verifying',state_hash=NULL,browser_hash=NULL
        WHERE launch_hash=? AND status='opened'`).run(row.launch_hash);
      if (!changed.changes) return browserPage(res, row.language, 'googleFailed', 'googleStartAgain');
      setBrowserCookie(res, '', 0);
      try {
        const code = url.searchParams.get('code');
        if (url.searchParams.has('error') || !code || code.length > 2048) throw new Error('Google sign-in was cancelled');
        const identity = await exchange(code, row);
        const proof = secret();
        const ready = db.prepare(`UPDATE google_attempts SET status='ready',proof_hash=?,identity=?,nonce=NULL,verifier=NULL
          WHERE launch_hash=? AND status='verifying' AND expires_at>?`).run(hash(proof), JSON.stringify(identity), row.launch_hash, Date.now());
        if (!ready.changes) throw new Error('Google sign-in expired during verification');
        if (row.channel === 'web') return redirect(res, `/index.html#google=${proof}`);
        return browserPage(res, row.language, 'googleApproved', 'googleReturnNote', `${origin}/auth/google/android-return#${proof}`);
      } catch {
        db.prepare('DELETE FROM google_attempts WHERE launch_hash=?').run(row.launch_hash);
        if (row.channel === 'web') return redirect(res, '/index.html#google=failed');
        return browserPage(res, row.language, 'googleFailed', 'googleStartAgain');
      }
    },
    // Runs in the same transaction as GarageShare session rotation.
    finish(session, proof) {
      const row = validSecret(proof) && attempt("a.session_hash=? AND a.proof_hash=? AND a.status='ready'",
        session.token_hash, hash(proof));
      if (!row) throw expired();
      const identity = JSON.parse(row.identity);
      const linked = db.prepare('SELECT user_id FROM google_identities WHERE subject=?').get(identity.subject);
      const existing = db.prepare('SELECT id FROM users WHERE email=?').get(identity.email);
      let userId = session.user_id || linked?.user_id;
      let action = 'google_login';
      if (session.user_id) {
        const own = db.prepare('SELECT subject FROM google_identities WHERE user_id=?').get(session.user_id);
        if (existing?.id !== session.user_id || (linked && linked.user_id !== session.user_id) ||
            (own && own.subject !== identity.subject)) throw new ApiError('Choose a Google account with the same email as your GarageShare account.', 409);
        action = 'google_connected';
      } else if (!userId) {
        if (existing) throw new ApiError('Sign in with your password first, then connect Google in your account.', 409);
        userId = id();
        db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(userId, identity.name, identity.email, '', Date.now());
        action = 'google_registered';
      }
      if (!linked) db.prepare('INSERT INTO google_identities VALUES(?,?,?)').run(identity.subject, userId, Date.now());
      audit(db, userId, action, userId);
      return userId;
    }
  };
}
