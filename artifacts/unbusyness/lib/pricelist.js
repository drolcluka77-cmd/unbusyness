// Import a price list from a file: Excel (.xlsx), CSV, a photo or a PDF.
// Spreadsheets are read here (no extra packages). Photos and PDFs are read by the AI (needs ANTHROPIC_API_KEY).
// Nothing is saved here: the result goes back to Settings › Price list, where the owner checks it and clicks Save.
'use strict';
const zlib = require('zlib');

const MAX_ITEMS = 200;
const num = (v) => { if (v === null || v === undefined) return NaN; const s = String(v).replace(/[^\d,.-]/g, ''); if (!s) return NaN;
  // "1.234,50" (EU) or "1,234.50" (US) or "45,5"
  const lastComma = s.lastIndexOf(','); const lastDot = s.lastIndexOf('.');
  const norm = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  return Number(norm); };
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
function tidy(items) {
  const seen = new Set();
  return items.map((i) => ({ name: clean(i.name, 200), unit: clean(i.unit, 20) || 'job', price: Math.round((num(i.price) || 0) * 100) / 100, keywords: clean(i.keywords, 300) }))
    .filter((i) => i.name && i.name.length > 1 && !seen.has(i.name.toLowerCase()) && seen.add(i.name.toLowerCase()))
    .slice(0, MAX_ITEMS);
}

/* ---------- CSV ---------- */
function parseCsv(text) {
  const t = text.replace(/^﻿/, '');
  const firstLine = t.split(/\r?\n/)[0] || '';
  const sep = [';', '\t', ','].map((c) => [c, firstLine.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

/* ---------- XLSX (zip of XML files): first worksheet only ---------- */
function unzip(buf) {
  const files = {};
  // find End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This does not look like an Excel file (.xlsx).');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10); const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28); const extraLen = buf.readUInt16LE(p + 30); const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42); const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26); const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen; const data = buf.slice(start, start + csize);
    if (/^xl\/(sharedStrings|workbook)\.xml$|^xl\/worksheets\/sheet\d+\.xml$|^xl\/_rels\/workbook\.xml\.rels$/.test(name)) {
      if (csize > 30e6) throw new Error('This spreadsheet is too large.');
      files[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
const xmlText = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function parseXlsx(buf) {
  const f = unzip(buf);
  const shared = [...(f['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText((m[1].match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).join('')));
  const sheetName = Object.keys(f).filter((k) => k.startsWith('xl/worksheets/')).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))[0];
  if (!sheetName) throw new Error('No worksheet found in this file.');
  const rows = [];
  for (const rm of f[sheetName].matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]; const inner = cm[2] || '';
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1] || '';
      const col = ref ? ref.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1 : row.length;
      const type = (attrs.match(/t="(\w+)"/) || [])[1];
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = '';
      if (type === 's') val = shared[Number(v)] || '';
      else if (type === 'inlineStr') val = xmlText((inner.match(/<is>([\s\S]*?)<\/is>/) || [])[1] || '');
      else val = v !== undefined ? xmlText(v) : '';
      row[col] = val;
    }
    if (row.some((c) => String(c ?? '').trim())) rows.push(Array.from(row, (c) => c ?? ''));
    if (rows.length > 2000) break;
  }
  return rows;
}

/* ---------- table → items: find the name, price, unit and keyword columns ---------- */
const HEAD = {
  name: /^(service|services|item|items|name|description|work|job|task|product|storitev|storitve|opis|naziv|artikel|postavka)/i,
  price: /(price|cost|rate|amount|fee|cena|cene|znesek|eur|usd|€|\$)/i,
  unit: /^(unit|units|uom|per|enota|em|mera)/i,
  keywords: /(keyword|tags|aliases|search|klju[cč]n)/i,
};
function tableToItems(rows) {
  if (!rows.length) return [];
  let hi = rows.slice(0, 10).findIndex((r) => r.some((c) => HEAD.name.test(String(c).trim())) && r.some((c) => HEAD.price.test(String(c).trim())));
  let cols;
  if (hi >= 0) {
    const h = rows[hi].map((c) => String(c).trim());
    cols = { name: h.findIndex((c) => HEAD.name.test(c)), price: h.findIndex((c) => HEAD.price.test(c) && !HEAD.name.test(c)), unit: h.findIndex((c) => HEAD.unit.test(c)), keywords: h.findIndex((c) => HEAD.keywords.test(c)) };
  } else {
    // no header: the first mostly-text column is the name, the first mostly-number column is the price
    hi = -1; const sample = rows.slice(0, 30); const width = Math.max(...sample.map((r) => r.length));
    const share = (k, test) => sample.filter((r) => test(r[k])).length / sample.length;
    const isNum = (v) => Number.isFinite(num(v)) && String(v).trim() !== '';
    const isText = (v) => /[a-zA-ZčšžČŠŽ]{2,}/.test(String(v || ''));
    const textCol = [...Array(width).keys()].find((k) => share(k, isText) > 0.5);
    const numCol = [...Array(width).keys()].find((k) => k !== textCol && share(k, isNum) > 0.5);
    cols = { name: textCol ?? -1, price: numCol ?? -1, unit: -1, keywords: -1 };
  }
  if (cols.name < 0) return [];
  return tidy(rows.slice(hi + 1).filter((r) => String(r[cols.name] || '').trim() && !HEAD.name.test(String(r[cols.name]).trim()))
    .map((r) => ({ name: r[cols.name], price: cols.price >= 0 ? r[cols.price] : 0, unit: cols.unit >= 0 ? r[cols.unit] : '', keywords: cols.keywords >= 0 ? r[cols.keywords] : '' })));
}

/* ---------- photo / PDF → AI ---------- */
async function aiRead({ mime, data, text }, business) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('Reading photos and PDFs needs the AI to be switched on (ANTHROPIC_API_KEY). Excel and CSV files work without it.'), { status: 400 });
  const ask = `This is the price list of a ${business.trade || 'trade'} business${business.currency ? ` (currency ${business.currency})` : ''}. Extract every service or product with its price.
Rules: copy names as written (fix obvious typos only); price is a number without currency (use the main price if there are several; 0 if none is shown); unit is short (job, hour, visit, m, m2, piece, ...; "job" if unclear); keywords are 2–5 short words a customer might say on the phone (in the same language as the list). Skip headings, totals, VAT lines and contact details.
Reply with JSON only: {"items":[{"name":string,"unit":string,"price":number,"keywords":string}]}`;
  const content = text ? [{ type: 'text', text: `${ask}\n\nPrice list:\n${text.slice(0, 60000)}` }]
    : [mime === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } } : { type: 'image', source: { type: 'base64', media_type: mime, data } }, { type: 'text', text: ask }];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.AI_MODEL || 'claude-sonnet-5-5', max_tokens: 8000, messages: [{ role: 'user', content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error('The AI could not read this file' + (j.error && j.error.message ? `: ${j.error.message}` : '.')), { status: 502 });
  const txt = (j.content || []).map((c) => c.text || '').join('');
  try { return tidy(JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)).items || []); }
  catch { throw Object.assign(new Error('The AI answer could not be read. Try a sharper photo or an Excel file.'), { status: 502 }); }
}

const IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
async function importFile({ filename, mime, dataBase64 }, business) {
  const name = String(filename || '').toLowerCase(); const buf = Buffer.from(String(dataBase64 || ''), 'base64');
  if (!buf.length) throw Object.assign(new Error('The file is empty.'), { status: 400 });
  if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error('The file is larger than 8 MB.'), { status: 413 });
  let items; let via;
  if (name.endsWith('.xlsx') || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    const rows = parseXlsx(buf); items = tableToItems(rows); via = 'excel';
    if (!items.length && process.env.ANTHROPIC_API_KEY) { items = await aiRead({ text: rows.map((r) => r.join(' | ')).join('\n') }, business); via = 'excel+ai'; }
  } else if (name.endsWith('.xls')) {
    throw Object.assign(new Error('Old Excel files (.xls) are not supported. In Excel choose File › Save as › Excel Workbook (.xlsx) or CSV, then upload again.'), { status: 400 });
  } else if (/\.(csv|tsv|txt)$/.test(name) || /^text\//.test(mime || '')) {
    const rows = parseCsv(buf.toString('utf8')); items = tableToItems(rows); via = 'csv';
    if (!items.length && process.env.ANTHROPIC_API_KEY) { items = await aiRead({ text: buf.toString('utf8') }, business); via = 'csv+ai'; }
  } else if (name.endsWith('.pdf') || mime === 'application/pdf') {
    items = await aiRead({ mime: 'application/pdf', data: buf.toString('base64') }, business); via = 'pdf';
  } else if (IMAGE.includes(mime) || /\.(jpe?g|png|webp|gif)$/.test(name)) {
    items = await aiRead({ mime: IMAGE.includes(mime) ? mime : 'image/jpeg', data: buf.toString('base64') }, business); via = 'photo';
  } else {
    throw Object.assign(new Error('Upload a photo (JPG, PNG), a PDF, an Excel file (.xlsx) or a CSV.'), { status: 400 });
  }
  if (!items.length) throw Object.assign(new Error('No services with prices were found in this file. Check that it has a column with the service name and one with the price.'), { status: 422 });
  return { items, via };
}

module.exports = { importFile, parseCsv, parseXlsx, tableToItems };
