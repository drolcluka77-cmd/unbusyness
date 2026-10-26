/* Unbusyness app — single-page app, no build step. */
'use strict';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const attr = (t) => esc(t).replace(/\n/g, '&#10;');
const S = { me: null, counts: { calls: 0, quotes: 0 }, week: 0, customers: null, doc: null };
const cur = () => (S.me && S.me.business && S.me.business.currency) || 'USD';
const moneyFmt = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur() }).format(Number(n) || 0);
const money0 = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur(), maximumFractionDigits: 0 }).format(Number(n) || 0);
// All dates and times are shown in the BUSINESS time zone (Settings › Business), not the browser's.
const TZ = () => (S.me && S.me.business && S.me.business.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone;
function partsIn(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
function zoned(y, m, d, h = 0, mi = 0) { const g = Date.UTC(y, m - 1, d, h, mi); const p = partsIn(new Date(g)); return new Date(g - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - g)); }
const dateKey = (d) => { const p = partsIn(new Date(d)); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
const isDateOnly = (d) => String(d).length <= 10;
const dParse = (d) => (d ? new Date(isDateOnly(d) ? d + 'T12:00:00Z' : d) : null);
const fmt = (d, o) => dParse(d).toLocaleString('en-US', { ...o, timeZone: isDateOnly(d) ? 'UTC' : TZ() });
const fDate = (d) => (d ? fmt(d, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const fDay = (d) => fmt(d, { weekday: 'short', month: 'short', day: 'numeric' });
const fTime = (d) => (d ? fmt(d, { hour: 'numeric', minute: '2-digit' }) : '');
const fWhen = (d) => (d ? `${fDay(d)} · ${fTime(d)}` : 'Not scheduled');
const ago = (d) => { const s = (Date.now() - new Date(d)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago'; if (s < 86400) return Math.round(s / 3600) + ' h ago'; if (s < 172800) return 'yesterday'; return fDate(d); };
const isToday = (d) => d && dateKey(d) === dateKey(new Date());
const dayStart = (offset = 0) => { const p = partsIn(new Date()); const t = new Date(Date.UTC(p.y, p.m - 1, p.d + offset)); return zoned(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
const toLocalInput = (d) => { if (!d) return ''; const p = partsIn(new Date(d)); const z = (n) => String(n).padStart(2, '0'); return `${p.y}-${z(p.m)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`; };
const fromLocalInput = (v) => { const m = String(v).match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/); return m ? zoned(+m[1], +m[2], +m[3], +m[4], +m[5]) : null; };
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const first = (n) => String(n || '').split(' ')[0];
const telHref = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
const mapHref = (a) => 'https://maps.google.com/?q=' + encodeURIComponent(a || '');
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

const I = {
  tree: '<path d="M12 3v5M6 13v-2h12v2M6 13v3M18 13v3"/><circle cx="12" cy="8" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h4"/>',
  euro: '<path d="M12 3v18M16.5 7.5c-.8-1.3-2.5-2-4.5-2-2.5 0-4.5 1.3-4.5 3.2 0 4.6 9.5 2.3 9.5 6.9 0 2-2 3.4-5 3.4-2.2 0-4-.8-5-2.3"/>',
  team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2A5 5 0 0 1 21 19"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
  check: '<path d="M5 12l4 4 10-10"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/>', dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  nav: '<path d="M3 11l18-8-8 18-2-8z"/>', truck: '<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
  play: '<path d="M7 4l13 8-13 8z"/>', cam: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>', clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/>', search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>', out: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>', back: '<path d="M15 5l-7 7 7 7"/>', eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};
const svg = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n] || ''}</svg>`;
const LOGO = '<svg width="32" height="32" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="24" fill="#1F4D45"/><path d="M14.5 19 V25.5 a9.5 9.5 0 0 0 19 0 V19" fill="none" stroke="#FBFAF7" stroke-width="4" stroke-linecap="round"/><circle cx="24" cy="15.5" r="3.4" fill="#F2A57A"/></svg>';
const can = (p) => !!(S.me && S.me.perms && (S.me.perms.includes('*') || S.me.perms.includes(p)));
const manages = () => can('jobs.manage');
const explain = (t) => `<div class="explain"><span class="ei">i</span><div>${t}</div></div>`;
const pill = (txt, tone) => `<span class="pill ${tone}">${esc(txt)}</span>`;

function toast(m, err) {
  const h = $('#toastHost');
  h.innerHTML = `<div class="toast ${err ? 'err' : ''}" role="status">${svg(err ? 'alert' : 'check', 16)}<span>${esc(m)}</span></div>`;
  clearTimeout(window._tt); window._tt = setTimeout(() => (h.innerHTML = ''), err ? 5000 : 2800);
}
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  if (r.status === 401) { S.me = null; location.hash = '#/login'; throw new Error('Please log in'); }
  if (!r.ok) throw new Error((j && j.error) || 'Something went wrong');
  return j;
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r; } catch (e) { toast(e.message, true); return null; }
}
function layer(h) { $('#layer').innerHTML = h; }
function closeLayer() { $('#layer').innerHTML = ''; if (/^#\/jobs\/\d+/.test(location.hash)) history.replaceState(null, '', '#/jobs'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#layer').innerHTML) closeLayer(); });
const modal = (title, body, wide) => layer(`<div class="scrim center" onclick="if(event.target===this)closeLayer()"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-label="${attr(title)}"><div class="mh"><h2>${esc(title)}</h2><button class="x" onclick="closeLayer()" aria-label="Close">${svg('x')}</button></div>${body}</div></div>`);
const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
const statusPill = {
  quote: (q) => ({ draft: pill(q.ai_drafted ? 'Draft by AI' : 'Draft', 'apricot'), sent: pill(q.viewed_at ? 'Viewed' : 'Sent', 'slate'), accepted: pill('Accepted', 'ok'), declined: pill('Declined', 'gray') }[q.status] || pill(q.status, 'gray')),
  invoice: (i) => (i.status === 'paid' ? pill('Paid', 'ok') : i.status === 'draft' ? pill('Draft', 'apricot') : i.status === 'void' ? pill('Void', 'gray') : i.overdue || (i.due_date && dParse(i.due_date) < dayStart()) ? pill('Overdue', 'red') : pill(i.viewed_at ? 'Viewed' : 'Sent', 'slate')),
  job: (s) => ({ scheduled: pill('Scheduled', 'slate'), on_the_way: pill('On the way', 'green'), in_progress: pill('Working', 'green'), done: pill('Done', 'ok') }[s] || pill(s, 'gray')),
};
const KIND = { job: 'Job', appointment: 'Appointment', inspection: 'Inspection', meeting: 'Meeting' };
const STEPS = ['scheduled', 'on_the_way', 'in_progress', 'done'];
const NEXT = { scheduled: ['on_the_way', "I'm on my way", 'truck'], on_the_way: ['in_progress', 'Start job', 'play'], in_progress: ['done', 'Finish job', 'check'] };

/* ---------- routing ---------- */
window.addEventListener('hashchange', route);
async function boot() {
  try { S.me = await api('GET', '/api/me'); } catch { S.me = { user: null }; }
  route();
}
function route() {
  const h = location.hash || '#/';
  $('#layer').innerHTML = ''; S.nav = (S.nav || 0) + 1;
  const parts = h.replace(/^#\/?/, '').split('?')[0].split('/');
  const qs = new URLSearchParams(h.split('?')[1] || '');
  if (parts[0] === 'reset') return pLogin(qs, 'reset');
  if (!S.me || !S.me.user) return pLogin(qs);
  if (parts[0] === 'account') return pAccount(qs);
  if (!S.me.business) return pSetup();
  if (!manages()) {
    if (parts[0] === 'job' && parts[1]) return pWorkerJob(parts[1]);
    return pMy();
  }
  const [p, id] = parts;
  const pages = { '': pToday, today: pToday, calls: pCalls, customers: pCustomers, tasks: pTasks, quotes: pQuotes, jobs: pJobs, invoices: pInvoices, settings: pSettings, more: pMore, job: (x) => { location.hash = '#/jobs/' + x; } };
  const need = { today: 'calls.manage', calls: 'calls.manage', customers: 'customers.manage', tasks: 'tasks.manage', quotes: 'money.manage', invoices: 'money.manage', jobs: 'jobs.manage' };
  const page = pages[p] ? p : 'today';
  if (need[page] && !can(need[page])) return (can('calls.manage') ? pToday : pJobs)(); // not allowed → home
  pages[page](id, qs);
}
const curPage = () => (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]) || 'today';
const gone = (p) => curPage() !== p; // user navigated away while we were loading
function go(h) { if (location.hash === h) route(); else location.hash = h; }

/* ---------- owner shell ---------- */
const NAV = [['today', 'Today', 'tree', 1, 'calls.manage'], ['calls', 'Calls', 'phone', 1, 'calls.manage'], ['jobs', 'Jobs', 'cal', 1, 'jobs.manage'], ['tasks', 'Tasks', 'check', 1, 'tasks.manage'], ['customers', 'Customers', 'user', 1, 'customers.manage'], ['quotes', 'Quotes', 'doc', 2, 'money.manage'], ['invoices', 'Invoices', 'euro', 2, 'money.manage'], ['settings', 'Settings', 'gear', 2, 'settings']];
const navOk = (n) => (n[4] === 'settings' ? can('company.settings') || can('team.manage') || can('integrations.manage') : can(n[4]));
const roleLabel = (r) => ((S.me.roles || []).find((x) => x.key === r) || { label: r }).label;
function shell(page, crumb, content) {
  const b = S.me.business; const u = S.me.user;
  const cnt = { calls: S.counts.calls, quotes: S.counts.quotes };
  const link = (n) => `<a href="#/${n[0]}" class="${page === n[0] ? 'on' : ''}" aria-current="${page === n[0] ? 'page' : 'false'}">${svg(n[2])}${n[1]}${cnt[n[0]] ? `<span class="cnt ${n[0] === 'calls' ? 'hot' : ''}">${cnt[n[0]]}</span>` : ''}</a>`;
  const tab = (k, label, ic, c) => `<a href="#/${k}" class="${page === k || (k === 'more' && ['customers', 'quotes', 'settings', 'more'].includes(page)) ? 'on' : ''}">${svg(ic, 20)}${label}${c ? `<span class="cnt">${c}</span>` : ''}</a>`;
  $('#root').innerHTML = `<div class="app">
  <aside class="side"><div class="brand">${LOGO}unbusyness</div>
    <div class="ws"><span class="av">${b.logo_mime ? `<img src="/logo/${b.id}" alt="">` : esc(initials(b.name))}</span><div style="min-width:0;flex:1"><b>${esc(b.name)}</b><small>${esc(b.trade || 'Business')}</small></div></div>
    ${(S.me.memberships || []).length > 1 ? `<select class="input" style="min-height:34px;font-size:12px" aria-label="Switch company" onchange="switchCompany(this.value)">${S.me.memberships.map((m) => `<option value="${m.business_id}" ${m.business_id === b.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : ''}
    <div><div class="navlabel">WORKSPACE</div><nav class="nav">${NAV.filter((n) => n[3] === 1 && navOk(n)).map(link).join('')}</nav></div>
    ${NAV.some((n) => n[3] === 2 && navOk(n)) ? `<div><div class="navlabel">${can('money.manage') ? 'MONEY' : 'COMPANY'}</div><nav class="nav">${NAV.filter((n) => n[3] === 2 && navOk(n)).map(link).join('')}</nav></div>` : ''}
    <div class="sidefoot"><a class="ws" href="#/account" style="text-decoration:none;color:inherit" title="Your account"><span class="av" style="background:var(--apricot-soft);color:var(--apricot-ink)">${esc(initials(u.name))}</span><div style="min-width:0"><b>${esc(u.name || u.email)}</b><small>${esc(roleLabel(u.role))} · Account</small></div></a><a class="btn line sm" href="/api/logout">${svg('out', 14)}Log out</a></div>
  </aside>
  <div class="main"><header class="top"><div class="crumb">${crumb}</div><div class="topr"><button class="btn primary sm" onclick="openJobForm({})">${svg('plus', 14)}<span class="hide-m">New job</span></button></div></header>
    <main class="content" id="content">${verifyBanner()}${content || '<div class="empty">Loading…</div>'}</main></div></div>
  <nav class="tabbar" aria-label="Main">${tab('today', 'Today', 'tree')}${tab('calls', 'Calls', 'phone', cnt.calls)}${tab('jobs', 'Jobs', 'cal')}${can('money.manage') ? tab('invoices', 'Money', 'euro') : tab('tasks', 'Tasks', 'check')}${tab('more', 'More', 'more', can('money.manage') ? cnt.quotes : 0)}</nav>`;
}
const setContent = (h) => { const c = $('#content'); if (c) c.innerHTML = verifyBanner() + h; };
const head = (eb, title, sub, right = '') => `<div class="head"><div><div class="eyebrow">${eb}</div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${right}</div>`;
const stat = (l, n, s, ic, tone = 'green', href) => `<${href ? `a href="${href}"` : 'div'} class="card stat"><div class="lbl">${l}<span class="ic ${tone}">${svg(ic)}</span></div><b>${n}</b><small>${s}</small></${href ? 'a' : 'div'}>`;

/* ---------- login + setup ---------- */
/* ---------- Unbusyness accounts: log in, sign up, forgot / reset password ---------- */
const NOTICES = { verified: 'Your email is confirmed. Thank you!', 'verify-expired': 'That confirmation link has expired. Log in and ask for a new one.', linked: 'Login method connected.' };
async function pLogin(qs, mode) {
  const m = S.me || {}; mode = mode || qs.get('mode') || 'login';
  if (!S.authCfg) { try { S.authCfg = await api('GET', '/api/auth/config'); } catch { S.authCfg = {}; } }
  const cfg = S.authCfg; const invite = m.invite || qs.get('invite');
  const err = qs.get('error'); const notice = NOTICES[qs.get('notice')];
  const social = (cfg.google || cfg.microsoft) ? `<div class="or">or</div><div class="stack">
      ${cfg.google ? `<a class="btn line lg" href="/api/auth/oauth/google/start"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Continue with Google</a>` : ''}
      ${cfg.microsoft ? `<a class="btn line lg" href="/api/auth/oauth/microsoft/start"><svg width="16" height="16" viewBox="0 0 23 23" aria-hidden="true"><path fill="#f35325" d="M1 1h10v10H1z"/><path fill="#81bc06" d="M12 1h10v10H12z"/><path fill="#05a6f0" d="M1 12h10v10H1z"/><path fill="#ffba08" d="M12 12h10v10H12z"/></svg>Continue with Microsoft</a>` : ''}</div>` : '';
  const forms = {
    login: `<form class="form" onsubmit="doLogin(event)"><div class="field"><label for="le">Email</label><input class="input" id="le" type="email" required autocomplete="email" placeholder="you@company.com"></div>
      <div class="field"><div class="row between"><label for="lp">Password</label><a href="#/login?mode=forgot" class="small">Forgot password?</a></div><input class="input" id="lp" type="password" required autocomplete="current-password"></div>
      <button class="btn primary lg">Log in</button></form>${social}<p class="muted small" style="margin:0;text-align:center">New to Unbusyness? <a href="#/login?mode=signup${invite ? '&invite=1' : ''}">Create an account</a></p>`,
    signup: `<form class="form" onsubmit="doSignup(event)"><div class="field"><label for="sn2">Your name</label><input class="input" id="sn2" required autocomplete="name" placeholder="Janez Novak"></div>
      <div class="field"><label for="se">Email</label><input class="input" id="se" type="email" required autocomplete="email"></div>
      <div class="field"><label for="sp">Password</label><input class="input" id="sp" type="password" required minlength="10" autocomplete="new-password"><span class="hint">At least 10 characters.</span></div>
      <button class="btn primary lg">Create account</button></form>${social}<p class="muted small" style="margin:0;text-align:center">Already have an account? <a href="#/login${invite ? '?invite=1' : ''}">Log in</a></p>`,
    forgot: `<form class="form" onsubmit="doForgot(event)"><div class="field"><label for="fe">Email</label><input class="input" id="fe" type="email" required autocomplete="email"></div><button class="btn primary lg">Send reset link</button></form>
      <div id="forgotOut"></div><p class="muted small" style="margin:0;text-align:center"><a href="#/login">Back to log in</a></p>`,
    reset: `<form class="form" onsubmit="doReset(event)"><div class="field"><label for="rp">New password</label><input class="input" id="rp" type="password" required minlength="10" autocomplete="new-password"><span class="hint">At least 10 characters.</span></div><button class="btn primary lg">Save new password</button></form>`,
  };
  const titles = { login: invite ? 'Join your team' : 'Log in', signup: invite ? 'Join your team' : 'Create your account', forgot: 'Forgot your password?', reset: 'Choose a new password' };
  const subs = { login: invite ? 'Log in or create an account to see your jobs.' : 'The AI office manager for trade businesses.', signup: invite ? 'Create your Unbusyness account to join.' : 'Free to start. No credit card needed.', forgot: 'We will email you a link to choose a new password.', reset: 'You will be logged in right after.' };
  $('#root').innerHTML = `<div class="auth"><div class="authcard">
    <div class="row">${LOGO}<b style="font-size:20px;letter-spacing:-.6px">unbusyness</b></div>
    <div><h1>${titles[mode]}</h1><p class="muted" style="margin:6px 0 0">${subs[mode]}</p></div>
    ${err ? `<div class="explain"><span class="ei">!</span><div>${err === 'invite' ? 'This invite link is no longer valid. Ask for a new one.' : esc(err.length > 12 ? err : 'Login did not finish. Please try again.')}</div></div>` : ''}
    ${notice ? `<div class="explain" style="background:var(--ok-soft);color:#1f4a35"><span class="ei">✓</span><div>${esc(notice)}</div></div>` : ''}
    ${forms[mode]}
    ${cfg.replit && mode === 'login' ? '<a class="btn line sm" href="/api/login" style="align-self:center">Developer: log in with Replit</a>' : ''}
    ${m.devLogin && mode === 'login' ? `<details><summary class="small">Demo login (development only)</summary><form class="form" style="margin-top:10px" onsubmit="devLogin(event)"><div class="field"><label for="dn">Your name</label><input class="input" id="dn" autocomplete="name"></div>
      <div class="field"><label for="de">Email</label><input class="input" id="de" type="email" required></div><button class="btn line">Continue</button></form></details>` : ''}
  </div></div>`;
  window._resetToken = qs.get('token');
}
async function afterLogin() { S.me = await api('GET', '/api/me'); location.hash = '#/'; route(); }
async function doLogin(e) { e.preventDefault(); if (await act(() => api('POST', '/api/auth/login', { email: val('le'), password: val('lp') }))) afterLogin(); }
async function doSignup(e) {
  e.preventDefault();
  const r = await act(() => api('POST', '/api/auth/signup', { name: val('sn2'), email: val('se'), password: val('sp') }));
  if (r) { toast('Account created. Check your email to confirm your address.'); afterLogin(); }
}
async function doForgot(e) {
  e.preventDefault();
  if (await act(() => api('POST', '/api/auth/forgot', { email: val('fe') }))) $('#forgotOut').innerHTML = explain('If an account exists for this email, a reset link is on its way. Check your inbox and spam folder.');
}
async function doReset(e) { e.preventDefault(); if (await act(() => api('POST', '/api/auth/reset', { token: window._resetToken, password: val('rp') }), 'Password saved')) afterLogin(); }
function verifyBanner() {
  if (!S.me || !S.me.user || S.me.user.verified) return '';
  return `<div class="explain" style="margin-bottom:14px"><span class="ei">!</span><div><b>Please confirm your email.</b> We sent a link to ${esc(S.me.user.email)}. <button class="btn line sm" style="margin-left:6px" onclick="resendVerify()">Send again</button></div></div>`;
}
async function resendVerify() { await act(() => api('POST', '/api/auth/verify/resend'), 'Confirmation email sent'); }

/* ---------- Account ---------- */
async function pAccount(qs) {
  const a = await act(() => api('GET', '/api/auth/account')); if (!a) return;
  if (qs.get('notice')) toast(NOTICES[qs.get('notice')] || 'Done');
  if (qs.get('error')) toast(qs.get('error'), true);
  const has = (p) => a.identities.some((i) => i.provider === p) || a.legacy === p;
  const body = `${head('Account', 'Your account', esc(a.email))}
    <div class="grid g2"><div class="stack"><div class="card cb stack"><b>Profile</b><form class="form" onsubmit="saveAccount(event)"><div class="field"><label for="an">Name</label><input class="input" id="an" value="${attr(a.name || '')}" required></div>
      <div class="field"><span class="lab">EMAIL</span><div>${esc(a.email)} ${a.verified ? pill('Confirmed', 'ok') : pill('Not confirmed', 'apricot')}</div></div><button class="btn primary" style="justify-self:start">Save</button></form></div>
      <div class="card cb stack"><b>${a.password ? 'Change password' : 'Set a password'}</b><form class="form" onsubmit="savePassword(event)">${a.password ? '<div class="field"><label for="apc">Current password</label><input class="input" id="apc" type="password" required autocomplete="current-password"></div>' : ''}
        <div class="field"><label for="apn">New password</label><input class="input" id="apn" type="password" required minlength="10" autocomplete="new-password"><span class="hint">At least 10 characters. Other devices are logged out.</span></div><button class="btn primary" style="justify-self:start">Save password</button></form></div></div>
      <div class="card cb stack"><b>Ways to log in</b>
        <div class="li" style="padding:10px 0"><span class="ic sand">${svg('user')}</span><div class="grow"><b>Email and password</b><span class="s">${a.password ? 'Set' : 'Not set'}</span></div></div>
        ${['google', 'microsoft'].filter((p) => a[p] || has(p)).map((p) => `<div class="li" style="padding:10px 0"><span class="ic sand">${svg('link')}</span><div class="grow"><b>${p === 'google' ? 'Google' : 'Microsoft'}</b><span class="s">${has(p) ? 'Connected' : 'Not connected'}</span></div>${has(p) ? (a.identities.some((i) => i.provider === p) ? `<button class="btn line sm" onclick="removeIdentity('${p}')">Remove</button>` : '') : `<a class="btn line sm" href="/api/auth/oauth/${p}/start?link=1">Connect</a>`}</div>`).join('')}
        <a class="btn line" href="/api/logout">${svg('out', 16)}Log out</a></div></div>`;
  if (manages()) shell('account', 'Your <b>account</b>', body); else phoneShell('Account', body, '#/my');
}
async function saveAccount(e) { e.preventDefault(); if (await act(() => api('PUT', '/api/auth/account', { name: val('an') }), 'Saved')) { await refreshMe(); route(); } }
async function savePassword(e) { e.preventDefault(); if (await act(() => api('POST', '/api/auth/password', { current: val('apc'), password: val('apn') }), 'Password saved')) route(); }
async function removeIdentity(p) { if (confirm('Remove this login method?') && await act(() => api('POST', `/api/auth/identities/${p}/remove`), 'Removed')) route(); }
async function devLogin(e) {
  e.preventDefault();
  if (await act(() => api('POST', '/api/dev-login', { name: val('dn'), email: val('de') }))) { location.hash = '#/'; boot(); }
}
function pSetup() {
  $('#root').innerHTML = `<div class="auth"><div class="authcard" style="width:min(560px,100%)">
    <div class="row">${LOGO}<b style="font-size:20px">unbusyness</b></div>
    ${verifyBanner()}
    <div><h1>Set up your business</h1><p class="muted" style="margin:6px 0 0">Two minutes. You can change everything later in Settings.</p></div>
    <form class="form two" onsubmit="createBusiness(event)">
      <div class="field full"><label for="bn">Business name</label><input class="input" id="bn" required placeholder="Demo Plumbing Co."></div>
      <div class="field"><label for="bt">Trade</label><select class="input" id="bt"><option>Plumbing</option><option>HVAC</option><option>Electrical</option><option>Other</option></select></div>
      <div class="field"><label for="bx">Sales tax %</label><input class="input" id="bx" type="number" step="0.01" min="0" value="0"></div>
      <div class="field full"><label for="ba">Business address</label><input class="input" id="ba" placeholder="100 Main St, Austin, TX 78701"></div>
      <div class="field"><label for="bp">Business phone</label><input class="input" id="bp" type="tel" placeholder="+1 512 555 0100"></div>
      <div class="field"><label for="bm">Your mobile (urgent alerts)</label><input class="input" id="bm" type="tel" placeholder="+1 512 555 0101"></div>
      <div class="full">${explain('We add a starter <b>price list</b> for your trade. The AI uses it to draft quotes, so check the prices in Settings first.')}</div>
      <button class="btn primary lg full">Create my business</button></form>
    <a class="btn line sm" href="/api/logout" style="align-self:flex-start">Log out</a></div></div>`;
}
async function createBusiness(e) {
  e.preventDefault();
  const ok = await act(() => api('POST', '/api/business', { name: val('bn'), trade: val('bt'), tax_rate: val('bx'), address: val('ba'), phone: val('bp'), owner_phone: val('bm') }));
  if (ok) { S.me = await api('GET', '/api/me'); location.hash = '#/today'; route(); }
}
async function switchCompany(id) { if (await act(() => api('POST', '/api/companies/switch', { business_id: Number(id) }))) { await refreshMe(); location.hash = '#/'; route(); } }
async function refreshMe() { S.me = await api('GET', '/api/me'); }

/* ---------- Today ---------- */
async function pToday() {
  shell('today', 'Workspace / <b>Today</b>');
  const d = await act(() => api('GET', `/api/today?from=${dayStart().toISOString()}&to=${dayStart(1).toISOString()}`));
  if (!d || gone('today')) return;
  S.counts = { calls: d.calls.length, quotes: d.draftQuotes.length };
  shell('today', 'Workspace / <b>Today</b>');
  const u = S.me.user; const hr = partsIn(new Date()).h;
  const T = (dot, b, s, href) => `<a class="task" href="${href}"><span class="dot ${dot}"></span><div><b>${esc(b)}</b><span>${esc(s)}</span></div></a>`;
  const urgent = d.calls.filter((c) => ['emergency', 'high'].includes(c.urgency) || c.intent === 'emergency').length;
  const left = d.jobsToday.filter((j) => j.status !== 'done');
  const toApprove = d.draftQuotes.length + d.draftInvoices.length + d.requested.length;
  let h = head(fmt(new Date(), { weekday: 'long', month: 'long', day: 'numeric' }), `Good ${hr < 12 ? 'morning' : hr < 18 ? 'afternoon' : 'evening'}, ${esc(first(u.name) || 'there')}.`, 'Here is what needs you today.',
    `<div class="btns"><button class="btn line" onclick="simulateCall()">${svg('phone', 16)}Test call</button><button class="btn primary" onclick="openJobForm({})">${svg('plus', 16)}New job</button></div>`);
  h += `<div class="grid g4" style="margin-bottom:16px">${stat('Jobs today', d.jobsToday.length, `${d.jobsToday.length - left.length} done · ${left.length} to go`, 'cal', 'green', '#/jobs')}${stat('New calls', d.calls.length, urgent ? `${urgent} urgent` : 'answered by AI', 'phone', urgent ? 'red' : 'green', '#/calls')}${d.money ? stat('Waiting to be paid', money0(d.money.unpaid), d.money.overdue_n ? `${d.money.overdue_n} overdue · ${money0(d.money.overdue)}` : `${d.money.unpaid_n} invoices`, 'clock', 'apricot', '#/invoices') + stat('To check and send', toApprove, toApprove ? 'quotes and invoices' : 'all clear', 'doc', 'slate', '#/quotes') : stat('Open tasks', d.tasks.length, 'for the team', 'check', 'slate', '#/tasks') + stat('To confirm', d.requested.length, 'bookings from the AI', 'cal', 'apricot', '#/jobs')}</div>`;
  const followups = [...d.acceptedQuotes.map((q) => T('', `Schedule ${q.customer_name || 'customer'}`, `Accepted quote ${q.number} · ${money0(q.total)}`, `#/quotes/${q.id}`)),
    ...(d.money && d.money.overdue_n ? [T('apricot', `${d.money.overdue_n} overdue invoice${d.money.overdue_n === 1 ? '' : 's'}`, `${money0(d.money.overdue)} · reminders go out automatically`, '#/invoices?f=overdue')] : []),
    ...d.tasks.filter((t) => !t.call_id).map((t) => `<div class="task"><span class="dot slate"></span><div class="grow"><b>${esc(t.title)}</b><span>${esc([t.assignee, t.customer_name, t.due_at && fWhen(t.due_at)].filter(Boolean).join(' · '))}</span></div><button class="btn line sm" onclick="taskDone(${t.id})">Done</button></div>`)];
  h += `<div class="grid gmain"><section class="card"><div class="ch"><div><h2>Task Node Tree</h2><p>Every call, job, quote and payment becomes a next step</p></div><span class="pill green">Live</span></div><div class="cb">
    <div class="root"><span class="ic" style="background:rgba(255,255,255,.14);color:var(--apricot-light)">${svg('spark')}</span><div class="grow"><small>MAIN GOAL</small><b>Close more jobs with less admin</b></div><div style="text-align:right"><b style="font-size:18px">${d.week.done}/${d.week.total}</b><small>jobs done, this fortnight</small></div></div><div class="stem"></div>
    <div class="branches">
      <div class="branch"><div class="bh"><span class="ic red" style="width:30px;height:30px">${svg('phone', 15)}</span><div><strong>New calls</strong><small>From the AI receptionist</small></div><span class="pill red" style="margin-left:auto">${d.calls.length}</span></div>
        ${d.calls.slice(0, 5).map((c) => T(['emergency', 'high'].includes(c.urgency) ? 'red' : '', `${c.intent === 'question' ? 'Call back' : ['emergency', 'high'].includes(c.urgency) ? 'Urgent: call back' : 'Book'} ${c.customer_name || c.from_phone}`, c.service || c.summary, `#/calls/${c.id}`)).join('') || `<div class="task"><div><b>No new calls</b><span>Send a test call to see how it works.</span></div></div>`}</div>
      <div class="branch"><div class="bh"><span class="ic green" style="width:30px;height:30px">${svg('cal', 15)}</span><div><strong>Jobs today</strong><small>Crew and status</small></div><span class="pill green" style="margin-left:auto">${left.length}</span></div>
        ${left.slice(0, 5).map((j) => T('', `${fTime(j.scheduled_at)} ${j.title}`, `${j.customer_name || ''}${j.assignee ? ' · ' + j.assignee : ''}`, `#/jobs/${j.id}`)).join('') || '<div class="task"><div><b>Nothing left today</b><span>Enjoy the quiet.</span></div></div>'}</div>
      <div class="branch"><div class="bh"><span class="ic apricot" style="width:30px;height:30px">${svg('doc', 15)}</span><div><strong>${d.money ? 'Check and send' : 'To confirm'}</strong><small>${d.money ? 'Drafts waiting for you' : 'Bookings from the AI'}</small></div><span class="pill apricot" style="margin-left:auto">${toApprove}</span></div>
        ${[...d.requested.map((j) => T('red', `Confirm AI booking · ${j.customer_name || 'caller'}`, `${j.title} · ${fWhen(j.scheduled_at)}`, `#/jobs/${j.id}`)), ...d.draftQuotes.map((q) => T('apricot', `Quote ${money0(q.total)} · ${q.customer_name || 'customer'}`, q.title || q.number, `#/quotes/${q.id}`)), ...d.draftInvoices.map((i) => T('apricot', `Invoice ${money0(i.total)} · ${i.customer_name || 'customer'}`, i.number, `#/invoices/${i.id}`))].slice(0, 6).join('') || '<div class="task"><div><b>Nothing to approve</b><span>All quotes and invoices are sent.</span></div></div>'}</div>
      <div class="branch"><div class="bh"><span class="ic slate" style="width:30px;height:30px">${svg('clock', 15)}</span><div><strong>Follow-ups</strong><small>Money and open tasks</small></div><span class="pill slate" style="margin-left:auto">${followups.length}</span></div>
        ${followups.slice(0, 6).join('') || '<div class="task"><div><b>No follow-ups</b><span>Nothing waiting.</span></div></div>'}</div>
    </div></div></section>
    <aside class="stack">${gettingStarted(d)}<div class="card"><div class="ch"><div><h2>Recent activity</h2><p>What happened, including what the AI did</p></div></div><div class="cb" style="padding-top:2px">
      ${d.recent.map((a) => `<div class="act"><span class="ic ${{ call: 'red', quote: 'apricot', paid: 'green', invoice: 'slate', job: 'green' }[a.kind] || 'sand'}" style="width:30px;height:30px">${svg({ call: 'phone', quote: 'doc', paid: 'check', invoice: 'euro', job: 'cal' }[a.kind] || 'spark', 15)}</span><div><b>${esc(a.text)}</b><time>${ago(a.created_at)}</time></div></div>`).join('') || '<div class="empty">No activity yet.</div>'}</div></div></aside></div>`;
  setContent(h);
}
function gettingStarted(d) {
  if (store.get('ub_gs_hide') === '1' || !can('company.settings')) return '';
  const b = S.me.business;
  const steps = [
    ['Check your price list', 'The AI drafts quotes from it.', S.me.services.length > 0 && store.get('ub_prices_seen') === '1', '#/settings/prices'],
    ['Connect your voice agent', 'Give the agency your webhook link.', d.recent.some((a) => a.kind === 'call'), '#/settings/voice'],
    ['Invite your crew', 'They see their jobs on their phone.', S.me.team.length > 1, '#/settings/team'],
    ['Get paid online', 'Connect Stripe for the Pay button.', b.stripe_ready, '#/settings/payments'],
  ];
  if (steps.every((s) => s[2])) return '';
  return `<div class="card"><div class="ch"><div><h2>Getting started</h2><p>${steps.filter((s) => s[2]).length} of ${steps.length} done</p></div><button class="btn line sm" onclick="store.set('ub_gs_hide','1');route()">Hide</button></div>
    ${steps.map((s) => `<a class="li" href="${s[3]}"><span class="ic ${s[2] ? 'green' : 'sand'}" style="width:28px;height:28px">${svg(s[2] ? 'check' : 'plus', 14)}</span><div class="grow"><b>${s[0]}</b><span class="s">${s[1]}</span></div></a>`).join('')}</div>`;
}
async function taskDone(id) { if (await act(() => api('POST', `/api/tasks/${id}/done`), 'Task done')) route(); }
async function simulateCall(k) {
  const sample = k ?? (Number(store.get('ub_sim') || 0));
  store.set('ub_sim', String((sample + 1) % 3));
  const r = await act(() => api('POST', '/api/calls/simulate', { sample }), (x) => (x.next === 'quote' ? 'Test call received. The AI drafted a quote.' : 'Test call received.'));
  if (r) {
    if (location.hash.startsWith('#/settings/voice')) return pSettings('voice');
    go(`#/calls/${r.id}`);
  }
}

/* ---------- Calls ---------- */
async function pCalls(id) {
  shell('calls', 'Workspace / <b>Calls</b>');
  const list = await act(() => api('GET', '/api/calls'));
  if (!list || gone('calls')) return;
  S.counts.calls = list.filter((c) => c.status === 'new').length;
  shell('calls', 'Workspace / <b>Calls</b>');
  const selId = Number(id) || (window.innerWidth > 1100 && list[0] ? list[0].id : null);
  const tone = (c) => (c.status !== 'new' ? 'sand' : ['emergency', 'high'].includes(c.urgency) ? 'red' : 'green');
  const badge = (c) => (c.status === 'new' ? (['emergency', 'high'].includes(c.urgency) ? pill('Urgent', 'red') : pill('New', 'green')) : c.status === 'dismissed' ? pill('Dismissed', 'gray') : pill('Handled', 'ok'));
  let h = head('Voice agent', 'Calls', 'Every call is answered, summarised and turned into a next step.', `<div class="btns"><button class="btn line" onclick="simulateCall()">${svg('phone', 16)}Send a test call</button></div>`);
  h += `<div class="split"><div class="card ${selId && window.innerWidth <= 1100 ? 'hide-m' : ''}"><div class="ch"><div><h2>All calls</h2><p>${list.length} calls · ${S.counts.calls} new</p></div></div>
    ${list.map((c) => `<a class="li ${c.id === selId ? 'sel' : ''}" href="#/calls/${c.id}"><span class="ic ${tone(c)}">${svg('phone', 16)}</span><div class="grow"><b class="ellipsis">${esc(c.customer_name || c.from_phone || 'Unknown caller')}</b><span class="s ellipsis">${esc(c.service || c.summary || c.intent)}</span><span class="s">${ago(c.created_at)}</span></div>${badge(c)}</a>`).join('') || `<div class="empty">No calls yet.<br><br><button class="btn primary" onclick="simulateCall()">Send a test call</button></div>`}</div>
    <div id="callDetail">${selId ? '<div class="card empty">Loading…</div>' : `<div class="card cb">${explain('When your voice agent answers a call, it appears here with a summary. Quote requests get a draft quote, everything else becomes a task. Try <b>Send a test call</b>.')}</div>`}</div></div>`;
  setContent(h);
  if (selId) loadCall(selId);
}
async function loadCall(id) {
  const d = await act(() => api('GET', `/api/calls/${id}`)); if (!d) return;
  const c = d.call;
  const intent = { new_job: 'New job', quote_request: 'Quote request', question: 'Question', emergency: 'Emergency', other: 'Other' }[c.intent] || c.intent;
  $('#callDetail').innerHTML = `<div class="card"><div class="ch"><div><a href="#/calls" class="btn line sm" style="margin-bottom:8px;display:${window.innerWidth <= 1100 ? 'inline-flex' : 'none'}">${svg('back', 14)}All calls</a><h2>${esc(c.customer_name || c.from_phone || 'Unknown caller')}</h2><p>${fWhen(c.created_at)}${c.duration_sec ? ` · ${Math.floor(c.duration_sec / 60)} min ${c.duration_sec % 60} s` : ''}</p></div>${['emergency', 'high'].includes(c.urgency) ? pill('Urgent', 'red') : pill(intent, 'green')}</div>
  <div class="cb stack">
    <div class="summary"><b style="color:var(--green);display:flex;gap:6px;align-items:center">${svg('spark', 16)}AI summary</b>${esc(c.summary || 'No summary.')}</div>
    <div class="fields"><div class="fld"><small>Needs</small><b>${esc(c.service || '—')}</b></div><div class="fld"><small>Address</small><b>${esc(c.address || '—')}</b></div><div class="fld"><small>Phone</small><b>${esc(c.from_phone || '—')}</b></div><div class="fld"><small>Preferred time</small><b>${esc(c.preferred_time || '—')}</b></div><div class="fld"><small>Type</small><b>${esc(intent)}</b></div><div class="fld"><small>Customer</small><b>${c.customer_id ? `<a href="#/customers/${c.customer_id}">Open profile</a>` : '—'}</b></div></div>
    ${c.recording_url ? `<audio controls preload="none" src="${attr(c.recording_url)}" style="width:100%"></audio>` : ''}
    ${c.transcript ? `<details><summary>Transcript</summary><div class="transcript">${esc(c.transcript)}</div></details>` : ''}
    <div class="btns">${c.from_phone ? `<a class="btn primary" href="${telHref(c.from_phone)}">${svg('phone', 16)}Call back</a>` : ''}
      ${d.job ? `<a class="btn soft" href="#/jobs/${d.job.id}">${svg('cal', 16)}Open job · ${fWhen(d.job.scheduled_at)}</a>` : `<button class="btn soft" onclick='openJobForm(${JSON.stringify({ call_id: c.id, customer_id: c.customer_id, title: c.service, address: c.address })})'>${svg('cal', 16)}Book job</button>`}
      ${!can('money.manage') ? '' : d.quote ? `<a class="btn apricot" href="#/quotes/${d.quote.id}">${svg('doc', 16)}Quote ${esc(d.quote.number)} · ${money0(d.quote.total)}</a>` : `<button class="btn line" onclick="quoteFromCall(${c.id})">${svg('doc', 16)}Create quote</button>`}
      ${c.status === 'new' ? `<button class="btn line" onclick="callStatus(${c.id},'handled')">${svg('check', 16)}Mark handled</button><button class="btn line" onclick="callStatus(${c.id},'dismissed')">Dismiss</button>` : `<button class="btn line" onclick="callStatus(${c.id},'new')">Mark as new</button>`}</div>
    ${explain('<b>You stay in control.</b> The AI never commits to a price. Quotes and bookings it prepares wait for your approval.')}</div></div>`;
}
async function callStatus(id, status) { if (await act(() => api('POST', `/api/calls/${id}/status`, { status }), 'Updated')) pCalls(id); }
async function quoteFromCall(id) { const r = await act(() => api('POST', `/api/calls/${id}/quote`), 'Quote drafted from the call'); if (r) go(`#/quotes/${r.id}`); }

/* ---------- Customers ---------- */
async function loadCustomers(force) { if (!S.customers || force) S.customers = await api('GET', '/api/customers'); return S.customers; }
async function pCustomers(id) {
  shell('customers', 'Workspace / <b>Customers</b>');
  if (id) return customerDetail(id);
  const list = await act(() => loadCustomers(true)); if (!list || gone('customers')) return;
  setContent(head('Customers', `${list.length} customers`, 'Everyone who called or got a quote, job or invoice.', `<button class="btn primary" onclick="customerForm()">${svg('plus', 16)}New customer</button>`) +
    `<div class="card"><div class="cb" style="border-bottom:1px solid var(--line2)"><input class="input" id="cs" placeholder="Search name, phone, address…" oninput="filterCustomers()" aria-label="Search customers"></div><div class="tscroll" id="ctable"></div></div>`);
  filterCustomers();
}
function filterCustomers() {
  const q = val('cs').toLowerCase();
  const rows = S.customers.filter((c) => !q || [c.name, c.phone, c.address, c.email].join(' ').toLowerCase().includes(q));
  $('#ctable').innerHTML = rows.length ? `<table class="tbl"><thead><tr><th>Name</th><th class="hide-m">Phone</th><th class="hide-m">Address</th><th class="num">Jobs</th><th class="num">Balance</th></tr></thead><tbody>
    ${rows.map((c) => `<tr class="click" onclick="go('#/customers/${c.id}')"><td><b>${esc(c.name)}</b><div class="muted small">${esc(c.email || '')}</div></td><td class="hide-m">${esc(c.phone)}</td><td class="hide-m muted">${esc(c.address)}</td><td class="num">${c.jobs}</td><td class="num">${c.balance ? `<b style="color:var(--apricot-ink)">${money0(c.balance)}</b>` : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No customers found.</div>';
}
function customerForm(c = {}, after) {
  window._afterCustomer = after;
  modal(c.id ? 'Edit customer' : 'New customer', `<form class="form two" onsubmit="saveCustomer(event, ${c.id || 0})">
    <div class="field full"><label for="cn">Name</label><input class="input" id="cn" required value="${attr(c.name || '')}"></div>
    <div class="field"><label for="cp">Phone</label><input class="input" id="cp" type="tel" value="${attr(c.phone || '')}"></div>
    <div class="field"><label for="ce">Email</label><input class="input" id="ce" type="email" value="${attr(c.email || '')}"></div>
    <div class="field full"><label for="ca">Address</label><input class="input" id="ca" value="${attr(c.address || '')}"></div>
    <div class="field full"><label for="cno">Notes (gate code, pets, equipment…)</label><textarea class="input" id="cno">${esc(c.notes || '')}</textarea></div>
    <div class="btns full"><button class="btn primary">${svg('check', 16)}Save</button><button type="button" class="btn line" onclick="closeLayer()">Cancel</button></div></form>`);
}
async function saveCustomer(e, id) {
  e.preventDefault();
  const body = { name: val('cn'), phone: val('cp'), email: val('ce'), address: val('ca'), notes: val('cno') };
  const r = await act(() => (id ? api('PUT', `/api/customers/${id}`, body) : api('POST', '/api/customers', body)), 'Customer saved');
  if (!r) return;
  closeLayer(); S.customers = null;
  if (window._afterCustomer) { const f = window._afterCustomer; window._afterCustomer = null; return f(r.id ? r : { id, ...body }); }
  if (id) customerDetail(id); else go(`#/customers/${r.id}`);
}
async function customerDetail(id) {
  const d = await act(() => api('GET', `/api/customers/${id}`)); if (!d) return;
  const c = d.customer;
  const sec = (title, rows, emptyTxt) => `<div class="card"><div class="ch"><h2>${title}</h2></div>${rows.join('') || `<div class="empty">${emptyTxt}</div>`}</div>`;
  setContent(`<a href="#/customers" class="btn line sm" style="margin-bottom:14px">${svg('back', 14)}All customers</a>` +
    head('Customer', esc(c.name), esc([c.phone, c.email].filter(Boolean).join(' · ')), `<div class="btns">${c.phone ? `<a class="btn line" href="${telHref(c.phone)}">${svg('phone', 16)}Call</a>` : ''}<button class="btn line" onclick='customerForm(${JSON.stringify(c).replace(/'/g, '&#39;')})'>${svg('edit', 16)}Edit</button>${can('money.manage') ? `<button class="btn soft" onclick="newQuote(${c.id})">${svg('doc', 16)}New quote</button>` : ''}<button class="btn primary" onclick='openJobForm({customer_id:${c.id}})'>${svg('plus', 16)}New job</button></div>`) +
    `<div class="grid g2"><div class="stack"><div class="card cb stack"><div class="fld"><small>Address</small><b>${esc(c.address || '—')}</b>${c.address ? ` <a href="${mapHref(c.address)}" target="_blank" rel="noopener">Map</a>` : ''}</div><div class="fld"><small>Notes</small><b style="font-weight:500">${esc(c.notes || '—')}</b></div></div>
      ${sec('Jobs', d.jobs.map((j) => `<a class="li" href="#/jobs/${j.id}"><div class="grow"><b>${esc(j.title)}</b><span class="s">${fWhen(j.scheduled_at)}</span></div>${statusPill.job(j.status)}</a>`), 'No jobs yet.')}
      ${sec('Calls', d.calls.map((k) => `<a class="li" href="#/calls/${k.id}"><div class="grow"><b>${esc(k.service || 'Call')}</b><span class="s">${fWhen(k.created_at)}</span></div></a>`), 'No calls.')}</div>
      <div class="stack">${can('email.use') ? `<div class="card" id="custEmails"><div class="ch"><h2>Emails</h2></div><div class="empty">Loading…</div></div>` : ''}${!can('money.manage') ? '' : sec('Quotes', d.quotes.map((q) => `<a class="li" href="#/quotes/${q.id}"><div class="grow"><b>${esc(q.number)} · ${esc(q.title || '')}</b><span class="s">${fDate(q.created_at)}</span></div><b>${money0(q.total)}</b>${statusPill.quote(q)}</a>`), 'No quotes.')}
      ${!can('money.manage') ? '' : sec('Invoices', d.invoices.map((i) => `<a class="li" href="#/invoices/${i.id}"><div class="grow"><b>${esc(i.number)}</b><span class="s">Due ${fDate(i.due_date)}</span></div><b>${money0(i.total)}</b>${statusPill.invoice(i)}</a>`), 'No invoices.')}</div></div>`);
  if (can('email.use')) loadCustomerEmails(c);
}

async function loadCustomerEmails(c) {
  const box = $('#custEmails'); if (!box) return;
  let r; try { r = await api('GET', `/api/customers/${c.id}/emails`); } catch (e) { box.innerHTML = `<div class="ch"><h2>Emails</h2></div><div class="empty">${esc(e.message)}</div>`; return; }
  box.innerHTML = `<div class="ch"><div><h2>Emails</h2><p>${r.connected ? 'From your connected mailbox' : 'Connect a mailbox to see emails here'}</p></div>${r.connected && c.email ? `<button class="btn line sm" onclick='composeEmail(${JSON.stringify({ to: c.email }).replace(/'/g, '&#39;')})'>${svg('send', 14)}Write</button>` : ''}</div>
    ${!r.connected ? `<div class="cb">${can('integrations.manage') ? '<a href="#/settings/integrations" class="btn line sm">Connect email</a>' : '<span class="muted small">Ask the owner to connect the company mailbox.</span>'}</div>` : !c.email ? '<div class="empty">Add an email address to this customer.</div>'
      : r.threads.map((t) => `<button class="li" onclick="openThread('${attr(t.id)}')"><div class="grow"><b class="ellipsis">${esc(t.subject || '(no subject)')}</b><span class="s ellipsis">${esc(t.from)} · ${ago(t.date)}</span><span class="s ellipsis">${esc(t.snippet || '')}</span></div>${t.unread ? pill('New', 'green') : ''}</button>`).join('') || '<div class="empty">No emails with this customer yet.</div>'}`;
}
async function openThread(id) {
  modal('Email', '<div class="empty">Loading…</div>', true);
  const t = await act(() => api('GET', `/api/email/threads/${encodeURIComponent(id)}`)); if (!t) return closeLayer();
  const last = t.messages[t.messages.length - 1] || {};
  const replyTo = String(last.from || '').replace(/.*<|>.*/g, '');
  modal(t.subject || 'Email', `<div class="stack">${t.messages.map((m) => `<div class="card cb"><div class="row between wrap"><b>${esc(m.from)}</b><span class="muted small">${fWhen(m.date)}</span></div><div class="muted small">To: ${esc(m.to)}</div><div style="white-space:pre-wrap;margin-top:8px;max-height:320px;overflow:auto">${esc(m.text || '')}</div></div>`).join('')}
    <div class="card cb stack"><b>Reply</b><textarea class="input" id="rpText" placeholder="Write a reply…"></textarea><div class="btns"><button class="btn primary" onclick='sendReply(${JSON.stringify({ to: replyTo, subject: /^re:/i.test(t.subject) ? t.subject : 'Re: ' + t.subject, thread_id: t.id, in_reply_to: last.messageId, reply_to_id: last.id }).replace(/'/g, '&#39;')})'>${svg('send', 16)}Send</button><button class="btn line" onclick='sendReply(${JSON.stringify({ to: replyTo, subject: 'Re: ' + t.subject, thread_id: t.id, in_reply_to: last.messageId, draft: true }).replace(/'/g, '&#39;')})'>Save as draft</button></div></div></div>`, true);
}
async function sendReply(m) {
  const text = val('rpText'); if (!text) return toast('Write a message first', true);
  const r = await act(() => api('POST', m.draft ? '/api/email/drafts' : '/api/email/send', { ...m, text }), m.draft ? 'Draft saved in your mailbox' : 'Email sent');
  if (r) closeLayer();
}
function composeEmail(m) {
  modal('New email', `<form class="form" onsubmit="event.preventDefault();sendNew()"><div class="field"><label for="ceTo">To</label><input class="input" id="ceTo" value="${attr(m.to || '')}"></div><div class="field"><label for="ceSu">Subject</label><input class="input" id="ceSu"></div>
    <div class="field"><label for="rpText">Message</label><textarea class="input" id="rpText" style="min-height:160px"></textarea></div><div class="btns"><button class="btn primary">${svg('send', 16)}Send</button><button type="button" class="btn line" onclick="sendNew(true)">Save as draft</button></div></form>`);
}
async function sendNew(draft) { const text = val('rpText'); const body = { to: val('ceTo'), subject: val('ceSu'), text }; const r = await act(() => api('POST', draft ? '/api/email/drafts' : '/api/email/send', body), draft ? 'Draft saved in your mailbox' : 'Email sent'); if (r) closeLayer(); }

/* ---------- Tasks (internal to-dos; never synced to external calendars) ---------- */
async function pTasks(id, qs) {
  shell('tasks', 'Workspace / <b>Tasks</b>');
  const f = (qs && qs.get('f')) || 'open';
  const list = await act(() => api('GET', `/api/tasks?${f === 'mine' ? 'mine=1' : ''}${f === 'done' ? '&done=1' : ''}`)); if (!list || gone('tasks')) return;
  setContent(head('Tasks', 'Tasks', 'Internal to-dos for the team. They stay in Unbusyness and never go to your external calendar.', `<button class="btn primary" onclick="taskForm({})">${svg('plus', 16)}New task</button>`) +
    `<div class="tabs" style="margin-bottom:12px">${[['open', 'Open'], ['mine', 'Mine'], ['done', 'Done']].map((t) => `<a href="#/tasks?f=${t[0]}" class="${f === t[0] ? 'on' : ''}">${t[1]}</a>`).join('')}</div>
    <div class="card">${list.map((t) => `<div class="li"><button class="iconbtn" style="${t.done_at ? 'background:var(--green);color:#fff;border-color:var(--green)' : ''}" onclick="toggleTask(${t.id})" aria-label="${t.done_at ? 'Reopen' : 'Mark done'}">${svg('check', 16)}</button>
      <div class="grow"><b style="${t.done_at ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(t.title)}</b><span class="s">${esc([t.assignee ? 'For ' + t.assignee : 'Unassigned', t.customer_name, t.due_at ? 'Due ' + fWhen(t.due_at) : ''].filter(Boolean).join(' · '))}</span>${t.notes ? `<span class="s">${esc(t.notes)}</span>` : ''}</div>
      ${t.due_at && !t.done_at && new Date(t.due_at) < new Date() ? pill('Overdue', 'red') : ''}<button class="btn line sm" onclick='taskForm(${JSON.stringify({ id: t.id, title: t.title, notes: t.notes, due_at: t.due_at, assigned_user_id: t.assigned_user_id }).replace(/'/g, '&#39;')})'>Edit</button></div>`).join('') || '<div class="empty">No tasks here.</div>'}</div>`);
}
function taskForm(t) {
  const team = S.me.team.filter((m) => m.active);
  modal(t.id ? 'Edit task' : 'New task', `<form class="form two" onsubmit="saveTask(event, ${t.id || 0})"><div class="field full"><label for="tt">Task</label><input class="input" id="tt" required value="${attr(t.title || '')}" placeholder="e.g. Call supplier about the valve"></div>
    <div class="field"><label for="ta">For</label><select class="input" id="ta"><option value="">Unassigned</option>${team.map((m) => `<option value="${m.id}" ${t.assigned_user_id === m.id ? 'selected' : ''}>${esc(m.name || m.email)}${m.id === S.me.user.id ? ' (me)' : ''}</option>`).join('')}</select></div>
    <div class="field"><label for="td">Due</label><input class="input" id="td" type="datetime-local" value="${t.due_at ? toLocalInput(t.due_at) : ''}"></div>
    <div class="field full"><label for="tn">Notes</label><textarea class="input" id="tn">${esc(t.notes || '')}</textarea></div>
    <div class="full">${explain('Tasks are internal. They are never added to Google or Outlook calendars. Customer appointments and jobs are.')}</div>
    <div class="btns full"><button class="btn primary">${svg('check', 16)}Save</button>${t.id ? `<button type="button" class="btn danger" onclick="delTask(${t.id})">${svg('trash', 16)}Delete</button>` : ''}<button type="button" class="btn line" onclick="closeLayer()">Cancel</button></div></form>`);
}
async function saveTask(e, id) {
  e.preventDefault();
  const due = val('td'); const body = { title: val('tt'), notes: val('tn'), assigned_user_id: Number(val('ta')) || null, due_at: due && fromLocalInput(due) ? fromLocalInput(due).toISOString() : null };
  if (await act(() => (id ? api('PUT', `/api/tasks/${id}`, body) : api('POST', '/api/tasks', body)), 'Task saved')) { closeLayer(); route(); }
}
async function toggleTask(id) { if (await act(() => api('POST', `/api/tasks/${id}/done`))) route(); }
async function delTask(id) { if (confirm('Delete this task?') && await act(() => api('DELETE', `/api/tasks/${id}`), 'Task deleted')) { closeLayer(); route(); } }

