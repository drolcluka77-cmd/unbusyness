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
// Simple branded HTML with one button.
function layout({ title, intro, button, url, outro }) {
  return `<!doctype html><html><body style="margin:0;background:#FBFAF7;font-family:Arial,Helvetica,sans-serif;color:#14201E">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px"><div style="font-size:20px;font-weight:700;margin-bottom:24px"><span style="display:inline-block;width:26px;height:26px;border-radius:50%;background:#1F4D45;vertical-align:-6px;margin-right:8px"></span>unbusyness</div>
  <div style="background:#fff;border:1px solid #E7E3DA;border-radius:18px;padding:28px"><h1 style="margin:0 0 12px;font-size:22px">${esc(title)}</h1><p style="margin:0 0 22px;line-height:1.55;color:#56615F">${esc(intro)}</p>
  ${url ? `<a href="${esc(url)}" style="display:inline-block;background:#1F4D45;color:#FBFAF7;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:12px">${esc(button)}</a>
  <p style="margin:22px 0 0;font-size:12px;color:#7A8481;word-break:break-all">Or paste this link into your browser:<br>${esc(url)}</p>` : ''}
  ${outro ? `<p style="margin:18px 0 0;font-size:13px;color:#7A8481">${esc(outro)}</p>` : ''}</div></div></body></html>`;
}

async function sendSystemEmail(to, subject, text, html) {
  if (!configured()) {
    if (!isProd()) { console.log(`\n[system email → ${to}] ${subject}\n${text}\n`); return 'logged'; }
    console.error(`System email NOT sent (SYSTEM_SMTP_* secrets missing): "${subject}" to ${to}`);
    return 'not_configured';
  }
  try {
    await getTransport().sendMail({ from: cfg().from, to, subject, text, html });
    return 'sent';
  } catch (e) {
    console.error('System email failed:', e.message);
    return 'failed';
  }
}

module.exports = { sendSystemEmail, layout, configured, isProd };
