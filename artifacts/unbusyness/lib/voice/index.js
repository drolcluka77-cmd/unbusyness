// Voice integration layer: the only door between a voice platform and Unbusyness.
//
//   Voice platform (Retell, Vapi, ElevenLabs, …)
//        │  webhooks + live tool calls (HTTPS, signed)
//        ▼
//   /api/voice/<provider>/<business key>/…   ← this file: auth, logging, routing
//        │  adapter translates the provider's format ⇄ the Unbusyness contract
//        ▼
//   Core (calls, customers, quotes, jobs)    ← never knows which provider it was
//
// The agent has no database access and no API keys of ours. Swapping providers means
// changing one setting and the URLs in the provider dashboard. Nothing else changes.
'use strict';
const db = require('../db');
const { fail } = require('../http');
const { rid, originOf } = require('../auth');
const { need } = require('../rbac');
const adapters = require('./adapters');
const { TOOLS } = require('./contract');
const { makeTools } = require('./tools');

function trim(obj) {
  try { const t = JSON.stringify(obj); return t.length > 200000 ? { truncated: true, size: t.length } : obj; } catch { return null; }
}
async function record(businessId, provider, kind, name, externalId, status, error, payload) {
  await db.query('INSERT INTO voice_events(business_id, provider, kind, name, external_id, status, error, payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [businessId, provider, kind, name || '', externalId || null, status, error ? String(error).slice(0, 1000) : null, trim(payload)]);
}

// Who is calling us? Accept the provider's own signature, or the Unbusyness secret.
function authorize(req, ctx, business, adapter) {
  const ours = req.headers['x-unbusyness-secret'] || ctx.query.get('secret') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (ours && ours === business.voice_secret) return true;
  const providerSecret = business.voice_provider_secret || (adapter.id === 'vapi' ? business.voice_secret : '');
  const v = adapter.verify(req, providerSecret);
  if (v === true) return true;
  return false;
}

async function resolve(req, ctx) {
  const adapter = adapters.get(ctx.params.provider);
  if (!adapter) fail(404, 'Unknown voice provider');
  const business = await db.one('SELECT * FROM businesses WHERE voice_key=$1', [ctx.params.key]);
  if (!business) fail(404, 'Unknown business');
  if (!authorize(req, ctx, business, adapter)) {
    await record(business.id, adapter.id, 'auth', '', null, 'rejected', 'Signature or secret did not match', null);
    fail(401, 'Not authorized');
  }
  return { adapter, business };
}

function routes(router, core) {
  const tools = makeTools(core);

  // 1) After a call: the provider sends the finished call here.
  const handleEvent = async (req, res, ctx) => {
    const { adapter, business } = await resolve(req, ctx);
    let parsed;
    try { parsed = adapter.parseEvent(ctx.body || {}); } catch (e) { await record(business.id, adapter.id, 'event', '', null, 'error', 'Could not read payload: ' + e.message, ctx.body); fail(400, 'Could not read payload'); }
    if (parsed.kind === 'ignore') { await record(business.id, adapter.id, 'event', '', null, 'ignored', parsed.reason, null); return { ok: true, ignored: true }; }
    try {
      const out = await core.ingestCall(business, parsed.call, { provider: adapter.id, raw: trim(ctx.body) });
      await record(business.id, adapter.id, 'event', out.next || 'duplicate', parsed.call.external_id, out.duplicate ? 'duplicate' : 'ok', null, null);
      return { ok: true, id: out.call.id, duplicate: !!out.duplicate };
    } catch (e) {
      await record(business.id, adapter.id, 'event', '', parsed.call.external_id, 'error', e.message, ctx.body);
      throw e; // 500 → the provider retries later
    }
  };

  // 2) During a call: the agent asks a question (availability, customer lookup, booking).
  const handleTool = async (req, res, ctx) => {
    const { adapter, business } = await resolve(req, ctx);
    const body = req.method === 'GET' ? Object.fromEntries(ctx.query) : (ctx.body || {});
    let calls;
    try { calls = adapter.parseToolCalls(body, ctx.params.tool); } catch (e) { fail(400, 'Could not read tool call'); }
    const results = [];
    for (const c of calls) {
      const fn = tools[c.name];
      let result;
      if (!fn) result = { ok: false, error: `Unknown tool "${c.name}". Available: ${Object.keys(TOOLS).join(', ')}` };
      else {
        try { result = await fn(business, c.args || {}, { caller_phone: c.caller_phone, external_call_id: c.external_call_id }); } catch (e) { console.error('Voice tool failed', c.name, e); result = { ok: false, error: 'Tool failed', say: 'Sorry, I could not check that right now. I will ask the office to call you back.' }; }
      }
      await record(business.id, adapter.id, 'tool', c.name, c.external_call_id, result.ok ? 'ok' : 'error', result.error, { args: c.args });
      results.push({ id: c.id, name: c.name, result });
    }
    return adapter.formatToolResponse(results);
  };

  router.post('/api/voice/:provider/:key/events', handleEvent);
  router.post('/api/voice/:provider/:key/tools', handleTool);
  router.post('/api/voice/:provider/:key/tools/:tool', handleTool);
  router.get('/api/voice/:provider/:key/tools/:tool', handleTool);
  // Old URL from the first version, kept so nothing breaks.
  router.post('/api/webhooks/voice/:key', (req, res, ctx) => { ctx.params.provider = 'generic'; return handleEvent(req, res, ctx); });

  // ---- owner settings ----
  router.get('/api/voice/settings', async (req) => {
    need(req, 'company.settings');
    const b = await db.one('SELECT * FROM businesses WHERE id=$1', [req.user.business_id]);
    const base = `${originOf(req)}/api/voice/${b.voice_provider}/${b.voice_key}`;
    const events = await db.many('SELECT id, provider, kind, name, external_id, status, error, created_at FROM voice_events WHERE business_id=$1 ORDER BY id DESC LIMIT 40', [b.id]);
    return {
      provider: b.voice_provider, providers: Object.values(adapters.ADAPTERS).map((a) => ({ id: a.id, label: a.label })),
      has_provider_secret: !!b.voice_provider_secret, secret: b.voice_secret,
      urls: { events: `${base}/events`, tools: `${base}/tools`, tool: Object.keys(TOOLS).map((t) => ({ name: t, url: `${base}/tools/${t}`, description: TOOLS[t] })) },
      schedule: { work_days: b.work_days, work_start: b.work_start, work_end: b.work_end, slot_minutes: b.slot_minutes, service_area: b.service_area, emergency_policy: b.emergency_policy },
      events,
    };
  });
  router.put('/api/voice/settings', async (req, res, ctx) => {
    need(req, 'company.settings');
    const v = ctx.body; const b = await db.one('SELECT * FROM businesses WHERE id=$1', [req.user.business_id]);
    const provider = adapters.get(v.provider) ? v.provider : b.voice_provider;
    const secret = v.provider_secret === undefined ? b.voice_provider_secret : String(v.provider_secret).trim().slice(0, 300);
    const days = String(v.work_days ?? b.work_days).split(',').map(Number).filter((n) => n >= 1 && n <= 7).join(',') || '1,2,3,4,5';
    const ws = Math.min(23, Math.max(0, Number(v.work_start ?? b.work_start)));
    const we = Math.min(24, Math.max(ws + 1, Number(v.work_end ?? b.work_end)));
    await db.query(`UPDATE businesses SET voice_provider=$2, voice_provider_secret=$3, work_days=$4, work_start=$5, work_end=$6, slot_minutes=$7, service_area=$8, emergency_policy=$9 WHERE id=$1`,
      [b.id, provider, secret, days, ws, we, Math.max(30, Number(v.slot_minutes ?? b.slot_minutes) || 120), String(v.service_area ?? b.service_area).slice(0, 300), String(v.emergency_policy ?? b.emergency_policy).slice(0, 600)]);
    return { ok: true };
  });
}

module.exports = { routes, rid };
