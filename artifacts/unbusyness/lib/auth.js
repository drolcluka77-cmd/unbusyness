// Sessions + login. Production login uses Replit Auth (OpenID Connect with PKCE), no extra packages.
// For local testing or demos, DEV_LOGIN=1 enables a simple "name + email" login.
'use strict';
const crypto = require('crypto');
const db = require('./db');
const { parseCookies, setCookie, redirect, fail } = require('./http');
const { permissionsFor } = require('./rbac');

const COOKIE = 'ub_sid';
const SESSION_DAYS = 30;
const ISSUER = (process.env.ISSUER_URL || 'https://replit.com/oidc').replace(/\/$/, '');
const CLIENT_ID = process.env.REPL_ID || '';
const DEV_LOGIN = process.env.NODE_ENV !== 'production' && process.env.DEV_LOGIN === '1';

const rid = (n = 24) => crypto.randomBytes(n).toString('base64url');
const isSecure = (req) => (req.headers['x-forwarded-proto'] || '').includes('https');
const originOf = (req) => `${isSecure(req) ? 'https' : 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;

async function loadSession(req, res) {
  const sid = parseCookies(req)[COOKIE];
  req.session = null; req.user = null;
  if (sid) {
    const s = await db.one('SELECT * FROM sessions WHERE id=$1 AND expires_at > now()', [sid]);
    if (s) {
      req.session = { id: s.id, user_id: s.user_id, data: s.data || {} };
      if (s.user_id) req.user = await db.one('SELECT * FROM users WHERE id=$1 AND active', [s.user_id]);
    }
  }
  req.memberships = []; req.membership = null; req.perms = [];
  if (req.user) {
    // Every request runs inside ONE company: the membership chosen for this session.
    req.memberships = await db.many(`SELECT m.*, b.name AS business_name FROM memberships m JOIN businesses b ON b.id=m.business_id
      WHERE m.user_id=$1 AND m.active ORDER BY m.id`, [req.user.id]);
    const want = Number(req.session.data.business_id) || 0;
    const m = req.memberships.find((x) => x.business_id === want) || req.memberships[0] || null;
    req.membership = m;
    req.user.business_id = m ? m.business_id : null;
    req.user.role = m ? m.role : null;
    req.perms = m ? await permissionsFor(m.business_id, m.role) : [];
  }
}

async function ensureSession(req, res) {
  if (req.session) return req.session;
  const id = rid(32);
  await db.query("INSERT INTO sessions(id, data, expires_at) VALUES($1, '{}'::jsonb, now() + interval '1 day')", [id]);
  setCookie(res, COOKIE, id, { maxAge: 86400, secure: isSecure(req) });
  req.session = { id, user_id: null, data: {} };
  return req.session;
}

async function saveSessionData(req) {
  await db.query('UPDATE sessions SET data=$2 WHERE id=$1', [req.session.id, req.session.data]);
}

async function startUserSession(req, res, userId, data = {}) {
  if (req.session) await db.query('DELETE FROM sessions WHERE id=$1', [req.session.id]);
  const id = rid(32);
  await db.query(`INSERT INTO sessions(id, user_id, data, expires_at) VALUES($1,$2,$3, now() + interval '${SESSION_DAYS} days')`, [id, userId, data]);
  await db.query('UPDATE users SET last_login_at=now() WHERE id=$1', [userId]);
  setCookie(res, COOKIE, id, { maxAge: SESSION_DAYS * 86400, secure: isSecure(req) });
}

// Create or update a user from a login, then apply a pending team invite if there is one.
async function upsertUser({ sub, email, name }, pendingInvite) {
  let user = await db.one('SELECT * FROM users WHERE auth_sub=$1', [sub]);
  if (!user) {
    user = await db.one('INSERT INTO users(auth_sub, email, name, role) VALUES($1,$2,$3,$4) RETURNING *', [sub, email || '', name || email || 'Owner', 'owner']);
  } else if ((email && email !== user.email) || (!user.name && name)) {
    user = await db.one('UPDATE users SET email=COALESCE(NULLIF($2,\'\'), email), name=CASE WHEN name=\'\' THEN $3 ELSE name END WHERE id=$1 RETURNING *', [user.id, email || '', name || '']);
  }
  if (pendingInvite) {
    const r = await require('./invites').acceptInvite(user, pendingInvite);
    user.invite = r;
    if (r.status === 'joined') user.joinedBusiness = r.business_id;
  }
  return user;
}

// ---------- Replit Auth (OIDC) ----------
let discovery = null; let jwksCache = { at: 0, keys: [] };
async function discover() {
  if (discovery) return discovery;
  const r = await fetch(`${ISSUER}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error('Could not reach Replit Auth (' + r.status + ')');
  discovery = await r.json();
  return discovery;
}
async function jwks(force) {
  if (!force && Date.now() - jwksCache.at < 3600e3 && jwksCache.keys.length) return jwksCache.keys;
  const d = await discover();
  const r = await fetch(d.jwks_uri);
  jwksCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  return jwksCache.keys;
}
async function verifyIdToken(idToken, nonce) {
  const [h, p, s] = idToken.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  let keys = await jwks(); let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await jwks(true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error('Unknown signing key');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(`${h}.${p}`); const sig = Buffer.from(s, 'base64url');
  let ok;
  if (header.alg === 'RS256') ok = crypto.verify('RSA-SHA256', data, key, sig);
  else if (header.alg === 'ES256') ok = crypto.verify('SHA256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  else if (header.alg === 'PS256') ok = crypto.verify('SHA256', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
  else throw new Error('Unsupported token algorithm ' + header.alg);
  if (!ok) throw new Error('Invalid token signature');
  const d = await discover();
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== d.issuer) throw new Error('Wrong token issuer');
  if (!aud.includes(CLIENT_ID)) throw new Error('Wrong token audience');
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 < Date.now() - 60e3) throw new Error('Token expired');
  if (nonce && claims.nonce !== nonce) throw new Error('Wrong nonce');
  return claims;
}

