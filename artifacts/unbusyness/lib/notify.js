// Tell a worker when a job is assigned to them, moved, or cancelled.
// SMS when the worker has a phone number and Twilio is set up; email otherwise (or as well).
// Workers never get prices or customer phone numbers in these messages: only what, when, where, and a link.
'use strict';
const db = require('./db');
const svc = require('./services');
const { sendSystemEmail, layout } = require('./mailer');

const fmtWhen = (iso, tz) => (iso ? new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/Chicago' }) : 'time to be confirmed');
const first = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
const sameTime = (a, b) => (a ? new Date(a).getTime() : 0) === (b ? new Date(b).getTime() : 0);

// What changed between the job before and after an edit, from the assignee's point of view.
function changes(before, after) {
  const out = [];
  if (!before) { if (after.assigned_user_id) out.push({ userId: after.assigned_user_id, kind: 'assigned' }); return out; }
  if (before.assigned_user_id !== after.assigned_user_id) {
    if (after.assigned_user_id) out.push({ userId: after.assigned_user_id, kind: 'assigned' });
    if (before.assigned_user_id) out.push({ userId: before.assigned_user_id, kind: 'unassigned' });
  } else if (after.assigned_user_id && (!sameTime(before.scheduled_at, after.scheduled_at) || (before.address || '') !== (after.address || ''))) {
    out.push({ userId: after.assigned_user_id, kind: 'changed' });
  }
  return out;
}

const TEXT = {
  assigned: (j, w) => ({ subject: `New job: ${j.title} · ${w}`, head: 'New job for you', line: `New job: ${j.title}` }),
  changed: (j, w) => ({ subject: `Job moved: ${j.title} · ${w}`, head: 'A job was changed', line: `Changed: ${j.title}` }),
  unassigned: (j) => ({ subject: `Job taken off your list: ${j.title}`, head: 'A job was taken off your list', line: `No longer yours: ${j.title}` }),
  cancelled: (j) => ({ subject: `Job cancelled: ${j.title}`, head: 'A job was cancelled', line: `Cancelled: ${j.title}` }),
};

// job: the job row (after the change; for 'cancelled' the deleted row). actorId: who made the change (not notified).
async function notifyWorker(job, kind, { userId, actorId, origin } = {}) {
  try {
    const to = userId || job.assigned_user_id;
    if (!to || to === actorId || job.tentative) return null;
    const w = await db.one(`SELECT u.id, u.name, u.email, u.phone, m.active FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.business_id=$1 AND m.user_id=$2 AND u.active`, [job.business_id, to]);
    if (!w || !w.active) return null;
    const b = await db.one('SELECT name, timezone FROM businesses WHERE id=$1', [job.business_id]);
    const c = job.customer_id ? await db.one('SELECT name FROM customers WHERE id=$1', [job.customer_id]) : null;
    const when = fmtWhen(job.scheduled_at, b.timezone);
    const t = TEXT[kind](job, when);
    const link = kind === 'unassigned' || kind === 'cancelled' ? `${origin}/#/my` : `${origin}/#/job/${job.id}`;
    const details = [when, job.address, c && c.name].filter(Boolean).join(' · ');
    const sms = `${b.name}: ${t.line}. ${details}. ${link}`;
    const sent = []; let emailProblem = '';
    if (w.phone && process.env.TWILIO_ACCOUNT_SID) { const s = await svc.sendSms({ businessId: job.business_id, to: w.phone, body: sms.slice(0, 600) }); if (s === 'sent') sent.push('SMS'); }
    if (w.email && !sent.length) {
      const s = await sendSystemEmail(w.email, `${b.name}: ${t.subject}`, `Hi ${first(w.name)},\n\n${t.line}\n${details}\n\nOpen: ${link}\n\n${b.name} via Unbusyness`,
        layout({ title: t.head, intro: `Hi ${first(w.name)}, ${t.line.charAt(0).toLowerCase() + t.line.slice(1)}. ${details}.`, button: kind === 'unassigned' || kind === 'cancelled' ? 'Open my jobs' : 'Open the job', url: link, outro: `Sent by ${b.name} via Unbusyness.` }), 'worker_job');
      await db.query("INSERT INTO outbox(business_id, channel, to_addr, subject, body, status) VALUES($1,'email:team',$2,$3,$4,$5)", [job.business_id, w.email, t.subject, sms, s]);
      if (s === 'sent') sent.push('email'); else emailProblem = s === 'failed' ? 'the email was not accepted by the mail server' : 'system email (SMTP) is not set up';
    }
    await db.query('INSERT INTO activity(business_id, kind, text, ref_type, ref_id) VALUES($1,$2,$3,$4,$5)', [job.business_id, 'team',
      sent.length ? `${first(w.name)} was told by ${sent.join(' and ')}: ${t.line}` : `Could not tell ${first(w.name)} about "${job.title}": ${emailProblem || 'add their phone number or email'}`, 'job', job.id]);
    return sent;
  } catch (e) { console.error('Worker notification failed:', e.message); return null; }
}

async function notifyChanges(before, after, opts) {
  for (const ch of changes(before, after)) await notifyWorker(after, ch.kind, { ...opts, userId: ch.userId });
}

module.exports = { notifyWorker, notifyChanges, changes };
