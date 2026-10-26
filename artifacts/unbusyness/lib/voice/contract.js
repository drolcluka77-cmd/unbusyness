// The Unbusyness voice contract: the one shape the core system understands.
// Every provider adapter translates its own payloads into this shape, so the rest of
// Unbusyness never knows (or cares) which voice platform answered the call.
'use strict';

const INTENTS = ['new_job', 'quote_request', 'question', 'emergency', 'other'];
const URGENCY = ['low', 'normal', 'high', 'emergency'];

// Field names an agent's post-call analysis may use, mapped to canonical names.
const ALIASES = {
  customer_name: ['customer_name', 'caller_name', 'name', 'full_name', 'customer'],
  customer_email: ['customer_email', 'email', 'caller_email'],
  address: ['address', 'service_address', 'location', 'job_address'],
  intent: ['intent', 'call_type', 'reason_type', 'category'],
  service: ['service', 'issue', 'problem', 'need', 'job', 'request', 'reason'],
  urgency: ['urgency', 'priority', 'severity'],
  preferred_time: ['preferred_time', 'availability', 'preferred_date', 'when'],
  from_phone: ['from_phone', 'caller_phone', 'phone', 'callback_number', 'phone_number'],
};

const s = (v, max = 4000) => (v === undefined || v === null ? '' : String(typeof v === 'object' ? (v.value ?? JSON.stringify(v)) : v).trim().slice(0, max));

// Pick canonical fields out of a flat "structured data" object (any provider).
function fromStructured(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  const lower = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v && typeof v === 'object' && 'value' in v ? v.value : v]));
  for (const [canon, names] of Object.entries(ALIASES)) {
    for (const n of names) if (lower[n] !== undefined && lower[n] !== null && lower[n] !== '') { out[canon] = lower[n]; break; }
  }
  return out;
}

function normIntent(v, text) {
  const x = s(v).toLowerCase().replace(/[\s-]+/g, '_');
  if (INTENTS.includes(x)) return x;
  if (/quote|estimate|price/.test(x)) return 'quote_request';
  if (/emerg|urgent/.test(x)) return 'emergency';
  if (/question|info/.test(x)) return 'question';
  if (/book|job|repair|service|appoint/.test(x)) return 'new_job';
  const t = s(text).toLowerCase();
  if (/\b(quote|estimate|how much|price)\b/.test(t)) return 'quote_request';
  return 'new_job';
}
function normUrgency(v, intent) {
  const x = s(v).toLowerCase();
  if (URGENCY.includes(x)) return x;
  if (/emerg|asap|immediate/.test(x)) return 'emergency';
  if (/high|urgent|today/.test(x)) return 'high';
  if (/low|whenever|no rush/.test(x)) return 'low';
  return intent === 'emergency' ? 'emergency' : 'normal';
}

// Build a canonical CallRecord. All fields are strings except duration_sec.
function callRecord(p) {
  const intent = normIntent(p.intent, `${s(p.service)} ${s(p.summary)}`);
  return {
    external_id: s(p.external_id, 200) || null,
    from_phone: s(p.from_phone, 40),
    to_phone: s(p.to_phone, 40),
    customer_name: s(p.customer_name, 200),
    customer_email: s(p.customer_email, 200),
    address: s(p.address, 400),
    intent,
    service: s(p.service, 300),
    urgency: normUrgency(p.urgency, intent),
    preferred_time: s(p.preferred_time, 200),
    summary: s(p.summary, 4000),
    transcript: s(p.transcript, 60000),
    recording_url: s(p.recording_url, 1000),
    duration_sec: Number.isFinite(Number(p.duration_sec)) && p.duration_sec !== '' && p.duration_sec !== null ? Math.round(Number(p.duration_sec)) : null,
  };
}

// Tool names every provider can call during a live call.
const TOOLS = {
  get_business_info: 'Business name, trade, hours, service area and emergency policy. No prices.',
  lookup_customer: 'Find an existing customer by phone number. Args: phone.',
  get_availability: 'Next free appointment slots. Args (optional): date (YYYY-MM-DD), limit.',
  request_booking: 'Hold a slot for the caller; the owner confirms. Args: customer_name, phone, address, service, slot_start (ISO time from get_availability), notes, urgency.',
  create_callback: 'Ask the owner to call back. Args: customer_name, phone, reason, urgency.',
};

module.exports = { callRecord, fromStructured, TOOLS, INTENTS, URGENCY, s };
