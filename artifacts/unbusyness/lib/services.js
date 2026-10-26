// Outside services: email (Resend), SMS (Twilio), AI quote drafts (Anthropic), payments (Stripe).
// Each one is optional. Without keys, messages are saved to the Outbox so the app still works end to end.
'use strict';
const crypto = require('crypto');
const db = require('./db');

// ---------- Messages ----------
async function sendEmail({ businessId, to, subject, html, text, replyTo, fromName }) {
  let status = 'logged'; let error = null; let via = null;
  const key = process.env.RESEND_API_KEY;
  // 1) The company's own mailbox (Gmail, Microsoft 365 or IMAP/SMTP), so customers see the real sender.
  if (to && businessId) {
    try {
      const { companyMailbox } = require('./integrations');
      const box = await companyMailbox(businessId);
      if (box) {
        via = box.provider;
        try { await require('./integrations/email').send(box, { to, subject, text, html, fromName }); status = 'sent'; }
        catch (e) { status = 'failed'; error = `${box.provider}: ${e.message}`; await db.query('UPDATE integrations SET last_error=$2 WHERE id=$1', [box.id, error.slice(0, 500)]); }
      }
    } catch (e) { console.error('Mailbox lookup failed', e.message); }
  }
  // 2) Otherwise Resend (app-wide sender), 3) otherwise only saved in the Outbox.
  if (!via && key && to) {
    try {
      const from = process.env.MAIL_FROM || 'onboarding@resend.dev';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromName ? `${fromName} <${from.replace(/.*</, '').replace(/>.*/, '')}>` : from, to: [to], subject, html, text, reply_to: replyTo || undefined }),
      });
      if (r.ok) status = 'sent'; else { status = 'failed'; error = (await r.text()).slice(0, 500); }
    } catch (e) { status = 'failed'; error = e.message; }
  }
  await db.query('INSERT INTO outbox(business_id, channel, to_addr, subject, body, status, error) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [businessId, via ? `email:${via}` : 'email', to || '(no email on file)', subject, text || html, status, error]);
  return status;
}

async function sendSms({ businessId, to, body }) {
  let status = 'logged'; let error = null;
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_FROM: from } = process.env;
  if (sid && tok && from && to) {
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${tok}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: from, To: to, Body: body }),
      });
      if (r.ok) status = 'sent'; else { status = 'failed'; error = (await r.text()).slice(0, 500); }
    } catch (e) { status = 'failed'; error = e.message; }
  }
  await db.query('INSERT INTO outbox(business_id, channel, to_addr, subject, body, status, error) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [businessId, 'sms', to || '(no phone on file)', '', body, status, error]);
  return status;
}

// ---------- AI quote draft ----------
const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
function heuristicDraft(call, services) {
  const text = new Set(words(`${call.service} ${call.summary}`));
  const scored = services.map((s) => {
    const kw = [...words(s.name), ...words(s.keywords)].filter((w) => w.length > 2);
    return { s, score: kw.filter((w) => text.has(w) || text.has(w.replace(/s$/, ''))).length };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const items = [];
  const callout = services.find((s) => /call[- ]?out|trip|diagnos|service call/i.test(s.name));
  if (callout && (!scored[0] || scored[0].s.id !== callout.id)) items.push({ description: callout.name, qty: 1, unit: callout.unit, unit_price: Number(callout.price) });
  if (scored[0]) items.push({ description: scored[0].s.name, qty: 1, unit: scored[0].s.unit, unit_price: Number(scored[0].s.price) });
  if (!scored[0]) items.push({ description: call.service || 'Work as discussed', qty: 1, unit: 'job', unit_price: 0 });
  return { title: call.service || 'Quote', items, notes: 'Price based on the details from your call. Final scope is confirmed on site.' };
}

async function draftQuote(call, services, business) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ...heuristicDraft(call, services), ai: false };
  const prompt = `You prepare a draft quote for a ${business.trade || 'trade'} business. Use ONLY items from the price list; never invent prices. If nothing fits, use one line with unit_price 0 so the owner fills it in.
Price list (JSON): ${JSON.stringify(services.map((s) => ({ name: s.name, unit: s.unit, price: Number(s.price) })))}
Call: ${JSON.stringify({ service: call.service, summary: call.summary, urgency: call.urgency, transcript: String(call.transcript || '').slice(0, 4000) })}
Reply with JSON only: {"title": string, "items": [{"description": string, "qty": number, "unit": string, "unit_price": number}], "notes": string (one short customer-facing sentence)}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    const txt = (j.content || []).map((c) => c.text || '').join('');
    const parsed = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    if (!Array.isArray(parsed.items) || !parsed.items.length) throw new Error('no items');
    parsed.items = parsed.items.map((i) => ({ description: String(i.description || ''), qty: Number(i.qty) || 1, unit: String(i.unit || 'job'), unit_price: Number(i.unit_price) || 0 }));
    return { ...parsed, ai: true };
  } catch (e) {
    console.error('AI draft failed, using price-list match:', e.message);
    return { ...heuristicDraft(call, services), ai: false };
  }
}

// ---------- Stripe (Connect) ----------
const STRIPE = 'https://api.stripe.com/v1';
const stripeOn = () => !!process.env.STRIPE_SECRET_KEY;
function form(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) form(v, key, out);
    else if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, x)));
    else out.append(key, String(v));
  }
  return out;
}
async function stripe(method, path, params) {
  const r = await fetch(STRIPE + path + (method === 'GET' && params ? '?' + form(params) : ''), {
    method,
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : form(params || {}),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe error');
  return j;
}
const feePct = () => Number(process.env.PLATFORM_FEE_PCT || 0.5);

async function checkoutForInvoice({ business, invoice, customer, origin }) {
  const cents = Math.round(Number(invoice.total) * 100);
  const params = {
    mode: 'payment',
    success_url: `${origin}/i/${invoice.public_token}?paid=1`,
    cancel_url: `${origin}/i/${invoice.public_token}`,
    customer_email: customer && customer.email ? customer.email : undefined,
    line_items: [{ quantity: 1, price_data: { currency: (business.currency || 'usd').toLowerCase(), unit_amount: cents, product_data: { name: `${business.name} · Invoice ${invoice.number}` } } }],
    metadata: { invoice_id: invoice.id, business_id: business.id },
    payment_method_types: ['card', 'us_bank_account'],
  };
  if (business.stripe_account && business.stripe_ready) {
    params.payment_intent_data = { application_fee_amount: Math.round(cents * feePct() / 100), transfer_data: { destination: business.stripe_account }, metadata: { invoice_id: invoice.id } };
  }
  try { return await stripe('POST', '/checkout/sessions', params); }
  catch (e) {
    if (/us_bank_account/.test(e.message)) { delete params.payment_method_types; return stripe('POST', '/checkout/sessions', params); }
    throw e;
  }
}

function verifyStripeWebhook(raw, header, secret) {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw.toString('utf8')}`).digest('hex');
  const sigs = String(header || '').split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new Error('Bad Stripe signature');
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) throw new Error('Stripe webhook too old');
  return JSON.parse(raw.toString('utf8'));
}

module.exports = { sendEmail, sendSms, draftQuote, stripe, stripeOn, checkoutForInvoice, verifyStripeWebhook, feePct };
