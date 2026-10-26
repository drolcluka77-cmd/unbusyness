// Settings › Integrations: connect email (Google, Microsoft, IMAP) and calendar (Google, Microsoft),
// plus the generic email API the rest of the app uses. All credentials stay on the server, encrypted.
'use strict';
const crypto = require('crypto');
const db = require('../db');
const { fail, redirect } = require('../http');
const { saveSessionData, originOf, rid } = require('../auth');
const { need, can } = require('../rbac');
const oauth = require('./oauth');
const vault = require('./vault');
const email = require('./email');
const calendar = require('./calendar');

const KINDS = { email: ['google', 'microsoft', 'imap'], calendar: ['google', 'microsoft'] };
const summary = (row) => (row ? { provider: row.provider, account: row.account, status: row.status, last_ok_at: row.last_ok_at, last_error: row.last_error, connected_at: row.created_at } : null);
const conn = (bizId, kind) => db.one('SELECT * FROM integrations WHERE business_id=$1 AND kind=$2', [bizId, kind]);
async function save(bizId, userId, kind, provider, account, creds, settings = {}) {
  await db.query(`INSERT INTO integrations(business_id, kind, provider, account, status, credentials, settings, connected_by, last_ok_at, last_error)
    VALUES($1,$2,$3,$4,'connected',$5,$6,$7,now(),NULL)
    ON CONFLICT (business_id, kind) DO UPDATE SET provider=EXCLUDED.provider, account=EXCLUDED.account, status='connected', credentials=EXCLUDED.credentials,
      settings=EXCLUDED.settings, connected_by=EXCLUDED.connected_by, last_ok_at=now(), last_error=NULL, created_at=now()`,
  [bizId, kind, provider, account || '', vault.seal(creds), settings, userId]);
}
async function mailbox(req) {
  const row = await conn(req.user.business_id, 'email');
  if (!row || row.status === 'disconnected') fail(409, 'No mailbox is connected. Connect one in Settings › Integrations.');
  return row;
}
const wrap = async (row, fn) => {
  try { const r = await fn(); await db.query("UPDATE integrations SET last_ok_at=now(), status='connected', last_error=NULL WHERE id=$1", [row.id]); return r; }
  catch (e) { await db.query('UPDATE integrations SET last_error=$2 WHERE id=$1', [row.id, String(e.message).slice(0, 500)]); fail(502, `${row.provider === 'imap' ? 'Mail server' : row.provider === 'google' ? 'Google' : 'Microsoft'}: ${e.message}`); }
};

