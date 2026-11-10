// Waitlist sign-ups from the marketing site (unbusyness.com).
//
// POST /api/waitlist is the only public, cross-origin endpoint: the site lives on its own domain and sends
// JSON with fetch(). Only origins in ALLOWED_ORIGINS (plus WAITLIST_ORIGINS, comma separated) may call it.
// Each new sign-up is saved and emailed to WAITLIST_NOTIFY (default info@unbusyness.com).
// The same email signing up again for the same list updates the row and sends no second email.
// The team console (#/admin/waitlist) lists, exports and deletes sign-ups.
'use strict';
const db = require('./db');
const { fail } = require('./http');
const L = require('./lists');

const ALLOWED_ORIGINS = ['https://unbusyness.com', 'https://www.unbusyness.com'];
const allowedOrigins = () => [...ALLOWED_ORIGINS, ...String(process.env.WAITLIST_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)];
const notifyTo = () => String(process.env.WAITLIST_NOTIFY || 'info@unbusyness.com').trim();

// The welcome page and the full pages name the same lists differently; store one name per list.
const SEGMENTS = { resident: 'residents', residents: 'residents', manager: 'building_managers', building_managers: 'building_managers', trade: 'tradespeople', tradespeople: 'tradespeople', hotel: 'hotels', hotels: 'hotels' };
const SEGMENT_LABEL = { residents: 'Residents (Unbusyness Home)', building_managers: 'Building managers', tradespeople: 'Tradespeople', hotels: 'Hotels' };
// The welcome page sends its two extra answers as field1/field2; give them real names.
const WELCOME_FIELDS = { residents: ['address', 'manager'], building_managers: ['company', 'buildings'], tradespeople: ['company', 'team'], hotels: ['company', 'rooms'] };
const MAIN = new Set(['segment', 'name', 'email', 'phone', 'language', 'consent', 'page', 'website', 'field1', 'field2']);

/* ---------- CORS for the public endpoint ---------- */
function isWaitlistPath(pathname) { return pathname === '/api/waitlist' || pathname === '/api/waitlist/'; }
// Sets CORS headers when the origin is allowed. Returns true when the request was a preflight and is answered.
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins().includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  return false;
}
// Browsers send Origin on cross-site POSTs; only the site (or same-origin pages) may post sign-ups.
function originAllowed(req) {
  const origin = req.headers.origin;
  return !origin || allowedOrigins().includes(origin) || origin === `https://${req.headers.host}`;
}

/* ---------- simple abuse limits ---------- */
const hits = new Map();
function rateLimited(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(); const list = (hits.get(ip) || []).filter((t) => t > now - 10 * 60e3);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => t > now - 10 * 60e3)) hits.delete(k);
  return list.length > 8; // 8 sign-ups per 10 minutes per address is plenty for one household or office
}

const clip = (v, max = 300) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
function cleanDetails(body, segment) {
  const out = {};
  const [f1, f2] = WELCOME_FIELDS[segment] || [];
  if (f1 && clip(body.field1)) out[f1] = clip(body.field1);
  if (f2 && clip(body.field2)) out[f2] = clip(body.field2);
  for (const [k, v] of Object.entries(body || {}).slice(0, 30)) {
    if (MAIN.has(k) || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) continue;
    if (Array.isArray(v)) { const a = v.slice(0, 20).map((x) => clip(x, 120)).filter(Boolean); if (a.length) out[k] = a; }
    else if (typeof v === 'boolean') out[k] = v;
    else if (v !== null && v !== undefined && typeof v !== 'object' && clip(v)) out[k] = clip(v, k === 'message' ? 2000 : 300);
  }
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const label = (k) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const show = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));

