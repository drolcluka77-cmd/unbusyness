// Renders quotes and invoices as professional A4 documents (HTML). Used for the customer page,
// the in-app preview and printing to PDF, so every place shows the same document.
'use strict';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const money = (n, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(Number(n) || 0);
const day = (d) => (d ? new Date(String(d).length <= 10 ? d + 'T12:00:00Z' : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const nl = (s) => esc(s).replace(/\n/g, '<br>');

const LOGO = `<svg width="34" height="34" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="24" fill="#1F4D45"/><path d="M14.5 19 V25.5 a9.5 9.5 0 0 0 19 0 V19" fill="none" stroke="#FBFAF7" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="15.5" r="3.4" fill="#F2A57A"/></svg>`;

const DOC_CSS = `
.ubdoc{--g:#1F4D45;--ink:#1b2422;--mut:#5b6663;--line:#ebe6dc;--sand:#F4EFE6;font-family:'Plus Jakarta Sans','Segoe UI',system-ui,sans-serif;color:var(--ink);background:#fff;width:100%;max-width:820px;margin:0 auto;box-sizing:border-box;padding:48px 52px;font-size:13px;line-height:1.5;border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 40px rgba(20,32,30,.08)}
.ubdoc *{box-sizing:border-box}
.ubdoc .d-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}
.ubdoc .d-co b{font-size:16px}.ubdoc .d-co div{color:var(--mut);font-size:12px}.ubdoc .d-co .d-brand b{color:var(--ink)}
.ubdoc .d-brand{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.ubdoc .d-brand img{max-height:48px;max-width:160px;object-fit:contain}
.ubdoc .d-meta{display:grid;grid-template-columns:auto auto;gap:3px 16px;font-size:12px;text-align:right}
.ubdoc .d-meta span{color:var(--mut)}
.ubdoc h1{margin:30px 0 2px;font-size:28px;letter-spacing:-.6px}
.ubdoc .d-sub{color:var(--mut)}
.ubdoc .d-bill{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin:20px 0 22px}
.ubdoc small.d-lab{display:block;font-size:10px;font-weight:700;letter-spacing:1.2px;color:var(--mut);text-transform:uppercase;margin-bottom:4px}
.ubdoc table{width:100%;border-collapse:collapse;font-size:12.5px}
.ubdoc th{background:var(--sand);text-align:left;font-size:10px;letter-spacing:1px;text-transform:uppercase;padding:9px 10px;color:var(--mut)}
.ubdoc td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
.ubdoc .d-r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.ubdoc .d-tot{margin-left:auto;width:300px;margin-top:14px}
.ubdoc .d-tot div{display:flex;justify-content:space-between;padding:5px 10px}
.ubdoc .d-tot .d-grand{background:var(--g);color:#fff;border-radius:6px;font-weight:800;font-size:15px;padding:10px;margin-top:4px}
.ubdoc .d-foot{margin-top:28px;border-top:1px solid var(--line);padding-top:14px;color:var(--mut);font-size:12px;display:flex;flex-direction:column;gap:6px}
.ubdoc .d-stamp{display:inline-block;border:2px solid #2F7A55;color:#2F7A55;border-radius:6px;padding:2px 10px;font-weight:800;letter-spacing:2px;transform:rotate(-6deg);font-size:14px;margin-left:10px;vertical-align:middle}
@media (max-width:640px){.ubdoc{padding:24px 18px}.ubdoc .d-top,.ubdoc .d-bill{display:block}.ubdoc .d-meta{text-align:left;margin-top:12px}.ubdoc .d-tot{width:100%}.ubdoc th:nth-child(3),.ubdoc td:nth-child(3){display:none}}
@media print{.ubdoc{border:0;box-shadow:none;max-width:none;padding:0}}
`;

function renderDoc({ type, business: b, doc: d, items, customer: c, origin = '' }) {
  const isQ = type === 'quote';
  const cur = b.currency || 'USD';
  const logo = b.logo_mime ? `<img src="${origin}/logo/${b.id}?v=${Date.parse(b.created_at) || 1}" alt="${esc(b.name)} logo">` : LOGO;
  const paid = !isQ && d.status === 'paid';
  const rows = items.map((i) => `<tr><td>${nl(i.description)}</td><td class="d-r">${Number(i.qty)}</td><td>${esc(i.unit)}</td><td class="d-r">${money(i.unit_price, cur)}</td><td class="d-r">${money(Number(i.qty) * Number(i.unit_price), cur)}</td></tr>`).join('');
  const taxLine = Number(d.tax_rate) > 0 ? `<div><span>${esc(b.tax_label || 'Tax')} ${Number(d.tax_rate)}%</span><b>${money(d.tax, cur)}</b></div>` : '';
  return `<div class="ubdoc">
  <div class="d-top"><div class="d-co"><div class="d-brand">${logo}<b>${esc(b.name)}</b></div>
    ${b.address ? `<div>${nl(b.address)}</div>` : ''}<div>${[b.phone, b.email, b.website].filter(Boolean).map(esc).join(' · ')}</div>${b.tax_id ? `<div>Tax ID ${esc(b.tax_id)}</div>` : ''}</div>
    <div class="d-meta"><span>${isQ ? 'Quote' : 'Invoice'} no.</span><b>${esc(d.number)}</b>
      <span>Date</span><div>${day(isQ ? d.created_at : d.issue_date)}</div>
      ${isQ ? `<span>Valid until</span><div>${day(d.valid_until)}</div>` : `<span>Due date</span><div>${day(d.due_date)}</div>`}</div></div>
  <h1>${isQ ? 'Quote' : 'Invoice'}${paid ? '<span class="d-stamp">PAID</span>' : ''}</h1>${d.title ? `<div class="d-sub">${esc(d.title)}</div>` : ''}
  <div class="d-bill"><div><small class="d-lab">${isQ ? 'Prepared for' : 'Bill to'}</small><b>${esc(c ? c.name : 'Customer')}</b>${c && c.address ? `<div>${nl(c.address)}</div>` : ''}${c && (c.email || c.phone) ? `<div class="d-sub">${[c.email, c.phone].filter(Boolean).map(esc).join(' · ')}</div>` : ''}</div>
    <div>${!isQ && d.status !== 'paid' ? `<small class="d-lab">Amount due</small><b style="font-size:20px">${money(d.total, cur)}</b>` : ''}</div></div>
  <table><thead><tr><th>Description</th><th class="d-r">Qty</th><th>Unit</th><th class="d-r">Price</th><th class="d-r">Amount</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="d-sub">No items yet</td></tr>'}</tbody></table>
  <div class="d-tot"><div><span>Subtotal</span><b>${money(d.subtotal, cur)}</b></div>${taxLine}<div class="d-grand"><span>Total${isQ ? '' : paid ? ' paid' : ' due'}</span><span>${money(d.total, cur)}</span></div></div>
  <div class="d-foot">${d.notes ? `<div>${nl(d.notes)}</div>` : ''}
    ${isQ ? `<div>This quote is valid until ${day(d.valid_until)}. Prices may change if the scope changes on site.</div>`
      : `<div>${paid ? `Paid on ${day(d.paid_at)}. Thank you!` : `Please pay by ${day(d.due_date)}.`}</div>${b.payment_notes ? `<div>${nl(b.payment_notes)}</div>` : ''}`}
    <div>Thank you for your business.</div></div>
</div>`;
}

function publicPage({ title, body, business }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(business.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap">
<style>body{margin:0;background:#FBFAF7;color:#14201E;font-family:'Plus Jakarta Sans',system-ui,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:24px 16px 60px}.bar{display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin-bottom:16px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border-radius:14px;font:inherit;font-weight:700;font-size:15px;border:0;cursor:pointer;text-decoration:none}
.primary{background:#1F4D45;color:#FBFAF7}.line{background:#fff;border:1px solid #E7E3DA;color:#14201E}
.note{background:#E4F1E8;color:#1f4a35;border-radius:14px;padding:14px 16px;margin-bottom:16px;font-weight:600}.warn{background:#FBE8DC;color:#5A3A26}
.pw{font-size:12px;color:#56615F;text-align:center;margin-top:20px}
${DOC_CSS}
@media print{.bar,.note,.pw{display:none}.wrap{padding:0}body{background:#fff}}</style></head>
<body><div class="wrap">${body}<div class="pw">Sent with Unbusyness</div></div></body></html>`;
}

module.exports = { renderDoc, publicPage, DOC_CSS, esc, money, day };