/* ---------- Quotes ---------- */
async function pQuotes(id) {
  shell('quotes', 'Money / <b>Quotes</b>');
  if (id) return docEditor('quote', id);
  const list = await act(() => api('GET', '/api/quotes')); if (!list || gone('quotes')) return;
  S.counts.quotes = list.filter((q) => q.status === 'draft').length;
  shell('quotes', 'Money / <b>Quotes</b>');
  const open = list.filter((q) => q.status === 'sent');
  setContent(head('Quotes', 'Quotes', 'The AI drafts them from calls. You check the price and send.', `<button class="btn primary" onclick="newQuote()">${svg('plus', 16)}New quote</button>`) +
    `<div class="grid g4" style="margin-bottom:16px">${stat('To check and send', S.counts.quotes, 'drafts', 'doc', 'apricot')}${stat('Waiting for customer', open.length, money0(open.reduce((a, q) => a + Number(q.total), 0)), 'clock', 'slate')}${stat('Accepted', list.filter((q) => q.status === 'accepted').length, money0(list.filter((q) => q.status === 'accepted').reduce((a, q) => a + Number(q.total), 0)), 'check', 'green')}${stat('Win rate', (() => { const done = list.filter((q) => ['accepted', 'declined'].includes(q.status)); return done.length ? Math.round(done.filter((q) => q.status === 'accepted').length / done.length * 100) + '%' : '—'; })(), 'accepted of decided', 'spark', 'green')}</div>
    <div class="card"><div class="tscroll">${list.length ? `<table class="tbl"><thead><tr><th>Number</th><th>Customer</th><th class="hide-m">Work</th><th class="hide-m">Date</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>
    ${list.map((q) => `<tr class="click" onclick="go('#/quotes/${q.id}')"><td><b>${esc(q.number)}</b></td><td>${esc(q.customer_name || '—')}</td><td class="hide-m muted">${esc(q.title)}</td><td class="hide-m">${fDate(q.created_at)}</td><td>${statusPill.quote(q)}</td><td class="num"><b>${moneyFmt(q.total)}</b></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No quotes yet. They appear here when a caller asks for a price, or create one yourself.</div>'}</div></div>`);
}
async function newQuote(customerId) {
  const r = await act(() => api('POST', '/api/quotes', { customer_id: customerId || null }));
  if (r) go(`#/quotes/${r.id}`);
}

/* ---------- Invoices ---------- */
async function pInvoices(id, qs) {
  shell('invoices', 'Money / <b>Invoices</b>');
  if (id) return docEditor('invoice', id);
  const list = await act(() => api('GET', '/api/invoices')); if (!list || gone('invoices')) return;
  const f = (qs && qs.get('f')) || 'all';
  const unpaid = list.filter((i) => i.status === 'sent'); const od = unpaid.filter((i) => i.overdue);
  const paidWeek = list.filter((i) => i.status === 'paid' && new Date(i.paid_at) > Date.now() - 7 * 864e5);
  const sum = (a) => a.reduce((x, i) => x + Number(i.total), 0);
  const filt = { all: list.filter((i) => i.status !== 'void'), draft: list.filter((i) => i.status === 'draft'), unpaid, overdue: od, paid: list.filter((i) => i.status === 'paid') }[f] || list;
  setContent(head('Money', 'Invoices', 'Created when a job is finished. Unpaid invoices get friendly reminders automatically.', `<div class="btns"><a class="btn line" href="/api/export/invoices.csv">${svg('dl', 16)}Export for accountant</a><button class="btn primary" onclick="newInvoice()">${svg('plus', 16)}New invoice</button></div>`) +
    `<div class="grid g4" style="margin-bottom:16px">${stat('Waiting to be paid', money0(sum(unpaid)), `${unpaid.length} invoices`, 'clock', 'apricot', '#/invoices?f=unpaid')}${stat('Overdue', money0(sum(od)), `${od.length} past due date`, 'alert', 'red', '#/invoices?f=overdue')}${stat('Paid in the last 7 days', money0(sum(paidWeek)), `${paidWeek.length} invoices`, 'check', 'green', '#/invoices?f=paid')}${stat('Drafts to send', list.filter((i) => i.status === 'draft').length, 'from finished jobs', 'doc', 'slate', '#/invoices?f=draft')}</div>
    <div class="row between wrap" style="margin-bottom:12px"><div class="tabs">${[['all', 'All'], ['draft', 'Drafts'], ['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid']].map((t) => `<a href="#/invoices?f=${t[0]}" class="${f === t[0] ? 'on' : ''}">${t[1]}</a>`).join('')}</div></div>
    <div class="card"><div class="tscroll">${filt.length ? `<table class="tbl"><thead><tr><th>Number</th><th>Customer</th><th class="hide-m">Job</th><th class="hide-m">Due</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>
    ${filt.map((i) => `<tr class="click" onclick="go('#/invoices/${i.id}')"><td><b>${esc(i.number)}</b></td><td>${esc(i.customer_name || '—')}</td><td class="hide-m muted">${esc(i.job_title || '')}</td><td class="hide-m">${fDate(i.due_date)}</td><td>${statusPill.invoice(i)}</td><td class="num"><b>${moneyFmt(i.total)}</b></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No invoices here.</div>'}</div></div>`);
}
async function newInvoice() { const r = await act(() => api('POST', '/api/invoices', {})); if (r) go(`#/invoices/${r.id}`); }

/* ---------- Quote / invoice editor ---------- */
async function docEditor(type, id) {
  const d = await act(() => api('GET', `/api/${type}s/${id}`)); if (!d) return;
  const customers = await loadCustomers();
  const doc = d[type];
  S.doc = { type, id: doc.id, doc, items: d.items.map((i) => ({ ...i })), tax_rate: Number(doc.tax_rate), url: d.url, extra: d };
  const isQ = type === 'quote'; const locked = !isQ && doc.status === 'paid';
  const services = S.me.services || [];
  const back = isQ ? '#/quotes' : '#/invoices';
  let side = '';
  if (isQ) {
    side = `<div class="card cb stack"><div class="row between"><b>Status</b>${statusPill.quote(doc)}</div>
      ${doc.status === 'draft' ? `<button class="btn primary block" onclick="sendDoc()">${svg('send', 16)}Approve and send</button>` : ''}
      ${doc.status === 'sent' ? `<button class="btn primary block" onclick="sendDoc()">${svg('send', 16)}Send again</button><button class="btn soft block" onclick="docAction('accept','Marked as accepted')">${svg('check', 16)}Mark as accepted</button>` : ''}
      ${d.job ? `<a class="btn soft block" href="#/jobs/${d.job.id}">${svg('cal', 16)}Job · ${fWhen(d.job.scheduled_at)}</a>` : `<button class="btn ${doc.status === 'accepted' ? 'primary' : 'line'} block" onclick='openJobForm({quote_id:${doc.id}})'>${svg('cal', 16)}Book the job</button>`}
      ${d.invoice ? `<a class="btn line block" href="#/invoices/${d.invoice.id}">Invoice ${esc(d.invoice.number)}</a>` : `<button class="btn line block" onclick="invoiceFromQuote(${doc.id})">${svg('euro', 16)}Create invoice</button>`}
      <button class="btn line block" onclick="previewDoc()">${svg('eye', 16)}Preview and PDF</button>
      ${doc.status !== 'draft' ? `<button class="btn line block" onclick="copyLink()">${svg('copy', 16)}Copy customer link</button>` : ''}
      ${['sent', 'draft'].includes(doc.status) ? `<button class="btn line sm" onclick="docAction('decline','Marked as declined')">Mark as declined</button>` : ''}</div>
      ${timeline([['Created' + (doc.ai_drafted ? ' by AI from the call' : ''), doc.created_at], ['Sent to customer', doc.sent_at], ['Viewed by customer', doc.viewed_at], ['Follow-up sent', doc.followup_at], ['Accepted', doc.accepted_at]])}
      ${d.call ? `<div class="card cb"><b>From the call</b><p class="muted small" style="margin:6px 0">${esc(d.call.summary)}</p><a href="#/calls/${d.call.id}" class="btn line sm">Open call</a></div>` : ''}
      ${explain(doc.ai_drafted ? '<b>The AI wrote this from the call and your price list.</b> Check the scope and price. Nothing is sent without your approval.' : 'Add lines from your price list or type your own. The customer gets a link with an <b>Accept</b> button.')}`;
  } else {
    side = `<div class="card cb stack"><div class="row between"><b>Status</b>${statusPill.invoice(doc)}</div>
      ${doc.status === 'draft' ? `<button class="btn primary block" onclick="sendDoc()">${svg('send', 16)}Send invoice</button>` : ''}
      ${doc.status === 'sent' ? `<button class="btn primary block" onclick="markPaid()">${svg('check', 16)}Record payment</button><button class="btn soft block" onclick="docAction('remind','Reminder sent')">${svg('send', 16)}Send reminder</button>` : ''}
      <button class="btn line block" onclick="previewDoc()">${svg('eye', 16)}Preview and PDF</button>
      ${doc.status !== 'draft' && doc.status !== 'void' ? `<button class="btn line block" onclick="copyLink()">${svg('copy', 16)}Copy payment link</button>` : ''}
      ${d.job ? `<a class="btn line block" href="#/jobs/${d.job.id}">${svg('cal', 16)}Open job</a>` : ''}
      ${['draft', 'sent'].includes(doc.status) ? `<button class="btn danger sm" onclick="if(confirm('Void this invoice?'))docAction('void','Invoice voided')">Void invoice</button>` : ''}</div>
      ${timeline([['Created', doc.created_at], ['Sent to customer', doc.sent_at], ['Viewed by customer', doc.viewed_at], [`Reminders sent: ${doc.reminders_sent}`, doc.last_reminder], ['Paid' + (doc.paid_method ? ` (${doc.paid_method})` : ''), doc.paid_at]])}
      ${d.photos && d.photos.length ? `<div class="card cb stack"><b>Job photos</b><div class="thumbs">${d.photos.map((p) => `<a class="thumb ${p.label === 'invoice' ? 'inv' : ''}" href="/api/photos/${p.id}" target="_blank" rel="noopener"><img src="/api/photos/${p.id}" alt="${p.label === 'invoice' ? 'Supplier invoice photo' : 'Job photo'}"><span class="lbl">${p.label === 'invoice' ? 'Invoice' : 'Job photo'}</span></a>`).join('')}</div></div>` : ''}
      ${explain(S.me.stripe && S.me.business.stripe_ready ? 'Your customer can pay by card or bank transfer from the link. Paid invoices update automatically.' : 'Connect Stripe in <a href="#/settings/payments">Settings</a> to add a <b>Pay</b> button. Until then, record payments here.')}`;
  }
  setContent(`<a href="${back}" class="btn line sm" style="margin-bottom:14px">${svg('back', 14)}All ${type}s</a>` +
    head(isQ ? 'Quote' : 'Invoice', esc(doc.number), isQ ? `Valid until ${fDate(doc.valid_until)}` : `Due ${fDate(doc.due_date)}`, locked ? '' : `<button class="btn primary" onclick="saveDoc()">${svg('check', 16)}Save</button>`) +
    `<div class="editor"><div class="stack">
      <div class="card cb form two">
        <div class="field"><label for="dc">Customer</label><select class="input" id="dc" ${locked ? 'disabled' : ''} onchange="if(this.value==='new'){customerForm({},(c)=>{S.customers=null;saveDoc(c.id,true)})}">
          <option value="">Choose a customer…</option>${customers.map((c) => `<option value="${c.id}" ${c.id === doc.customer_id ? 'selected' : ''}>${esc(c.name)}${c.phone ? ' · ' + esc(c.phone) : ''}</option>`).join('')}<option value="new">+ New customer</option></select>
          ${d.customer && !d.customer.email ? '<span class="hint" style="color:var(--apricot-ink)">No email on file. Add one so the customer receives it.</span>' : ''}</div>
        ${isQ ? `<div class="field"><label for="dt">Title</label><input class="input" id="dt" value="${attr(doc.title || '')}" placeholder="e.g. Replace water heater"></div>`
          : `<div class="field"><label for="dd">Due date</label><input class="input" id="dd" type="date" ${locked ? 'disabled' : ''} value="${String(doc.due_date || '').slice(0, 10)}"></div>`}
        ${isQ ? `<div class="field"><label for="dv">Valid until</label><input class="input" id="dv" type="date" value="${String(doc.valid_until || '').slice(0, 10)}"></div>` : `<div class="field"><label for="di">Issue date</label><input class="input" id="di" type="date" ${locked ? 'disabled' : ''} value="${String(doc.issue_date || '').slice(0, 10)}"></div>`}
        <div class="field"><label for="dx">${esc(S.me.business.tax_label || 'Tax')} %</label><input class="input" id="dx" type="number" step="0.01" min="0" ${locked ? 'disabled' : ''} value="${S.doc.tax_rate}" oninput="S.doc.tax_rate=Number(this.value)||0;docTotals()"></div>
      </div>
      <div class="card"><div class="ch"><div><h2>Line items</h2><p>Qty × price. ${esc(S.me.business.tax_label || 'Tax')} is added on the total.</p></div>
        ${locked ? '' : `<select class="input" style="width:auto;min-height:36px" onchange="addFromPrice(this)" aria-label="Add from price list"><option value="">+ Add from price list</option>${services.map((s, k) => `<option value="${k}">${esc(s.name)} · ${moneyFmt(s.price)}/${esc(s.unit)}</option>`).join('')}</select>`}</div>
        <div class="tscroll" id="itemsBox"></div></div>
      <div class="card cb field"><label for="dn">Note for the customer</label><textarea class="input" id="dn" ${locked ? 'disabled' : ''} placeholder="${isQ ? 'Scope, materials, what is included…' : 'Thank you note, warranty…'}">${esc(doc.notes || '')}</textarea></div>
    </div><aside class="stack">${side}</aside></div>`);
  drawItems(locked);
}
function timeline(rows) {
  return `<div class="card cb"><b>History</b><div style="margin-top:6px">${rows.map(([t, d]) => `<div class="row" style="padding:6px 0;align-items:flex-start"><span style="width:10px;height:10px;border-radius:50%;margin-top:5px;background:${d ? 'var(--green)' : 'var(--line)'};flex-shrink:0"></span><div><b style="font-size:12.5px;font-weight:600">${esc(t)}</b><div class="muted small">${d ? fWhen(d) : '—'}</div></div></div>`).join('')}</div></div>`;
}
function drawItems(locked) {
  const it = S.doc.items;
  $('#itemsBox').innerHTML = `<table class="tbl items"><thead><tr><th>Description</th><th class="num">Qty</th><th class="u">Unit</th><th class="num">Price</th><th class="num">Amount</th>${locked ? '' : '<th></th>'}</tr></thead><tbody>
    ${it.map((i, k) => `<tr><td>${locked ? esc(i.description) : `<input class="input" value="${attr(i.description)}" oninput="S.doc.items[${k}].description=this.value" aria-label="Description">`}</td>
      <td class="num">${locked ? i.qty : `<input class="input q" type="number" step="0.25" value="${i.qty}" oninput="S.doc.items[${k}].qty=Number(this.value)||0;docTotals()" aria-label="Quantity">`}</td>
      <td class="u">${locked ? esc(i.unit) : `<input class="input u" value="${attr(i.unit)}" oninput="S.doc.items[${k}].unit=this.value" aria-label="Unit">`}</td>
      <td class="num">${locked ? moneyFmt(i.unit_price) : `<input class="input p" type="number" step="0.01" value="${i.unit_price}" oninput="S.doc.items[${k}].unit_price=Number(this.value)||0;docTotals()" aria-label="Unit price">`}</td>
      <td class="num" id="amt${k}">${moneyFmt(i.qty * i.unit_price)}</td>${locked ? '' : `<td><button class="iconbtn" style="width:32px;height:32px" onclick="S.doc.items.splice(${k},1);drawItems()" aria-label="Remove line">${svg('trash', 14)}</button></td>`}</tr>`).join('') || `<tr><td colspan="6" class="empty">No lines yet. Add one from your price list.</td></tr>`}</tbody></table>
    <div class="row between" style="padding:12px 16px;flex-wrap:wrap">${locked ? '<span></span>' : `<button class="btn line sm" onclick="S.doc.items.push({description:'',qty:1,unit:'job',unit_price:0});drawItems();setTimeout(()=>{const r=document.querySelectorAll('#itemsBox tbody tr');r[r.length-1].querySelector('input').focus()},10)">${svg('plus', 14)}Add line</button>`}
      <div id="totBox" style="min-width:240px"></div></div>`;
  docTotals();
}
function docTotals() {
  const it = S.doc.items; it.forEach((i, k) => { const el = $('#amt' + k); if (el) el.textContent = moneyFmt(i.qty * i.unit_price); });
  const sub = Math.round(it.reduce((a, i) => a + i.qty * i.unit_price, 0) * 100) / 100; const tax = Math.round(sub * S.doc.tax_rate) / 100;
  const box = $('#totBox'); if (box) box.innerHTML = `<div class="row between"><span class="muted">Subtotal</span><b>${moneyFmt(sub)}</b></div>${S.doc.tax_rate ? `<div class="row between"><span class="muted">${esc(S.me.business.tax_label || 'Tax')} ${S.doc.tax_rate}%</span><b>${moneyFmt(tax)}</b></div>` : ''}<div class="row between" style="font-size:17px;margin-top:4px"><b>Total</b><b style="color:var(--green)">${moneyFmt(sub + tax)}</b></div>`;
}
function addFromPrice(sel) {
  const s = (S.me.services || [])[Number(sel.value)]; sel.value = ''; if (!s) return;
  S.doc.items.push({ description: s.name, qty: 1, unit: s.unit, unit_price: Number(s.price) }); drawItems();
}
async function saveDoc(customerOverride, reload) {
  const { type, id } = S.doc; const isQ = type === 'quote';
  const cust = customerOverride || (val('dc') === 'new' ? '' : val('dc'));
  const body = { customer_id: cust || null, items: S.doc.items, tax_rate: S.doc.tax_rate, notes: val('dn') };
  if (isQ) Object.assign(body, { title: val('dt'), valid_until: val('dv') || undefined }); else Object.assign(body, { due_date: val('dd') || undefined, issue_date: val('di') || undefined });
  const r = await act(() => api('PUT', `/api/${type}s/${id}`, body), reload === false ? null : 'Saved');
  if (r && reload !== false) docEditor(type, id);
  return r;
}
async function sendDoc() {
  const { type, id } = S.doc;
  if (!(await saveDoc(null, false))) return;
  const r = await act(() => api('POST', `/api/${type}s/${id}/send`), (x) => (x.delivery === 'sent' ? 'Sent to the customer by email' : x.delivery === 'failed' ? 'Saved, but the email failed. See Settings › Messages.' : 'Ready. No mailbox is connected yet, so copy the link and send it yourself (or connect one in Settings › Integrations).'));
  if (r) { S.doc.url = r.url; docEditor(type, id); }
}
async function docAction(action, msg) { const { type, id } = S.doc; if (await act(() => api('POST', `/api/${type}s/${id}/${action}`), msg)) docEditor(type, id); }
async function invoiceFromQuote(qid) { const r = await act(() => api('POST', '/api/invoices', { quote_id: qid }), 'Invoice created'); if (r) go(`#/invoices/${r.id}`); }
function markPaid() {
  modal('Record payment', `<div class="form"><div class="field"><label for="pm">How was it paid?</label><select class="input" id="pm"><option value="card">Card</option><option value="bank transfer">Bank transfer</option><option value="check">Check</option><option value="cash">Cash</option><option value="other">Other</option></select></div>
    <div class="btns"><button class="btn primary" onclick="doPaid()">${svg('check', 16)}Mark as paid · ${moneyFmt(S.doc.doc.total)}</button><button class="btn line" onclick="closeLayer()">Cancel</button></div></div>`);
}
async function doPaid() { const m = val('pm'); closeLayer(); if (await act(() => api('POST', `/api/invoices/${S.doc.id}/paid`, { method: m }), 'Payment recorded')) docEditor('invoice', S.doc.id); }
async function copyLink() {
  try { await navigator.clipboard.writeText(S.doc.url); toast('Link copied'); } catch { modal('Customer link', `<div class="code">${esc(S.doc.url)}</div>`); }
}
async function previewDoc() {
  await saveDoc(null, false);
  const r = await act(() => api('GET', `/api/doc/${S.doc.type}/${S.doc.id}`)); if (!r) return;
  window._docHtml = r;
  modal('Preview', `<style>${r.css}</style><div class="docframe">${r.html}</div><div class="btns"><button class="btn primary" onclick="printDoc()">${svg('dl', 16)}Download PDF</button><button class="btn line" onclick="closeLayer()">Close</button></div>`, true);
}
function printDoc() {
  const r = window._docHtml; const w = window.open('', '_blank');
  if (!w) return toast('Allow pop-ups to download the PDF', true);
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(S.doc.doc.number)}</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap"><style>body{margin:24px}${r.css}</style></head><body>${r.html}<script>setTimeout(()=>print(),400)<\/script></body></html>`);
  w.document.close();
}

/* ---------- Jobs ---------- */
function weekStart(offset) { const p = partsIn(new Date()); const wd = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7; return dayStart(-wd + offset * 7); }
async function pJobs(id) {
  shell('jobs', 'Workspace / <b>Jobs</b>');
  const ws = weekStart(S.week); const we = weekStart(S.week + 1);
  const jobs = await act(() => api('GET', `/api/jobs?from=${ws.toISOString()}&to=${we.toISOString()}`)); if (!jobs || gone('jobs')) return;
  const scheduled = jobs.filter((j) => j.scheduled_at); const unscheduled = jobs.filter((j) => !j.scheduled_at);
  const team = S.me.team.filter((t) => t.active);
  const days = [...Array(7)].map((_, k) => new Date(ws.getTime() + (k * 24 + 12) * 3600e3));
  const card = (j) => `<a class="jc ${j.status === 'done' ? 'done' : ''}" style="border-left-color:${j.assignee_color || '#8A938F'}${j.tentative ? ';border-style:dashed;background:var(--apricot-soft)' : ''}" href="#/jobs/${j.id}"><span class="t">${j.scheduled_at ? fTime(j.scheduled_at) : 'No time'} · ${j.tentative ? 'Requested by AI' : { scheduled: 'Scheduled', on_the_way: 'On the way', in_progress: 'Working', done: 'Done' }[j.status]}</span><b>${esc(j.title)}</b><span>${esc(j.customer_name || '')}</span><span>${esc(j.assignee || 'Unassigned')}${Number(j.price) ? ' · ' + money0(j.price) : ''}${j.invoice_status === 'paid' ? ' · Paid' : ''}</span></a>`;
  const rangeTxt = `${fmt(days[0], { month: 'short', day: 'numeric' })} – ${fmt(days[6], { month: 'short', day: 'numeric' })}`;
  let h = head('Jobs and calendar', S.week === 0 ? 'This week' : S.week === 1 ? 'Next week' : S.week === -1 ? 'Last week' : 'Week', `${rangeTxt} · ${scheduled.length} jobs · ${scheduled.filter((j) => j.status === 'done').length} done`,
    `<div class="btns"><button class="btn line" onclick="S.week--;pJobs()" aria-label="Previous week">${svg('back', 16)}</button><button class="btn line" onclick="S.week=0;pJobs()">Today</button><button class="btn line" onclick="S.week++;pJobs()" aria-label="Next week" style="transform:scaleX(-1)">${svg('back', 16)}</button><button class="btn primary" onclick="openJobForm({})">${svg('plus', 16)}New job</button></div>`);
  h += `<div class="row between wrap" style="margin-bottom:12px"><div class="legend">${team.map((t) => `<span><i style="background:${t.color}"></i>${esc(t.name || t.email)}${t.role === 'owner' ? ' (you)' : ''}</span>`).join('')}</div>${team.length < 2 ? '<a href="#/settings/team" class="small">Invite your crew</a>' : ''}</div>`;
  if (unscheduled.length) h += `<div class="card cb" style="margin-bottom:12px"><b>Not scheduled yet</b><div class="grid g4" style="margin-top:8px">${unscheduled.map(card).join('')}</div></div>`;
  if (window.innerWidth > 760) {
    h += `<div class="tscroll"><div class="board">${days.map((d) => { const js = scheduled.filter((j) => dateKey(j.scheduled_at) === dateKey(d)); return `<div class="col ${isToday(d) ? 'today' : ''}"><div class="dh"><b>${fmt(d, { weekday: 'short', day: 'numeric' })}</b><span>${js.length ? money0(js.reduce((a, j) => a + Number(j.price || 0), 0)) : ''}</span></div>${js.map(card).join('') || '<span class="muted small" style="padding:4px">No jobs</span>'}</div>`; }).join('')}</div></div>`;
  } else {
    h += `<div class="daylist">${days.map((d) => { const js = scheduled.filter((j) => dateKey(j.scheduled_at) === dateKey(d)); return js.length ? `<div class="dayh">${isToday(d) ? 'Today · ' : ''}${fmt(d, { weekday: 'long', month: 'short', day: 'numeric' })}</div><div class="stack">${js.map(card).join('')}</div>` : ''; }).join('') || '<div class="empty">No jobs this week.</div>'}</div>`;
  }
  setContent(h);
  if (id) openJob(id);
}
async function openJob(id) {
  const seq = S.nav;
  const d = await act(() => api('GET', `/api/jobs/${id}`)); if (!d || seq !== S.nav || (manages() && gone('jobs'))) return;
  const j = d.job; const c = d.customer; const owner = manages(); const money = can('money.manage');
  const nx = NEXT[j.status]; const si = STEPS.indexOf(j.status);
  const team = S.me.team.filter((t) => t.active);
  layer(`<div class="scrim" onclick="if(event.target===this)closeLayer()"><div class="drawer" role="dialog" aria-label="Job details">
    <div class="mh"><div><div class="eyebrow">${fWhen(j.scheduled_at)}</div><h2>${esc(j.title)}</h2></div><button class="x" onclick="closeLayer()" aria-label="Close">${svg('x')}</button></div>
    <div class="steps" aria-hidden="true">${STEPS.map((s, k) => `<i class="${k <= si ? 'on' : ''}"></i>`).join('')}</div>
    <div class="row between">${statusPill.job(j.status)} ${pill(KIND[j.kind] || 'Job', 'gray')}${j.cal_event_id ? `<span class="muted small" title="Synced to your connected calendar">${svg('cal', 12)} In calendar</span>` : j.cal_error ? `<span class="small" style="color:var(--red)" title="${attr(j.cal_error)}">Calendar sync failed</span>` : ''}${money && d.invoice ? `<a href="#/invoices/${d.invoice.id}" onclick="closeLayer()">${esc(d.invoice.number)} · ${statusPill.invoice(d.invoice)}</a>` : ''}</div>
    ${j.tentative && owner ? `<div class="explain"><span class="ei">!</span><div><b>Requested by the AI during a call.</b> The time was free. Confirm it and the customer gets a confirmation message.</div></div><button class="btn apricot lg" onclick="confirmJob(${j.id})">${svg('check', 18)}Confirm booking</button>` : ''}
    ${j.tentative ? '' : nx ? `<button class="btn primary lg" onclick="jobStatus(${j.id},'${nx[0]}')">${svg(nx[2], 18)}${nx[1]}</button>` : money && !d.invoice ? `<button class="btn primary lg" onclick="invoiceFromJob(${j.id})">${svg('euro', 18)}Create invoice</button>` : ''}
    ${c ? `<div class="card cb stack"><div class="row"><span class="ic sand">${svg('user')}</span><div class="grow"><b>${esc(c.name)}</b><div class="muted small">${esc(j.address || c.address || '')}</div></div></div>
      <div class="btns">${c.phone ? `<a class="btn line sm" href="${telHref(c.phone)}">${svg('phone', 14)}Call</a>` : ''}${j.address || c.address ? `<a class="btn line sm" target="_blank" rel="noopener" href="${mapHref(j.address || c.address)}">${svg('nav', 14)}Navigate</a>` : ''}${owner ? `<a class="btn line sm" href="#/customers/${c.id}" onclick="closeLayer()">Profile</a>` : ''}</div>
      ${c.notes ? `<div class="muted small">${esc(c.notes)}</div>` : ''}</div>` : ''}
    <div class="card cb stack"><div class="row"><span class="ic slate">${svg('team')}</span><div class="grow"><div class="lab">ASSIGNED TO</div><b>${esc(d.assignee ? d.assignee.name : 'Nobody')}</b></div></div>
      ${owner ? `<div class="field"><label for="ja">Change who does it</label><select class="input" id="ja" onchange="assignJob(${j.id},this.value)">${team.map((t) => `<option value="${t.id}" ${d.assignee && d.assignee.id === t.id ? 'selected' : ''}>${esc(t.name || t.email)}${t.id === S.me.user.id ? ' (keep it myself)' : t.trade_role ? ' · ' + esc(t.trade_role) : ''}</option>`).join('')}</select></div>` : ''}</div>
    ${j.notes || d.items.length ? `<div class="card cb stack">${j.notes ? `<div><div class="lab">NOTES</div>${esc(j.notes)}</div>` : ''}${d.items.length ? `<div><div class="lab">WORK</div>${d.items.map((i) => `<div class="row between" style="padding:3px 0"><span>${esc(i.description)} ${Number(i.qty) !== 1 ? '× ' + i.qty : ''}</span>${money ? `<b>${moneyFmt(i.qty * i.unit_price)}</b>` : ''}</div>`).join('')}</div>` : ''}</div>` : ''}
    ${photoCard(j, d.photos)}
    ${owner ? `<div class="btns"><button class="btn line" onclick='openJobForm(${JSON.stringify({ id: j.id, kind: j.kind, title: j.title, address: j.address, scheduled_at: j.scheduled_at, duration_min: j.duration_min, assigned_user_id: j.assigned_user_id, price: j.price, notes: j.notes, customer_id: j.customer_id }).replace(/'/g, '&#39;')})'>${svg('edit', 16)}Edit job</button>${j.status !== 'scheduled' ? `<button class="btn line" onclick="jobStatus(${j.id},'scheduled')">Reset status</button>` : ''}<button class="btn danger" onclick="if(confirm('Delete this job?'))delJob(${j.id})">${svg('trash', 16)}Delete</button></div>` : ''}
  </div></div>`);
}
function photoCard(j, photos) {
  return `<div class="card cb stack"><div class="row between"><div><b>Photos</b><div class="muted small">${photos.length ? `${photos.filter((p) => p.label === 'job').length} job · ${photos.filter((p) => p.label === 'invoice').length} invoice` : 'Optional · none yet'}</div></div><button class="btn line sm" onclick="openPhoto(${j.id})">${svg('cam', 14)}Add photo</button></div>
    ${photos.length ? `<div class="thumbs">${photos.map((p) => `<a class="thumb ${p.label === 'invoice' ? 'inv' : ''}" href="/api/photos/${p.id}" target="_blank" rel="noopener"><img src="/api/photos/${p.id}" alt="${p.label === 'invoice' ? 'Supplier invoice' : 'Job photo'}" loading="lazy"><span class="lbl">${p.label === 'invoice' ? 'Invoice' : 'Job photo'}</span></a>`).join('')}</div>` : ''}</div>`;
}
async function jobStatus(id, status) {
  const msg = { on_the_way: 'Customer told you are on the way', in_progress: 'Job started', done: 'Job finished', scheduled: 'Status reset' }[status];
  const r = await act(() => api('POST', `/api/jobs/${id}/status`, { status }), msg);
  if (!r) return;
  if (!manages()) return pWorkerJob(id);
  if (r.invoiceId) toast('Job finished. Invoice draft is ready to check and send.');
  refreshJobsBehind(id);
}
async function refreshJobsBehind(id) { if (location.hash.startsWith('#/jobs')) await pJobs(); await openJob(id); }
async function assignJob(id, uid) { if (await act(() => api('PUT', `/api/jobs/${id}`, { assigned_user_id: Number(uid) }), 'Job reassigned')) refreshJobsBehind(id); }
async function confirmJob(id) { if (await act(() => api('POST', `/api/jobs/${id}/confirm`), 'Booking confirmed. The customer was told.')) refreshJobsBehind(id); }
async function delJob(id) { if (await act(() => api('DELETE', `/api/jobs/${id}`), 'Job deleted')) { closeLayer(); pJobs(); } }
async function invoiceFromJob(id) { const r = await act(() => api('POST', '/api/invoices', { job_id: id }), 'Invoice created'); if (r) { closeLayer(); go(`#/invoices/${r.id}`); } }
async function openJobForm(pre) {
  const customers = await act(() => loadCustomers()); if (!customers) return;
  const team = S.me.team.filter((t) => t.active);
  const when = pre.scheduled_at ? toLocalInput(pre.scheduled_at) : toLocalInput(new Date(dayStart(1).getTime() + 9 * 3600e3));
  window._jobPre = pre;
  modal(pre.id ? 'Edit job' : 'New job', `<form class="form two" onsubmit="saveJob(event)">
    ${pre.quote_id ? `<div class="full">${explain('Booking the job from the quote. Customer, work and price come from the quote.')}</div>` : `<div class="field full"><label for="jc">Customer</label><select class="input" id="jc" onchange="if(this.value==='new')customerForm({},(c)=>{S.customers=null;window._jobPre.customer_id=c.id;openJobForm(window._jobPre)});else{const c=S.customers.find(x=>x.id==this.value);if(c&&!val('jaddr'))document.getElementById('jaddr').value=c.address||''}">
      <option value="">No customer</option>${customers.map((c) => `<option value="${c.id}" ${c.id === pre.customer_id ? 'selected' : ''}>${esc(c.name)}${c.phone ? ' · ' + esc(c.phone) : ''}</option>`).join('')}<option value="new">+ New customer</option></select></div>
    <div class="field full"><label for="jt">What is the job?</label><input class="input" id="jt" ${pre.quote_id ? '' : 'required'} value="${attr(pre.title || '')}" placeholder="e.g. Clogged bathroom drain"></div>
    <div class="field full"><label for="jaddr">Address</label><input class="input" id="jaddr" value="${attr(pre.address || '')}"></div>`}
    <div class="field"><label for="jk">Type</label><select class="input" id="jk">${Object.entries(KIND).map(([k, l]) => `<option value="${k}" ${(pre.kind || 'job') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field"><label for="jw">When</label><input class="input" id="jw" type="datetime-local" value="${when}"></div>
    <div class="field"><label for="jd">Duration</label><select class="input" id="jd">${[30, 60, 90, 120, 180, 240, 480].map((m) => `<option value="${m}" ${(pre.duration_min || 90) === m ? 'selected' : ''}>${m < 60 ? m + ' min' : m / 60 + ' h'}</option>`).join('')}</select></div>
    <div class="field"><label for="ju">Who does it?</label><select class="input" id="ju">${team.map((t) => `<option value="${t.id}" ${(pre.assigned_user_id || S.me.user.id) === t.id ? 'selected' : ''}>${esc(t.name || t.email)}${t.id === S.me.user.id ? ' (me)' : t.trade_role ? ' · ' + esc(t.trade_role) : ''}</option>`).join('')}</select></div>
    ${pre.quote_id || !can('money.manage') ? '' : `<div class="field"><label for="jp">Agreed price (before tax)</label><input class="input" id="jp" type="number" step="0.01" min="0" value="${pre.price || ''}" placeholder="0.00"></div>`}
    <div class="field full"><label for="jn">Notes for the crew</label><textarea class="input" id="jn" placeholder="Gate code, parts to bring, where to park…">${esc(pre.notes || '')}</textarea></div>
    ${pre.id ? '' : '<label class="row full small"><input type="checkbox" id="jnotify" checked> Send the customer a booking confirmation</label>'}
    <div class="btns full"><button class="btn primary">${svg('check', 16)}${pre.id ? 'Save' : 'Book job'}</button><button type="button" class="btn line" onclick="closeLayer()">Cancel</button></div></form>`);
}
async function saveJob(e) {
  e.preventDefault();
  const pre = window._jobPre || {};
  const w = val('jw');
  const body = { kind: val('jk'), scheduled_at: w && fromLocalInput(w) ? fromLocalInput(w).toISOString() : null, duration_min: Number(val('jd')), assigned_user_id: Number(val('ju')), notes: val('jn') };
  if (!pre.quote_id) Object.assign(body, { customer_id: val('jc') && val('jc') !== 'new' ? Number(val('jc')) : null, title: val('jt'), address: val('jaddr'), price: val('jp') });
  if (pre.quote_id) body.quote_id = pre.quote_id;
  if (pre.call_id) body.call_id = pre.call_id;
  if (!pre.id) body.notify_customer = !!($('#jnotify') && $('#jnotify').checked);
  const r = await act(() => (pre.id ? api('PUT', `/api/jobs/${pre.id}`, body) : api('POST', '/api/jobs', body)), pre.id ? 'Job saved' : 'Job booked');
  if (!r) return;
  closeLayer(); S.customers = null;
  const jid = pre.id || r.id;
  if (body.scheduled_at) S.week = Math.floor((new Date(body.scheduled_at) - weekStart(0)) / (7 * 864e5));
  go(`#/jobs/${jid}`);
}

/* ---------- photos (owner + worker) ---------- */
function openPhoto(jobId) { window._ph = { jobId, label: null }; drawPhoto(); }
function drawPhoto() {
  const L = window._ph.label;
  layer(`<div class="scrim center" onclick="if(event.target===this)photoBack()"><div class="modal" role="dialog" aria-label="Add a photo">
    <div class="mh"><h2>Add a photo</h2><button class="x" onclick="photoBack()" aria-label="Close">${svg('x')}</button></div>
    <div class="lab">1 · WHAT IS IT? (REQUIRED)</div>
    <div class="lblpick"><button class="${L === 'job' ? 'on' : ''}" aria-pressed="${L === 'job'}" onclick="window._ph.label='job';drawPhoto()"><b>${svg('cam', 16)} Job photo</b><span>The problem, before and after, the finished work</span></button>
      <button class="${L === 'invoice' ? 'on' : ''}" aria-pressed="${L === 'invoice'}" onclick="window._ph.label='invoice';drawPhoto()"><b>${svg('doc', 16)} Invoice</b><span>Supplier invoice or receipt for parts</span></button></div>
    <div class="lab">2 · ADD THE PHOTO</div>
    <label class="btn primary lg ${L ? '' : 'off'}" for="phIn" style="${L ? '' : 'opacity:.4;pointer-events:none'}">${svg('cam', 18)}Take or choose photo</label>
    <input id="phIn" type="file" accept="image/*" hidden onchange="uploadPhoto(this)">
    <div id="phStatus" class="muted small"></div>
    ${explain('Photos are optional. The label keeps job photos and invoices for parts apart, so nothing gets mixed up.')}</div></div>`);
}
function photoBack() { const id = window._ph.jobId; if (manages()) openJob(id); else { closeLayer(); pWorkerJob(id); } }
function resizeImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.82)); };
    img.onerror = () => reject(new Error('Could not read this image'));
    img.src = url;
  });
}
async function uploadPhoto(inp) {
  const f = inp.files && inp.files[0]; if (!f) return;
  $('#phStatus').textContent = 'Uploading…';
  try {
    const dataUrl = await resizeImage(f);
    await api('POST', `/api/jobs/${window._ph.jobId}/photos`, { label: window._ph.label, dataUrl });
    toast(window._ph.label === 'invoice' ? 'Invoice photo saved to the job' : 'Job photo saved');
    photoBack();
  } catch (e) { $('#phStatus').textContent = ''; toast(e.message, true); }
}

