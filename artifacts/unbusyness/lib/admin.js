// Unbusyness team console (#/admin): see every company and user, fix roles, and follow what is happening.
//
// Who is a platform admin: only the addresses in the PLATFORM_ADMINS secret (comma separated),
// and only when that account's email is confirmed. Nobody can become an admin from inside the app.
// Every change made here is written to admin_audit (who, what, before → after).
// The console never shows passwords, tokens, mailbox credentials or payment details.
'use strict';
const crypto = require('crypto');
const db = require('./db');
const { fail } = require('./http');
const { ROLES } = require('./rbac');
const L = require('./lists');

const adminEmails = () => String(process.env.PLATFORM_ADMINS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
function isPlatformAdmin(user) {
  if (!user || !user.active || !user.email) return false;
  if (!adminEmails().includes(String(user.email).toLowerCase())) return false;
  // The address must be confirmed (email link or a verified Google/Microsoft address). Replit logins come verified;
  // the development-only demo login is accepted outside production.
  const sub = String(user.auth_sub || '');
  return !!user.email_verified_at || sub.startsWith('replit:') || (sub.startsWith('dev:') && process.env.NODE_ENV !== 'production');
}
function needAdmin(req) {
  if (!req.user) fail(401, 'Please log in');
  if (!isPlatformAdmin(req.user)) fail(404, 'Not found'); // do not reveal that the console exists
}
async function audit(req, action, { businessId = null, userId = null, details = {} } = {}) {
  await db.query('INSERT INTO admin_audit(admin_user_id, admin_email, action, business_id, target_user_id, details) VALUES($1,$2,$3,$4,$5,$6)',
    [req.user.id, req.user.email, action, businessId, userId, details]);
}
const inviteId = (token) => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
const activeOwners = (bizId) => db.one("SELECT COUNT(*)::int AS n FROM memberships WHERE business_id=$1 AND role='owner' AND active", [bizId]).then((r) => r.n);

function routes(router) {
  router.get('/api/admin/overview', async (req) => {
    needAdmin(req);
    const [totals, signups, companies, activity, auditRows] = await Promise.all([
      db.one(`SELECT (SELECT COUNT(*)::int FROM businesses) AS companies, (SELECT COUNT(*)::int FROM users WHERE active) AS users,
        (SELECT COUNT(*)::int FROM users WHERE created_at > now() - interval '7 days') AS users_7d,
        (SELECT COUNT(*)::int FROM businesses WHERE created_at > now() - interval '7 days') AS companies_7d,
        (SELECT COUNT(*)::int FROM calls WHERE created_at > now() - interval '7 days') AS calls_7d,
        (SELECT COUNT(*)::int FROM jobs WHERE created_at > now() - interval '7 days') AS jobs_7d,
        (SELECT COALESCE(SUM(total),0)::float FROM invoices WHERE status='paid' AND paid_at > now() - interval '30 days') AS paid_30d,
        (SELECT COUNT(*)::int FROM businesses b WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.business_id=b.id AND m.role='owner' AND m.active)) AS no_owner`),
      db.many(`SELECT u.id, u.email, u.name, u.created_at, u.email_verified_at IS NOT NULL AS verified,
        (SELECT string_agg(b.name || ' (' || m.role || ')', ', ') FROM memberships m JOIN businesses b ON b.id=m.business_id WHERE m.user_id=u.id AND m.active) AS companies
        FROM users u ORDER BY u.id DESC LIMIT 10`),
      db.many(`SELECT b.id, b.name, b.trade, b.created_at, (SELECT COUNT(*)::int FROM memberships m WHERE m.business_id=b.id AND m.active) AS members
        FROM businesses b ORDER BY b.id DESC LIMIT 8`),
      db.many(`SELECT a.kind, a.text, a.created_at, a.business_id, b.name AS business_name FROM activity a JOIN businesses b ON b.id=a.business_id ORDER BY a.id DESC LIMIT 30`),
      db.many('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 15'),
    ]);
    return { totals, signups, companies, activity, audit: auditRows };
  });

  router.get('/api/admin/companies', async (req, res, ctx) => {
    needAdmin(req);
    const q = ctx.query; const w = L.where('TRUE AND $1::int IS NOT NULL', 1);
    if (L.str(q.get('q'))) w.add(`(b.name ILIKE ? OR b.email ILIKE ? OR EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=b.id AND u.email ILIKE ?))`, `%${L.str(q.get('q'), 100)}%`);
    if (q.get('f') === 'no_owner') w.add("NOT EXISTS (SELECT 1 FROM memberships m WHERE m.business_id=b.id AND m.role='owner' AND m.active)");
    const p = L.paging(q, { name: 'lower(b.name)', created: 'b.created_at', members: 'members', last: 'last_activity' }, 'created', 'desc', 'b.id');
    const base = `SELECT b.id, b.name, b.trade, b.created_at, b.currency, b.plan,
        (SELECT COUNT(*)::int FROM memberships m WHERE m.business_id=b.id AND m.active) AS members,
        (SELECT string_agg(u.email, ', ') FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=b.id AND m.role='owner' AND m.active) AS owners,
        (SELECT COUNT(*)::int FROM calls c WHERE c.business_id=b.id) AS calls, (SELECT COUNT(*)::int FROM jobs j WHERE j.business_id=b.id) AS jobs,
        (SELECT COUNT(*)::int FROM invoices i WHERE i.business_id=b.id) AS invoices,
        (SELECT MAX(created_at) FROM activity a WHERE a.business_id=b.id) AS last_activity
      FROM businesses b WHERE ${w.sql()}`;
    const [rows, t] = await Promise.all([
      db.many(`SELECT * FROM (${base}) b ORDER BY ${p.order} LIMIT ${p.per} OFFSET ${p.offset}`, w.params),
      db.one(`SELECT COUNT(*)::int AS n FROM businesses b WHERE ${w.sql()}`, w.params),
    ]);
    return L.pageResult(rows, t.n, p);
  });

  router.get('/api/admin/companies/:id', async (req, res, ctx) => {
    needAdmin(req);
    const id = Number(ctx.params.id) || 0;
    const b = await db.one(`SELECT id, name, trade, address, phone, email, currency, timezone, plan, stripe_ready, voice_provider, created_at,
      (stripe_account IS NOT NULL) AS stripe_connected FROM businesses WHERE id=$1`, [id]);
    if (!b) fail(404, 'Not found');
    const [members, invitesRows, activity, counts, integ, voice, outbox] = await Promise.all([
      db.many(`SELECT u.id, u.email, u.name, u.active AS user_active, u.email_verified_at IS NOT NULL AS verified, u.last_login_at, m.role, m.trade_role, m.active, m.created_at
        FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=$1 ORDER BY m.active DESC, m.role, u.id`, [id]),
      db.many("SELECT token, email, role, name, created_at FROM invites WHERE business_id=$1 AND used_at IS NULL ORDER BY created_at DESC", [id]),
      db.many('SELECT kind, text, created_at FROM activity WHERE business_id=$1 ORDER BY id DESC LIMIT 40', [id]),
      db.one(`SELECT (SELECT COUNT(*)::int FROM customers WHERE business_id=$1) AS customers, (SELECT COUNT(*)::int FROM calls WHERE business_id=$1) AS calls,
        (SELECT COUNT(*)::int FROM jobs WHERE business_id=$1) AS jobs, (SELECT COUNT(*)::int FROM quotes WHERE business_id=$1) AS quotes,
        (SELECT COUNT(*)::int FROM invoices WHERE business_id=$1) AS invoices,
        (SELECT COALESCE(SUM(total),0)::float FROM invoices WHERE business_id=$1 AND status='paid') AS paid_total,
        (SELECT COALESCE(SUM(total),0)::float FROM invoices WHERE business_id=$1 AND status='sent') AS unpaid_total`, [id]),
      db.many('SELECT kind, provider, account, status, last_ok_at, last_error FROM integrations WHERE business_id=$1', [id]),
      db.many('SELECT provider, kind, name, status, error, created_at FROM voice_events WHERE business_id=$1 ORDER BY id DESC LIMIT 20', [id]),
      db.many(`SELECT channel, to_addr, subject, status, error, created_at FROM outbox WHERE business_id=$1 ORDER BY id DESC LIMIT 20`, [id]),
    ]);
    // invite tokens are secrets: show only a short hint so the console cannot be used to grab a join link
    return { company: b, members, invites: invitesRows.map(({ token, ...i }) => ({ ...i, id: inviteId(token) })), activity, counts, integrations: integ, voice, outbox,
      roles: Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label })) };
  });

  // Change a member's role or remove/restore them. Never leaves a company without an active owner.
  router.put('/api/admin/companies/:id/members/:userId', async (req, res, ctx) => {
    needAdmin(req);
    const bizId = Number(ctx.params.id) || 0; const userId = Number(ctx.params.userId) || 0;
    const m = await db.one('SELECT * FROM memberships WHERE business_id=$1 AND user_id=$2', [bizId, userId]);
    if (!m) fail(404, 'This person is not a member of this company');
    const role = ctx.body.role !== undefined ? String(ctx.body.role) : m.role;
    if (!ROLES[role]) fail(400, 'Unknown role');
    const active = ctx.body.active !== undefined ? ctx.body.active !== false : m.active;
    const losesOwner = m.role === 'owner' && m.active && (role !== 'owner' || !active);
    if (losesOwner && await activeOwners(bizId) <= 1) fail(409, 'This is the only owner. Make someone else owner first.');
    await db.query('UPDATE memberships SET role=$3, active=$4 WHERE business_id=$1 AND user_id=$2', [bizId, userId, role, active]);
    await audit(req, 'membership.update', { businessId: bizId, userId, details: { before: { role: m.role, active: m.active }, after: { role, active }, reason: String(ctx.body.reason || '').slice(0, 300) } });
    return { ok: true };
  });

  // Add an existing user to a company (e.g. restore an owner who lost access)
  router.post('/api/admin/companies/:id/members', async (req, res, ctx) => {
    needAdmin(req);
    const bizId = Number(ctx.params.id) || 0;
    if (!await db.one('SELECT id FROM businesses WHERE id=$1', [bizId])) fail(404, 'Not found');
    const email = String(ctx.body.email || '').trim().toLowerCase(); const role = ROLES[ctx.body.role] ? ctx.body.role : 'worker';
    const users = await db.many('SELECT id FROM users WHERE lower(email)=$1 AND active ORDER BY id', [email]);
    if (!users.length) fail(404, 'No account with this email. Ask them to sign up first, or send a team invite.');
    if (users.length > 1) fail(409, 'More than one account uses this email. Change the role on the right account in the member list.');
    const u = users[0];
    const before = await db.one('SELECT role, active FROM memberships WHERE business_id=$1 AND user_id=$2', [bizId, u.id]);
    if (before && before.active) fail(409, 'Already a member. Change their role in the member list.');
    await db.query(`INSERT INTO memberships(business_id, user_id, role) VALUES($1,$2,$3)
      ON CONFLICT (business_id, user_id) DO UPDATE SET role=EXCLUDED.role, active=TRUE`, [bizId, u.id, role]);
    await audit(req, 'membership.add', { businessId: bizId, userId: u.id, details: { before, after: { role, active: true }, reason: String(ctx.body.reason || '').slice(0, 300) } });
    return { ok: true };
  });

  router.post('/api/admin/companies/:id/invites/:inviteId/revoke', async (req, res, ctx) => {
    needAdmin(req);
    const bizId = Number(ctx.params.id) || 0;
    const open = await db.many('SELECT token, email, role FROM invites WHERE business_id=$1 AND used_at IS NULL', [bizId]);
    const inv = open.find((i) => inviteId(i.token) === String(ctx.params.inviteId));
    if (!inv) fail(404, 'Invite not found');
    await db.query('DELETE FROM invites WHERE token=$1', [inv.token]);
    await audit(req, 'invite.revoke', { businessId: bizId, details: { email: inv.email, role: inv.role } });
    return { ok: true };
  });

  router.get('/api/admin/users', async (req, res, ctx) => {
    needAdmin(req);
    const q = ctx.query; const w = L.where('TRUE AND $1::int IS NOT NULL', 1);
    if (L.str(q.get('q'))) w.add('(u.email ILIKE ? OR u.name ILIKE ?)', `%${L.str(q.get('q'), 100)}%`);
    if (q.get('f') === 'unverified') w.add("u.email_verified_at IS NULL AND u.auth_sub LIKE 'email:%'");
    if (q.get('f') === 'no_company') w.add('NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.active)');
    if (q.get('f') === 'blocked') w.add('NOT u.active');
    const p = L.paging(q, { email: 'lower(u.email)', created: 'u.created_at', login: 'u.last_login_at' }, 'created', 'desc', 'u.id');
    const [rows, t] = await Promise.all([
      db.many(`SELECT u.id, u.email, u.name, u.active, u.created_at, u.last_login_at, u.email_verified_at IS NOT NULL AS verified, split_part(u.auth_sub, ':', 1) AS login,
        (SELECT COALESCE(json_agg(json_build_object('business_id', b.id, 'name', b.name, 'role', m.role, 'active', m.active) ORDER BY m.id), '[]'::json)
          FROM memberships m JOIN businesses b ON b.id=m.business_id WHERE m.user_id=u.id) AS companies
        FROM users u WHERE ${w.sql()} ORDER BY ${p.order} LIMIT ${p.per} OFFSET ${p.offset}`, w.params),
      db.one(`SELECT COUNT(*)::int AS n FROM users u WHERE ${w.sql()}`, w.params),
    ]);
    return L.pageResult(rows.map((r) => ({ ...r, admin: adminEmails().includes(String(r.email || '').toLowerCase()) })), t.n, p);
  });

  // Block / unblock an account (logs them out everywhere). Admins cannot block themselves.
  router.put('/api/admin/users/:id', async (req, res, ctx) => {
    needAdmin(req);
    const id = Number(ctx.params.id) || 0;
    const u = await db.one('SELECT id, email, active FROM users WHERE id=$1', [id]);
    if (!u) fail(404, 'Not found');
    if (u.id === req.user.id) fail(400, 'You cannot block your own account');
    const active = ctx.body.active !== false;
    await db.query('UPDATE users SET active=$2 WHERE id=$1', [id, active]);
    if (!active) await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    await audit(req, active ? 'user.unblock' : 'user.block', { userId: id, details: { email: u.email, reason: String(ctx.body.reason || '').slice(0, 300) } });
    return { ok: true };
  });

  // System health: what is set up, what is failing, and the latest errors
  router.get('/api/admin/system', async (req) => {
    needAdmin(req);
    const t0 = Date.now(); await db.one('SELECT 1 AS ok'); const dbMs = Date.now() - t0;
    const [errorsRows, outboxFails, size] = await Promise.all([
      db.many('SELECT id, source, location, message, stack, count, first_at, last_at, resolved_at, business_id FROM app_errors ORDER BY resolved_at IS NOT NULL, last_at DESC LIMIT 50'),
      db.one("SELECT COUNT(*)::int AS n FROM outbox WHERE status='failed' AND created_at > now() - interval '7 days'"),
      db.one('SELECT pg_size_pretty(pg_database_size(current_database())) AS size'),
    ]);
    const mail = require('./mailer').status();
    const on = (k) => !!process.env[k];
    return {
      env: process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT === '1' ? 'production' : 'development',
      uptimeMin: Math.round(process.uptime() / 60), node: process.version, db: { ok: true, ms: dbMs, size: size.size }, remindersAt: state.remindersAt,
      checks: [
        { key: 'database', label: 'Database', ok: true, note: `${dbMs} ms · ${size.size}` },
        { key: 'smtp', label: 'System email (SMTP)', ok: mail.configured, note: mail.configured ? `${mail.host}:${mail.port} · from ${mail.from}` : 'Missing SYSTEM_SMTP_HOST / USER / PASS. Confirm and reset emails and worker alerts are not sent.' },
        { key: 'encryption', label: 'Encryption key', ok: on('ENCRYPTION_KEY'), note: on('ENCRYPTION_KEY') ? 'Set' : 'Missing ENCRYPTION_KEY. Mailbox and calendar cannot be connected.' },
        { key: 'sms', label: 'SMS (Twilio)', ok: on('TWILIO_ACCOUNT_SID') && on('TWILIO_AUTH_TOKEN') && on('TWILIO_FROM'), note: on('TWILIO_ACCOUNT_SID') ? `From ${process.env.TWILIO_FROM || '(TWILIO_FROM missing)'}` : 'Not set. Workers and customers get email only.' },
        { key: 'payments', label: 'Payments (Stripe)', ok: on('STRIPE_SECRET_KEY'), note: on('STRIPE_SECRET_KEY') ? (String(process.env.STRIPE_SECRET_KEY).startsWith('sk_live') ? 'Live mode' : 'Test mode') + (on('STRIPE_WEBHOOK_SECRET') ? '' : ' · STRIPE_WEBHOOK_SECRET missing') : 'Not set. No Pay button on invoices.' },
        { key: 'ai', label: 'AI quote drafts', ok: on('ANTHROPIC_API_KEY'), note: on('ANTHROPIC_API_KEY') ? 'On' : 'Off. Quotes are drafted from the price list keywords only.' },
        { key: 'google', label: 'Google login and mailbox', ok: on('GOOGLE_CLIENT_ID') && on('GOOGLE_CLIENT_SECRET'), note: on('GOOGLE_CLIENT_ID') ? 'Set' : 'Not set' },
        { key: 'microsoft', label: 'Microsoft login and mailbox', ok: on('MICROSOFT_CLIENT_ID') && on('MICROSOFT_CLIENT_SECRET'), note: on('MICROSOFT_CLIENT_ID') ? 'Set' : 'Not set' },
        { key: 'outbox', label: 'Messages that failed (7 days)', ok: outboxFails.n === 0, note: outboxFails.n ? `${outboxFails.n} failed. Open a company to see which.` : 'None' },
      ],
      errors: errorsRows,
    };
  });
  router.post('/api/admin/system/test-email', async (req) => {
    needAdmin(req);
    const { sendSystemEmail, layout, status } = require('./mailer');
    if (!status().configured) fail(400, 'SMTP is not set up yet. Add SYSTEM_SMTP_HOST, SYSTEM_SMTP_PORT, SYSTEM_SMTP_USER, SYSTEM_SMTP_PASS and SYSTEM_MAIL_FROM in Secrets.');
    const r = await sendSystemEmail(req.user.email, 'Unbusyness test email', 'If you can read this, system email works.', layout({ title: 'System email works', intro: 'Confirmation emails, password resets, worker alerts and error alerts will be delivered.' }), 'test');
    if (r !== 'sent') fail(502, 'The mail server did not accept the message. Check the SMTP secrets (host, port 587 or 465, username, password) and the server log for the error code.');
    return { ok: true, to: req.user.email };
  });
  router.post('/api/admin/errors/:id/resolve', async (req, res, ctx) => {
    needAdmin(req);
    await db.query('UPDATE app_errors SET resolved_at=now() WHERE id=$1', [Number(ctx.params.id) || 0]);
    return { ok: true };
  });

  router.get('/api/admin/audit', async (req) => {
    needAdmin(req);
    return db.many(`SELECT a.*, b.name AS business_name, u.email AS target_email FROM admin_audit a LEFT JOIN businesses b ON b.id=a.business_id
      LEFT JOIN users u ON u.id=a.target_user_id ORDER BY a.id DESC LIMIT 200`);
  });
}

const state = { remindersAt: null };

module.exports = { routes, isPlatformAdmin, state };
