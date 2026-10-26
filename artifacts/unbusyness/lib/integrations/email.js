// Provider-agnostic email layer. The core app only calls these functions:
//   listThreads(row, { q, limit })  → [{ id, subject, from, snippet, date, unread }]
//   getThread(row, id)              → { id, subject, messages: [{ id, from, to, date, text, html }] }
//   createDraft(row, msg)           → { id }
//   send(row, msg)                  → { id }
//   test(row)                       → { ok, account }
// msg = { to, cc, subject, text, html, threadId, inReplyTo, references, fromName }
// Providers: Gmail (Google API), Microsoft 365 / Outlook (Graph API), IMAP/SMTP.
'use strict';
const crypto = require('crypto');
const { api } = require('./oauth');
const vault = require('./vault');

const enc = (s) => (/^[\x20-\x7e]*$/.test(s || '') ? (s || '') : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => x.trim()).filter(Boolean);
const stripHtml = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();

// RFC 5322 message (used by Gmail).
function mime({ from, to, cc, subject, text, html, inReplyTo, references }) {
  const b = 'ub_' + crypto.randomBytes(8).toString('hex');
  const head = [from ? `From: ${from}` : null, `To: ${list(to).join(', ')}`, list(cc).length ? `Cc: ${list(cc).join(', ')}` : null, `Subject: ${enc(subject || '')}`,
    'MIME-Version: 1.0', inReplyTo ? `In-Reply-To: ${inReplyTo}` : null, references || inReplyTo ? `References: ${references || inReplyTo}` : null].filter(Boolean);
  const plain = text || stripHtml(html);
  if (!html) return [...head, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(plain, 'utf8').toString('base64')].join('\r\n');
  return [...head, `Content-Type: multipart/alternative; boundary="${b}"`, '', `--${b}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(plain, 'utf8').toString('base64'),
    `--${b}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(html, 'utf8').toString('base64'), `--${b}--`].join('\r\n');
}