function routes(router) {
  router.get('/api/login', async (req, res, ctx) => {
    if (!CLIENT_ID) return redirect(res, '/#/login');
    await ensureSession(req, res);
    const d = await discover();
    const verifier = rid(48);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = rid(16); const nonce = rid(16);
    Object.assign(req.session.data, { oidc: { verifier, state, nonce, returnTo: ctx.query.get('returnTo') || '/' } });
    await saveSessionData(req);
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      client_id: CLIENT_ID, response_type: 'code', scope: 'openid email profile offline_access', prompt: 'login consent',
      redirect_uri: `${originOf(req)}/api/callback`, state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    redirect(res, u.toString());
  });

  router.get('/api/callback', async (req, res, ctx) => {
    const o = req.session && req.session.data.oidc;
    if (!o || ctx.query.get('state') !== o.state) return redirect(res, '/#/login?error=state');
    const d = await discover();
    const r = await fetch(d.token_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: ctx.query.get('code') || '', redirect_uri: `${originOf(req)}/api/callback`, client_id: CLIENT_ID, code_verifier: o.verifier }),
    });
    const tok = await r.json();
    if (!r.ok || !tok.id_token) { console.error('Token exchange failed', r.status); return redirect(res, '/#/login?error=token'); }
    const c = await verifyIdToken(tok.id_token, o.nonce);
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.name || c.username || '';
    const user = await upsertUser({ sub: 'replit:' + c.sub, email: c.email, name }, req.session.data.invite);
    await startUserSession(req, res, user.id, { ...(user.joinedBusiness ? { business_id: user.joinedBusiness } : {}), ...(user.invite ? { notice: user.invite.status } : {}) });
    redirect(res, o.returnTo && /^\/(?![\/\\])/.test(o.returnTo) ? o.returnTo : '/');
  });

  router.get('/api/logout', async (req, res) => {
    if (req.session) await db.query('DELETE FROM sessions WHERE id=$1', [req.session.id]);
    setCookie(res, COOKIE, '', { maxAge: 0 });
    if (CLIENT_ID && req.user && String(req.user.auth_sub || '').startsWith('replit:')) {
      try {
        const d = await discover();
        if (d.end_session_endpoint) {
          const u = new URL(d.end_session_endpoint);
          u.search = new URLSearchParams({ client_id: CLIENT_ID, post_logout_redirect_uri: originOf(req) + '/' }).toString();
          return redirect(res, u.toString());
        }
      } catch { /* fall through */ }
    }
    redirect(res, '/');
  });

  // Simple login for local testing and demos (DEV_LOGIN=1)
  router.post('/api/dev-login', async (req, res, ctx) => {
    if (!DEV_LOGIN) fail(404, 'Not found');
    const email = String(ctx.body.email || '').trim().toLowerCase();
    if (!email) fail(400, 'Email is required');
    await ensureSession(req, res);
    const user = await upsertUser({ sub: 'dev:' + email, email, name: String(ctx.body.name || '').trim() }, req.session.data.invite);
    await startUserSession(req, res, user.id, { ...(user.joinedBusiness ? { business_id: user.joinedBusiness } : {}), ...(user.invite ? { notice: user.invite.status } : {}) });
    return { ok: true };
  });

  // Switch the active company (for people in more than one company)
  router.post('/api/companies/switch', async (req, res, ctx) => {
    if (!req.user) fail(401, 'Please log in');
    const id = Number(ctx.body.business_id);
    if (!req.memberships.some((m) => m.business_id === id)) fail(403, 'You are not a member of this company');
    req.session.data.business_id = id; await saveSessionData(req);
    return { ok: true };
  });

  // Team invite links: /join/<token>
  router.get('/join/:token', async (req, res, ctx) => {
    const inv = await db.one('SELECT * FROM invites WHERE token=$1 AND used_at IS NULL', [ctx.params.token]);
    if (!inv) return redirect(res, '/#/login?error=invite');
    if (req.user) {
      // Already signed in: only the invited address can join, and an existing membership never changes.
      const r = await require('./invites').acceptInvite(req.user, inv.token);
      if (r.status === 'joined') req.session.data.business_id = r.business_id;
      req.session.data.notice = r.status; await saveSessionData(req);
      return redirect(res, '/');
    }
    await ensureSession(req, res);
    req.session.data.invite = inv.token; await saveSessionData(req);
    redirect(res, '/#/login?invite=1');
  });
}

const requireUser = (req) => { if (!req.user) fail(401, 'Please log in'); };
const requireBusiness = (req) => { requireUser(req); if (!req.membership) fail(409, 'Create or join a company first'); };

module.exports = { loadSession, routes, requireUser, requireBusiness, saveSessionData, startUserSession, upsertUser, ensureSession, isSecure, DEV_LOGIN, rid, originOf };
