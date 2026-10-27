// System emails from Unbusyness itself (confirm email, reset password, invites).
// Sent over SMTP from a mailbox like noreply@unbusyness.com. Customer emails do NOT use this:
// they go through the company's own connected mailbox (lib/integrations/email.js).
// One function, so the provider can be swapped later without touching the rest of the app.
'use strict';

const cfg = () => ({
  host: process.env.SYSTEM_SMTP_HOST, port: Number(process.env.SYSTEM_SMTP_PORT) || 587,
  user: process.env.SYSTEM_SMTP_USER, pass: process.env.SYSTEM_SMTP_PASS,
  from: process.env.SYSTEM_MAIL_FROM || (process.env.SYSTEM_SMTP_USER ? `Unbusyness <${process.env.SYSTEM_SMTP_USER}>` : ''),
});
const configured = () => { const c = cfg(); return !!(c.host && c.user && c.pass); };
const isProd = () => process.env.NODE_ENV === 'production' || process.env.REPLIT_DEPLOYMENT === '1';

let transport = null;
function getTransport() {
  if (transport) return transport;
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch { throw new Error('nodemailer is not installed. Run npm install.'); }
  const c = cfg();
  transport = nodemailer.createTransport({ host: c.host, port: c.port, secure: c.port === 465, auth: { user: c.user, pass: c.pass } });
  return transport;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

// Keep operator-visible delivery events useful without logging message contents,
// recipient addresses, tokens, provider responses, or SMTP credentials.
function logDelivery(category, status, details = {}) {
  const event = { event: 'account_email_delivery', category, status, ...details };
  const line = `[account-email] ${JSON.stringify(event)}`;
  if (status === 'accepted_by_smtp') console.info(line);
  else console.error(line);
}

function safeErrorDetails(error) {
  const details = {};
  if (/^E[A-Z0-9_]+$/.test(String(error && error.code || ''))) details.errorCode = error.code;
  const responseCode = Number(error && error.responseCode);
  if (Number.isInteger(responseCode) && responseCode >= 400 && responseCode <= 599) details.responseCode = responseCode;
  return details;
}

// Simple branded HTML with one button.
function layout({ title, intro, button, url, outro }) {
  return `<!doctype html><html><body style="margin:0;background:#FBFAF7;font-family:Arial,Helvetica,sans-serif;color:#14201E">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px"><div style="font-size:20px;font-weight:700;margin-bottom:24px"><span style="display:inline-block;width:26px;height:26px;border-radius:50%;background:#1F4D45;vertical-align:-6px;margin-right:8px"></span>unbusyness</div>
  <div style="background:#fff;border:1px solid #E7E3DA;border-radius:18px;padding:28px"><h1 style="margin:0 0 12px;font-size:22px">${esc(title)}</h1><p style="margin:0 0 22px;line-height:1.55;color:#56615F">${esc(intro)}</p>
  ${url ? `<a href="${esc(url)}" style="display:inline-block;background:#1F4D45;color:#FBFAF7;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:12px">${esc(button)}</a>
  <p style="margin:22px 0 0;font-size:12px;color:#7A8481;word-break:break-all">Or paste this link into your browser:<br>${esc(url)}</p>` : ''}
  ${outro ? `<p style="margin:18px 0 0;font-size:13px;color:#7A8481">${esc(outro)}</p>` : ''}</div></div></body></html>`;
}

async function sendSystemEmail(to, subject, text, html, category = 'other') {
  if (!configured()) {
    logDelivery(category, 'not_configured');
    // Development only: print the email so confirm/reset links can be used without SMTP. Never in production.
    if (!isProd()) { console.log(`\n[system email → ${to}] ${subject}\n${text}\n`); return 'logged'; }
    return 'not_configured';
  }
  try {
    const info = await getTransport().sendMail({ from: cfg().from, to, subject, text, html });
    const acceptedCount = Array.isArray(info && info.accepted) ? info.accepted.length : 0;
    const rejectedCount = Array.isArray(info && info.rejected) ? info.rejected.length : 0;
    if (rejectedCount) {
      const status = acceptedCount ? 'partially_rejected' : 'rejected';
      logDelivery(category, status, { acceptedCount, rejectedCount });
      return 'failed';
    }
    if (!acceptedCount) {
      logDelivery(category, 'failed', { reason: 'no_recipient_outcome' });
      return 'failed';
    }
    logDelivery(category, 'accepted_by_smtp');
    return 'sent';
  } catch (e) {
    logDelivery(category, 'failed', safeErrorDetails(e));
    return 'failed';
  }
}

// For the team console: is SMTP set up, and does a test message go through? (never returns the password)
const status = () => { const c = cfg(); return { configured: configured(), host: c.host || '', port: c.port, from: c.from || '' }; };

module.exports = { sendSystemEmail, layout, configured, isProd, status };
