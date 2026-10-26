// Encrypts OAuth tokens and IMAP passwords before they are stored. AES-256-GCM.
// The key comes from the ENCRYPTION_KEY secret and never leaves the server.
// Losing the key means every connection must be reconnected (data stays safe).
'use strict';
const crypto = require('crypto');
const { fail } = require('../http');

function key() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (raw.length < 16) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const b = Buffer.from(raw, 'base64');
  if (b.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(raw)) return b;
  return crypto.createHash('sha256').update(raw).digest(); // any long passphrase also works
}
const ready = () => !!key();

function seal(obj) {
  const k = key();
  if (!k) fail(503, 'ENCRYPTION_KEY is not set on the server. Add it in Replit Secrets first (see README).');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}
function open(text) {
  const k = key();
  if (!k) fail(503, 'ENCRYPTION_KEY is not set on the server.');
  const [v, iv, tag, data] = String(text || '').split('.');
  if (v !== 'v1') throw new Error('Unknown credential format');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8'));
}

module.exports = { seal, open, ready };
