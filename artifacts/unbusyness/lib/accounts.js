// Unbusyness accounts: email + password, email confirmation, password reset,
// and "Continue with Google / Microsoft". Users never need a Replit account.
// Uses the existing sessions (auth.js), memberships and invites. No extra packages.
'use strict';
const crypto = require('crypto');
const db = require('./db');
const { fail, redirect } = require('./http');
const { startUserSession, ensureSession, saveSessionData, originOf, rid } = require('./auth');
const { sendSystemEmail, layout } = require('./mailer');
const { PROVIDERS } = require('./integrations/oauth');

/* ---------- passwords (scrypt, built into Node) ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, len: 64 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(got, want);
}
const DUMMY = hashPassword(crypto.randomBytes(12).toString('hex')); // equal timing for unknown emails
const validPassword = (pw) => typeof pw === 'string' && pw.length >= 10 && pw.length <= 200;
const normEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 200);
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/* ---------- rate limit (per email and per IP, in memory; fine for one server) ---------- */
const attempts = new Map();
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function limited(keys) {
  const now = Date.now();
  return keys.some((k) => { const a = (attempts.get(k) || []).filter((t) => now - t < 15 * 60e3); attempts.set(k, a); return a.length >= 5; });
}
const failed = (keys) => keys.forEach((k) => attempts.set(k, [...(attempts.get(k) || []), Date.now()]));
const cleared = (keys) => keys.forEach((k) => attempts.delete(k));
setInterval(() => { const now = Date.now(); for (const [k, a] of attempts) if (!a.some((t) => now - t < 15 * 60e3)) attempts.delete(k); }, 10 * 60e3).unref();

/* ---------- one-time tokens (only the hash is stored) ---------- */
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
async function makeToken(userId, type, minutes) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query('UPDATE auth_tokens SET used_at=now() WHERE user_id=$1 AND type=$2 AND used_at IS NULL', [userId, type]);
  await db.query(`INSERT INTO auth_tokens(user_id, type, token_hash, expires_at) VALUES($1,$2,$3, now() + interval '${Number(minutes)} minutes')`, [userId, type, sha(token)]);
  return token;
}
async function useToken(token, type) {
  const row = await db.one('UPDATE auth_tokens SET used_at=now() WHERE token_hash=$1 AND type=$2 AND used_at IS NULL AND expires_at > now() RETURNING user_id', [sha(String(token || '')), type]);
  return row ? row.user_id : null;
}

async function sendVerify(req, user) {
  const token = await makeToken(user.id, 'verify', 24 * 60);
  const url = `${originOf(req)}/api/auth/verify?token=${token}`;
  return sendSystemEmail(user.email, 'Confirm your email for Unbusyness',
    `Hi ${user.name || ''},\n\nPlease confirm your email address:\n${url}\n\nThe link works for 24 hours.`,
    layout({ title: 'Confirm your email', intro: `Hi ${user.name || 'there'}, please confirm your email address to finish setting up your Unbusyness account.`, button: 'Confirm email', url, outro: 'The link works for 24 hours. If you did not create an account, ignore this email.' }),
    'confirmation');
}

// Join the company from a pending invite (same rules as auth.js upsertUser).
async function joinInvite(userId, token) {
  if (!token) return null;
  const inv = await db.one('SELECT * FROM invites WHERE token=$1 AND used_at IS NULL', [token]);
  if (!inv) return null;
  await db.query(`INSERT INTO memberships(business_id, user_id, role, trade_role, color) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT (business_id, user_id) DO UPDATE SET role=EXCLUDED.role, trade_role=EXCLUDED.trade_role, active=TRUE`,
  [inv.business_id, userId, inv.role, inv.trade_role || '', ['#E8915F', '#4F5F80', '#8A5A9E', '#2F7A55', '#B23A32'][userId % 5]]);
  await db.query('UPDATE invites SET used_at=now() WHERE token=$1', [inv.token]);
  return inv.business_id;
}
async function finishLogin(req, res, user) {
  const invite = req.session && req.session.data.invite;
  const joined = await joinInvite(user.id, invite);
  await startUserSession(req, res, user.id, joined ? { business_id: joined } : {}); // new session id on every login
}

