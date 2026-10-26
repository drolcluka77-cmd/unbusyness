'use strict';
// Exercises the existing OIDC callback with signed test tokens; never bypasses app auth.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../../artifacts/unbusyness/lib/db');
const auth = require('../../artifacts/unbusyness/lib/auth');
const { createRouter } = require('../../artifacts/unbusyness/lib/http');
const { spawnSync } = require('node:child_process');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' };
const issuer = (process.env.ISSUER_URL || 'https://replit.com/oidc').replace(/\/$/, '');
const claims = { iss: issuer, aud: process.env.REPL_ID, sub: 'oidc-test-user', email: 'oidc-test@example.com', name: 'OIDC Test', nonce: 'test-nonce', exp: Math.floor(Date.now() / 1000) + 300 };
const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
const token = (c) => {
  const data = `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode(c)}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
};
let nextToken = token(claims);
let createdUser, createdSession;
const originalFetch = global.fetch;
global.fetch = async url => {
  if (String(url).endsWith('openid-configuration')) return { ok: true, json: async () => ({ issuer, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }) };
  if (String(url).endsWith('/jwks')) return { ok: true, json: async () => ({ keys: [jwk] }) };
  return { ok: true, status: 200, json: async () => ({ id_token: nextToken }) };
};
db.one = async (sql, params) => {
  if (sql.startsWith('INSERT INTO users')) { createdUser = params; return { id: 1, auth_sub: params[0], email: params[1], name: params[2] }; }
  return null;
};
db.query = async (sql, params) => { if (sql.includes('INSERT INTO sessions')) createdSession = params; return { rows: [] }; };
const router = createRouter();
auth.routes(router);
async function callback(state = 'test-state') {
  const headers = {};
  const res = { getHeader: k => headers[k], setHeader: (k, v) => headers[k] = v, writeHead: (status, h) => Object.assign(headers, h, { status }), end() {} };
  const req = { headers: { host: 'example.test', 'x-forwarded-proto': 'https' }, session: { id: 'old-session', data: { oidc: { verifier: 'test-verifier', state: 'test-state', nonce: 'test-nonce', returnTo: '//evil.example' } } } };
  const ctx = { query: new URLSearchParams({ state, code: 'test-code' }) };
  await router.match('GET', '/api/callback').handlers[0](req, res, ctx);
  return headers;
}
(async () => {
  const result = await callback();
  assert.equal(result.Location, '/');
  assert.equal(createdUser[0], 'replit:oidc-test-user');
  assert.equal(createdSession[1], 1);
  assert.match(result['Set-Cookie'][0], /Secure/);
  assert.match(result['Set-Cookie'][0], /HttpOnly/);
  assert.equal((await callback('wrong-state')).Location, '/#/login?error=state');
  nextToken = token({ ...claims, nonce: 'wrong-nonce' });
  await assert.rejects(callback(), /Wrong nonce/);
  nextToken = token({ ...claims, exp: 1 });
  await assert.rejects(callback(), /Token expired/);
  nextToken = token({ ...claims, aud: 'wrong-client' });
  await assert.rejects(callback(), /Wrong token audience/);
  const prod = spawnSync(process.execPath, ['-e', "const a=require('./artifacts/unbusyness/lib/auth');if(a.DEV_LOGIN)process.exit(1);"], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', DEV_LOGIN: '1' } });
  assert.equal(prod.status, 0);
  console.log('PASS OIDC signature, upsertUser/session, secure cookie, state/nonce/expiry/audience, safe return URL, production demo-login disabled');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; });
