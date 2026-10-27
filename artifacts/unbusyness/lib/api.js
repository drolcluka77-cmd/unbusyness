// All business API routes, the voice-agent webhook, public quote/invoice pages and reminders.
'use strict';
const db = require('./db');
const { fail, html, redirect, json } = require('./http');
const { requireUser, requireBusiness, saveSessionData, rid, originOf, DEV_LOGIN } = require('./auth');
const { need, can, rank, roleList, ROLES, PERMISSIONS } = require('./rbac');
const svc = require('./services');
const { callRecord } = require('./voice/contract');
const calendar = require('./integrations/calendar');
const JOB_KINDS = Object.keys(calendar.KINDS);
const { renderDoc, publicPage, DOC_CSS, esc, money, day } = require('./docs');
const L = require('./lists');
const invites = require('./invites');
const notify = require('./notify');

// ---------- helpers ----------
const biz = (req) => db.one('SELECT * FROM businesses WHERE id=$1', [req.user.business_id]);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const isOwner = (req) => can(req, 'money.manage'); // sees prices and money
const manages = (req) => can(req, 'jobs.manage');
const first = (n) => String(n || '').split(' ')[0];
const publicUrl = () => (process.env.PUBLIC_URL || (process.env.REPLIT_DOMAINS ? 'https://' + process.env.REPLIT_DOMAINS.split(',')[0] : 'http://localhost:3000')).replace(/\/$/, '');
const COLORS = ['#1F4D45', '#E8915F', '#4F5F80', '#8A5A9E', '#2F7A55', '#B23A32'];