/* ---------- worker (crew) view ---------- */
function phoneShell(title, inner, backHref) {
  const b = S.me.business || { name: 'Unbusyness' };
  $('#root').innerHTML = `<div class="phone"><div class="ptop">${backHref ? `<a class="btn line sm" href="${backHref}">${svg('back', 14)}My jobs</a>` : `<div class="row">${LOGO}<div><div class="t">${esc(title)}</div><div class="muted small">${esc(b.name)}</div></div></div>`}
    ${backHref ? '' : `<a class="btn line sm" href="#/account">${svg('user', 14)}Account</a>`}</div>${verifyBanner()}${inner}</div>`;
}
async function pMy() {
  phoneShell('My jobs', '<div class="empty">Loading…</div>');
  const [jobs, tasks] = await Promise.all([act(() => api('GET', `/api/jobs?mine=1&from=${dayStart().toISOString()}&to=${dayStart(14).toISOString()}`)), can('tasks.assigned') ? act(() => api('GET', '/api/tasks?mine=1')) : []]); if (!jobs) return;
  const today = jobs.filter((j) => isToday(j.scheduled_at)); const later = jobs.filter((j) => !isToday(j.scheduled_at));
  const next = today.find((j) => j.status !== 'done');
  const item = (j) => `<a class="pitem" href="#/job/${j.id}"><span class="time">${fTime(j.scheduled_at)}</span><div class="grow"><b>${esc(j.title)}</b><span>${esc(j.customer_name || '')}${j.address ? ' · ' + esc(j.address) : ''}</span></div>${statusPill.job(j.status)}</a>`;
  phoneShell(`Hi ${first(S.me.user.name) || 'there'}`, `
    ${next ? `<a class="bigjob" href="#/job/${next.id}"><span class="k">Next job · ${fTime(next.scheduled_at)}</span><b>${esc(next.title)}</b><span>${esc(next.customer_name || '')} · ${esc(next.address || '')}</span></a>` : `<div class="card cb">${explain(today.length ? '<b>All done for today.</b> Nice work.' : 'No jobs today. New jobs from the office appear here.')}</div>`}
    <div class="daylist"><div class="dayh">Today · ${today.length} job${today.length === 1 ? '' : 's'}</div><div class="stack">${today.map(item).join('') || '<div class="muted">Nothing scheduled.</div>'}</div>
    ${tasks && tasks.length ? `<div class="dayh">My tasks · ${tasks.length}</div><div class="stack">${tasks.map((t) => `<div class="pitem"><button class="iconbtn" onclick="workerTask(${t.id})" aria-label="Mark done">${svg('check', 16)}</button><div class="grow"><b>${esc(t.title)}</b><span>${esc([t.customer_name, t.due_at ? 'Due ' + fWhen(t.due_at) : ''].filter(Boolean).join(' · '))}</span></div></div>`).join('')}</div>` : ''}
    ${later.length ? `<div class="dayh">Coming up</div><div class="stack">${later.map((j) => item(j).replace('<span class="time">', `<span class="time" style="width:80px;font-size:13px">${fDay(j.scheduled_at)}<br>`)).join('')}</div>` : ''}</div>`);
}
async function workerTask(id) { if (await act(() => api('POST', `/api/tasks/${id}/done`), 'Task done')) pMy(); }
async function pWorkerJob(id) {
  phoneShell('Job', '<div class="empty">Loading…</div>', '#/my');
  const d = await act(() => api('GET', `/api/jobs/${id}`)); if (!d) return;
  const j = d.job; const c = d.customer; const nx = NEXT[j.status]; const si = STEPS.indexOf(j.status);
  const addr = j.address || (c && c.address) || '';
  phoneShell('Job', `<div class="stack">
    <div><div class="eyebrow">${fWhen(j.scheduled_at)}</div><div style="font-size:26px;font-weight:700;letter-spacing:-.6px">${esc(j.title)}</div><div class="muted">${esc(c ? c.name : '')}</div></div>
    <div class="steps" aria-hidden="true">${STEPS.map((s, k) => `<i class="${k <= si ? 'on' : ''}"></i>`).join('')}</div>${statusPill.job(j.status)}
    <div class="card cb stack"><div class="fld" style="border:0;padding:0"><small>Address</small><b style="font-size:17px">${esc(addr || '—')}</b></div>
      <div class="g2 grid">${addr ? `<a class="btn line lg" target="_blank" rel="noopener" href="${mapHref(addr)}">${svg('nav', 18)}Navigate</a>` : ''}${c && c.phone ? `<a class="btn line lg" href="${telHref(c.phone)}">${svg('phone', 18)}Call</a>` : ''}</div></div>
    ${j.notes || (c && c.notes) ? `<div class="card cb"><div class="lab">NOTES</div>${esc(j.notes || '')}${c && c.notes ? `<div class="muted small" style="margin-top:6px">${esc(c.notes)}</div>` : ''}</div>` : ''}
    ${d.items.length ? `<div class="card cb"><div class="lab">WORK</div>${d.items.map((i) => `<div style="padding:4px 0">${esc(i.description)}${Number(i.qty) !== 1 ? ' × ' + i.qty : ''}</div>`).join('')}</div>` : ''}
    ${photoCard(j, d.photos)}
    ${nx ? `<button class="btn primary lg" style="min-height:62px;font-size:18px" onclick="jobStatus(${j.id},'${nx[0]}')">${svg(nx[2], 20)}${nx[1]}</button>${nx[0] === 'on_the_way' && c ? `<p class="muted small" style="text-align:center;margin:0">${esc(first(c.name))} gets a message that you are on the way.</p>` : ''}` : `<div class="card cb">${explain('<b>Job done.</b> The office sends the invoice.')}</div>`}
  </div>`, '#/my');
}