function routes(router) {
  // Status for Settings › Integrations (never returns credentials)
  router.get('/api/integrations', async (req) => {
    need(req, 'integrations.manage');
    const [e, c] = await Promise.all([conn(req.user.business_id, 'email'), conn(req.user.business_id, 'calendar')]);
    const synced = await db.one('SELECT COUNT(*) FILTER (WHERE cal_event_id IS NOT NULL)::int AS synced, COUNT(*) FILTER (WHERE cal_error IS NOT NULL)::int AS failed FROM jobs WHERE business_id=$1', [req.user.business_id]);
    let imapReady = true; try { require.resolve('imapflow'); require.resolve('nodemailer'); require.resolve('mailparser'); } catch { imapReady = false; }
    return {
      encryption: vault.ready(), email: summary(e), calendar: summary(c), calendarStats: synced,
      available: { google: oauth.configured('google'), microsoft: oauth.configured('microsoft'), imap: imapReady },
      redirectUris: { google: `${originOf(req)}/api/integrations/oauth/google/callback`, microsoft: `${originOf(req)}/api/integrations/oauth/microsoft/callback` },
    };
  });

  // OAuth start → provider consent screen
  router.get('/api/integrations/oauth/:provider/start', async (req, res, ctx) => {
    need(req, 'integrations.manage');
    const { provider } = ctx.params; const kind = ctx.query.get('kind');
    if (!KINDS[kind] || !KINDS[kind].includes(provider) || provider === 'imap') fail(400, 'Unknown integration');
    if (!oauth.configured(provider)) fail(400, `${oauth.PROVIDERS[provider].label} is not set up on the server yet (missing client ID or secret).`);
    if (!vault.ready()) fail(503, 'ENCRYPTION_KEY is not set on the server.');
    const verifier = rid(48); const state = rid(16);
    req.session.data.oauth = { provider, kind, verifier, state, business_id: req.user.business_id };
    await saveSessionData(req);
    redirect(res, oauth.authUrl(provider, kind, { redirectUri: `${originOf(req)}/api/integrations/oauth/${provider}/callback`, state, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }));
  });
  router.get('/api/integrations/oauth/:provider/callback', async (req, res, ctx) => {
    const o = req.session && req.session.data.oauth;
    const back = (q) => redirect(res, `/#/settings/integrations?${q}`);
    if (!o || o.provider !== ctx.params.provider || ctx.query.get('state') !== o.state) return back('error=' + encodeURIComponent('The connection could not be verified. Please try again.'));
    if (ctx.query.get('error')) return back('error=' + encodeURIComponent(ctx.query.get('error_description') || ctx.query.get('error')));
    need(req, 'integrations.manage');
    if (req.user.business_id !== o.business_id) fail(403, 'Company changed during the connection. Please try again.');
    try {
      const { account, creds } = await oauth.exchange(o.provider, o.kind, { code: ctx.query.get('code') || '', redirectUri: `${originOf(req)}/api/integrations/oauth/${o.provider}/callback`, verifier: o.verifier });
      if (!creds.refresh_token) return back('error=' + encodeURIComponent('No long-term access was granted. Remove Unbusyness from your account permissions and connect again.'));
      await save(o.business_id, req.user.id, o.kind, o.provider, account, creds);
      delete req.session.data.oauth; await saveSessionData(req);
      if (o.kind === 'calendar') calendar.syncAll(o.business_id, originOf(req)).catch((e) => console.error('Initial calendar sync failed', e.message));
      return back(`connected=${o.kind}`);
    } catch (e) { return back('error=' + encodeURIComponent(e.message)); }
  });

  // IMAP/SMTP (manual onboarding): tested before it is saved
  router.post('/api/integrations/imap', async (req, res, ctx) => {
    need(req, 'integrations.manage');
    const b = ctx.body;
    const cfg = {
      imap_host: String(b.imap_host || '').trim(), imap_port: Number(b.imap_port) || 993, imap_secure: b.imap_secure !== false,
      smtp_host: String(b.smtp_host || '').trim(), smtp_port: Number(b.smtp_port) || 587,
      username: String(b.username || '').trim(), password: String(b.password || ''), smtp_username: String(b.smtp_username || '').trim(), smtp_password: String(b.smtp_password || ''),
      from_email: String(b.from_email || b.username || '').trim(), from_name: String(b.from_name || '').trim(),
    };
    if (!cfg.imap_host || !cfg.smtp_host || !cfg.username || !cfg.password) fail(400, 'IMAP host, SMTP host, username and password are required');
    const temp = { provider: 'imap', credentials: vault.seal(cfg) };
    try { await email.test(temp); } catch (e) { fail(400, 'Could not connect: ' + e.message); }
    await save(req.user.business_id, req.user.id, 'email', 'imap', cfg.from_email, cfg);
    return { ok: true };
  });

  router.post('/api/integrations/:kind/test', async (req, res, ctx) => {
    need(req, 'integrations.manage');
    const row = await conn(req.user.business_id, ctx.params.kind);
    if (!row) fail(404, 'Not connected');
    if (ctx.params.kind === 'email') return wrap(row, async () => { const t = await email.test(row); const threads = await email.listThreads(row, { limit: 3 }); return { ...t, threads }; });
    return wrap(row, () => calendar.test(row));
  });
  router.post('/api/integrations/:kind/disconnect', async (req, res, ctx) => {
    need(req, 'integrations.manage');
    const row = await conn(req.user.business_id, ctx.params.kind);
    if (!row) return { ok: true };
    if (row.provider !== 'imap') await oauth.revoke(row);
    await db.query('DELETE FROM integrations WHERE id=$1', [row.id]);
    if (row.kind === 'calendar') await db.query('UPDATE jobs SET cal_event_id=NULL, cal_provider=NULL, cal_error=NULL WHERE business_id=$1', [req.user.business_id]);
    return { ok: true };
  });
  router.post('/api/integrations/calendar/sync', async (req) => {
    need(req, 'calendar.manage');
    const row = await conn(req.user.business_id, 'calendar');
    if (!row) fail(409, 'No calendar is connected');
    const n = await calendar.syncAll(req.user.business_id, originOf(req));
    return { ok: true, jobs: n };
  });

  // ---- generic email API used by the app (works the same for every provider) ----
  router.get('/api/email/threads', async (req, res, ctx) => {
    need(req, 'email.use');
    const row = await mailbox(req);
    return wrap(row, () => email.listThreads(row, { q: String(ctx.query.get('q') || '').slice(0, 200), limit: Math.min(Number(ctx.query.get('limit')) || 20, 50) }));
  });
  router.get('/api/email/threads/:id', async (req, res, ctx) => {
    need(req, 'email.use');
    const row = await mailbox(req);
    return wrap(row, () => email.getThread(row, ctx.params.id));
  });
  const msgFrom = (b) => ({ to: String(b.to || '').slice(0, 1000), cc: String(b.cc || '').slice(0, 1000), subject: String(b.subject || '').slice(0, 300), text: String(b.text || '').slice(0, 50000),
    threadId: b.thread_id || undefined, inReplyTo: b.in_reply_to || undefined, replyToId: b.reply_to_id || undefined });
  router.post('/api/email/drafts', async (req, res, ctx) => {
    need(req, 'email.use');
    const row = await mailbox(req); const m = msgFrom(ctx.body);
    if (!m.to) fail(400, 'Who is the email for?');
    return wrap(row, () => email.createDraft(row, m));
  });
  router.post('/api/email/send', async (req, res, ctx) => {
    need(req, 'email.use');
    const row = await mailbox(req); const m = msgFrom(ctx.body);
    if (!m.to || !m.text) fail(400, 'Add a recipient and a message');
    const r = await wrap(row, () => email.send(row, m));
    await db.query("INSERT INTO outbox(business_id, channel, to_addr, subject, body, status) VALUES($1,'email',$2,$3,$4,'sent')", [req.user.business_id, m.to, m.subject, m.text]);
    return r;
  });
  router.get('/api/customers/:id/emails', async (req, res, ctx) => {
    need(req, 'email.use');
    const c = await db.one('SELECT email FROM customers WHERE id=$1 AND business_id=$2', [Number(ctx.params.id) || 0, req.user.business_id]);
    if (!c) fail(404, 'Not found');
    const row = await conn(req.user.business_id, 'email');
    if (!row || !c.email) return { connected: !!row, threads: [] };
    const q = row.provider === 'google' ? `from:${c.email} OR to:${c.email}` : c.email;
    return { connected: true, threads: await wrap(row, () => email.listThreads(row, { q, limit: 10 })) };
  });
}

// Used by services.sendEmail: send customer emails from the company's own mailbox when one is connected.
async function companyMailbox(bizId) {
  const row = await db.one("SELECT * FROM integrations WHERE business_id=$1 AND kind='email' AND status='connected'", [bizId]);
  return row || null;
}

module.exports = { routes, companyMailbox, can };