// The team of a company = active memberships. Use this everywhere instead of the users table.
const TEAM_SQL = `SELECT u.id, u.name, u.email, u.phone, m.role, m.trade_role, m.color, m.active FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=$1`;
async function member(bizId, userId) {
  const m = await db.one(`${TEAM_SQL} AND m.user_id=$2`, [bizId, Number(userId) || 0]);
  if (!m || !m.active) fail(400, 'That person is not an active member of this company');
  return m;
}
async function log(bizId, kind, text, refType, refId) {
  await db.query('INSERT INTO activity(business_id, kind, text, ref_type, ref_id) VALUES($1,$2,$3,$4,$5)', [bizId, kind, text, refType || null, refId || null]);
}
function totals(items, taxRate) {
  const subtotal = r2(items.reduce((a, i) => a + Number(i.qty || 0) * Number(i.unit_price || 0), 0));
  const tax = r2(subtotal * Number(taxRate || 0) / 100);
  return { subtotal, tax, total: r2(subtotal + tax) };
}
const cleanItems = (items) => (Array.isArray(items) ? items : []).slice(0, 100).map((i, k) => ({
  description: str(i.description, 500), qty: Number(i.qty) || 0, unit: str(i.unit || 'job', 20) || 'job', unit_price: r2(i.unit_price), position: k,
})).filter((i) => i.description || i.unit_price);
async function saveItems(type, id, items) {
  await db.query('DELETE FROM line_items WHERE doc_type=$1 AND doc_id=$2', [type, id]);
  for (const i of items) {
    await db.query('INSERT INTO line_items(doc_type, doc_id, description, qty, unit, unit_price, position) VALUES($1,$2,$3,$4,$5,$6,$7)', [type, id, i.description, i.qty, i.unit, i.unit_price, i.position]);
  }
}
const getItems = (type, id) => db.many('SELECT description, qty, unit, unit_price FROM line_items WHERE doc_type=$1 AND doc_id=$2 ORDER BY position, id', [type, id]);
async function nextNumber(bizId, kind) {
  const col = kind === 'quote' ? 'next_quote_no' : 'next_invoice_no';
  const row = await db.one(`UPDATE businesses SET ${col}=${col}+1 WHERE id=$1 RETURNING ${col}-1 AS n`, [bizId]);
  return `${kind === 'quote' ? 'Q' : 'INV'}-${new Date().getFullYear()}-${String(row.n).padStart(4, '0')}`;
}
const addDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + Number(n || 0)); return d.toISOString().slice(0, 10); };
async function owned(table, id, bizId) {
  const row = await db.one(`SELECT * FROM ${table} WHERE id=$1 AND business_id=$2`, [Number(id) || 0, bizId]);
  if (!row) fail(404, 'Not found');
  return row;
}
const fmtTime = (iso, tz) => (iso ? new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/Chicago' }) : 'to be confirmed');

// Find a customer by phone, else create one.
async function findOrCreateCustomer(bizId, { name, phone, email, address }) {
  const d = digits(phone);
  let c = null;
  if (d.length >= 7) c = await db.one("SELECT * FROM customers WHERE business_id=$1 AND right(regexp_replace(phone, '\\D', '', 'g'), 10)=$2 ORDER BY id LIMIT 1", [bizId, d]);
  if (!c && email) c = await db.one('SELECT * FROM customers WHERE business_id=$1 AND lower(email)=lower($2) LIMIT 1', [bizId, email]);
  if (c) {
    c = await db.one(`UPDATE customers SET name=CASE WHEN name='' THEN $2 ELSE name END, address=CASE WHEN address='' THEN $3 ELSE address END,
      email=CASE WHEN email='' THEN $4 ELSE email END WHERE id=$1 RETURNING *`, [c.id, name || '', address || '', email || '']);
    return c;
  }
  return db.one('INSERT INTO customers(business_id, name, phone, email, address) VALUES($1,$2,$3,$4,$5) RETURNING *', [bizId, name || 'New caller', phone || '', email || '', address || '']);
}

// ---------- voice agent intake (webhook + simulator share this) ----------
// Takes a canonical call record (see lib/voice/contract.js) from ANY voice provider.
async function ingestCall(business, p, meta = {}) {
  const { intent, urgency } = p;
  const external = p.external_id || null;
  if (external) {
    const dup = await db.one('SELECT * FROM calls WHERE business_id=$1 AND external_id=$2', [business.id, external]);
    if (dup) {
      await db.query(`UPDATE calls SET summary=CASE WHEN summary='' THEN $2 ELSE summary END, transcript=CASE WHEN transcript='' THEN $3 ELSE transcript END,
        recording_url=CASE WHEN recording_url='' THEN $4 ELSE recording_url END, service=CASE WHEN service='' THEN $5 ELSE service END WHERE id=$1`, [dup.id, p.summary, p.transcript, p.recording_url, p.service]);
      return { call: dup, duplicate: true };
    }
  }
  const customer = await findOrCreateCustomer(business.id, { name: p.customer_name, phone: p.from_phone, email: p.customer_email, address: p.address });
  const call = await db.one(`INSERT INTO calls(business_id, customer_id, external_id, provider, from_phone, to_phone, customer_name, customer_email, address, intent, service, urgency,
      preferred_time, summary, transcript, recording_url, duration_sec, raw) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
  [business.id, customer.id, external, meta.provider || 'generic', p.from_phone, p.to_phone || '', p.customer_name, p.customer_email, p.address, intent, p.service, urgency,
    p.preferred_time, p.summary, p.transcript, p.recording_url, p.duration_sec, meta.raw || null]);
  const who = call.customer_name || call.from_phone || 'Caller';
  await log(business.id, 'call', `AI answered ${who}: ${call.service || intent.replace('_', ' ')}`, 'call', call.id);

  let next = 'task';
  // A booking the agent already requested during this call (request_booking tool)?
  const held = external ? await db.one('UPDATE jobs SET call_id=$1 WHERE business_id=$2 AND voice_call_id=$3 RETURNING id', [call.id, business.id, external]) : null;
  if (held) {
    await db.query("UPDATE calls SET status='handled' WHERE id=$1", [call.id]);
    next = 'booking';
  } else if (intent === 'quote_request') {
    await createQuoteFromCall(business, call);
    next = 'quote';
  } else {
    const title = intent === 'emergency' || urgency === 'emergency' || urgency === 'high' ? `Call back ${who} now (urgent)` : intent === 'question' ? `Call back ${who}` : `Book ${who}: ${call.service || 'new job'}`;
    await db.query('INSERT INTO tasks(business_id, title, customer_id, call_id, due_at) VALUES($1,$2,$3,$4, now())', [business.id, title, customer.id, call.id]);
  }
  if (urgency === 'emergency' || urgency === 'high' || intent === 'emergency') {
    await notifyOwner(business, `URGENT call from ${who} (${call.from_phone}): ${call.service || call.summary}`.slice(0, 300), `Summary: ${call.summary}\nAddress: ${call.address}`);
  }
  return { call, next };
}

async function notifyOwner(business, msg, extra = '') {
  const owner = await db.one("SELECT u.* FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=$1 AND m.role='owner' AND m.active ORDER BY m.id LIMIT 1", [business.id]);
  if (owner && owner.phone) await svc.sendSms({ businessId: business.id, to: owner.phone, body: msg });
  await svc.sendEmail({ businessId: business.id, to: (owner && owner.email) || business.email, subject: msg.slice(0, 90), text: `${msg}\n\n${extra}` });
}

async function createQuoteFromCall(business, call) {
  const services = await db.many('SELECT * FROM services WHERE business_id=$1 ORDER BY position, id', [business.id]);
  const draft = await svc.draftQuote(call, services, business);
  const items = cleanItems(draft.items);
  const t = totals(items, business.tax_rate);
  const q = await db.one(`INSERT INTO quotes(business_id, customer_id, call_id, number, title, notes, tax_rate, subtotal, tax, total, valid_until, public_token, ai_drafted)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE) RETURNING *`,
  [business.id, call.customer_id, call.id, await nextNumber(business.id, 'quote'), str(draft.title || call.service, 200), str(draft.notes, 2000), business.tax_rate, t.subtotal, t.tax, t.total, addDays(business.quote_valid_days), rid(18)]);
  await saveItems('quote', q.id, items);
  await db.query("UPDATE calls SET status='handled' WHERE id=$1", [call.id]);
  await log(business.id, 'quote', `Quote ${q.number} drafted for ${call.customer_name || 'caller'} · ${money(q.total, business.currency)}`, 'quote', q.id);
  return q;
}

const SAMPLE_CALLS = [
  { intent: 'emergency', urgency: 'emergency', customer_name: 'Sarah Miller', from_phone: '+1 512 555 0148', address: '18 Maple Street, Austin, TX', service: 'Water leaking under the kitchen sink', preferred_time: 'As soon as possible', summary: 'Water is leaking under the kitchen sink. Sarah turned off the valve under the sink. She is home all day and wants someone today.', transcript: 'AI: Hi, this is your plumber\'s AI assistant. How can I help?\nCaller: Water is leaking under my kitchen sink!\nAI: Sorry to hear that. Can you turn off the valve under the sink?\nCaller: Yes, done.\nAI: What is your address?\nCaller: 18 Maple Street.\nAI: Thanks. Someone will call you back in a few minutes to confirm a time.' },
  { intent: 'quote_request', urgency: 'normal', customer_name: 'David Chen', from_phone: '+1 512 555 0172', customer_email: 'david.chen@example.com', address: '402 Oak Avenue, Austin, TX', service: 'Replace water heater', preferred_time: 'Next week, mornings', summary: 'David\'s 12-year-old 40-gallon gas water heater is making noise and the water is not hot. He wants a price to replace it.', transcript: 'Caller: My water heater is about 12 years old and it\'s making a banging noise. Can I get a price for a new one?' },
  { intent: 'new_job', urgency: 'normal', customer_name: 'Emily Johnson', from_phone: '+1 512 555 0119', address: '77 Cedar Lane, Round Rock, TX', service: 'Clogged bathroom drain', preferred_time: 'Thursday afternoon', summary: 'Emily\'s bathroom sink drains very slowly. She is free Thursday after 1 p.m.', transcript: '' },
];

// ---------- routes ----------
function routes(router) {
  // Session + app bootstrap
  router.get('/api/me', async (req) => {
    if (!req.user) {
      const inv = req.session && req.session.data.invite ? await invites.pending(req.session.data.invite) : null;
      return { user: null, devLogin: DEV_LOGIN, invite: !!inv, inviteEmail: (inv && inv.email) || '' };
    }
    // One-time message from the last login or invite link (e.g. "you are already a member")
    let notice = null;
    if (req.session && req.session.data.notice) { notice = { status: req.session.data.notice, message: invites.MESSAGES[req.session.data.notice] || '' }; delete req.session.data.notice; await saveSessionData(req); }
    const business = req.user.business_id ? await biz(req) : null;
    const team = business && (can(req, 'team.manage') || can(req, 'jobs.manage')) ? await db.many(`${TEAM_SQL} ORDER BY m.active DESC, m.role, u.id`, [business.id]) : business ? await db.many(`${TEAM_SQL} AND m.user_id=$2`, [business.id, req.user.id]) : [];
    const services = business && isOwner(req) ? await db.many('SELECT * FROM services WHERE business_id=$1 ORDER BY position, id', [business.id]) : [];
    if (business) {
      delete business.logo_data; delete business.voice_provider_secret;
      if (!can(req, 'company.settings')) { delete business.voice_secret; delete business.stripe_account; }
    }
    return { user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, phone: req.user.phone, verified: !!req.user.email_verified_at || !String(req.user.auth_sub || '').startsWith('email:') }, business, team, services,
      perms: req.perms, roles: roleList(), memberships: req.memberships.map((m) => ({ business_id: m.business_id, name: m.business_name, role: m.role })), devLogin: DEV_LOGIN, stripe: svc.stripeOn(), ai: !!process.env.ANTHROPIC_API_KEY, email: !!(business && await db.one("SELECT 1 FROM integrations WHERE business_id=$1 AND kind='email' AND status='connected'", [business.id])), sms: !!process.env.TWILIO_ACCOUNT_SID, notice, admin: require('./admin').isPlatformAdmin(req.user) };
  });

  router.post('/api/business', async (req, res, ctx) => {
    requireUser(req);
    const b = ctx.body;
    const name = str(b.name, 200); if (!name) fail(400, 'Business name is required');
    const row = await db.one(`INSERT INTO businesses(name, trade, address, phone, email, tax_rate, voice_key, voice_secret) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [name, str(b.trade, 60) || 'Plumbing', str(b.address, 400), str(b.phone, 40), str(b.email || req.user.email, 200), Number(b.tax_rate) || 0, rid(9).toLowerCase().replace(/[^a-z0-9]/g, 'x'), rid(24)]);
    await db.query("INSERT INTO memberships(business_id, user_id, role) VALUES($1,$2,'owner')", [row.id, req.user.id]);
    await db.query("UPDATE users SET phone=COALESCE(NULLIF($2,''), phone) WHERE id=$1", [req.user.id, str(b.owner_phone, 40)]);
    req.session.data.business_id = row.id; await saveSessionData(req);
    const defaults = {
      Plumbing: [['Service call and diagnosis', 'visit', 89, 'call out trip diagnose check visit'], ['Labor', 'hour', 115, 'labor work hour'], ['Leak repair', 'job', 185, 'leak leaking drip pipe'], ['Drain cleaning', 'job', 175, 'drain clog clogged blocked slow'], ['Faucet replacement', 'job', 225, 'faucet tap'], ['Toilet repair', 'job', 165, 'toilet running cistern'], ['Water heater replacement (40 gal, gas)', 'job', 1850, 'water heater hot boiler tank']],
      HVAC: [['Service call and diagnosis', 'visit', 95, 'call out trip diagnose'], ['Labor', 'hour', 125, 'labor hour'], ['AC tune-up', 'job', 149, 'ac air conditioning tune service'], ['Furnace tune-up', 'job', 149, 'furnace heating heat service'], ['Heat pump service', 'job', 189, 'heat pump service'], ['Thermostat install', 'job', 225, 'thermostat']],
      Electrical: [['Service call and diagnosis', 'visit', 95, 'call out trip diagnose'], ['Labor', 'hour', 120, 'labor hour'], ['Outlet or switch replacement', 'each', 145, 'outlet socket switch'], ['Light fixture install', 'each', 165, 'light fixture lamp'], ['Panel inspection', 'job', 199, 'panel breaker fuse']],
    };
    const list = defaults[b.trade] || defaults.Plumbing;
    for (let i = 0; i < list.length; i++) await db.query('INSERT INTO services(business_id, name, unit, price, keywords, position) VALUES($1,$2,$3,$4,$5,$6)', [row.id, list[i][0], list[i][1], list[i][2], list[i][3], i]);
    await log(row.id, 'setup', `${name} joined Unbusyness`);
    return { ok: true };
  });

  router.put('/api/business', async (req, res, ctx) => {
    need(req, 'company.settings');
    const b = ctx.body; const cur = await biz(req);
    const f = (k, max) => (b[k] !== undefined ? str(b[k], max) : cur[k]);
    const n = (k) => (b[k] !== undefined ? Number(b[k]) || 0 : cur[k]);
    await db.query(`UPDATE businesses SET name=$2, trade=$3, address=$4, phone=$5, email=$6, website=$7, tax_id=$8, tax_rate=$9, tax_label=$10, timezone=$11,
      payment_terms=$12, quote_valid_days=$13, payment_notes=$14 WHERE id=$1`,
    [cur.id, f('name', 200) || cur.name, f('trade', 60), f('address', 400), f('phone', 40), f('email', 200), f('website', 200), f('tax_id', 60), n('tax_rate'), f('tax_label', 40) || 'Sales tax', f('timezone', 60) || cur.timezone, Math.max(0, n('payment_terms')), Math.max(1, n('quote_valid_days')), f('payment_notes', 1000)]);
    if (b.my_phone !== undefined) await db.query('UPDATE users SET phone=$2 WHERE id=$1', [req.user.id, str(b.my_phone, 40)]);
    return { ok: true };
  });

  router.post('/api/business/logo', async (req, res, ctx) => {
    need(req, 'company.settings');
    const m = String(ctx.body.dataUrl || '').match(/^data:(image\/(png|jpeg|webp|svg\+xml));base64,(.+)$/);
    if (!m) fail(400, 'Please upload a PNG, JPG or SVG image');
    const buf = Buffer.from(m[3], 'base64'); if (buf.length > 1.5e6) fail(413, 'Logo is too large (max 1.5 MB)');
    await db.query('UPDATE businesses SET logo_mime=$2, logo_data=$3 WHERE id=$1', [req.user.business_id, m[1], buf]);
    return { ok: true };
  });
  router.get('/logo/:id', async (req, res, ctx) => {
    const b = await db.one('SELECT logo_mime, logo_data FROM businesses WHERE id=$1', [Number(ctx.params.id) || 0]);
    if (!b || !b.logo_data) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': b.logo_mime, 'Cache-Control': 'public, max-age=3600' }); res.end(b.logo_data);
  });
  router.post('/api/business/rotate-secret', async (req) => {
    need(req, 'company.settings');
    await db.query('UPDATE businesses SET voice_secret=$2 WHERE id=$1', [req.user.business_id, rid(24)]);
    return { ok: true };
  });

  // Price list
  // Read a price list from a photo, PDF, Excel or CSV. Returns items to check; nothing is saved here.
  router.post('/api/services/import', async (req, res, ctx) => {
    need(req, 'company.settings');
    try {
      return await require('./pricelist').importFile({ filename: ctx.body.filename, mime: ctx.body.mime, dataBase64: ctx.body.data }, await biz(req));
    } catch (e) { if (e.status) fail(e.status, e.message); throw e; }
  });
  router.put('/api/services', async (req, res, ctx) => {
    need(req, 'company.settings');
    const list = (Array.isArray(ctx.body.services) ? ctx.body.services : []).slice(0, 200);
    await db.query('DELETE FROM services WHERE business_id=$1', [req.user.business_id]);
    let i = 0;
    for (const s of list) {
      if (!str(s.name)) continue;
      await db.query('INSERT INTO services(business_id, name, unit, price, keywords, position) VALUES($1,$2,$3,$4,$5,$6)', [req.user.business_id, str(s.name, 200), str(s.unit, 20) || 'job', r2(s.price), str(s.keywords, 300), i++]);
    }
    return { ok: true };
  });

  // Team
  router.post('/api/invites', async (req, res, ctx) => {
    need(req, 'team.manage');
    const role = ROLES[ctx.body.role] ? ctx.body.role : 'worker';
    if (rank(role) > rank(req.user.role) || (role === 'owner' && req.user.role !== 'owner')) fail(403, 'You cannot invite someone with a higher role than yours');
    // The link only works for this address (see lib/invites.js).
    const email = invites.normEmail(ctx.body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) fail(400, 'Enter the email address of the person you are inviting');
    const already = await db.one('SELECT m.active FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.business_id=$1 AND lower(u.email)=$2 AND m.active LIMIT 1', [req.user.business_id, email]);
    if (already) fail(409, 'This person is already in your team. Change their role in the list instead.');
    const token = rid(16);
    await db.query('INSERT INTO invites(token, business_id, role, name, trade_role, email) VALUES($1,$2,$3,$4,$5,$6)', [token, req.user.business_id, role, str(ctx.body.name, 100), str(ctx.body.trade_role, 60), email]);
    return { url: `${originOf(req)}/join/${token}`, email };
  });
  router.put('/api/team/:id', async (req, res, ctx) => {
    need(req, 'team.manage');
    const u = await db.one(`${TEAM_SQL} AND m.user_id=$2`, [req.user.business_id, Number(ctx.params.id) || 0]);
    if (!u) fail(404, 'Not found');
    const b = ctx.body;
    const newRole = ROLES[b.role] ? b.role : u.role;
    if (u.id === req.user.id && (b.active === false || newRole !== u.role)) fail(400, 'You cannot change your own role or remove yourself');
    if (rank(u.role) > rank(req.user.role) || rank(newRole) > rank(req.user.role) || (u.role === 'owner' || newRole === 'owner') && req.user.role !== 'owner') fail(403, 'You cannot change someone with a higher role than yours');
    if (u.role === 'owner' && (newRole !== 'owner' || b.active === false)) {
      const owners = await db.one("SELECT COUNT(*)::int AS n FROM memberships WHERE business_id=$1 AND role='owner' AND active", [req.user.business_id]);
      if (owners.n < 2) fail(400, 'A company needs at least one owner');
    }
    await db.query('UPDATE memberships SET trade_role=$3, color=$4, role=$5, active=$6 WHERE business_id=$1 AND user_id=$2',
      [req.user.business_id, u.id, b.trade_role !== undefined ? str(b.trade_role, 60) : u.trade_role, COLORS.includes(b.color) ? b.color : u.color, newRole, b.active !== undefined ? !!b.active : u.active]);
    if (b.name !== undefined || b.phone !== undefined) await db.query('UPDATE users SET name=$2, phone=$3 WHERE id=$1', [u.id, b.name !== undefined ? str(b.name, 100) : u.name, b.phone !== undefined ? str(b.phone, 40) : u.phone]);
    return { ok: true };
  });

  // Today (owner home)
  router.get('/api/today', async (req, res, ctx) => {
    need(req, 'calls.manage');
    const id = req.user.business_id;
    const [calls, tasks, draftQuotes, draftInvoices, acceptedQuotes, jobsToday, money1, recent, week, requested, nextJob, ai24] = await Promise.all([
      db.many("SELECT id, customer_name, from_phone, intent, service, urgency, summary, created_at FROM calls WHERE business_id=$1 AND status='new' ORDER BY (urgency IN ('emergency','high')) DESC, created_at DESC LIMIT 20", [id]),
      db.many('SELECT t.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS assignee FROM tasks t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN users u ON u.id=t.assigned_user_id WHERE t.business_id=$1 AND t.done_at IS NULL ORDER BY t.due_at NULLS LAST, t.id LIMIT 30', [id]),
      db.many("SELECT q.id, q.number, q.title, q.total, c.name AS customer_name FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id WHERE q.business_id=$1 AND q.status='draft' ORDER BY q.id DESC", [id]),
      db.many("SELECT i.id, i.number, i.total, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE i.business_id=$1 AND i.status='draft' ORDER BY i.id DESC", [id]),
      db.many("SELECT q.id, q.number, q.title, q.total, c.name AS customer_name FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id WHERE q.business_id=$1 AND q.status='accepted' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.quote_id=q.id) ORDER BY q.accepted_at DESC", [id]),
      db.many(`SELECT j.*, c.name AS customer_name, u.name AS assignee FROM jobs j LEFT JOIN customers c ON c.id=j.customer_id LEFT JOIN users u ON u.id=j.assigned_user_id
               WHERE j.business_id=$1 AND j.scheduled_at >= $2::timestamptz AND j.scheduled_at < $3::timestamptz ORDER BY j.scheduled_at`, [id, ctx.query.get('from') || new Date(Date.now() - 12 * 3600e3).toISOString(), ctx.query.get('to') || new Date(Date.now() + 12 * 3600e3).toISOString()]),
      db.one(`SELECT COALESCE(SUM(total) FILTER (WHERE status='sent'),0)::float AS unpaid, COUNT(*) FILTER (WHERE status='sent')::int AS unpaid_n,
               COALESCE(SUM(total) FILTER (WHERE status='sent' AND due_date < CURRENT_DATE),0)::float AS overdue, COUNT(*) FILTER (WHERE status='sent' AND due_date < CURRENT_DATE)::int AS overdue_n,
               COALESCE(SUM(total) FILTER (WHERE status='paid' AND paid_at > now() - interval '7 days'),0)::float AS paid_week,
               COUNT(*) FILTER (WHERE status='paid' AND paid_at > now() - interval '7 days')::int AS paid_week_n
               FROM invoices WHERE business_id=$1`, [id]),
      db.many('SELECT * FROM activity WHERE business_id=$1 ORDER BY created_at DESC LIMIT 12', [id]),
      db.one(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='done')::int AS done FROM jobs WHERE business_id=$1 AND scheduled_at > now() - interval '7 days' AND scheduled_at < now() + interval '7 days'`, [id]),
      db.many('SELECT j.id, j.title, j.scheduled_at, c.name AS customer_name FROM jobs j LEFT JOIN customers c ON c.id=j.customer_id WHERE j.business_id=$1 AND j.tentative ORDER BY j.scheduled_at', [id]),
      // The next job that is not done yet (for the phone view's "Next job" card)
      db.one(`SELECT j.id, j.title, j.kind, j.status, j.scheduled_at, j.address, j.assigned_user_id, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address, u.name AS assignee
        FROM jobs j LEFT JOIN customers c ON c.id=j.customer_id LEFT JOIN users u ON u.id=j.assigned_user_id
        WHERE j.business_id=$1 AND NOT j.tentative AND j.status<>'done' AND j.scheduled_at >= now() - interval '3 hours' ORDER BY j.scheduled_at LIMIT 1`, [id]),
      db.one(`SELECT (SELECT COUNT(*)::int FROM calls WHERE business_id=$1 AND created_at > now() - interval '24 hours') AS calls,
        (SELECT COUNT(*)::int FROM quotes WHERE business_id=$1 AND ai_drafted AND created_at > now() - interval '24 hours') AS quotes,
        (SELECT COUNT(*)::int FROM jobs WHERE business_id=$1 AND tentative AND created_at > now() - interval '24 hours') AS bookings`, [id]),
    ]);
    if (!can(req, 'money.manage')) return { calls, tasks, draftQuotes: [], draftInvoices: [], acceptedQuotes: [], jobsToday: jobsToday.map(({ price, ...j }) => j), money: null, recent: recent.filter((a) => !['paid', 'invoice', 'quote'].includes(a.kind)), week, requested, nextJob, ai24: { ...ai24, quotes: 0 } };
    return { calls, tasks, draftQuotes, draftInvoices, acceptedQuotes, jobsToday, money: money1, recent, week, requested, nextJob, ai24 };
  });

  // Calls
  router.get('/api/calls', async (req) => {
    need(req, 'calls.manage');
    return db.many('SELECT id, customer_id, from_phone, customer_name, intent, service, urgency, status, summary, created_at, duration_sec FROM calls WHERE business_id=$1 ORDER BY created_at DESC LIMIT 200', [req.user.business_id]);
  });
  router.get('/api/calls/:id', async (req, res, ctx) => {
    need(req, 'calls.manage');
    const call = await owned('calls', ctx.params.id, req.user.business_id);
    delete call.raw;
    const quote = await db.one('SELECT id, number, status, total FROM quotes WHERE call_id=$1', [call.id]);
    const job = await db.one('SELECT id, title, scheduled_at, status FROM jobs WHERE call_id=$1', [call.id]);
    return { call, quote, job };
  });
  router.post('/api/calls/:id/status', async (req, res, ctx) => {
    need(req, 'calls.manage');
    const call = await owned('calls', ctx.params.id, req.user.business_id);
    const status = ['new', 'handled', 'dismissed'].includes(ctx.body.status) ? ctx.body.status : 'handled';
    await db.query('UPDATE calls SET status=$2 WHERE id=$1', [call.id, status]);
    if (status !== 'new') await db.query('UPDATE tasks SET done_at=now() WHERE call_id=$1 AND done_at IS NULL', [call.id]);
    return { ok: true };
  });
  router.post('/api/calls/:id/quote', async (req, res, ctx) => {
    need(req, 'money.manage');
    const call = await owned('calls', ctx.params.id, req.user.business_id);
    const existing = await db.one('SELECT id FROM quotes WHERE call_id=$1', [call.id]);
    if (existing) return { id: existing.id };
    const q = await createQuoteFromCall(await biz(req), call);
    await db.query('UPDATE tasks SET done_at=now() WHERE call_id=$1 AND done_at IS NULL', [call.id]);
    return { id: q.id };
  });
  router.post('/api/calls/simulate', async (req, res, ctx) => {
    need(req, 'calls.manage');
    const k = Number(ctx.body.sample || 0) % SAMPLE_CALLS.length;
    const p = callRecord({ ...SAMPLE_CALLS[k], external_id: 'sim-' + rid(6), duration_sec: 95 + k * 40 });
    const out = await ingestCall(await biz(req), p, { provider: 'test' });
    await db.query(`INSERT INTO voice_events(business_id, provider, kind, name, external_id, status)
      VALUES($1,'test','event',$2,$3,'ok')`, [req.user.business_id, out.next, p.external_id]);
    return { id: out.call.id, next: out.next };
  });

  // Tasks: internal to-dos. They stay in Unbusyness and are NEVER synced to external calendars.
  router.get('/api/tasks', async (req, res, ctx) => {
    requireBusiness(req);
    const all = can(req, 'tasks.manage') && ctx.query.get('mine') !== '1';
    if (!all) need(req, 'tasks.assigned');
    const open = ctx.query.get('done') !== '1';
    return db.many(`SELECT t.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS assignee FROM tasks t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN users u ON u.id=t.assigned_user_id
      WHERE t.business_id=$1 AND ($2::boolean OR t.assigned_user_id=$3) AND (t.done_at IS NULL) = $4 ORDER BY t.due_at NULLS LAST, t.id DESC LIMIT 300`, [req.user.business_id, all, req.user.id, open]);
  });
  router.post('/api/tasks', async (req, res, ctx) => {
    need(req, 'tasks.manage');
    const title = str(ctx.body.title, 300); if (!title) fail(400, 'Task title is required');
    const assignee = ctx.body.assigned_user_id ? await member(req.user.business_id, ctx.body.assigned_user_id) : null;
    const customer = ctx.body.customer_id ? await owned('customers', ctx.body.customer_id, req.user.business_id) : null;
    return db.one('INSERT INTO tasks(business_id, title, notes, customer_id, due_at, assigned_user_id, created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.business_id, title, str(ctx.body.notes, 2000), customer ? customer.id : null, ctx.body.due_at || null, assignee ? assignee.id : null, req.user.id]);
  });
  router.put('/api/tasks/:id', async (req, res, ctx) => {
    need(req, 'tasks.manage');
    const t = await owned('tasks', ctx.params.id, req.user.business_id); const b = ctx.body;
    const assignee = b.assigned_user_id !== undefined ? (b.assigned_user_id ? await member(req.user.business_id, b.assigned_user_id) : null) : undefined;
    await db.query('UPDATE tasks SET title=$2, notes=$3, due_at=$4, assigned_user_id=$5 WHERE id=$1', [t.id, str(b.title ?? t.title, 300) || t.title, str(b.notes ?? t.notes, 2000),
      b.due_at !== undefined ? (b.due_at || null) : t.due_at, assignee === undefined ? t.assigned_user_id : (assignee ? assignee.id : null)]);
    return { ok: true };
  });
  router.post('/api/tasks/:id/done', async (req, res, ctx) => {
    requireBusiness(req);
    const t = await owned('tasks', ctx.params.id, req.user.business_id);
    if (!can(req, 'tasks.manage') && !(can(req, 'tasks.assigned') && t.assigned_user_id === req.user.id)) fail(403, 'This task is not assigned to you');
    await db.query('UPDATE tasks SET done_at=CASE WHEN done_at IS NULL THEN now() ELSE NULL END WHERE id=$1', [t.id]);
    if (t.call_id) await db.query("UPDATE calls SET status='handled' WHERE id=$1 AND status='new'", [t.call_id]);
    return { ok: true };
  });
  router.del('/api/tasks/:id', async (req, res, ctx) => {
    need(req, 'tasks.manage');
    const t = await owned('tasks', ctx.params.id, req.user.business_id);
    await db.query('DELETE FROM tasks WHERE id=$1', [t.id]);
    return { ok: true };
  });

  // Customers
  router.get('/api/customers', async (req, res, ctx) => {
    need(req, 'customers.manage');
    if (ctx.query.get('page')) {
      const w = L.customerWhere(req.user.business_id, ctx.query); const p = L.paging(ctx.query, L.CUSTOMER_SORTS, 'last', 'desc', 'c.id');
      const base = `SELECT c.*, (SELECT COUNT(*)::int FROM jobs j WHERE j.customer_id=c.id) AS jobs,
        (SELECT COALESCE(SUM(total),0)::float FROM invoices i WHERE i.customer_id=c.id AND i.status='sent') AS balance,
        (SELECT COUNT(*)::int FROM quotes q WHERE q.customer_id=c.id AND q.status='sent') AS open_quotes,
        (SELECT MIN(scheduled_at) FROM jobs j WHERE j.customer_id=c.id AND j.status<>'done' AND j.scheduled_at >= now()) AS next_job,
        GREATEST(c.created_at, (SELECT MAX(created_at) FROM calls k WHERE k.customer_id=c.id), (SELECT MAX(scheduled_at) FROM jobs j WHERE j.customer_id=c.id AND j.scheduled_at <= now()),
          (SELECT MAX(created_at) FROM quotes q WHERE q.customer_id=c.id), (SELECT MAX(created_at) FROM invoices i WHERE i.customer_id=c.id)) AS last_activity
        FROM customers c WHERE ${w.sql()}`;
      const [rows, t, counts] = await Promise.all([
        db.many(`SELECT * FROM (${base}) c ORDER BY ${p.order} LIMIT ${p.per} OFFSET ${p.offset}`, w.params),
        db.one(`SELECT COUNT(*)::int AS n FROM customers c WHERE ${w.sql()}`, w.params),
        db.one(`SELECT COUNT(*)::int AS all, ${Object.entries(L.CUSTOMER_FILTERS).filter(([k]) => k !== 'all').map(([k, v]) => `COUNT(*) FILTER (WHERE ${v})::int AS ${k}`).join(', ')} FROM customers c WHERE c.business_id=$1`, [req.user.business_id]),
      ]);
      return L.pageResult(rows, t.n, p, { counts });
    }
    const q = `%${str(ctx.query.get('q'), 100)}%`;
    return db.many(`SELECT c.*, (SELECT COUNT(*)::int FROM jobs j WHERE j.customer_id=c.id) AS jobs,
      (SELECT COALESCE(SUM(total),0)::float FROM invoices i WHERE i.customer_id=c.id AND i.status='sent') AS balance,
      (SELECT MAX(created_at) FROM calls k WHERE k.customer_id=c.id) AS last_call
      FROM customers c WHERE c.business_id=$1 AND (c.name ILIKE $2 OR c.phone ILIKE $2 OR c.address ILIKE $2 OR c.email ILIKE $2) ORDER BY c.created_at DESC LIMIT 300`, [req.user.business_id, q]);
  });
  router.post('/api/customers', async (req, res, ctx) => {
    need(req, 'customers.manage');
    const b = ctx.body; if (!str(b.name)) fail(400, 'Name is required');
    return db.one('INSERT INTO customers(business_id, name, phone, email, address, notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [req.user.business_id, str(b.name, 200), str(b.phone, 40), str(b.email, 200), str(b.address, 400), str(b.notes, 4000)]);
  });
  router.get('/api/customers/:id', async (req, res, ctx) => {
    need(req, 'customers.manage');
    const c = await owned('customers', ctx.params.id, req.user.business_id);
    const [calls, quotes, jobs, invoices] = await Promise.all([
      db.many('SELECT id, service, summary, urgency, created_at FROM calls WHERE customer_id=$1 ORDER BY created_at DESC', [c.id]),
      db.many('SELECT id, number, title, status, total, created_at FROM quotes WHERE customer_id=$1 ORDER BY id DESC', [c.id]),
      db.many('SELECT id, title, status, scheduled_at FROM jobs WHERE customer_id=$1 ORDER BY scheduled_at DESC NULLS LAST', [c.id]),
      db.many('SELECT id, number, status, total, due_date FROM invoices WHERE customer_id=$1 ORDER BY id DESC', [c.id]),
    ]);
    return { customer: c, calls, quotes, jobs, invoices };
  });
  router.put('/api/customers/:id', async (req, res, ctx) => {
    need(req, 'customers.manage');
    const c = await owned('customers', ctx.params.id, req.user.business_id); const b = ctx.body;
    await db.query('UPDATE customers SET name=$2, phone=$3, email=$4, address=$5, notes=$6 WHERE id=$1', [c.id, str(b.name ?? c.name, 200), str(b.phone ?? c.phone, 40), str(b.email ?? c.email, 200), str(b.address ?? c.address, 400), str(b.notes ?? c.notes, 4000)]);
    return { ok: true };
  });

  // Quotes
  router.get('/api/quotes', async (req, res, ctx) => {
    need(req, 'money.manage');
    if (ctx.query.get('page')) {
      const b = await biz(req);
      const w = L.quoteWhere(b.id, b.timezone, ctx.query); const p = L.paging(ctx.query, L.QUOTE_SORTS, 'number', 'desc', 'q.id');
      const from = 'FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id';
      const [rows, t, stats] = await Promise.all([
        db.many(`SELECT q.id, q.number, q.title, q.status, q.total, q.created_at, q.valid_until, q.sent_at, q.viewed_at, q.ai_drafted, q.customer_id, c.name AS customer_name,
          (q.status='sent' AND q.valid_until < CURRENT_DATE) AS expired ${from} WHERE ${w.sql()} ORDER BY ${p.order} LIMIT ${p.per} OFFSET ${p.offset}`, w.params),
        db.one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(q.total),0)::float AS sum ${from} WHERE ${w.sql()}`, w.params),
        db.one(`SELECT COUNT(*) FILTER (WHERE status='draft')::int AS drafts,
          COUNT(*) FILTER (WHERE status='sent')::int AS open, COALESCE(SUM(total) FILTER (WHERE status='sent'),0)::float AS open_sum,
          COUNT(*) FILTER (WHERE status='accepted')::int AS accepted, COALESCE(SUM(total) FILTER (WHERE status='accepted'),0)::float AS accepted_sum,
          COUNT(*) FILTER (WHERE status='declined')::int AS declined FROM quotes WHERE business_id=$1`, [b.id]),
      ]);
      return L.pageResult(rows, t.n, p, { sum: t.sum, stats });
    }
    return db.many('SELECT q.id, q.number, q.title, q.status, q.total, q.created_at, q.valid_until, q.sent_at, q.viewed_at, q.ai_drafted, c.name AS customer_name FROM quotes q LEFT JOIN customers c ON c.id=q.customer_id WHERE q.business_id=$1 ORDER BY q.id DESC LIMIT 300', [req.user.business_id]);
  });
  router.post('/api/quotes', async (req, res, ctx) => {
    need(req, 'money.manage');
    const b = await biz(req);
    const q = await db.one(`INSERT INTO quotes(business_id, customer_id, number, title, tax_rate, valid_until, public_token) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.id, Number(ctx.body.customer_id) || null, await nextNumber(b.id, 'quote'), str(ctx.body.title, 200), b.tax_rate, addDays(b.quote_valid_days), rid(18)]);
    return { id: q.id };
  });
  router.get('/api/quotes/:id', async (req, res, ctx) => {
    need(req, 'money.manage');
    const q = await owned('quotes', ctx.params.id, req.user.business_id);
    const [items, customer, job, invoice, call] = await Promise.all([getItems('quote', q.id), q.customer_id ? db.one('SELECT * FROM customers WHERE id=$1', [q.customer_id]) : null,
      db.one('SELECT id, scheduled_at, status FROM jobs WHERE quote_id=$1', [q.id]), db.one('SELECT id, number, status FROM invoices WHERE quote_id=$1', [q.id]),
      q.call_id ? db.one('SELECT id, summary, service, created_at FROM calls WHERE id=$1', [q.call_id]) : null]);
    return { quote: q, items, customer, job, invoice, call, url: `${originOf(req)}/q/${q.public_token}` };
  });
  router.put('/api/quotes/:id', async (req, res, ctx) => {
    need(req, 'money.manage');
    const q = await owned('quotes', ctx.params.id, req.user.business_id); const b = ctx.body;
    const items = cleanItems(b.items); const taxRate = b.tax_rate !== undefined ? Number(b.tax_rate) || 0 : q.tax_rate; const t = totals(items, taxRate);
    await db.query('UPDATE quotes SET customer_id=$2, title=$3, notes=$4, tax_rate=$5, subtotal=$6, tax=$7, total=$8, valid_until=$9 WHERE id=$1',
      [q.id, b.customer_id !== undefined ? Number(b.customer_id) || null : q.customer_id, str(b.title ?? q.title, 200), str(b.notes ?? q.notes, 4000), taxRate, t.subtotal, t.tax, t.total, b.valid_until || q.valid_until]);
    await saveItems('quote', q.id, items);
    return { ok: true, ...t };
  });
  router.post('/api/quotes/:id/send', async (req, res, ctx) => {
    need(req, 'money.manage');
    const b = await biz(req); const q = await owned('quotes', ctx.params.id, b.id);
    const c = q.customer_id ? await db.one('SELECT * FROM customers WHERE id=$1', [q.customer_id]) : null;
    if (!c) fail(400, 'Add a customer to the quote first');
    if (!Number(q.total)) fail(400, 'The quote total is $0. Add prices first.');
    const url = `${originOf(req)}/q/${q.public_token}`;
    const text = `Hi ${c.name.split(' ')[0]},\n\nThank you for calling ${b.name}. Here is your quote ${q.number} for ${q.title || 'the work'}: ${money(q.total, b.currency)}.\n\nView and accept it here: ${url}\n\n${b.name}${b.phone ? '\n' + b.phone : ''}`;
    const st = await svc.sendEmail({ businessId: b.id, to: c.email, subject: `Your quote from ${b.name}: ${q.number}`, text, html: text.replace(/\n/g, '<br>').replace(url, `<a href="${url}">${url}</a>`), replyTo: b.email, fromName: b.name });
    if (c.phone && process.env.TWILIO_ACCOUNT_SID) await svc.sendSms({ businessId: b.id, to: c.phone, body: `${b.name}: your quote ${q.number} (${money(q.total, b.currency)}) is ready: ${url}` });
    await db.query("UPDATE quotes SET status=CASE WHEN status='accepted' THEN status ELSE 'sent' END, sent_at=now() WHERE id=$1", [q.id]);
    await log(b.id, 'quote', `Quote ${q.number} sent to ${c.name}`, 'quote', q.id);
    return { ok: true, delivery: st, url };
  });
  router.post('/api/quotes/:id/accept', async (req, res, ctx) => {
    need(req, 'money.manage');
    const q = await owned('quotes', ctx.params.id, req.user.business_id);
    await db.query("UPDATE quotes SET status='accepted', accepted_at=COALESCE(accepted_at, now()) WHERE id=$1", [q.id]);
    await log(q.business_id, 'quote', `Quote ${q.number} marked as accepted`, 'quote', q.id);
    return { ok: true };
  });
  router.post('/api/quotes/:id/decline', async (req, res, ctx) => {
    need(req, 'money.manage');
    const q = await owned('quotes', ctx.params.id, req.user.business_id);
    await db.query("UPDATE quotes SET status='declined' WHERE id=$1", [q.id]);
    return { ok: true };
  });

  // Jobs
  router.get('/api/jobs', async (req, res, ctx) => {
    requireBusiness(req);
    const from = ctx.query.get('from') || new Date(Date.now() - 7 * 864e5).toISOString();
    const to = ctx.query.get('to') || new Date(Date.now() + 21 * 864e5).toISOString();
    const mine = !manages(req) || ctx.query.get('mine') === '1';
    if (!manages(req)) need(req, 'jobs.assigned');
    if (ctx.query.get('page') && manages(req)) {
      const b = await biz(req);
      const w = L.jobWhere(b.id, b.timezone, ctx.query, JOB_KINDS);
      if (mine) w.add('j.assigned_user_id=?', req.user.id);
      const sorts = isOwner(req) ? L.JOB_SORTS : { ...L.JOB_SORTS, price: L.JOB_SORTS.when };
      const p = L.paging(ctx.query, sorts, 'when', 'asc', 'j.id');
      const from = 'FROM jobs j LEFT JOIN customers c ON c.id=j.customer_id LEFT JOIN users u ON u.id=j.assigned_user_id';
      const [rows, t] = await Promise.all([
        db.many(`SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS assignee, mm.color AS assignee_color,
            (SELECT COUNT(*)::int FROM photos p WHERE p.job_id=j.id) AS photo_count,
            (SELECT i.status FROM invoices i WHERE i.job_id=j.id ORDER BY i.id DESC LIMIT 1) AS invoice_status
          ${from} LEFT JOIN memberships mm ON mm.user_id=j.assigned_user_id AND mm.business_id=j.business_id
          WHERE ${w.sql()} ORDER BY ${p.order} LIMIT ${p.per} OFFSET ${p.offset}`, w.params),
        db.one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(j.price),0)::float AS sum ${from} WHERE ${w.sql()}`, w.params),
      ]);
      return L.pageResult(isOwner(req) ? rows : rows.map(({ price, ...j }) => j), t.n, p, isOwner(req) ? { sum: t.sum } : {});
    }
    return db.many(`SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS assignee, mm.color AS assignee_color,
        (SELECT COUNT(*)::int FROM photos p WHERE p.job_id=j.id) AS photo_count,
        (SELECT i.status FROM invoices i WHERE i.job_id=j.id ORDER BY i.id DESC LIMIT 1) AS invoice_status
      FROM jobs j LEFT JOIN customers c ON c.id=j.customer_id LEFT JOIN users u ON u.id=j.assigned_user_id LEFT JOIN memberships mm ON mm.user_id=j.assigned_user_id AND mm.business_id=j.business_id
      WHERE j.business_id=$1 AND ((j.scheduled_at >= $2::timestamptz AND j.scheduled_at < $3::timestamptz) OR (j.scheduled_at IS NULL AND $5::boolean))
        AND ($4::int IS NULL OR j.assigned_user_id=$4) ORDER BY j.scheduled_at NULLS FIRST`,
    [req.user.business_id, from, to, mine ? req.user.id : null, manages(req)]).then((rows) => (isOwner(req) ? rows : rows.map(({ price, ...j }) => j)));
  });
  router.post('/api/jobs', async (req, res, ctx) => {
    need(req, 'jobs.manage');
    const b = ctx.body; const bz = await biz(req);
    if (b.scheduled_at && isNaN(Date.parse(b.scheduled_at))) fail(400, 'Please pick a valid date and time');
    let customerId = Number(b.customer_id) || null; let address = str(b.address, 400); let title = str(b.title, 200); let price = r2(b.price);
    let quoteId = null; let callId = Number(b.call_id) || null;
    if (b.quote_id) {
      const q = await owned('quotes', b.quote_id, bz.id); quoteId = q.id; customerId = customerId || q.customer_id; title = title || q.title; price = price || Number(q.subtotal);
      if (q.status !== 'accepted') await db.query("UPDATE quotes SET status='accepted', accepted_at=COALESCE(accepted_at, now()) WHERE id=$1", [q.id]);
      callId = callId || q.call_id;
    }
    if (callId) { const c = await owned('calls', callId, bz.id); customerId = customerId || c.customer_id; title = title || c.service; address = address || c.address; }
    if (customerId && !address) { const c = await db.one('SELECT address FROM customers WHERE id=$1', [customerId]); address = (c && c.address) || ''; }
    if (!title) fail(400, 'What is the job? Add a title.');
    const assignee = b.assigned_user_id ? await member(bz.id, b.assigned_user_id) : null;
    const job = await db.one(`INSERT INTO jobs(business_id, customer_id, quote_id, call_id, title, address, scheduled_at, duration_min, assigned_user_id, price, notes, kind)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [bz.id, customerId, quoteId, callId, title, address, b.scheduled_at || null, Number(b.duration_min) || 90, assignee ? assignee.id : req.user.id, isOwner(req) ? price : 0, str(b.notes, 4000), JOB_KINDS.includes(b.kind) ? b.kind : 'job']);
    calendar.queue(job.id, originOf(req));
    notify.notifyWorker(job, 'assigned', { actorId: req.user.id, origin: originOf(req) }); // tells the worker (not awaited)
    if (callId) { await db.query("UPDATE calls SET status='handled' WHERE id=$1", [callId]); await db.query('UPDATE tasks SET done_at=now() WHERE call_id=$1 AND done_at IS NULL', [callId]); }
    const cust = customerId ? await db.one('SELECT * FROM customers WHERE id=$1', [customerId]) : null;
    if (cust && b.notify_customer !== false && job.scheduled_at) {
      const when = fmtTime(job.scheduled_at, bz.timezone);
      const text = `Hi ${cust.name.split(' ')[0]}, your appointment with ${bz.name} is booked for ${when}. Reply or call ${bz.phone || 'us'} if you need to change it.`;
      if (cust.phone && process.env.TWILIO_ACCOUNT_SID) await svc.sendSms({ businessId: bz.id, to: cust.phone, body: text });
      await svc.sendEmail({ businessId: bz.id, to: cust.email, subject: `Booked: ${title} · ${when}`, text, replyTo: bz.email, fromName: bz.name });
    }
    await log(bz.id, 'job', `Job booked: ${title}${cust ? ' for ' + cust.name : ''}${assignee && assignee.id !== req.user.id ? ' · ' + assignee.name : ''}`, 'job', job.id);
    return { id: job.id };
  });
  router.get('/api/jobs/:id', async (req, res, ctx) => {
    requireBusiness(req);
    const j = await owned('jobs', ctx.params.id, req.user.business_id);
    if (!manages(req) && !(can(req, 'jobs.assigned') && j.assigned_user_id === req.user.id)) fail(403, 'This job is not assigned to you');
    const [customer, photos, invoice, items, assignee] = await Promise.all([
      j.customer_id ? db.one('SELECT id, name, phone, email, address, notes FROM customers WHERE id=$1', [j.customer_id]) : null,
      db.many('SELECT id, label, created_at FROM photos WHERE job_id=$1 ORDER BY id', [j.id]),
      isOwner(req) ? db.one('SELECT id, number, status, total FROM invoices WHERE job_id=$1 ORDER BY id DESC LIMIT 1', [j.id]) : null,
      j.quote_id ? getItems('quote', j.quote_id) : [],
      j.assigned_user_id ? db.one(`${TEAM_SQL} AND m.user_id=$2`, [j.business_id, j.assigned_user_id]) : null,
    ]);
    if (!isOwner(req)) delete j.price;
    return { job: j, customer, photos, invoice, items: isOwner(req) ? items : items.map((i) => ({ description: i.description, qty: i.qty, unit: i.unit })), assignee };
  });
  router.put('/api/jobs/:id', async (req, res, ctx) => {
    need(req, 'jobs.manage');
    const j = await owned('jobs', ctx.params.id, req.user.business_id); const b = ctx.body;
    if (b.scheduled_at && isNaN(Date.parse(b.scheduled_at))) fail(400, 'Please pick a valid date and time');
    const assignee = b.assigned_user_id !== undefined ? (b.assigned_user_id ? await member(req.user.business_id, b.assigned_user_id) : null) : undefined;
    await db.query('UPDATE jobs SET title=$2, address=$3, scheduled_at=$4, duration_min=$5, assigned_user_id=$6, price=$7, notes=$8, kind=$9 WHERE id=$1',
      [j.id, str(b.title ?? j.title, 200), str(b.address ?? j.address, 400), b.scheduled_at !== undefined ? (b.scheduled_at || null) : j.scheduled_at, Number(b.duration_min ?? j.duration_min) || 90,
        assignee === undefined ? j.assigned_user_id : (assignee ? assignee.id : null), b.price !== undefined && isOwner(req) ? r2(b.price) : j.price, str(b.notes ?? j.notes, 4000), JOB_KINDS.includes(b.kind) ? b.kind : j.kind]);
    calendar.queue(j.id, originOf(req));
    const after = await db.one('SELECT * FROM jobs WHERE id=$1', [j.id]);
    notify.notifyChanges(j, after, { actorId: req.user.id, origin: originOf(req) });
    if (assignee && assignee.id !== j.assigned_user_id) await log(j.business_id, 'job', `${j.title} assigned to ${assignee.name}`, 'job', j.id);
    return { ok: true };
  });
  router.post('/api/jobs/:id/confirm', async (req, res, ctx) => {
    need(req, 'jobs.manage');
    const j = await owned('jobs', ctx.params.id, req.user.business_id);
    await db.query('UPDATE jobs SET tentative=FALSE WHERE id=$1', [j.id]);
    calendar.queue(j.id, originOf(req));
    if (j.tentative) notify.notifyWorker({ ...j, tentative: false }, 'assigned', { actorId: req.user.id, origin: originOf(req) });
    const bz = await biz(req);
    const cust = j.customer_id ? await db.one('SELECT * FROM customers WHERE id=$1', [j.customer_id]) : null;
    if (cust && j.scheduled_at) {
      const when = fmtTime(j.scheduled_at, bz.timezone);
      const text = `Hi ${first(cust.name)}, your appointment with ${bz.name} is confirmed for ${when}. Reply or call ${bz.phone || 'us'} if you need to change it.`;
      if (cust.phone && process.env.TWILIO_ACCOUNT_SID) await svc.sendSms({ businessId: bz.id, to: cust.phone, body: text });
      await svc.sendEmail({ businessId: bz.id, to: cust.email, subject: `Confirmed: ${j.title} · ${when}`, text, replyTo: bz.email, fromName: bz.name });
    }
    await log(bz.id, 'job', `Booking confirmed: ${j.title}${cust ? ' for ' + cust.name : ''}`, 'job', j.id);
    return { ok: true };
  });
  router.del('/api/jobs/:id', async (req, res, ctx) => {
    need(req, 'jobs.manage');
    const j = await owned('jobs', ctx.params.id, req.user.business_id);
    await db.query('DELETE FROM jobs WHERE id=$1', [j.id]);
    if (j.status !== 'done' && (!j.scheduled_at || new Date(j.scheduled_at) > Date.now() - 864e5)) notify.notifyWorker(j, 'cancelled', { actorId: req.user.id, origin: originOf(req) });
    if (j.cal_event_id) calendar.removeEvent(j.business_id, j.cal_event_id, j.cal_provider);
    return { ok: true };
  });
  router.post('/api/jobs/:id/status', async (req, res, ctx) => {
    requireBusiness(req);
    const j = await owned('jobs', ctx.params.id, req.user.business_id);
    if (!manages(req) && !(can(req, 'jobs.assigned') && j.assigned_user_id === req.user.id)) fail(403, 'This job is not assigned to you');
    const status = ctx.body.status;
    if (!['scheduled', 'on_the_way', 'in_progress', 'done'].includes(status)) fail(400, 'Unknown status');
    const col = { on_the_way: 'on_way_at', in_progress: 'started_at', done: 'finished_at' }[status];
    await db.query(`UPDATE jobs SET status=$2${col ? `, ${col}=COALESCE(${col}, now())` : ''} WHERE id=$1`, [j.id, status]);
    const bz = await biz(req);
    const cust = j.customer_id ? await db.one('SELECT * FROM customers WHERE id=$1', [j.customer_id]) : null;
    const me = req.user.name.split(' ')[0] || 'Your technician';
    if (status === 'on_the_way' && cust) {
      const text = `Hi ${cust.name.split(' ')[0]}, ${me} from ${bz.name} is on the way and will arrive soon.`;
      if (cust.phone && process.env.TWILIO_ACCOUNT_SID) await svc.sendSms({ businessId: bz.id, to: cust.phone, body: text });
      else await svc.sendEmail({ businessId: bz.id, to: cust.email, subject: `${bz.name} is on the way`, text, fromName: bz.name });
    }
    let invoiceId = null;
    if (status === 'done' || j.status === 'done') calendar.queue(j.id, originOf(req));
    if (status === 'done') {
      await log(bz.id, 'job', `${me} finished: ${j.title}${cust ? ' for ' + cust.name : ''}`, 'job', j.id);
      const existing = await db.one('SELECT id FROM invoices WHERE job_id=$1', [j.id]);
      if (!existing) invoiceId = (await createInvoice(bz, { jobId: j.id })).id;
    }
    return { ok: true, invoiceId };
  });
  router.post('/api/jobs/:id/photos', async (req, res, ctx) => {
    requireBusiness(req);
    const j = await owned('jobs', ctx.params.id, req.user.business_id);
    if (!manages(req) && !(can(req, 'jobs.assigned') && j.assigned_user_id === req.user.id)) fail(403, 'This job is not assigned to you');
    const label = ctx.body.label;
    if (!['job', 'invoice'].includes(label)) fail(400, 'Choose a label: job photo or invoice');
    const m = String(ctx.body.dataUrl || '').match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
    if (!m) fail(400, 'Please add a photo (JPG or PNG)');
    const buf = Buffer.from(m[3], 'base64'); if (buf.length > 6e6) fail(413, 'Photo is too large');
    const p = await db.one('INSERT INTO photos(business_id, job_id, label, mime, data, uploaded_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id, label, created_at', [j.business_id, j.id, label, m[1], buf, req.user.id]);
    return p;
  });
  router.get('/api/photos/:id', async (req, res, ctx) => {
    requireBusiness(req);
    const p = await owned('photos', ctx.params.id, req.user.business_id);
    const j = await owned('jobs', p.job_id, req.user.business_id);
    if (!manages(req) && !(can(req, 'jobs.assigned') && j.assigned_user_id === req.user.id)) fail(403, 'This job is not assigned to you');
    res.writeHead(200, { 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=86400' }); res.end(p.data);
  });
  router.del('/api/photos/:id', async (req, res, ctx) => {
    requireBusiness(req);
    const p = await owned('photos', ctx.params.id, req.user.business_id);
    if (!manages(req) && p.uploaded_by !== req.user.id) fail(403, 'You can only delete your own photos');
    await db.query('DELETE FROM photos WHERE id=$1', [p.id]);
    return { ok: true };
  });

  // Invoices
  const INVOICE_FROM = 'FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN jobs j ON j.id=i.job_id';
  router.get('/api/invoices', async (req, res, ctx) => {
    need(req, 'money.manage');
    if (ctx.query.get('page')) {
      const w = L.invoiceWhere(req.user.business_id, ctx.query); const p = L.paging(ctx.query, L.INVOICE_SORTS, 'number', 'desc', 'i.id');
      const [rows, t, stats] = await Promise.all([
        db.many(`SELECT i.id, i.number, i.status, i.total, i.issue_date, i.due_date, i.sent_at, i.viewed_at, i.paid_at, i.reminders_sent, i.customer_id, c.name AS customer_name, j.title AS job_title,
          (i.status='sent' AND i.due_date < CURRENT_DATE) AS overdue ${INVOICE_FROM} WHERE ${w.sql()} ORDER BY ${p.order} LIMIT ${p.per} OFFSET ${p.offset}`, w.params),
        db.one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(i.total),0)::float AS sum ${INVOICE_FROM} WHERE ${w.sql()}`, w.params),
        db.one(`SELECT COUNT(*) FILTER (WHERE status='sent')::int AS unpaid, COALESCE(SUM(total) FILTER (WHERE status='sent'),0)::float AS unpaid_sum,
          COUNT(*) FILTER (WHERE status='sent' AND due_date < CURRENT_DATE)::int AS overdue, COALESCE(SUM(total) FILTER (WHERE status='sent' AND due_date < CURRENT_DATE),0)::float AS overdue_sum,
          COUNT(*) FILTER (WHERE status='paid' AND paid_at > now() - interval '7 days')::int AS paid_week, COALESCE(SUM(total) FILTER (WHERE status='paid' AND paid_at > now() - interval '7 days'),0)::float AS paid_week_sum,
          COUNT(*) FILTER (WHERE status='draft')::int AS drafts FROM invoices WHERE business_id=$1`, [req.user.business_id]),
      ]);
      return L.pageResult(rows, t.n, p, { sum: t.sum, stats });
    }
    return db.many(`SELECT i.id, i.number, i.status, i.total, i.issue_date, i.due_date, i.sent_at, i.viewed_at, i.paid_at, i.reminders_sent, c.name AS customer_name, j.title AS job_title,
      (i.status='sent' AND i.due_date < CURRENT_DATE) AS overdue FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN jobs j ON j.id=i.job_id
      WHERE i.business_id=$1 ORDER BY i.id DESC LIMIT 500`, [req.user.business_id]);
  });
  router.post('/api/invoices', async (req, res, ctx) => {
    need(req, 'money.manage');
    const inv = await createInvoice(await biz(req), { jobId: ctx.body.job_id, quoteId: ctx.body.quote_id, customerId: ctx.body.customer_id });
    return { id: inv.id };
  });
  router.get('/api/invoices/:id', async (req, res, ctx) => {
    need(req, 'money.manage');
    const i = await owned('invoices', ctx.params.id, req.user.business_id);
    const [items, customer, job, photos] = await Promise.all([getItems('invoice', i.id), i.customer_id ? db.one('SELECT * FROM customers WHERE id=$1', [i.customer_id]) : null,
      i.job_id ? db.one('SELECT id, title, scheduled_at, finished_at FROM jobs WHERE id=$1', [i.job_id]) : null,
      i.job_id ? db.many('SELECT id, label FROM photos WHERE job_id=$1 ORDER BY id', [i.job_id]) : []]);
    return { invoice: i, items, customer, job, photos, url: `${originOf(req)}/i/${i.public_token}` };
  });
  router.put('/api/invoices/:id', async (req, res, ctx) => {
    need(req, 'money.manage');
    const i = await owned('invoices', ctx.params.id, req.user.business_id); const b = ctx.body;
    if (i.status === 'paid') fail(400, 'This invoice is paid and can no longer be changed');
    const items = cleanItems(b.items); const taxRate = b.tax_rate !== undefined ? Number(b.tax_rate) || 0 : i.tax_rate; const t = totals(items, taxRate);
    await db.query('UPDATE invoices SET customer_id=$2, notes=$3, tax_rate=$4, subtotal=$5, tax=$6, total=$7, issue_date=$8, due_date=$9 WHERE id=$1',
      [i.id, b.customer_id !== undefined ? Number(b.customer_id) || null : i.customer_id, str(b.notes ?? i.notes, 4000), taxRate, t.subtotal, t.tax, t.total, b.issue_date || i.issue_date, b.due_date || i.due_date]);
    await saveItems('invoice', i.id, items);
    return { ok: true, ...t };
  });
  router.post('/api/invoices/:id/send', async (req, res, ctx) => {
    need(req, 'money.manage');
    const b = await biz(req); const i = await owned('invoices', ctx.params.id, b.id);
    const out = await emailInvoice(b, i, req, false);
    await db.query("UPDATE invoices SET status=CASE WHEN status='draft' THEN 'sent' ELSE status END, sent_at=COALESCE(sent_at, now()) WHERE id=$1", [i.id]);
    await log(b.id, 'invoice', `Invoice ${i.number} sent · ${money(i.total, b.currency)}`, 'invoice', i.id);
    return { ok: true, ...out };
  });
  router.post('/api/invoices/:id/remind', async (req, res, ctx) => {
    need(req, 'money.manage');
    const b = await biz(req); const i = await owned('invoices', ctx.params.id, b.id);
    if (i.status !== 'sent') fail(400, 'Only sent, unpaid invoices can get a reminder');
    const out = await emailInvoice(b, i, req, true);
    await db.query('UPDATE invoices SET reminders_sent=reminders_sent+1, last_reminder=now() WHERE id=$1', [i.id]);
    return { ok: true, ...out };
  });
  router.post('/api/invoices/:id/paid', async (req, res, ctx) => {
    need(req, 'money.manage');
    const i = await owned('invoices', ctx.params.id, req.user.business_id);
    await markPaid(i, str(ctx.body.method, 40) || 'manual');
    return { ok: true };
  });
  router.post('/api/invoices/:id/void', async (req, res, ctx) => {
    need(req, 'money.manage');
    const i = await owned('invoices', ctx.params.id, req.user.business_id);
    if (i.status === 'paid') fail(400, 'A paid invoice cannot be voided');
    await db.query("UPDATE invoices SET status='void' WHERE id=$1", [i.id]);
    return { ok: true };
  });

  // In-app document preview (same HTML the customer sees)
  router.get('/api/doc/:type/:id', async (req, res, ctx) => {
    need(req, 'money.manage');
    const type = ctx.params.type === 'quote' ? 'quote' : 'invoice';
    const d = await owned(type === 'quote' ? 'quotes' : 'invoices', ctx.params.id, req.user.business_id);
    const b = await biz(req);
    const [items, c] = await Promise.all([getItems(type, d.id), d.customer_id ? db.one('SELECT * FROM customers WHERE id=$1', [d.customer_id]) : null]);
    return { html: renderDoc({ type, business: b, doc: d, items, customer: c }), css: DOC_CSS };
  });

  // Messages log + export
  router.get('/api/outbox', async (req) => {
    need(req, 'company.settings');
    return db.many('SELECT * FROM outbox WHERE business_id=$1 ORDER BY id DESC LIMIT 100', [req.user.business_id]);
  });
  router.get('/api/export/invoices.csv', async (req, res, ctx) => {
    need(req, 'money.manage');
    // Same filters as the invoice list, so "last month, paid" exports exactly what is on screen.
    const w = L.invoiceWhere(req.user.business_id, ctx.query);
    const rows = await db.many(`SELECT i.number, i.status, i.issue_date, i.due_date, i.paid_at, i.paid_method, i.subtotal, i.tax, i.total, c.name AS customer, c.email, j.title AS job
      ${INVOICE_FROM} WHERE ${w.sql()} ORDER BY i.issue_date, i.id`, w.params);
    const cols = ['number', 'status', 'issue_date', 'due_date', 'paid_at', 'paid_method', 'customer', 'email', 'job', 'subtotal', 'tax', 'total'];
    const q = (v) => { const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, String(v).match(/^\d{4}-\d\d-\d\dT/) ? 10 : undefined); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="unbusyness-invoices.csv"' });
    res.end(csv);
  });

  // Stripe Connect onboarding
  router.post('/api/stripe/connect', async (req) => {
    need(req, 'money.manage');
    if (!svc.stripeOn()) fail(400, 'Stripe is not set up yet. Add STRIPE_SECRET_KEY in Replit Secrets.');
    const b = await biz(req);
    let acct = b.stripe_account;
    if (!acct) {
      const a = await svc.stripe('POST', '/accounts', { type: 'express', email: b.email || req.user.email || undefined, business_profile: { name: b.name }, capabilities: { card_payments: { requested: true }, transfers: { requested: true } } });
      acct = a.id; await db.query('UPDATE businesses SET stripe_account=$2 WHERE id=$1', [b.id, acct]);
    }
    const link = await svc.stripe('POST', '/account_links', { account: acct, type: 'account_onboarding', refresh_url: `${originOf(req)}/api/stripe/return`, return_url: `${originOf(req)}/api/stripe/return` });
    return { url: link.url };
  });
  router.get('/api/stripe/return', async (req, res) => {
    need(req, 'money.manage');
    const b = await biz(req);
    if (b.stripe_account) {
      const a = await svc.stripe('GET', `/accounts/${b.stripe_account}`);
      await db.query('UPDATE businesses SET stripe_ready=$2 WHERE id=$1', [b.id, !!a.charges_enabled]);
    }
    redirect(res, '/#/settings/payments');
  });
  router.post('/api/webhooks/stripe', async (req, res) => {
    const ev = svc.verifyStripeWebhook(req.rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    if (ev.type === 'checkout.session.completed' && ev.data.object.payment_status === 'paid') {
      const id = Number(ev.data.object.metadata && ev.data.object.metadata.invoice_id);
      const i = id ? await db.one('SELECT * FROM invoices WHERE id=$1', [id]) : null;
      if (i) await markPaid(i, 'online');
    }
    if (ev.type === 'account.updated') {
      await db.query('UPDATE businesses SET stripe_ready=$2 WHERE stripe_account=$1', [ev.data.object.id, !!ev.data.object.charges_enabled]);
    }
    return { received: true };
  });

  // ---------- public customer pages ----------
  router.get('/q/:token', async (req, res, ctx) => {
    const q = await db.one('SELECT * FROM quotes WHERE public_token=$1', [ctx.params.token]);
    if (!q || q.status === 'draft') return html(res, 404, '<h1 style="font-family:sans-serif">Quote not found</h1>');
    const b = await db.one('SELECT * FROM businesses WHERE id=$1', [q.business_id]);
    const [items, c] = await Promise.all([getItems('quote', q.id), q.customer_id ? db.one('SELECT * FROM customers WHERE id=$1', [q.customer_id]) : null]);
    if (!q.viewed_at && !req.user) await db.query('UPDATE quotes SET viewed_at=now() WHERE id=$1', [q.id]);
    const expired = q.valid_until && new Date(q.valid_until) < new Date(new Date().toISOString().slice(0, 10));
    const bar = q.status === 'accepted' ? `<div class="note">You accepted this quote. ${esc(b.name)} will contact you to schedule the work.</div>`
      : q.status === 'declined' ? '<div class="note warn">This quote was declined.</div>'
        : `<div class="bar"><b>${esc(b.name)} sent you a quote</b><div style="display:flex;gap:8px"><button class="btn line" onclick="print()">Download PDF</button>
          ${expired ? '<span class="note warn" style="margin:0">This quote has expired. Please call us for an updated price.</span>' : `<form method="post" action="/q/${esc(q.public_token)}/accept" style="margin:0"><button class="btn primary">Accept quote · ${money(q.total, b.currency)}</button></form>`}</div></div>`;
    html(res, 200, publicPage({ title: `Quote ${q.number}`, business: b, body: bar + renderDoc({ type: 'quote', business: b, doc: q, items, customer: c }) }));
  });
  router.post('/q/:token/accept', async (req, res, ctx) => {
    const q = await db.one('SELECT * FROM quotes WHERE public_token=$1', [ctx.params.token]);
    if (!q || !['sent', 'accepted'].includes(q.status)) return redirect(res, `/q/${ctx.params.token}`);
    if (q.status !== 'accepted') {
      await db.query("UPDATE quotes SET status='accepted', accepted_at=now() WHERE id=$1", [q.id]);
      const c = q.customer_id ? await db.one('SELECT name FROM customers WHERE id=$1', [q.customer_id]) : null;
      await log(q.business_id, 'quote', `${c ? c.name : 'Customer'} accepted quote ${q.number} · ${money(q.total)}`, 'quote', q.id);
      const b = await db.one('SELECT * FROM businesses WHERE id=$1', [q.business_id]);
      await svc.sendEmail({ businessId: b.id, to: b.email, subject: `Quote ${q.number} accepted`, text: `${c ? c.name : 'Your customer'} accepted quote ${q.number} (${money(q.total, b.currency)}). Open Unbusyness to schedule the job.` });
    }
    redirect(res, `/q/${ctx.params.token}`);
  });
  router.get('/i/:token', async (req, res, ctx) => {
    const i = await db.one('SELECT * FROM invoices WHERE public_token=$1', [ctx.params.token]);
    if (!i || ['draft', 'void'].includes(i.status)) return html(res, 404, '<h1 style="font-family:sans-serif">Invoice not found</h1>');
    const b = await db.one('SELECT * FROM businesses WHERE id=$1', [i.business_id]);
    const [items, c] = await Promise.all([getItems('invoice', i.id), i.customer_id ? db.one('SELECT * FROM customers WHERE id=$1', [i.customer_id]) : null]);
    if (!i.viewed_at && !req.user) await db.query('UPDATE invoices SET viewed_at=now() WHERE id=$1', [i.id]);
    const canPay = svc.stripeOn() && (b.stripe_ready || process.env.STRIPE_ALLOW_PLATFORM === '1');
    const bar = i.status === 'paid' ? '<div class="note">Paid. Thank you!</div>'
      : `${ctx.query.get('paid') ? '<div class="note">Thank you! Your payment is being processed.</div>' : ''}<div class="bar"><b>Invoice from ${esc(b.name)} · due ${day(i.due_date)}</b><div style="display:flex;gap:8px"><button class="btn line" onclick="print()">Download PDF</button>
        ${canPay ? `<form method="post" action="/i/${esc(i.public_token)}/pay" style="margin:0"><button class="btn primary">Pay ${money(i.total, b.currency)}</button></form>` : ''}</div></div>`;
    html(res, 200, publicPage({ title: `Invoice ${i.number}`, business: b, body: bar + renderDoc({ type: 'invoice', business: b, doc: i, items, customer: c }) }));
  });
  router.post('/i/:token/pay', async (req, res, ctx) => {
    const i = await db.one('SELECT * FROM invoices WHERE public_token=$1', [ctx.params.token]);
    if (!i || i.status !== 'sent') return redirect(res, `/i/${ctx.params.token}`);
    const b = await db.one('SELECT * FROM businesses WHERE id=$1', [i.business_id]);
    const c = i.customer_id ? await db.one('SELECT * FROM customers WHERE id=$1', [i.customer_id]) : null;
    const s = await svc.checkoutForInvoice({ business: b, invoice: i, customer: c, origin: originOf(req) });
    await db.query('UPDATE invoices SET stripe_session=$2 WHERE id=$1', [i.id, s.id]);
    redirect(res, s.url);
  });
}

