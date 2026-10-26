// Provider-agnostic calendar layer + one-way sync. Unbusyness is the source of truth:
// only time-based commitments (jobs, appointments, inspections, meetings) are pushed out.
// Internal tasks (call supplier, send quote, follow up…) are never sent to external calendars.
'use strict';
const db = require('../db');
const { api } = require('./oauth');

const KINDS = { job: 'Job', appointment: 'Appointment', inspection: 'Inspection', meeting: 'Meeting' };

const google = {
  async upsert(row, ev, id) {
    const cal = encodeURIComponent((row.settings && row.settings.calendar_id) || 'primary');
    const body = {
      summary: ev.title, description: ev.description, location: ev.location || undefined,
      start: { dateTime: ev.start, timeZone: ev.timeZone }, end: { dateTime: ev.end, timeZone: ev.timeZone },
      extendedProperties: { private: { unbusyness_job_id: String(ev.jobId) } }, source: ev.url ? { title: 'Unbusyness', url: ev.url } : undefined,
    };
    if (id) {
      try { const r = await api(row, `https://www.googleapis.com/calendar/v3/calendars/${cal}/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }); return r.id; }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    }
    const r = await api(row, `https://www.googleapis.com/calendar/v3/calendars/${cal}/events`, { method: 'POST', body: JSON.stringify(body) });
    return r.id;
  },
  async remove(row, id) {
    const cal = encodeURIComponent((row.settings && row.settings.calendar_id) || 'primary');
    try { await api(row, `https://www.googleapis.com/calendar/v3/calendars/${cal}/events/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
  },
  async test(row) { const r = await api(row, 'https://www.googleapis.com/calendar/v3/calendars/primary'); return { ok: true, account: r.id }; },
};

const msTime = (iso) => new Date(iso).toISOString().replace('Z', '').replace(/\.\d+$/, '');
const microsoft = {
  async upsert(row, ev, id) {
    const body = {
      subject: ev.title, body: { contentType: 'Text', content: ev.description }, location: ev.location ? { displayName: ev.location } : undefined,
      start: { dateTime: msTime(ev.start), timeZone: 'UTC' }, end: { dateTime: msTime(ev.end), timeZone: 'UTC' },
      singleValueExtendedProperties: undefined,
    };
    const base = row.settings && row.settings.calendar_id ? `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(row.settings.calendar_id)}/events` : 'https://graph.microsoft.com/v1.0/me/events';
    if (id) {
      try { const r = await api(row, `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }); return r.id; }
      catch (e) { if (e.status !== 404) throw e; }
    }
    const r = await api(row, base, { method: 'POST', body: JSON.stringify(body) });
    return r.id;
  },
  async remove(row, id) {
    try { await api(row, `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
    catch (e) { if (e.status !== 404) throw e; }
  },
  async test(row) { const r = await api(row, 'https://graph.microsoft.com/v1.0/me/calendar?$select=name,owner'); return { ok: true, account: (r.owner && r.owner.address) || r.name }; },
};
const PROVIDERS = { google, microsoft };

const connection = (bizId) => db.one("SELECT * FROM integrations WHERE business_id=$1 AND kind='calendar' AND status IN ('connected','error')", [bizId]);
// A job is a time-based commitment when it has a time and is confirmed (not an AI request waiting for the owner).
const isCommitment = (j) => !!(j && j.scheduled_at && !j.tentative);

async function syncJob(jobId, publicUrl = '') {
  const j = await db.one(`SELECT j.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS assignee, b.timezone, b.name AS biz_name
    FROM jobs j JOIN businesses b ON b.id=j.business_id LEFT JOIN customers c ON c.id=j.customer_id LEFT JOIN users u ON u.id=j.assigned_user_id WHERE j.id=$1`, [jobId]);
  if (!j) return;
  const row = await connection(j.business_id);
  if (!row) return;
  const p = PROVIDERS[row.provider];
  try {
    if (!isCommitment(j)) {
      if (j.cal_event_id && j.cal_provider === row.provider) await p.remove(row, j.cal_event_id);
      await db.query('UPDATE jobs SET cal_event_id=NULL, cal_synced_at=now(), cal_error=NULL WHERE id=$1', [j.id]);
      return;
    }
    const start = new Date(j.scheduled_at); const end = new Date(start.getTime() + (Number(j.duration_min) || 90) * 60e3);
    const label = KINDS[j.kind] || 'Job';
    const ev = {
      jobId: j.id, title: `${label}: ${j.title}${j.customer_name ? ' · ' + j.customer_name : ''}${j.assignee ? ' (' + j.assignee + ')' : ''}${j.status === 'done' ? ' ✓' : ''}`,
      description: [j.customer_name && `Customer: ${j.customer_name}${j.customer_phone ? ' · ' + j.customer_phone : ''}`, j.assignee && `Assigned to: ${j.assignee}`, j.notes && `Notes: ${j.notes}`, 'Managed in Unbusyness. Changes made here are overwritten.'].filter(Boolean).join('\n'),
      location: j.address, start: start.toISOString(), end: end.toISOString(), timeZone: j.timezone || 'UTC', url: publicUrl ? `${publicUrl}/#/jobs/${j.id}` : undefined,
    };
    const id = await p.upsert(row, ev, j.cal_provider === row.provider ? j.cal_event_id : null);
    await db.query('UPDATE jobs SET cal_event_id=$2, cal_provider=$3, cal_synced_at=now(), cal_error=NULL WHERE id=$1', [j.id, id, row.provider]);
    await db.query("UPDATE integrations SET last_ok_at=now(), status='connected', last_error=NULL WHERE id=$1", [row.id]);
  } catch (e) {
    await db.query('UPDATE jobs SET cal_error=$2 WHERE id=$1', [j.id, e.message.slice(0, 300)]);
    await db.query('UPDATE integrations SET last_error=$2 WHERE id=$1', [row.id, `Job ${j.id}: ${e.message}`.slice(0, 500)]);
  }
}
// Fire-and-forget: never slow down or break the user's action because a calendar is down.
const queue = (jobId, publicUrl) => { setImmediate(() => syncJob(jobId, publicUrl).catch((e) => console.error('Calendar sync failed', e.message))); };

async function removeEvent(bizId, eventId, provider) {
  const row = await connection(bizId);
  if (!row || !eventId || provider !== row.provider) return;
  try { await PROVIDERS[row.provider].remove(row, eventId); } catch (e) { console.error('Calendar delete failed', e.message); }
}

async function syncAll(bizId, publicUrl) {
  const jobs = await db.many("SELECT id FROM jobs WHERE business_id=$1 AND (scheduled_at > now() - interval '1 day' AND scheduled_at < now() + interval '120 days' OR cal_event_id IS NOT NULL) ORDER BY scheduled_at LIMIT 500", [bizId]);
  for (const j of jobs) await syncJob(j.id, publicUrl);
  return jobs.length;
}

module.exports = { KINDS, PROVIDERS, syncJob, queue, removeEvent, syncAll, isCommitment, test: (row) => PROVIDERS[row.provider].test(row) };