/* ---------- Google / Microsoft login (only openid email profile) ---------- */
const LOGIN_SCOPES = 'openid email profile';
const loginConfigured = (p) => !!(PROVIDERS[p] && PROVIDERS[p].id() && PROVIDERS[p].secret());
const claimsOf = (t) => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()); } catch { return {}; } };
async function findByIdentity(provider, subject) {
  const row = await db.one('SELECT u.* FROM user_identities i JOIN users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2 AND u.active', [provider, subject]);
  return row || db.one('SELECT * FROM users WHERE auth_sub=$1 AND active', [`${provider}:${subject}`]);
}
const addIdentity = (userId, provider, subject, email) => db.query('INSERT INTO user_identities(user_id, provider, subject, email) VALUES($1,$2,$3,$4) ON CONFLICT (provider, subject) DO NOTHING', [userId, provider, subject, email || '']);

function routes(router) {
  router.get('/api/auth/config', async () => ({
    google: loginConfigured('google'), microsoft: loginConfigured('microsoft'),
    replit: process.env.SHOW_REPLIT_LOGIN === '1' || (!!process.env.REPL_ID && process.env.REPLIT_DEPLOYMENT !== '1' && process.env.NODE_ENV !== 'production'),
  }));

  router.post('/api/auth/signup', async (req, res, ctx) => {
    const email = normEmail(ctx.body.email); const name = String(ctx.body.name || '').trim().slice(0, 100); const pw = ctx.body.password;
    if (!name) fail(400, 'Please enter your name');
    if (!validEmail(email)) fail(400, 'Please enter a valid email address');
    if (!validPassword(pw)) fail(400, 'The password needs at least 10 characters');
    if (limited([`ip:${ipOf(req)}:signup`])) fail(429, 'Too many attempts. Please wait 15 minutes.');
    failed([`ip:${ipOf(req)}:signup`]);
    const exists = await db.one('SELECT id FROM users WHERE lower(email)=$1 LIMIT 1', [email]);
    if (exists) fail(409, 'An account with this email already exists. Log in or reset your password.');
    const user = await db.one('INSERT INTO users(auth_sub, email, name, role, password_hash) VALUES($1,$2,$3,$4,$5) RETURNING *', [`email:${email}`, email, name, 'owner', hashPassword(pw)]);
    await ensureSession(req, res);
    await finishLogin(req, res, user);
    const delivery = await sendVerify(req, user);
    return { ok: true, verifySent: delivery };
  });

  router.post('/api/auth/login', async (req, res, ctx) => {
    const email = normEmail(ctx.body.email); const pw = String(ctx.body.password || '');
    const keys = [`email:${email}`, `ip:${ipOf(req)}`];
    if (limited(keys)) fail(429, 'Too many attempts. Please wait 15 minutes or reset your password.');
    const user = email ? await db.one('SELECT * FROM users WHERE lower(email)=$1 AND password_hash IS NOT NULL AND active ORDER BY id LIMIT 1', [email]) : null;
    const ok = checkPassword(pw, user ? user.password_hash : DUMMY) && !!user;
    if (!ok) { failed(keys); fail(401, 'Email or password is incorrect'); }
    cleared(keys);
    await ensureSession(req, res);
    await finishLogin(req, res, user);
    return { ok: true };
  });

  router.get('/api/auth/verify', async (req, res, ctx) => {
    const userId = await useToken(ctx.query.get('token'), 'verify');
    if (!userId) return redirect(res, '/#/login?notice=verify-expired');
    await db.query('UPDATE users SET email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1', [userId]);
    redirect(res, '/#/?notice=verified');
  });
  router.post('/api/auth/verify/resend', async (req) => {
    if (!req.user) fail(401, 'Please log in');
    if (req.user.email_verified_at) return { ok: true, already: true };
    if (limited([`verify:${req.user.id}`])) fail(429, 'Please wait a few minutes before asking again.');
    failed([`verify:${req.user.id}`]);
    return { ok: true, delivery: await sendVerify(req, req.user) };
  });

  router.post('/api/auth/forgot', async (req, res, ctx) => {
    const email = normEmail(ctx.body.email);
    if (limited([`forgot:${ipOf(req)}`])) fail(429, 'Too many attempts. Please wait 15 minutes.');
    failed([`forgot:${ipOf(req)}`]);
    const user = validEmail(email) ? await db.one('SELECT * FROM users WHERE lower(email)=$1 AND active ORDER BY id LIMIT 1', [email]) : null;
    if (user) {
      const token = await makeToken(user.id, 'reset', 60);
      const url = `${originOf(req)}/#/reset?token=${token}`;
      await sendSystemEmail(user.email, 'Reset your Unbusyness password', `Reset your password here:\n${url}\n\nThe link works for 1 hour. If you did not ask for this, ignore this email.`,
        layout({ title: 'Reset your password', intro: 'Click the button to choose a new password.', button: 'Choose a new password', url, outro: 'The link works for 1 hour and only once. If you did not ask for this, you can ignore this email.' }),
        'password_reset');
    }
    return { ok: true }; // same answer whether or not the email exists
  });
  router.post('/api/auth/reset', async (req, res, ctx) => {
    const pw = ctx.body.password;
    if (!validPassword(pw)) fail(400, 'The password needs at least 10 characters');
    const userId = await useToken(ctx.body.token, 'reset');
    if (!userId) fail(400, 'This link has expired or was already used. Ask for a new one.');
    await db.query('UPDATE users SET password_hash=$2, email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1', [userId, hashPassword(pw)]);
    await db.query('DELETE FROM sessions WHERE user_id=$1', [userId]); // log out everywhere
    const user = await db.one('SELECT * FROM users WHERE id=$1', [userId]);
    cleared([`email:${normEmail(user.email)}`, `ip:${ipOf(req)}`]);
    await ensureSession(req, res);
    await finishLogin(req, res, user);
    return { ok: true };
  });

  // Account page
  router.get('/api/auth/account', async (req) => {
    if (!req.user) fail(401, 'Please log in');
    const ids = await db.many('SELECT provider, email, created_at FROM user_identities WHERE user_id=$1', [req.user.id]);
    const legacy = String(req.user.auth_sub || '').split(':')[0];
    return { name: req.user.name, email: req.user.email, verified: !!req.user.email_verified_at, password: !!req.user.password_hash, identities: ids, legacy: ['replit', 'google', 'microsoft'].includes(legacy) ? legacy : null, google: loginConfigured('google'), microsoft: loginConfigured('microsoft') };
  });
  router.put('/api/auth/account', async (req, res, ctx) => {
    if (!req.user) fail(401, 'Please log in');
    const name = String(ctx.body.name || '').trim().slice(0, 100);
    if (!name) fail(400, 'Please enter your name');
    await db.query('UPDATE users SET name=$2 WHERE id=$1', [req.user.id, name]);
    return { ok: true };
  });
  router.post('/api/auth/password', async (req, res, ctx) => {
    if (!req.user) fail(401, 'Please log in');
    const { current, password } = ctx.body;
    if (!validPassword(password)) fail(400, 'The new password needs at least 10 characters');
    if (req.user.password_hash) {
      if (limited([`pw:${req.user.id}`])) fail(429, 'Too many attempts. Please wait 15 minutes.');
      if (!checkPassword(String(current || ''), req.user.password_hash)) { failed([`pw:${req.user.id}`]); fail(400, 'Your current password is not correct'); }
    }
    await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, hashPassword(password)]);
    await db.query('DELETE FROM sessions WHERE user_id=$1 AND id<>$2', [req.user.id, req.session.id]); // log out other devices
    return { ok: true };
  });

  // Continue with Google / Microsoft  (?link=1 when already logged in = connect to this account)
  router.get('/api/auth/oauth/:provider/start', async (req, res, ctx) => {
    const { provider } = ctx.params;
    if (!loginConfigured(provider)) fail(404, 'This login method is not available');
    await ensureSession(req, res);
    const verifier = rid(48); const state = rid(16); const nonce = rid(16);
    req.session.data.login_oauth = { provider, verifier, state, nonce, link: ctx.query.get('link') === '1' && !!req.user };
    await saveSessionData(req);
    const p = PROVIDERS[provider];
    const u = new URL(p.auth);
    u.search = new URLSearchParams({
      client_id: p.id(), response_type: 'code', redirect_uri: `${originOf(req)}/api/auth/oauth/${provider}/callback`, scope: LOGIN_SCOPES, state, nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account',
    }).toString();
    redirect(res, u.toString());
  });
  router.get('/api/auth/oauth/:provider/callback', async (req, res, ctx) => {
    const o = req.session && req.session.data.login_oauth;
    const back = (msg) => redirect(res, `/#/login?error=${encodeURIComponent(msg)}`);
    const { provider } = ctx.params;
    if (!o || o.provider !== provider || ctx.query.get('state') !== o.state) return back('The login could not be verified. Please try again.');
    if (ctx.query.get('error')) return back(ctx.query.get('error_description') || 'Login was cancelled.');
    const p = PROVIDERS[provider];
    let tok;
    try {
      const r = await fetch(p.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: p.id(), client_secret: p.secret(), grant_type: 'authorization_code', code: ctx.query.get('code') || '', redirect_uri: `${originOf(req)}/api/auth/oauth/${provider}/callback`, code_verifier: o.verifier, ...(provider === 'microsoft' ? { scope: LOGIN_SCOPES } : {}) }) });
      tok = await r.json();
      if (!r.ok || !tok.id_token) throw new Error(tok.error_description || tok.error || 'No ID token');
    } catch (e) { console.error('Login token exchange failed', e.message); return back('Login failed. Please try again.'); }
    // The ID token comes straight from the provider over TLS; check who it is for and that it is fresh.
    const c = claimsOf(tok.id_token);
    if (c.aud !== p.id() && !(Array.isArray(c.aud) && c.aud.includes(p.id()))) return back('Login failed (wrong audience).');
    if (c.nonce && c.nonce !== o.nonce) return back('Login failed (nonce).');
    if (!c.exp || c.exp * 1000 < Date.now() - 60e3) return back('Login expired. Please try again.');
    const subject = provider === 'microsoft' ? (c.oid ? `${c.tid || ''}:${c.oid}` : c.sub) : c.sub;
    const email = normEmail(c.email || (provider === 'microsoft' ? c.preferred_username : ''));
    // Google tells us if the email is verified. Microsoft does not reliably, so we never auto-link Microsoft by email.
    const emailVerified = provider === 'google' ? c.email_verified === true || c.email_verified === 'true' : false;
    const name = String(c.name || [c.given_name, c.family_name].filter(Boolean).join(' ') || '').slice(0, 100);
    delete req.session.data.login_oauth; await saveSessionData(req);

    let user = await findByIdentity(provider, subject);
    if (o.link) {
      if (!req.user) return back('Please log in first.');
      if (user && user.id !== req.user.id) return redirect(res, '/#/account?error=' + encodeURIComponent('This account is already used by another Unbusyness user.'));
      await addIdentity(req.user.id, provider, subject, email);
      return redirect(res, '/#/account?notice=linked');
    }
    if (!user && email) {
      const existing = await db.one('SELECT * FROM users WHERE lower(email)=$1 AND active ORDER BY id LIMIT 1', [email]);
      if (existing) {
        if (emailVerified && (existing.email_verified_at || !existing.password_hash)) { user = existing; await addIdentity(user.id, provider, subject, email); }
        else return back(`An account with ${email} already exists. Log in with your password, then connect ${p.label} under Account.`);
      }
    }
    if (!user) {
      user = await db.one('INSERT INTO users(auth_sub, email, name, role, email_verified_at) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [`${provider}:${subject}`, email, name || email, 'owner', emailVerified ? new Date().toISOString() : null]);
      await addIdentity(user.id, provider, subject, email);
    }
    if (emailVerified && !user.email_verified_at && normEmail(user.email) === email) await db.query('UPDATE users SET email_verified_at=now() WHERE id=$1', [user.id]);
    await finishLogin(req, res, user);
    redirect(res, '/');
  });
  router.post('/api/auth/identities/:provider/remove', async (req, res, ctx) => {
    if (!req.user) fail(401, 'Please log in');
    const others = await db.one('SELECT COUNT(*)::int AS n FROM user_identities WHERE user_id=$1 AND provider<>$2', [req.user.id, ctx.params.provider]);
    if (!req.user.password_hash && others.n === 0) fail(400, 'Set a password first, so you can still log in.');
    await db.query('DELETE FROM user_identities WHERE user_id=$1 AND provider=$2', [req.user.id, ctx.params.provider]);
    return { ok: true };
  });
}

// Blocks cross-site form/fetch posts to the API (CSRF). Webhooks from other servers are allowed.
function originAllowed(req, pathname) {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) || !pathname.startsWith('/api/')) return true;
  if (pathname.startsWith('/api/voice/') || pathname.startsWith('/api/webhooks/')) return true;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients; browsers always send Origin on these requests
  return origin === originOf(req);
}

module.exports = { routes, originAllowed, hashPassword, checkPassword };