async function notify(row) {
  const to = notifyTo(); if (!to) return;
  const { sendSystemEmail } = require('./mailer');
  const lines = [['List', SEGMENT_LABEL[row.segment] || row.segment], ['Name', row.name], ['Email', row.email], ['Phone', row.phone], ['Language', row.language],
    ...Object.entries(row.details || {}).map(([k, v]) => [label(k), show(v)]), ['Page', row.page]].filter(([, v]) => v);
  const text = `New waitlist sign-up\n\n${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nAll sign-ups: team console → Waitlist.`;
  const html = `<!doctype html><html><body style="margin:0;background:#FBFAF7;font-family:Arial,Helvetica,sans-serif;color:#14201E"><div style="max-width:560px;margin:0 auto;padding:28px 20px">
    <div style="background:#fff;border:1px solid #E7E3DA;border-radius:18px;padding:24px"><h1 style="margin:0 0 14px;font-size:20px">New waitlist sign-up</h1>
    <table style="border-collapse:collapse;width:100%;font-size:14px">${lines.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#7A8481;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`).join('')}</table>
    <p style="margin:18px 0 0;font-size:13px;color:#7A8481">All sign-ups are in the team console → Waitlist.</p></div></div></body></html>`;
  await sendSystemEmail(to, `Waitlist: ${SEGMENT_LABEL[row.segment] || row.segment} · ${row.name || row.email}`, text, html, 'waitlist');
}

function needAdminFn() { return require('./admin').needAdmin; }

function routes(router) {
  router.post('/api/waitlist', async (req, res, ctx) => {
    const b = ctx.body || {};
    if (clip(b.website)) return { ok: true }; // hidden "website" field: only bots fill it in
    if (rateLimited(req)) fail(429, 'Too many sign-ups from here. Please try again later.');
    const segment = SEGMENTS[clip(b.segment, 40)];
    if (!segment) fail(400, 'Unknown waitlist');
    const email = clip(b.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Please enter a valid email address.');
    if (b.consent !== true) fail(400, 'Consent is required.');
    const row = {
      segment, email, name: clip(b.name, 200), phone: clip(b.phone, 60), language: clip(b.language, 10).toLowerCase(),
      page: clip(b.page, 200), details: cleanDetails(b, segment),
    };
    if (JSON.stringify(row.details).length > 8000) fail(400, 'Too much text.');
    const saved = await db.one(`INSERT INTO waitlist(segment, email, name, phone, language, page, details) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (segment, email) DO UPDATE SET name=COALESCE(NULLIF(EXCLUDED.name,''), waitlist.name), phone=COALESCE(NULLIF(EXCLUDED.phone,''), waitlist.phone),
        language=EXCLUDED.language, page=EXCLUDED.page, details=waitlist.details || EXCLUDED.details, updated_at=now(), times=waitlist.times+1
      RETURNING id, (xmax = 0) AS inserted`, [row.segment, row.email, row.name, row.phone, row.language, row.page, row.details]);
    if (saved && saved.inserted) notify(row).catch((e) => console.error('Waitlist email failed:', e.message));
    return { ok: true };
  });

  const listWhere = (q) => {
    const w = L.where('TRUE AND $1::int IS NOT NULL', 1);
    const f = q.get('f');
    if (SEGMENT_LABEL[f]) w.add('w.segment=?', f);
    if (L.str(q.get('q'))) w.add('(w.email ILIKE ? OR w.name ILIKE ? OR w.phone ILIKE ? OR w.details::text ILIKE ?)', `%${L.str(q.get('q'), 100)}%`);
    return w;
  };

  router.get('/api/admin/waitlist', async (req, res, ctx) => {
    needAdminFn()(req);
    const w = listWhere(ctx.query);
    const p = L.paging(ctx.query, { created: 'w.created_at', email: 'lower(w.email)', segment: 'w.segment' }, 'created', 'desc', 'w.id');
    const [rows, t, counts] = await Promise.all([
      db.many(`SELECT w.* FROM waitlist w WHERE ${w.sql()} ORDER BY ${p.order} LIMIT ${p.per} OFFSET ${p.offset}`, w.params),
      db.one(`SELECT COUNT(*)::int AS n FROM waitlist w WHERE ${w.sql()}`, w.params),
      db.many('SELECT segment, COUNT(*)::int AS n FROM waitlist GROUP BY segment'),
    ]);
    return L.pageResult(rows, t.n, p, { counts: Object.fromEntries(counts.map((c) => [c.segment, c.n])), notify: notifyTo() });
  });

  router.get('/api/admin/waitlist.csv', async (req, res, ctx) => {
    needAdminFn()(req);
    const w = listWhere(ctx.query);
    const rows = await db.many(`SELECT w.* FROM waitlist w WHERE ${w.sql()} ORDER BY w.created_at, w.id`, w.params);
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r.details || {})))];
    const cols = ['created_at', 'segment', 'name', 'email', 'phone', 'language', 'page', ...keys];
    const q = (v) => { const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : /^\d{4}-\d\d-\d\dT/.test(String(v)) ? String(v).slice(0, 16).replace('T', ' ') : show(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => q(c in r ? r[c] : (r.details || {})[c])).join(','))].join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="unbusyness-waitlist.csv"', 'Cache-Control': 'no-store' });
    res.end(csv);
  });

  // Delete one sign-up (the consent text promises deletion on request). Logged in the change log.
  router.del('/api/admin/waitlist/:id', async (req, res, ctx) => {
    needAdminFn()(req);
    const row = await db.one('DELETE FROM waitlist WHERE id=$1 RETURNING email, segment', [Number(ctx.params.id) || 0]);
    if (!row) fail(404, 'Not found');
    await db.query('INSERT INTO admin_audit(admin_user_id, admin_email, action, details) VALUES($1,$2,$3,$4)',
      [req.user.id, req.user.email, 'waitlist.delete', { email: row.email, segment: row.segment, reason: clip((ctx.body || {}).reason, 300) }]);
    return { ok: true };
  });
}

module.exports = { routes, cors, isWaitlistPath, originAllowed, SEGMENT_LABEL };