async function createInvoice(b, { jobId, quoteId, customerId }) {
  let items = []; let custId = Number(customerId) || null; let job = null; let qId = Number(quoteId) || null;
  if (jobId) {
    job = await db.one('SELECT * FROM jobs WHERE id=$1 AND business_id=$2', [Number(jobId), b.id]);
    if (!job) fail(404, 'Job not found');
    custId = custId || job.customer_id; qId = qId || job.quote_id;
  }
  if (qId) {
    const q = await db.one('SELECT * FROM quotes WHERE id=$1 AND business_id=$2', [qId, b.id]);
    if (q) { items = await getItems('quote', q.id); custId = custId || q.customer_id; }
  }
  if (!items.length && job) items = [{ description: job.title, qty: 1, unit: 'job', unit_price: Number(job.price) || 0 }];
  items = cleanItems(items);
  const t = totals(items, b.tax_rate);
  const inv = await db.one(`INSERT INTO invoices(business_id, customer_id, job_id, quote_id, number, tax_rate, subtotal, tax, total, issue_date, due_date, public_token, notes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_DATE,$10,$11,$12) RETURNING *`,
  [b.id, custId, job ? job.id : null, qId, await nextNumber(b.id, 'invoice'), b.tax_rate, t.subtotal, t.tax, t.total, addDays(b.payment_terms), rid(18), '']);
  await saveItems('invoice', inv.id, items);
  await log(b.id, 'invoice', `Invoice ${inv.number} ready to send · ${money(inv.total, b.currency)}`, 'invoice', inv.id);
  return inv;
}

