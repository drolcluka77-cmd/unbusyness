// Provider adapters. Each adapter only translates; it never touches the database.
// To support a new voice platform, add one object here with the same five methods.
'use strict';
const crypto = require('crypto');
const { callRecord, fromStructured, s } = require('./contract');

const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hmacHex = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');
const transcriptText = (t) => (Array.isArray(t) ? t.map((m) => `${(m.role || m.speaker || '').replace('assistant', 'agent').replace(/^bot$/, 'agent')}: ${m.message || m.content || m.text || ''}`).join('\n') : s(t, 60000));

/* Generic: our own JSON format (documented in VOICE_INTEGRATION.md). Works with any platform
   that can send a webhook, including no-code tools like Make or Zapier. */
const generic = {
  id: 'generic', label: 'Generic (Unbusyness JSON)',
  verify: () => null, // uses the Unbusyness secret only
  parseEvent(b) {
    const d = b && b.data && typeof b.data === 'object' && !b.summary ? { ...b.data, call_id: b.data.call_id || b.call_id } : b;
    if (!d || (d.event && !/completed|ended|analy[sz]ed/.test(d.event))) return { kind: 'ignore', reason: 'event not used' };
    return { kind: 'call.completed', call: callRecord({ external_id: d.call_id || d.id, ...d, ...fromStructured(d), summary: d.summary, transcript: transcriptText(d.transcript) }) };
  },
  parseToolCalls(b, nameFromPath) {
    const name = nameFromPath || b.name || b.tool;
    const args = b.args || b.arguments || b.parameters || (nameFromPath ? b : {});
    return [{ id: b.id || 'call', name, args: typeof args === 'string' ? JSON.parse(args || '{}') : args, external_call_id: s(b.call_id), caller_phone: s(b.from_phone || b.caller_phone) }];
  },
  formatToolResponse: (results) => (results.length === 1 ? results[0].result : { results: results.map((r) => ({ id: r.id, result: r.result })) }),
};

/* Retell AI: webhook events (call_analyzed) + custom functions.
   Signature: header "x-retell-signature: v=<ms>,d=<hex HMAC-SHA256(apiKey, rawBody + ms)>" */
const retell = {
  id: 'retell', label: 'Retell AI',
  verify(req, secret) {
    const h = req.headers['x-retell-signature'];
    if (!h || !secret) return null;
    const m = String(h).match(/v=(\d+),d=(.*)/);
    if (!m) return false;
    if (Math.abs(Date.now() - Number(m[1])) > 5 * 60e3) return false;
    return safeEq(hmacHex(secret, req.rawBody.toString('utf8') + m[1]), m[2]);
  },
  parseEvent(b) {
    const ev = b.event; const c = b.call || b.data || {};
    // Only call_analyzed carries the summary and extracted fields. Turn it on in Retell's webhook settings.
    if (ev !== 'call_analyzed') return { kind: 'ignore', reason: `event ${ev} not used (Unbusyness uses call_analyzed)` };
    const a = c.call_analysis || {};
    const st = fromStructured({ ...(a.custom_analysis_data || {}), ...(c.retell_llm_dynamic_variables || {}), ...(c.collected_dynamic_variables || {}) });
    const inbound = (c.direction || 'inbound') === 'inbound';
    return {
      kind: 'call.completed', final: ev === 'call_analyzed',
      call: callRecord({
        ...st, external_id: c.call_id, from_phone: st.from_phone || (inbound ? c.from_number : c.to_number), to_phone: inbound ? c.to_number : c.from_number,
        summary: a.call_summary, transcript: c.transcript, recording_url: c.recording_url,
        duration_sec: c.end_timestamp && c.start_timestamp ? (c.end_timestamp - c.start_timestamp) / 1000 : c.duration_ms ? c.duration_ms / 1000 : null,
      }),
    };
  },
  parseToolCalls(b, nameFromPath) {
    const wrapped = b && b.args && typeof b.args === 'object';
    const c = (wrapped && b.call) || {};
    return [{ id: c.call_id || 'call', name: nameFromPath || b.name, args: wrapped ? b.args : b, external_call_id: s(c.call_id), caller_phone: s(c.from_number) }];
  },
  formatToolResponse: (results) => results[0].result,
};