/* ---------- Gmail ---------- */
const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const gHeader = (m, n) => ((m.payload && m.payload.headers) || []).find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || '';
function gBody(part, type) {
  if (!part) return '';
  if (part.mimeType === type && part.body && part.body.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  for (const p of part.parts || []) { const x = gBody(p, type); if (x) return x; }
  return '';
}
const gmail = {
  async listThreads(row, { q = '', limit = 20 } = {}) {
    const r = await api(row, `${G}/threads?maxResults=${Math.min(limit, 50)}&q=${encodeURIComponent(q)}`);
    const ids = (r && r.threads) || [];
    return Promise.all(ids.map(async (t) => {
      const th = await api(row, `${G}/threads/${t.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
      const last = th.messages[th.messages.length - 1];
      return { id: t.id, subject: gHeader(th.messages[0], 'Subject'), from: gHeader(last, 'From'), snippet: last.snippet || t.snippet, date: new Date(Number(last.internalDate)).toISOString(), unread: (last.labelIds || []).includes('UNREAD'), count: th.messages.length };
    }));
  },
  async getThread(row, id) {
    const th = await api(row, `${G}/threads/${encodeURIComponent(id)}?format=full`);
    return {
      id, subject: gHeader(th.messages[0], 'Subject'),
      messages: th.messages.map((m) => ({ id: m.id, messageId: gHeader(m, 'Message-ID'), from: gHeader(m, 'From'), to: gHeader(m, 'To'), date: new Date(Number(m.internalDate)).toISOString(), text: gBody(m.payload, 'text/plain') || stripHtml(gBody(m.payload, 'text/html')), html: gBody(m.payload, 'text/html') })),
    };
  },
  async createDraft(row, msg) {
    const r = await api(row, `${G}/drafts`, { method: 'POST', body: JSON.stringify({ message: { raw: Buffer.from(mime(msg)).toString('base64url'), threadId: msg.threadId || undefined } }) });
    return { id: r.id };
  },
  async send(row, msg) {
    const r = await api(row, `${G}/messages/send`, { method: 'POST', body: JSON.stringify({ raw: Buffer.from(mime(msg)).toString('base64url'), threadId: msg.threadId || undefined }) });
    return { id: r.id, threadId: r.threadId };
  },
  async test(row) { const p = await api(row, `${G}/profile`); return { ok: true, account: p.emailAddress }; },
};

/* ---------- Microsoft 365 / Outlook (Graph) ---------- */
const M = 'https://graph.microsoft.com/v1.0/me';
const addr = (a) => (a && a.emailAddress ? `${a.emailAddress.name || ''} <${a.emailAddress.address}>`.trim() : '');
const recips = (v) => list(v).map((a) => ({ emailAddress: { address: a.replace(/.*<|>.*/g, '') } }));
const SELECT = 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,conversationId,isRead,internetMessageId';
const microsoft = {
  async listThreads(row, { q = '', limit = 20 } = {}) {
    const url = q ? `${M}/messages?$search=${encodeURIComponent(`"${q.replace(/"/g, '')}"`)}&$top=${Math.min(limit * 2, 50)}&$select=${SELECT}`
      : `${M}/mailFolders/inbox/messages?$top=${Math.min(limit * 2, 50)}&$orderby=receivedDateTime desc&$select=${SELECT}`;
    const r = await api(row, url, { headers: q ? { ConsistencyLevel: 'eventual' } : {} });
    const byConv = new Map();
    for (const m of (r && r.value) || []) {
      const t = byConv.get(m.conversationId);
      if (!t || t.date < m.receivedDateTime) byConv.set(m.conversationId, { id: m.conversationId, subject: m.subject, from: addr(m.from), snippet: m.bodyPreview, date: m.receivedDateTime, unread: !m.isRead, count: (t ? t.count : 0) + 1 });
      else t.count++;
    }
    return [...byConv.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit);
  },
  async getThread(row, id) {
    const r = await api(row, `${M}/messages?$filter=${encodeURIComponent(`conversationId eq '${String(id).replace(/'/g, "''")}'`)}&$top=50&$select=${SELECT},body`);
    const msgs = ((r && r.value) || []).sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? -1 : 1));
    return {
      id, subject: msgs[0] ? msgs[0].subject : '',
      messages: msgs.map((m) => ({ id: m.id, messageId: m.internetMessageId, from: addr(m.from), to: (m.toRecipients || []).map(addr).join(', '), date: m.receivedDateTime, text: m.body && m.body.contentType === 'text' ? m.body.content : stripHtml(m.body && m.body.content), html: m.body && m.body.contentType === 'html' ? m.body.content : '' })),
    };
  },
  async createDraft(row, msg) {
    const r = await api(row, `${M}/messages`, { method: 'POST', body: JSON.stringify({ subject: msg.subject, body: { contentType: msg.html ? 'HTML' : 'Text', content: msg.html || msg.text }, toRecipients: recips(msg.to), ccRecipients: recips(msg.cc) }) });
    return { id: r.id };
  },
  async send(row, msg) {
    if (msg.replyToId) { // reply inside the conversation
      await api(row, `${M}/messages/${encodeURIComponent(msg.replyToId)}/reply`, { method: 'POST', body: JSON.stringify({ comment: msg.text || stripHtml(msg.html) }) });
      return { id: msg.replyToId };
    }
    await api(row, `${M}/sendMail`, { method: 'POST', body: JSON.stringify({ message: { subject: msg.subject, body: { contentType: msg.html ? 'HTML' : 'Text', content: msg.html || msg.text }, toRecipients: recips(msg.to), ccRecipients: recips(msg.cc) }, saveToSentItems: true }) });
    return { id: null };
  },
  async test(row) { const me = await api(row, 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName'); return { ok: true, account: me.mail || me.userPrincipalName }; },
};

/* ---------- IMAP / SMTP (any mailbox; for manual onboarding) ---------- */
function libs() {
  try { return { ImapFlow: require('imapflow').ImapFlow, nodemailer: require('nodemailer'), simpleParser: require('mailparser').simpleParser }; }
  catch { throw new Error('IMAP support is not installed. Run "npm install" (packages imapflow, nodemailer, mailparser).'); }
}
async function withImap(cfg, fn) {
  const { ImapFlow } = libs();
  const client = new ImapFlow({ host: cfg.imap_host, port: Number(cfg.imap_port) || 993, secure: cfg.imap_secure !== false, auth: { user: cfg.username, pass: cfg.password }, logger: false, socketTimeout: 30000 });
  await client.connect();
  try { return await fn(client); } finally { await client.logout().catch(() => {}); }
}
const imapCfg = (row) => vault.open(row.credentials);
const imap = {
  async listThreads(row, { q = '', limit = 20 } = {}) {
    return withImap(imapCfg(row), async (c) => {
      const lock = await c.getMailboxLock('INBOX');
      try {
        let uids = await c.search(q ? { or: [{ subject: q }, { from: q }, { to: q }, { body: q }] } : { all: true }, { uid: true });
        uids = (uids || []).slice(-limit).reverse();
        const out = [];
        if (!uids.length) return out;
        for await (const m of c.fetch(uids, { envelope: true, flags: true, internalDate: true }, { uid: true })) {
          const f = m.envelope.from && m.envelope.from[0];
          out.push({ id: `INBOX:${m.uid}`, subject: m.envelope.subject || '', from: f ? `${f.name || ''} <${f.address}>`.trim() : '', snippet: '', date: new Date(m.internalDate).toISOString(), unread: !m.flags.has('\\Seen'), count: 1 });
        }
        return out.sort((a, b) => (a.date < b.date ? 1 : -1));
      } finally { lock.release(); }
    });
  },
  async getThread(row, id) {
    const [box, uid] = String(id).split(':');
    const { simpleParser } = libs();
    return withImap(imapCfg(row), async (c) => {
      const lock = await c.getMailboxLock(box || 'INBOX');
      try {
        const m = await c.fetchOne(uid, { source: true }, { uid: true });
        const p = await simpleParser(m.source);
        return { id, subject: p.subject || '', messages: [{ id, messageId: p.messageId, from: p.from ? p.from.text : '', to: p.to ? p.to.text : '', date: (p.date || new Date()).toISOString(), text: p.text || stripHtml(p.html), html: p.html || '' }] };
      } finally { lock.release(); }
    });
  },
  async createDraft(row, msg) {
    const cfg = imapCfg(row);
    return withImap(cfg, async (c) => {
      const boxes = await c.list();
      const drafts = (boxes.find((b) => b.specialUse === '\\Drafts') || {}).path || 'Drafts';
      const r = await c.append(drafts, mime({ ...msg, from: fromOf(cfg, msg) }), ['\\Draft', '\\Seen']);
      return { id: `${drafts}:${r && r.uid}` };
    });
  },
  async send(row, msg) {
    const cfg = imapCfg(row);
    const { nodemailer } = libs();
    const t = nodemailer.createTransport({ host: cfg.smtp_host, port: Number(cfg.smtp_port) || 587, secure: Number(cfg.smtp_port) === 465, auth: { user: cfg.smtp_username || cfg.username, pass: cfg.smtp_password || cfg.password } });
    const r = await t.sendMail({ from: fromOf(cfg, msg), to: list(msg.to), cc: list(msg.cc), subject: msg.subject, text: msg.text || stripHtml(msg.html), html: msg.html || undefined, inReplyTo: msg.inReplyTo, references: msg.references || msg.inReplyTo });
    return { id: r.messageId };
  },
  async test(row) {
    const cfg = imapCfg(row);
    await withImap(cfg, async (c) => { await c.status('INBOX', { messages: true }); });
    const { nodemailer } = libs();
    const t = nodemailer.createTransport({ host: cfg.smtp_host, port: Number(cfg.smtp_port) || 587, secure: Number(cfg.smtp_port) === 465, auth: { user: cfg.smtp_username || cfg.username, pass: cfg.smtp_password || cfg.password } });
    await t.verify();
    return { ok: true, account: cfg.from_email || cfg.username };
  },
};
function fromOf(cfg, msg) { const email = cfg.from_email || cfg.username; const name = msg.fromName || cfg.from_name; return name ? `"${String(name).replace(/"/g, '')}" <${email}>` : email; }

const PROVIDERS = { google: gmail, microsoft, imap };
const adapter = (row) => { const a = PROVIDERS[row.provider]; if (!a) throw new Error('Unknown email provider'); return a; };

module.exports = {
  listThreads: (row, o) => adapter(row).listThreads(row, o),
  getThread: (row, id) => adapter(row).getThread(row, id),
  createDraft: (row, msg) => adapter(row).createDraft(row, msg),
  send: (row, msg) => adapter(row).send(row, msg),
  test: (row) => adapter(row).test(row),
  mime, stripHtml,
};
