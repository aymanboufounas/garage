import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';

export function googleFixture() {
  const config = { clientId: 'garageshare-test.apps.googleusercontent.com', clientSecret: 'test-fixture-secret' };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  let exchanges = 0;
  return {
    config,
    get exchanges() { return exchanges; },
    authorize(location, overrides = {}, invalidSignature = false) {
      const request = new URL(location);
      assert.equal(request.origin + request.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
      assert.equal(request.searchParams.get('client_id'), config.clientId);
      assert.equal(request.searchParams.get('scope'), 'openid email profile');
      assert.equal(request.searchParams.get('code_challenge_method'), 'S256');
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: 'https://accounts.google.com', aud: config.clientId, sub: 'fixture-subject',
        nonce: request.searchParams.get('nonce'), iat: now, exp: now + 3600,
        email: 'Driver@Example.com', email_verified: true, name: 'Garage Driver', ...overrides };
      const code = randomUUID(), callback = new URL(request.searchParams.get('redirect_uri'));
      codes.set(code, { claims, invalidSignature, callback: callback.href, challenge: request.searchParams.get('code_challenge') });
      callback.searchParams.set('state', request.searchParams.get('state'));
      callback.searchParams.set('code', code);
      return callback;
    },
    async fetch(url, options) {
      assert.equal(options.redirect, 'error');
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [key] });
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(options.method, 'POST');
      const body = options.body;
      const code = body.get('code'), authorization = codes.get(code);
      exchanges++;
      if (!authorization) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      codes.delete(code);
      assert.equal(body.get('client_id'), config.clientId);
      assert.equal(body.get('client_secret'), config.clientSecret);
      assert.equal(body.get('redirect_uri'), authorization.callback);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), authorization.challenge);
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const payload = `${encode({ alg: 'RS256', kid: key.kid })}.${encode(authorization.claims)}`;
      const signature = authorization.invalidSignature ? 'YQ' : sign('sha256', Buffer.from(payload), privateKey).toString('base64url');
      return Response.json({ id_token: `${payload}.${signature}`, access_token: 'fixture-access-token' });
    }
  };
}