/* Vapi: one server URL receives every message type.
   Auth: Vapi sends the server secret in the "x-vapi-secret" header. */
const vapi = {
  id: 'vapi', label: 'Vapi',
  verify(req, secret) {
    const h = req.headers['x-vapi-secret'];
    if (!h || !secret) return null;
    return safeEq(h, secret);
  },
  parseEvent(b) {
    const m = b.message || b;
    if (m.type !== 'end-of-call-report') return { kind: 'ignore', reason: `message ${m.type} not used` };
    const c = m.call || {}; const an = m.analysis || {}; const art = m.artifact || {};
    const st = fromStructured({ ...(an.structuredData || {}), ...((c.assistantOverrides && c.assistantOverrides.variableValues) || {}) });
    return {
      kind: 'call.completed', final: true,
      call: callRecord({
        ...st, external_id: c.id, from_phone: st.from_phone || (c.customer && c.customer.number) || '', to_phone: (c.phoneNumber && c.phoneNumber.number) || '',
        summary: an.summary || m.summary, transcript: art.transcript || m.transcript || transcriptText(art.messages), recording_url: art.recordingUrl || m.recordingUrl || '',
        duration_sec: m.durationSeconds || (m.startedAt && m.endedAt ? (Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 1000 : null),
      }),
    };
  },
  parseToolCalls(b) {
    const m = b.message || b; const c = m.call || {};
    const list = m.toolCallList || m.toolCalls || (m.toolWithToolCallList || []).map((t) => t.toolCall) || [];
    return list.map((t) => {
      const f = t.function || {}; let args = f.arguments ?? t.arguments ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      return { id: t.id, name: f.name || t.name, args, external_call_id: s(c.id), caller_phone: s(c.customer && c.customer.number) };
    });
  },
  formatToolResponse: (results) => ({ results: results.map((r) => ({ toolCallId: r.id, result: JSON.stringify(r.result) })) }),
};

/* ElevenLabs Agents: post-call webhook (post_call_transcription) + server tools.
   Signature: header "ElevenLabs-Signature: t=<sec>,v0=<hex HMAC-SHA256(secret, t + '.' + rawBody)>" */
const elevenlabs = {
  id: 'elevenlabs', label: 'ElevenLabs Agents',
  verify(req, secret) {
    const h = req.headers['elevenlabs-signature'];
    if (!h || !secret) return null;
    const parts = Object.fromEntries(String(h).split(',').map((p) => p.split('=')));
    if (!parts.t || !parts.v0) return false;
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 30 * 60) return false;
    return safeEq(hmacHex(secret, `${parts.t}.${req.rawBody.toString('utf8')}`), parts.v0);
  },
  parseEvent(b) {
    if (b.type !== 'post_call_transcription') return { kind: 'ignore', reason: `event ${b.type} not used` };
    const d = b.data || {}; const an = d.analysis || {}; const md = d.metadata || {}; const pc = md.phone_call || {};
    const dyn = (d.conversation_initiation_client_data && d.conversation_initiation_client_data.dynamic_variables) || {};
    const st = fromStructured(an.data_collection_results || {});
    return {
      kind: 'call.completed', final: true,
      call: callRecord({
        ...st, external_id: d.conversation_id, from_phone: st.from_phone || pc.external_number || dyn.system__caller_id || '', to_phone: pc.agent_number || dyn.system__called_number || '',
        summary: an.transcript_summary, transcript: transcriptText(d.transcript), duration_sec: md.call_duration_secs,
      }),
    };
  },
  parseToolCalls(b, nameFromPath) {
    return [{ id: 'call', name: nameFromPath || b.tool || b.name, args: b.args || b.parameters || b, external_call_id: s(b.conversation_id), caller_phone: s(b.caller_id || b.system__caller_id) }];
  },
  formatToolResponse: (results) => results[0].result,
};

const ADAPTERS = { generic, retell, vapi, elevenlabs };
module.exports = { ADAPTERS, get: (id) => ADAPTERS[id] || null };