/* ---------- More (mobile) ---------- */
function pMore() {
  shell('more', 'Workspace / <b>More</b>', `<div class="card">${[['tasks', 'Tasks', 'check', 'tasks.manage'], ['customers', 'Customers', 'user', 'customers.manage'], ['quotes', 'Quotes', 'doc', 'money.manage'], ['settings', 'Settings', 'gear', 'settings']].filter((x) => navOk([0, 0, 0, 0, x[3]])).map((x) => `<a class="li" href="#/${x[0]}"><span class="ic sand">${svg(x[2])}</span><div class="grow"><b>${x[1]}</b></div>${x[0] === 'quotes' && S.counts.quotes ? pill(S.counts.quotes + ' to send', 'apricot') : ''}</a>`).join('')}<a class="li" href="#/account"><span class="ic sand">${svg('user')}</span><div class="grow"><b>Account</b></div></a><a class="li" href="/api/logout"><span class="ic sand">${svg('out')}</span><div class="grow"><b>Log out</b></div></a></div>`);
}

/* ---------- Settings ---------- */
const STABS = [['business', 'Business', 'company.settings'], ['prices', 'Price list', 'company.settings'], ['voice', 'Voice agent', 'company.settings'], ['integrations', 'Integrations', 'integrations.manage'], ['payments', 'Payments', 'company.settings'], ['team', 'Team', 'team.manage'], ['messages', 'Messages', 'company.settings']];
async function pSettings(tab, qs) {
  const tabs = STABS.filter((t) => can(t[2]));
  if (!tabs.length) return pToday();
  tab = tabs.some((t) => t[0] === tab) ? tab : tabs[0][0];
  await refreshMe();
  shell('settings', `Settings / <b>${STABS.find((t) => t[0] === tab)[1]}</b>`);
  const b = S.me.business;
  let h = head('Settings', 'Settings', '', '') + `<div class="tabs" style="margin-bottom:16px">${tabs.map((t) => `<a href="#/settings/${t[0]}" class="${tab === t[0] ? 'on' : ''}">${t[1]}</a>`).join('')}</div>`;
  if (tab === 'business') {
    const F = (id, label, v, type = 'text', extra = '') => `<div class="field ${extra}"><label for="${id}">${label}</label><input class="input" id="${id}" type="${type}" value="${attr(v ?? '')}" ${type === 'number' ? 'step="0.01" min="0"' : ''}></div>`;
    h += `<div class="grid g2"><div class="card cb"><form class="form two" onsubmit="saveBusiness(event)">
      ${F('sn', 'Business name', b.name, 'text', 'full')}
      <div class="field"><label for="str">Trade</label><select class="input" id="str">${['Plumbing', 'HVAC', 'Electrical', 'Other'].map((t) => `<option ${b.trade === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      ${F('sph', 'Business phone', b.phone, 'tel')}${F('sad', 'Address', b.address, 'text', 'full')}${F('sem', 'Email (replies go here)', b.email, 'email')}${F('sweb', 'Website', b.website)}
      ${F('stid', 'Tax ID / license number', b.tax_id)}${F('smp', 'Your mobile (urgent call alerts)', S.me.user.phone, 'tel')}
      ${F('stl', 'Tax name', b.tax_label)}${F('str2', 'Tax rate %', b.tax_rate, 'number')}
      ${F('spt', 'Payment terms (days)', b.payment_terms, 'number')}${F('sqv', 'Quotes valid for (days)', b.quote_valid_days, 'number')}
      <div class="field full"><label for="stz">Time zone</label><select class="input" id="stz">${['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Europe/London', 'Europe/Ljubljana'].map((z) => `<option ${b.timezone === z ? 'selected' : ''}>${z}</option>`).join('')}</select></div>
      <div class="field full"><label for="spn">Payment instructions on invoices</label><textarea class="input" id="spn" placeholder="e.g. Pay online with the link, or by check to Demo Plumbing Co.">${esc(b.payment_notes || '')}</textarea></div>
      <div class="btns full"><button class="btn primary">${svg('check', 16)}Save</button></div></form></div>
      <div class="stack"><div class="card cb stack"><b>Logo</b><div class="row"><span class="av" style="width:64px;height:64px;border-radius:16px">${b.logo_mime ? `<img src="/logo/${b.id}?t=${Date.now()}" alt="Logo">` : esc(initials(b.name))}</span><label class="btn line" for="logoIn">${svg('cam', 16)}Upload logo</label><input id="logoIn" type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden onchange="uploadLogo(this)"></div><span class="hint">Shown on quotes and invoices. PNG or JPG, max 1.5 MB.</span></div>
      ${explain('These details appear on every quote and invoice. Quote and invoice numbers are created automatically.')}</div></div>`;
  }
  if (tab === 'prices') {
    store.set('ub_prices_seen', '1');
    window._prices = S.me.services.map((s) => ({ ...s }));
    h += `<div class="card"><div class="ch"><div><h2>Price list</h2><p>The AI only uses these prices when it drafts a quote. Keywords help it match what callers say.</p></div><button class="btn primary" onclick="savePrices()">${svg('check', 16)}Save</button></div><div class="tscroll" id="priceBox"></div></div>`;
  }
  if (tab === 'voice') {
    const v = await act(() => api('GET', '/api/voice/settings'));
    if (!v) return;
    window._voice = v;
    const sc = v.schedule; const days = String(sc.work_days).split(',');
    const secretHelp = { retell: 'Retell API key (the one with the webhook badge). Used to check the x-retell-signature.', vapi: 'Server secret you set in Vapi (sent as x-vapi-secret). Leave empty to use the Unbusyness secret.', elevenlabs: 'Webhook secret from ElevenLabs (used to check ElevenLabs-Signature).', generic: 'Not needed. The platform sends the Unbusyness secret header.' };
    const copy = (t) => `<button class="btn line sm" onclick="navigator.clipboard.writeText(${attr(JSON.stringify(t))}).then(()=>toast('Copied'))">${svg('copy', 14)}Copy</button>`;
    h += `<div class="grid g2"><div class="stack">
      <div class="card cb stack"><b>Voice platform</b>
        <div class="field"><label for="vp">Which platform answers your calls?</label><select class="input" id="vp">${v.providers.map((p) => `<option value="${p.id}" ${p.id === v.provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="vs">Platform secret ${v.has_provider_secret ? '(saved, enter a new one to replace)' : ''}</label><input class="input" id="vs" type="password" autocomplete="off" placeholder="${v.has_provider_secret ? '••••••••' : 'optional'}"><span class="hint">${esc(secretHelp[v.provider] || '')}</span></div>
        <div class="lab">WORKING HOURS (used for free time slots)</div>
        <div class="btns">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, k) => `<label class="pill ${days.includes(String(k + 1)) ? 'green' : 'gray'}" style="cursor:pointer"><input type="checkbox" class="vday" value="${k + 1}" ${days.includes(String(k + 1)) ? 'checked' : ''} style="margin:0 4px 0 0">${d}</label>`).join('')}</div>
        <div class="form two"><div class="field"><label for="vws">From</label><select class="input" id="vws">${[...Array(24)].map((_, k) => `<option value="${k}" ${sc.work_start === k ? 'selected' : ''}>${k}:00</option>`).join('')}</select></div><div class="field"><label for="vwe">To</label><select class="input" id="vwe">${[...Array(24)].map((_, k) => `<option value="${k + 1}" ${sc.work_end === k + 1 ? 'selected' : ''}>${k + 1}:00</option>`).join('')}</select></div>
          <div class="field"><label for="vsl">Appointment length</label><select class="input" id="vsl">${[60, 90, 120, 180, 240].map((m) => `<option value="${m}" ${sc.slot_minutes === m ? 'selected' : ''}>${m / 60} h</option>`).join('')}</select></div><div class="field"><label for="vsa">Service area</label><input class="input" id="vsa" value="${attr(sc.service_area || '')}" placeholder="Austin and Round Rock"></div>
          <div class="field full"><label for="vep">Emergency policy (the agent can say this)</label><textarea class="input" id="vep">${esc(sc.emergency_policy || '')}</textarea></div></div>
        <button class="btn primary" onclick="saveVoice()">${svg('check', 16)}Save</button></div>
      <div class="card"><div class="ch"><div><h2>Recent deliveries</h2><p>Every message the voice platform sent. Use this to check the connection.</p></div><button class="btn soft sm" onclick="simulateCall()">${svg('phone', 14)}Test call</button></div>
        ${v.events.length ? `<div class="tscroll"><table class="tbl"><tbody>${v.events.map((e) => `<tr><td class="muted" style="white-space:nowrap">${ago(e.created_at)}</td><td>${esc(e.provider)}</td><td>${e.kind === 'tool' ? 'Tool: ' + esc(e.name) : e.kind === 'event' ? 'Call' + (e.name && e.name !== 'duplicate' ? ' → ' + esc(e.name) : '') : 'Login check'}</td><td>${{ ok: pill('OK', 'ok'), duplicate: pill('Duplicate', 'gray'), ignored: pill('Ignored', 'gray'), rejected: pill('Rejected', 'red'), error: pill('Error', 'red') }[e.status] || esc(e.status)}${e.error ? `<div class="muted small">${esc(e.error)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">Nothing received yet.</div>'}</div></div>
      <div class="stack"><div class="card cb stack"><b>Give these to your voice agent company</b>
        <div class="field"><span class="lab">1 · AFTER EVERY CALL (WEBHOOK, POST)</span><div class="code">${esc(v.urls.events)}</div><div class="btns">${copy(v.urls.events)}</div></div>
        <div class="field"><span class="lab">2 · DURING THE CALL (TOOLS)</span>${v.provider === 'vapi' ? `<div class="code">${esc(v.urls.tools)}</div><div class="btns">${copy(v.urls.tools)}</div><span class="hint">One server URL for all tools. Tool names below.</span>` : ''}</div>
        ${v.urls.tool.map((t) => `<div class="fld"><small>${esc(t.name)}</small><div class="small">${esc(t.description)}</div>${v.provider !== 'vapi' ? `<div class="code" style="margin-top:6px">${esc(t.url)}</div>` : ''}</div>`).join('')}
        <div class="field"><span class="lab">SECRET (HEADER X-Unbusyness-Secret)</span><div class="code">${esc(v.secret)}</div><div class="btns">${copy(v.secret)}<button class="btn danger sm" onclick="if(confirm('Create a new secret? The old one stops working.'))rotateSecret()">New secret</button></div><span class="hint">Platforms that sign their requests (Retell, ElevenLabs) can use their own signature instead. You can also add ?secret=… to the URL.</span></div>
      </div>
      ${explain('<b>The agent never touches your data directly.</b> It can only use these five tools, never sees prices, and bookings it makes wait for your confirmation. To switch to another platform later, change it here and paste the new URLs. Nothing else changes.')}</div></div>`;
  }
  if (tab === 'integrations') {
    const v = await act(() => api('GET', '/api/integrations')); if (!v) return;
    if (qs && qs.get('connected')) toast(qs.get('connected') === 'email' ? 'Mailbox connected' : 'Calendar connected. Upcoming jobs are being added.');
    if (qs && qs.get('error')) toast(qs.get('error'), true);
    const P = { google: 'Google', microsoft: 'Microsoft', imap: 'IMAP / SMTP' };
    const sub = { email: { google: 'Gmail and Google Workspace', microsoft: 'Outlook and Microsoft 365', imap: 'Any other mailbox (manual setup)' }, calendar: { google: 'Google Calendar', microsoft: 'Outlook / Microsoft 365 calendar' } };
    const status = (c) => (!c ? pill('Not connected', 'gray') : c.status === 'connected' && !c.last_error ? pill('Connected', 'ok') : pill(c.status === 'error' ? 'Reconnect needed' : 'Connected, with errors', 'red'));
    const block = (kind, title, desc, providers) => {
      const c = v[kind];
      return `<div class="card"><div class="ch"><div><h2>${title}</h2><p>${desc}</p></div>${status(c)}</div><div class="cb stack">
        ${c ? `<div class="row"><span class="ic green">${svg(kind === 'email' ? 'send' : 'cal')}</span><div class="grow"><b>${esc(P[c.provider])} · ${esc(c.account || '')}</b><div class="muted small">Connected ${fDate(c.connected_at)}${c.last_ok_at ? ' · last used ' + ago(c.last_ok_at) : ''}</div>${c.last_error ? `<div class="small" style="color:var(--red)">${esc(c.last_error)}</div>` : ''}</div></div>
          <div class="btns"><button class="btn line sm" onclick="testIntegration('${kind}')">Test connection</button>${kind === 'calendar' ? `<button class="btn soft sm" onclick="syncCalendar()">${svg('cal', 14)}Sync now</button>` : ''}${c.provider !== 'imap' ? `<a class="btn line sm" href="/api/integrations/oauth/${c.provider}/start?kind=${kind}">Reconnect</a>` : ''}<button class="btn danger sm" onclick="if(confirm('Disconnect? Unbusyness stops using this account.'))disconnect('${kind}')">Disconnect</button></div>
          ${kind === 'calendar' ? `<span class="hint">${v.calendarStats.synced} jobs in the calendar${v.calendarStats.failed ? ` · ${v.calendarStats.failed} failed` : ''}.</span>` : ''}<div id="test_${kind}"></div>`
          : `<div class="grid g3">${providers.map((p) => `<div class="card cb stack"><b>${P[p]}</b><span class="muted small">${sub[kind][p]}</span>${p === 'imap'
            ? (v.available.imap ? `<button class="btn line sm" onclick="imapForm()">Set up</button>` : '<span class="hint">Run npm install on the server first.</span>')
            : v.available[p] && v.encryption ? `<a class="btn primary sm" href="/api/integrations/oauth/${p}/start?kind=${kind}">Connect</a>` : `<span class="hint">${!v.encryption ? 'Set ENCRYPTION_KEY first.' : `Add ${p === 'google' ? 'GOOGLE' : 'MICROSOFT'}_CLIENT_ID and _SECRET on the server.`}</span>`}</div>`).join('')}</div>`}
      </div></div>`;
    };
    h += `${!v.encryption ? `<div style="margin-bottom:14px">${explain('<b>ENCRYPTION_KEY is not set.</b> It protects saved passwords and tokens. Add it in Replit Secrets before connecting accounts (see README).')}</div>` : ''}
      <div class="stack">${block('email', 'Email', 'Quotes, invoices and reminders go out from your own address. Customer emails show on the customer page.', ['google', 'microsoft', 'imap'])}
      ${block('calendar', 'Calendar', 'Only time-based commitments are added: jobs, appointments, inspections and meetings. Internal tasks stay in Unbusyness.', ['google', 'microsoft'])}
      ${explain('<b>Unbusyness is the source of truth.</b> Changes go one way: from Unbusyness to your calendar. If you move an event in Google or Outlook, change it in Unbusyness too. Passwords and tokens are encrypted on the server and never shown in the browser.')}
      <details class="card cb"><summary>Setup details for the administrator</summary><div class="stack" style="margin-top:10px"><div class="field"><span class="lab">GOOGLE REDIRECT URIS (add both)</span><div class="code">${esc(v.redirectUris.googleLogin)}\n${esc(v.redirectUris.google)}</div></div><div class="field"><span class="lab">MICROSOFT REDIRECT URIS (add both)</span><div class="code">${esc(v.redirectUris.microsoftLogin)}\n${esc(v.redirectUris.microsoft)}</div></div><span class="hint">Add these in Google Cloud Console and Microsoft Entra (Azure). Steps are in the README.</span></div></details></div>`;
  }
  if (tab === 'payments') {
    h += `<div class="grid g2"><div class="card cb stack"><b>Online payments with Stripe</b>
      ${!S.me.stripe ? explain('Stripe is not set up on the server yet. Add <b>STRIPE_SECRET_KEY</b> in Replit Secrets (see the README).') : b.stripe_ready ? `<div class="row"><span class="ic green">${svg('check')}</span><div><b>Connected</b><div class="muted small">Invoices show a Pay button. Money goes to your Stripe account.</div></div></div>` : `<p class="muted" style="margin:0">Connect your Stripe account so customers can pay invoices by card or bank transfer.</p><button class="btn primary" onclick="connectStripe()">${b.stripe_account ? 'Finish Stripe setup' : 'Connect Stripe'}</button>`}
      ${explain('Fees: Stripe charges its standard processing fee. Unbusyness adds 0.5% on payments processed. Bank transfers (ACH) cost less than cards for big invoices.')}</div>
      <div class="card cb stack"><b>Export for your accountant</b><p class="muted" style="margin:0">All invoices with dates, status, tax and totals as a spreadsheet (CSV). QuickBooks, Xero and Zoho Books sync is coming.</p><a class="btn line" href="/api/export/invoices.csv">${svg('dl', 16)}Download CSV</a></div></div>`;
  }
  if (tab === 'team') {
    h += `<div class="grid g2"><div class="card"><div class="ch"><div><h2>Your team</h2><p>Crew members see only their own jobs, without prices.</p></div></div>
      ${S.me.team.map((t) => `<div class="li"><span class="av" style="background:${t.color};color:#fff">${esc(initials(t.name || t.email))}</span><div class="grow"><b>${esc(t.name || t.email)}${t.id === S.me.user.id ? ' (you)' : ''}</b><span class="s">${esc(roleLabel(t.role))}${t.trade_role ? ' · ' + esc(t.trade_role) : ''}${t.active ? '' : ' · removed'}</span></div>${t.id !== S.me.user.id && rankOf(t.role) <= rankOf(S.me.user.role) ? `<button class="btn line sm" onclick='editMember(${JSON.stringify(t).replace(/'/g, '&#39;')})'>Edit</button>` : ''}</div>`).join('')}</div>
      <div class="card cb stack"><b>Invite someone</b><form class="form" onsubmit="invite(event)"><div class="field"><label for="in">Name</label><input class="input" id="in" placeholder="Carlos Méndez"></div>
        <div class="field"><label for="iro">Access</label><select class="input" id="iro">${assignableRoles().map((r) => `<option value="${r.key}" ${r.key === 'worker' ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="ir">Job title</label><input class="input" id="ir" placeholder="Plumber"></div><button class="btn primary">${svg('plus', 16)}Create invite link</button></form><div id="inviteOut"></div>
      <div class="stack small">${(S.me.roles || []).map((r) => `<div><b>${esc(r.label)}:</b> <span class="muted">${esc(ROLE_HELP[r.key] || '')}</span></div>`).join('')}</div>
      ${explain('Send the link by text or WhatsApp. They log in on their phone and see their jobs right away. Tip: add the app to the home screen.')}</div></div>`;
  }
  if (tab === 'messages') {
    const box = await act(() => api('GET', '/api/outbox')) || [];
    h += `${!S.me.email ? `<div style="margin-bottom:14px">${explain('<b>No mailbox is connected yet.</b> Messages to customers are saved here instead of being sent. Connect your mailbox in <a href="#/settings/integrations">Settings › Integrations</a>.')}</div>` : ''}
      <div class="card"><div class="ch"><div><h2>Messages to customers</h2><p>Every email and text the app sent or prepared</p></div></div><div class="tscroll">${box.length ? `<table class="tbl"><thead><tr><th>When</th><th>To</th><th>Message</th><th>Status</th></tr></thead><tbody>${box.map((m) => `<tr><td class="muted" style="white-space:nowrap">${ago(m.created_at)}</td><td>${svg(m.channel === 'sms' ? 'phone' : 'send', 13)} ${esc(m.to_addr)}</td><td><b>${esc(m.subject || '')}</b><div class="muted small" style="white-space:pre-wrap;max-width:560px">${esc(String(m.body || '').slice(0, 240))}</div></td><td>${m.status === 'sent' ? pill('Sent', 'ok') : m.status === 'failed' ? `<span title="${attr(m.error || '')}">${pill('Failed', 'red')}</span>` : pill('Saved only', 'gray')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No messages yet.</div>'}</div></div>`;
  }
  setContent(h);
  if (tab === 'prices') drawPrices();
}
async function saveBusiness(e) {
  e.preventDefault();
  const body = { name: val('sn'), trade: val('str'), phone: val('sph'), address: val('sad'), email: val('sem'), website: val('sweb'), tax_id: val('stid'), my_phone: val('smp'), tax_label: val('stl'), tax_rate: val('str2'), payment_terms: val('spt'), quote_valid_days: val('sqv'), timezone: val('stz'), payment_notes: val('spn') };
  if (await act(() => api('PUT', '/api/business', body), 'Saved')) pSettings('business');
}
async function uploadLogo(inp) {
  const f = inp.files && inp.files[0]; if (!f) return;
  const dataUrl = f.type === 'image/svg+xml' ? await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); }) : await resizeImage(f, 600).then((u) => u);
  if (await act(() => api('POST', '/api/business/logo', { dataUrl }), 'Logo saved')) pSettings('business');
}
function drawPrices() {
  const p = window._prices;
  $('#priceBox').innerHTML = `<table class="tbl items"><thead><tr><th>Service</th><th class="u">Unit</th><th class="num">Price</th><th class="hide-m">Keywords (what callers might say)</th><th></th></tr></thead><tbody>
    ${p.map((s, k) => `<tr><td><input class="input" value="${attr(s.name)}" oninput="window._prices[${k}].name=this.value" aria-label="Service name"></td><td class="u"><input class="input u" value="${attr(s.unit)}" oninput="window._prices[${k}].unit=this.value" aria-label="Unit"></td><td class="num"><input class="input p" type="number" step="0.01" value="${s.price}" oninput="window._prices[${k}].price=this.value" aria-label="Price"></td><td class="hide-m"><input class="input" value="${attr(s.keywords || '')}" oninput="window._prices[${k}].keywords=this.value" aria-label="Keywords"></td><td><button class="iconbtn" style="width:32px;height:32px" onclick="window._prices.splice(${k},1);drawPrices()" aria-label="Remove">${svg('trash', 14)}</button></td></tr>`).join('')}</tbody></table>
    <div style="padding:12px 16px"><button class="btn line sm" onclick="window._prices.push({name:'',unit:'job',price:0,keywords:''});drawPrices()">${svg('plus', 14)}Add service</button></div>`;
}
async function savePrices() { if (await act(() => api('PUT', '/api/services', { services: window._prices }), 'Price list saved')) pSettings('prices'); }
async function saveVoice() {
  const body = { provider: val('vp'), work_days: [...document.querySelectorAll('.vday:checked')].map((x) => x.value).join(','), work_start: Number(val('vws')), work_end: Number(val('vwe')), slot_minutes: Number(val('vsl')), service_area: val('vsa'), emergency_policy: val('vep') };
  if (val('vs')) body.provider_secret = val('vs');
  if (await act(() => api('PUT', '/api/voice/settings', body), 'Saved')) pSettings('voice');
}
async function rotateSecret() { if (await act(() => api('POST', '/api/business/rotate-secret'), 'New secret created')) pSettings('voice'); }
async function connectStripe() { const r = await act(() => api('POST', '/api/stripe/connect')); if (r) location.href = r.url; }
async function invite(e) {
  e.preventDefault();
  const r = await act(() => api('POST', '/api/invites', { name: val('in'), trade_role: val('ir'), role: val('iro') })); if (!r) return;
  $('#inviteOut').innerHTML = `<div class="field"><span class="lab">INVITE LINK (works once)</span><div class="code">${esc(r.url)}</div></div><div class="btns"><button class="btn soft sm" onclick="navigator.clipboard.writeText('${r.url}').then(()=>toast('Link copied'))">${svg('copy', 14)}Copy link</button><a class="btn line sm" href="sms:?&body=${encodeURIComponent('Join our team on Unbusyness: ' + r.url)}">Send by text</a></div>`;
}
const ROLE_HELP = { owner: 'Everything, including money, settings and integrations.', manager: 'Team, customers, calls, jobs, tasks and the calendar. No prices or invoices.', worker: 'Only their own jobs, tasks and schedule. No prices.' };
const RANK = { owner: 3, manager: 2, worker: 1 };
const rankOf = (r) => RANK[r] || 1;
const assignableRoles = () => (S.me.roles || []).filter((r) => rankOf(r.key) <= rankOf(S.me.user.role));
async function testIntegration(kind) {
  const box = $('#test_' + kind); box.innerHTML = '<span class="muted small">Testing…</span>';
  try { const r = await api('POST', `/api/integrations/${kind}/test`); box.innerHTML = `<div class="explain" style="background:var(--ok-soft);color:#1f4a35"><span class="ei">✓</span><div><b style="color:var(--ok)">Works.</b> ${esc(r.account || '')}${r.threads ? `<br>Latest: ${r.threads.map((t) => esc(t.subject || '(no subject)')).join(' · ') || 'no emails'}` : ''}</div></div>`; }
  catch (e) { box.innerHTML = `<div class="explain" style="background:var(--red-soft)"><span class="ei">!</span><div>${esc(e.message)}</div></div>`; }
}
async function syncCalendar() { const r = await act(() => api('POST', '/api/integrations/calendar/sync'), (x) => `Synced ${x.jobs} jobs`); if (r) pSettings('integrations'); }
async function disconnect(kind) { if (await act(() => api('POST', `/api/integrations/${kind}/disconnect`), 'Disconnected')) pSettings('integrations'); }
function imapForm() {
  modal('Connect a mailbox (IMAP / SMTP)', `<form class="form two" onsubmit="saveImap(event)">
    <div class="field"><label for="ie">Email address</label><input class="input" id="ie" type="email" required></div><div class="field"><label for="ifn">Sender name</label><input class="input" id="ifn" value="${attr(S.me.business.name)}"></div>
    <div class="field"><label for="iu">Username</label><input class="input" id="iu" required autocomplete="off"></div><div class="field"><label for="ip">Password (or app password)</label><input class="input" id="ip" type="password" required autocomplete="new-password"></div>
    <div class="field"><label for="ih">IMAP server</label><input class="input" id="ih" required placeholder="imap.example.com"></div><div class="field"><label for="ipt">IMAP port</label><input class="input" id="ipt" type="number" value="993"></div>
    <div class="field"><label for="sh">SMTP server</label><input class="input" id="sh" required placeholder="smtp.example.com"></div><div class="field"><label for="spt">SMTP port</label><input class="input" id="spt" type="number" value="587"></div>
    <div class="full">${explain('We test the connection before saving. The password is encrypted on the server and is never shown again.')}</div>
    <div class="btns full"><button class="btn primary" id="imapBtn">${svg('check', 16)}Test and connect</button><button type="button" class="btn line" onclick="closeLayer()">Cancel</button></div></form>`);
  $('#ie').addEventListener('input', (e) => { if (!val('iu') || val('iu') === e.target.dataset.prev) $('#iu').value = e.target.value; e.target.dataset.prev = e.target.value; });
}
async function saveImap(e) {
  e.preventDefault(); $('#imapBtn').setAttribute('disabled', ''); $('#imapBtn').textContent = 'Testing…';
  const body = { from_email: val('ie'), from_name: val('ifn'), username: val('iu'), password: val('ip'), imap_host: val('ih'), imap_port: Number(val('ipt')), smtp_host: val('sh'), smtp_port: Number(val('spt')) };
  const r = await act(() => api('POST', '/api/integrations/imap', body), 'Mailbox connected');
  if (r) { closeLayer(); pSettings('integrations'); } else { $('#imapBtn').removeAttribute('disabled'); $('#imapBtn').textContent = 'Test and connect'; }
}
function editMember(t) {
  const colors = ['#1F4D45', '#E8915F', '#4F5F80', '#8A5A9E', '#2F7A55', '#B23A32'];
  modal('Edit team member', `<form class="form two" onsubmit="saveMember(event, ${t.id})"><div class="field full"><label for="mn">Name</label><input class="input" id="mn" value="${attr(t.name)}"></div>
    <div class="field"><label for="mr">Role</label><input class="input" id="mr" value="${attr(t.trade_role || '')}" placeholder="Plumber"></div><div class="field"><label for="mph">Phone</label><input class="input" id="mph" type="tel" value="${attr(t.phone || '')}"></div>
    <div class="field"><label for="mc">Calendar color</label><select class="input" id="mc">${colors.map((c) => `<option value="${c}" ${t.color === c ? 'selected' : ''} style="color:${c}">■ ${c}</option>`).join('')}</select></div>
    <div class="field"><label for="ma">Access</label><select class="input" id="ma">${assignableRoles().map((r) => `<option value="${r.key}" ${t.active && t.role === r.key ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}<option value="removed" ${!t.active ? 'selected' : ''}>Removed</option></select></div>
    <div class="btns full"><button class="btn primary">Save</button><button type="button" class="btn line" onclick="closeLayer()">Cancel</button></div></form>`);
}
async function saveMember(e, id) {
  e.preventDefault(); const a = val('ma');
  if (await act(() => api('PUT', `/api/team/${id}`, { name: val('mn'), trade_role: val('mr'), phone: val('mph'), color: val('mc'), role: a === 'removed' ? undefined : a, active: a !== 'removed' }), 'Saved')) { closeLayer(); pSettings('team'); }
}

boot();
