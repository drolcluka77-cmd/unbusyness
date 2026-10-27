// Error alerts: every unexpected server error is saved (app_errors) and the Unbusyness team gets an email.
// Same error → one email per hour at most; never more than 10 alert emails per hour in total.
// Only the request method and path are stored, never bodies, query strings, cookies or tokens.
'use strict';
const crypto = require('crypto');
const db = require('./db');

const sent = new Map(); let hourStart = Date.now(); let hourCount = 0;
const clean = (s) => String(s || '').replace(/[A-Za-z0-9_-]{24,}/g, '…'); // hide anything that looks like a token or id
const stackTop = (e) => String((e && e.stack) || '').split('\n').slice(0, 8).map((l) => l.replace(process.cwd(), '')).join('\n');

async function report(err, { method = '', path = '', userId = null, businessId = null, source = 'request' } = {}) {
  try {
    const message = clean(err && err.message ? err.message : err).slice(0, 500);
    const where = `${method} ${clean(String(path).split('?')[0])}`.trim().slice(0, 200);
    const sig = crypto.createHash('sha1').update(`${source}|${where.replace(/\d+/g, ':n')}|${message.replace(/\d+/g, 'n')}`).digest('hex').slice(0, 16);
    const row = await db.one(`INSERT INTO app_errors(signature, source, location, message, stack, user_id, business_id) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (signature) DO UPDATE SET count=app_errors.count+1, last_at=now(), location=EXCLUDED.location, user_id=EXCLUDED.user_id, business_id=EXCLUDED.business_id, resolved_at=NULL
      RETURNING count`, [sig, source, where, message, clean(stackTop(err)).slice(0, 2000), userId, businessId]);
    await alert(sig, { source, where, message, count: row ? row.count : 1 });
  } catch (e) { console.error('Could not save error report:', e.message); }
}

async function alert(sig, { source, where, message, count }) {
  const to = String(process.env.PLATFORM_ADMINS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!to.length) return;
  const now = Date.now();
  if (now - hourStart > 3600e3) { hourStart = now; hourCount = 0; }
  if ((sent.get(sig) || 0) > now - 3600e3 || hourCount >= 10) return;
  sent.set(sig, now); hourCount++;
  const { sendSystemEmail, layout } = require('./mailer');
  const url = `${(process.env.PUBLIC_URL || (process.env.REPLIT_DOMAINS ? 'https://' + process.env.REPLIT_DOMAINS.split(',')[0] : '')).replace(/\/$/, '')}/#/admin/system`;
  const text = `Something went wrong in Unbusyness.\n\n${message}\nWhere: ${where || source}\nTimes seen: ${count}\n\nDetails: ${url}`;
  await sendSystemEmail(to.join(','), `Unbusyness error: ${message.slice(0, 80)}`, text,
    layout({ title: 'Something went wrong', intro: `${message} — ${where || source} (seen ${count}×)`, button: 'Open the team console', url, outro: 'You get at most one email per error per hour.' }), 'error_alert');
}

module.exports = { report };
