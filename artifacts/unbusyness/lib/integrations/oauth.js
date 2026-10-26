// OAuth for Google and Microsoft. Client secrets come from server environment variables only.
// Tokens are stored encrypted (vault.js) and refreshed automatically.
'use strict';
const db = require('../db');
const vault = require('./vault');

const SCOPES = {
  google: {
    email: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
    calendar: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'],
  },
  microsoft: {
    email: ['offline_access', 'openid', 'email', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'],
    calendar: ['offline_access', 'openid', 'email', 'User.Read', 'Calendars.ReadWrite'],
  },
};
const PROVIDERS = {
  google: {
    label: 'Google', auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    id: () => process.env.GOOGLE_CLIENT_ID, secret: () => process.env.GOOGLE_CLIENT_SECRET,
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  microsoft: {
    label: 'Microsoft', auth: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/token`,
    id: () => process.env.MICROSOFT_CLIENT_ID, secret: () => process.env.MICROSOFT_CLIENT_SECRET,
    extra: { prompt: 'select_account', response_mode: 'query' },
  },
};
const configured = (p) => !!(PROVIDERS[p] && PROVIDERS[p].id() && PROVIDERS[p].secret());

function authUrl(provider, kind, { redirectUri, state, challenge }) {
  const p = PROVIDERS[provider];
  const u = new URL(p.auth);
  u.search = new URLSearchParams({
    client_id: p.id(), response_type: 'code', redirect_uri: redirectUri, scope: SCOPES[provider][kind].join(' '),
    state, code_challenge: challenge, code_challenge_method: 'S256', ...p.extra,
  }).toString();
  return u.toString();
}

async function tokenRequest(provider, params) {
  const p = PROVIDERS[provider];
  const r = await fetch(p.token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: p.id(), client_secret: p.secret(), ...params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `Token request failed (${r.status})`);
  return j;
}

const claims = (idToken) => { try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString()); } catch { return {}; } };

async function exchange(provider, kind, { code, redirectUri, verifier }) {
  const t = await tokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, ...(provider === 'microsoft' ? { scope: SCOPES.microsoft[kind].join(' ') } : {}) });
  const c = claims(t.id_token);
  return {
    account: c.email || c.preferred_username || c.upn || '',
    creds: { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000, scope: t.scope || SCOPES[provider][kind].join(' ') },
  };
}

// Returns a valid access token for an integration row, refreshing and saving if needed.
async function accessToken(row) {
  const creds = vault.open(row.credentials);
  if (creds.access_token && creds.expires_at > Date.now() + 60e3) return creds.access_token;
  if (!creds.refresh_token) throw new Error('The connection expired. Please reconnect.');
  try {
    const t = await tokenRequest(row.provider, { grant_type: 'refresh_token', refresh_token: creds.refresh_token, ...(row.provider === 'microsoft' ? { scope: SCOPES.microsoft[row.kind].join(' ') } : {}) });
    const next = { ...creds, access_token: t.access_token, refresh_token: t.refresh_token || creds.refresh_token, expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
    await db.query('UPDATE integrations SET credentials=$2 WHERE id=$1', [row.id, vault.seal(next)]);
    row.credentials = vault.seal(next);
    return next.access_token;
  } catch (e) {
    await db.query("UPDATE integrations SET status='error', last_error=$2 WHERE id=$1", [row.id, 'Reconnect needed: ' + e.message]);
    throw new Error('The connection expired. Please reconnect in Settings › Integrations.');
  }
}

async function revoke(row) {
  try {
    const creds = vault.open(row.credentials);
    if (row.provider === 'google' && (creds.refresh_token || creds.access_token)) {
      await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: creds.refresh_token || creds.access_token }) });
    }
  } catch { /* best effort; Microsoft tokens are removed by deleting them */ }
}

// Small JSON fetch helper with the bearer token.
async function api(row, url, opts = {}) {
  const token = await accessToken(row);
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 204) return null;
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; }
  if (!r.ok) { const e = new Error((j && j.error && (j.error.message || j.error)) || `Request failed (${r.status})`); e.status = r.status; throw e; }
  return j;
}

module.exports = { PROVIDERS, SCOPES, configured, authUrl, exchange, accessToken, revoke, api };
