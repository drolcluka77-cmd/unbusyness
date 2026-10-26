// Live-call tools. The voice agent can ask these questions DURING a call; it gets plain answers
// and a sentence it can say. The agent never sees prices and never commits to anything:
// bookings are held as "requested" until the owner confirms.
'use strict';
const db = require('../db');
const { s } = require('./contract');

// ---- time-zone helpers (no libraries) ----
function partsIn(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
function zoned(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = partsIn(new Date(guess), tz);
  const off = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - guess;
  return new Date(guess - off);
}
const label = (date, tz) => date.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz });

async function availability(b, { date, limit } = {}) {
  const tz = b.timezone || 'America/Chicago';
  const days = String(b.work_days || '1,2,3,4,5').split(',').map(Number);
  const slotMin = Math.max(30, Number(b.slot_minutes) || 120);
  const crew = Math.max(1, (await db.one("SELECT COUNT(*)::int AS n FROM memberships WHERE business_id=$1 AND active AND role IN ('worker','manager','owner')", [b.id])).n);
  const max = Math.min(Number(limit) || 6, 12);
  const now = new Date(); const earliest = new Date(now.getTime() + 2 * 3600e3);
  let start = partsIn(now, tz);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) { const [y, m, d] = date.split('-').map(Number); start = { y, m, d }; }
  const from = zoned(start.y, start.m, start.d, 0, 0, tz);
  const jobs = await db.many("SELECT scheduled_at, duration_min FROM jobs WHERE business_id=$1 AND scheduled_at >= $2::timestamptz AND scheduled_at < $2::timestamptz + interval '16 days' AND status <> 'done'", [b.id, from.toISOString()]);
  const busy = jobs.map((j) => [new Date(j.scheduled_at).getTime(), new Date(j.scheduled_at).getTime() + (Number(j.duration_min) || 90) * 60e3]);
  const out = [];
  for (let k = 0; k < 14 && out.length < max; k++) {
    const dayDate = new Date(Date.UTC(start.y, start.m - 1, start.d + k, 12));
    const y = dayDate.getUTCFullYear(); const m = dayDate.getUTCMonth() + 1; const d = dayDate.getUTCDate();
    if (!days.includes(dayDate.getUTCDay() === 0 ? 7 : dayDate.getUTCDay())) continue;
    for (let min = Number(b.work_start) * 60; min + slotMin <= Number(b.work_end) * 60 && out.length < max; min += slotMin) {
      const t = zoned(y, m, d, Math.floor(min / 60), min % 60, tz);
      if (t < earliest) continue;
      const a = t.getTime(); const z = a + slotMin * 60e3;
      const overlapping = busy.filter(([x, y2]) => x < z && y2 > a).length;
      if (overlapping < crew) out.push({ start: t.toISOString(), label: label(t, tz) });
    }
  }
  return out;
}