async function emailInvoice(b, i, req, reminder) {
  const c = i.customer_id ? await db.one('SELECT * FROM customers WHERE id=$1', [i.customer_id]) : null;
  if (!c) fail(400, 'Add a customer to the invoice first');
  if (!Number(i.total)) fail(400, 'The invoice total is $0. Add prices first.');
  const url = `${req ? originOf(req) : publicUrl()}/i/${i.public_token}`;
  const first = c.name.split(' ')[0];
  const text = reminder
    ? `Hi ${first},\n\nThis is a friendly reminder that invoice ${i.number} from ${b.name} (${money(i.total, b.currency)}) was due on ${day(i.due_date)}.\n\nYou can view and pay it here: ${url}\n\nIf you already paid, thank you and please ignore this message.\n\n${b.name}`
    : `Hi ${first},\n\nThank you for choosing ${b.name}. Here is your invoice ${i.number} for ${money(i.total, b.currency)}, due ${day(i.due_date)}.\n\nView and pay it here: ${url}\n\n${b.name}${b.phone ? '\n' + b.phone : ''}`;
  const delivery = await svc.sendEmail({ businessId: b.id, to: c.email, subject: `${reminder ? 'Reminder: ' : ''}Invoice ${i.number} from ${b.name}`, text, html: text.replace(/\n/g, '<br>').replace(url, `<a href="${url}">${url}</a>`), replyTo: b.email, fromName: b.name });
  if (c.phone && process.env.TWILIO_ACCOUNT_SID) await svc.sendSms({ businessId: b.id, to: c.phone, body: `${b.name}: ${reminder ? 'reminder, ' : ''}invoice ${i.number} (${money(i.total, b.currency)}): ${url}` });
  return { delivery, url };
}