function makeTools({ findOrCreateCustomer, log, notifyOwner }) {
  return {
    async get_business_info(b) {
      const services = await db.many('SELECT name FROM services WHERE business_id=$1 ORDER BY position, id', [b.id]);
      const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const hours = `${String(b.work_days || '').split(',').map((n) => dayNames[Number(n) - 1]).filter(Boolean).join(', ')} ${b.work_start}:00–${b.work_end}:00`;
      return {
        ok: true,
        data: { name: b.name, trade: b.trade, phone: b.phone, address: b.address, hours, timezone: b.timezone, service_area: b.service_area || '', emergency_policy: b.emergency_policy || '', services: services.map((x) => x.name) },
        say: `${b.name} works ${hours}${b.service_area ? ` in ${b.service_area}` : ''}. Prices are confirmed by the owner in a written quote.`,
      };
    },
    async lookup_customer(b, args, ctx) {
      const phone = s(args.phone || ctx.caller_phone, 40);
      const digits = phone.replace(/\D/g, '').slice(-10);
      if (digits.length < 7) return { ok: true, data: { found: false }, say: 'I could not find that number.' };
      const c = await db.one("SELECT id, name, address FROM customers WHERE business_id=$1 AND right(regexp_replace(phone, '\\D', '', 'g'), 10)=$2 ORDER BY id LIMIT 1", [b.id, digits]);
      if (!c) return { ok: true, data: { found: false }, say: 'This is a new customer.' };
      const last = await db.one("SELECT title, scheduled_at FROM jobs WHERE customer_id=$1 ORDER BY scheduled_at DESC NULLS LAST LIMIT 1", [c.id]);
      const next = await db.one("SELECT title, scheduled_at FROM jobs WHERE customer_id=$1 AND scheduled_at > now() AND status <> 'done' ORDER BY scheduled_at LIMIT 1", [c.id]);
      return {
        ok: true,
        data: { found: true, name: c.name, address: c.address, last_job: last ? last.title : null, upcoming_appointment: next ? label(new Date(next.scheduled_at), b.timezone) : null },
        say: `Returning customer ${c.name}${next ? `, with an appointment on ${label(new Date(next.scheduled_at), b.timezone)}` : ''}.`,
      };
    },
    async get_availability(b, args) {
      const slots = await availability(b, args);
      return { ok: true, data: { slots }, say: slots.length ? `The next free times are: ${slots.slice(0, 3).map((x) => x.label).join('; ')}.` : 'There are no free times in the next two weeks. Offer a callback.' };
    },
    async request_booking(b, args, ctx) {
      const when = new Date(args.slot_start || args.start || '');
      if (Number.isNaN(when.getTime()) || when < new Date()) return { ok: false, error: 'slot_start must be a future time from get_availability', say: 'That time is not available. Let me check the free times again.' };
      const free = await availability(b, { date: when.toISOString().slice(0, 10), limit: 12 });
      if (!free.some((x) => Math.abs(new Date(x.start) - when) < 60e3)) return { ok: false, error: 'slot no longer free', say: 'That time was just taken. Let me check other times.' };
      const customer = await findOrCreateCustomer(b.id, { name: s(args.customer_name, 200), phone: s(args.phone || ctx.caller_phone, 40), email: s(args.email, 200), address: s(args.address, 400) });
      const owner = await db.one("SELECT user_id AS id FROM memberships WHERE business_id=$1 AND role='owner' AND active ORDER BY id LIMIT 1", [b.id]);
      const job = await db.one(`INSERT INTO jobs(business_id, customer_id, title, address, scheduled_at, duration_min, assigned_user_id, notes, tentative, voice_call_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9) RETURNING id`, [b.id, customer.id, s(args.service, 200) || 'Service visit', s(args.address, 400) || customer.address, when.toISOString(), Number(b.slot_minutes) || 120, owner ? owner.id : null, s(args.notes, 2000), ctx.external_call_id || null]);
      await log(b.id, 'job', `AI requested a booking: ${s(args.service, 80) || 'service visit'} for ${customer.name}, ${label(when, b.timezone)}. Please confirm.`, 'job', job.id);
      if (/emerg|high/.test(s(args.urgency))) await notifyOwner(b, `Urgent booking request from ${customer.name} (${customer.phone}): ${s(args.service, 120)}`);
      return { ok: true, data: { booking_id: job.id, status: 'requested', start: when.toISOString(), label: label(when, b.timezone) }, say: `I have requested ${label(when, b.timezone)} for you. The office will confirm by text or email shortly.` };
    },
    async create_callback(b, args, ctx) {
      const customer = await findOrCreateCustomer(b.id, { name: s(args.customer_name, 200), phone: s(args.phone || ctx.caller_phone, 40) });
      const urgent = /emerg|high/.test(s(args.urgency));
      const t = await db.one('INSERT INTO tasks(business_id, title, customer_id, due_at) VALUES($1,$2,$3, now()) RETURNING id', [b.id, `${urgent ? 'URGENT: call back' : 'Call back'} ${customer.name}${args.reason ? ': ' + s(args.reason, 160) : ''}`, customer.id]);
      if (urgent) await notifyOwner(b, `Urgent callback: ${customer.name} (${customer.phone}) ${s(args.reason, 160)}`);
      return { ok: true, data: { task_id: t.id }, say: urgent ? 'I have flagged this as urgent. Someone will call you back within minutes.' : 'I have asked the office to call you back.' };
    },
  };
}

module.exports = { makeTools, availability };