async function markPaid(i, method) {
  if (i.status === 'paid') return;
  await db.query("UPDATE invoices SET status='paid', paid_at=now(), paid_method=$2 WHERE id=$1", [i.id, method]);
  const c = i.customer_id ? await db.one('SELECT name FROM customers WHERE id=$1', [i.customer_id]) : null;
  await log(i.business_id, 'paid', `Invoice ${i.number} paid${c ? ' by ' + c.name : ''} · ${money(i.total)}`, 'invoice', i.id);
}

// Runs every 15 minutes: follow up on quiet quotes and remind about overdue invoices.
async function runReminders() {
  const quotes = await db.many(`SELECT q.*, b.name AS biz_name, b.email AS biz_email, b.currency, c.name AS cname, c.email AS cemail FROM quotes q JOIN businesses b ON b.id=q.business_id
    LEFT JOIN customers c ON c.id=q.customer_id WHERE q.status='sent' AND q.followup_at IS NULL AND q.sent_at < now() - interval '3 days' LIMIT 50`);
  for (const q of quotes) {
    const url = `${publicUrl()}/q/${q.public_token}`;
    await svc.sendEmail({ businessId: q.business_id, to: q.cemail, subject: `Any questions about your quote ${q.number}?`, fromName: q.biz_name, replyTo: q.biz_email,
      text: `Hi ${(q.cname || '').split(' ')[0]},\n\nJust checking in on quote ${q.number} (${money(q.total, q.currency)}). If you would like to go ahead, you can accept it here: ${url}\n\nHappy to answer any questions.\n\n${q.biz_name}` });
    await db.query('UPDATE quotes SET followup_at=now() WHERE id=$1', [q.id]);
    await log(q.business_id, 'quote', `Follow-up sent for quote ${q.number}`, 'quote', q.id);
  }
  const invoices = await db.many(`SELECT i.* FROM invoices i WHERE i.status='sent' AND i.due_date < CURRENT_DATE AND i.reminders_sent < 3
    AND (i.last_reminder IS NULL OR i.last_reminder < now() - interval '4 days') LIMIT 50`);
  for (const i of invoices) {
    const b = await db.one('SELECT * FROM businesses WHERE id=$1', [i.business_id]);
    try { await emailInvoice(b, i, null, true); } catch (e) { continue; }
    await db.query('UPDATE invoices SET reminders_sent=reminders_sent+1, last_reminder=now() WHERE id=$1', [i.id]);
    await log(i.business_id, 'invoice', `Payment reminder sent for ${i.number}`, 'invoice', i.id);
  }
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
}

module.exports = { routes, runReminders, ingestCall, findOrCreateCustomer, log, notifyOwner };
