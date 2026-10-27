// Filters, sorting and paging for long lists (invoices, quotes, customers, jobs).
// Every list endpoint keeps returning a plain array unless the client asks for ?page=,
// so older callers (pickers, exports) keep working unchanged.
'use strict';

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d\d-\d\d$/.test(String(v || ''));
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Small WHERE builder: `?` in a condition becomes the next $n placeholder.
function where(first, firstValue) {
  const params = [firstValue]; const conds = [first.replace(/\?/g, '$1')];
  return {
    params,
    add(sql, ...values) {
      let k = 0;
      conds.push(sql.replace(/\?/g, () => { params.push(values[Math.min(k++, values.length - 1)]); return '$' + params.length; }));
      return this;
    },
    sql: () => conds.join(' AND '),
  };
}

// page / per / sort / dir from the query string. `sorts` maps a public key to a SQL expression.
function paging(q, sorts, defSort, defDir = 'desc', tiebreak = 'id') {
  const page = Math.max(1, Math.floor(num(q.get('page')) || 1));
  const per = Math.min(200, Math.max(10, Math.floor(num(q.get('per')) || 50)));
  const sort = sorts[q.get('sort')] ? q.get('sort') : defSort;
  const dir = (q.get('dir') || defDir) === 'asc' ? 'ASC' : 'DESC';
  return { page, per, sort, dir: dir.toLowerCase(), offset: (page - 1) * per, order: `${sorts[sort]} ${dir} NULLS LAST, ${tiebreak} ${dir}` };
}
const pageResult = (rows, total, p, extra = {}) => ({ rows, total, page: p.page, per: p.per, pages: Math.max(1, Math.ceil(total / p.per)), sort: p.sort, dir: p.dir, ...extra });

// Shared date-range filter: from/to are inclusive YYYY-MM-DD in the business time zone.
function dateRange(w, q, expr) {
  if (isDate(q.get('from'))) w.add(`${expr} >= ?::date`, q.get('from'));
  if (isDate(q.get('to'))) w.add(`${expr} <= ?::date`, q.get('to'));
}
const like = (q) => `%${str(q, 100).replace(/[\\%_]/g, (m) => '\\' + m)}%`;

/* ---------- invoices ---------- */
const INVOICE_STATUS = {
  draft: "i.status='draft'",
  unpaid: "i.status='sent'",
  overdue: "i.status='sent' AND i.due_date < CURRENT_DATE",
  paid: "i.status='paid'",
  void: "i.status='void'",
  all: "i.status<>'void'",
};
function invoiceWhere(bizId, q) {
  const w = where('i.business_id=?', bizId);
  const status = q.get('status') || q.get('f') || 'all';
  w.add(INVOICE_STATUS[status] || INVOICE_STATUS.all);
  if (str(q.get('q'))) w.add("(i.number ILIKE ? OR c.name ILIKE ? OR c.email ILIKE ? OR j.title ILIKE ?)", like(q.get('q')));
  if (num(q.get('customer_id'))) w.add('i.customer_id=?', num(q.get('customer_id')));
  dateRange(w, q, 'i.issue_date');
  if (num(q.get('min')) !== null) w.add('i.total >= ?', num(q.get('min')));
  if (num(q.get('max')) !== null) w.add('i.total <= ?', num(q.get('max')));
  return w;
}
const INVOICE_SORTS = { number: 'i.id', customer: 'lower(c.name)', issued: 'i.issue_date', due: 'i.due_date', total: 'i.total', status: 'i.status' };

/* ---------- quotes ---------- */
const QUOTE_STATUS = {
  draft: "q.status='draft'",
  sent: "q.status='sent'",
  viewed: "q.status='sent' AND q.viewed_at IS NOT NULL",
  accepted: "q.status='accepted'",
  declined: "q.status='declined'",
  expired: "q.status='sent' AND q.valid_until < CURRENT_DATE",
  all: 'TRUE',
};
function quoteWhere(bizId, tz, q) {
  const w = where('q.business_id=?', bizId);
  w.add(QUOTE_STATUS[q.get('status')] || QUOTE_STATUS.all);
  if (str(q.get('q'))) w.add('(q.number ILIKE ? OR q.title ILIKE ? OR c.name ILIKE ?)', like(q.get('q')));
  if (num(q.get('customer_id'))) w.add('q.customer_id=?', num(q.get('customer_id')));
  if (isDate(q.get('from'))) w.add('(q.created_at AT TIME ZONE ?)::date >= ?::date', tz, q.get('from'));
  if (isDate(q.get('to'))) w.add('(q.created_at AT TIME ZONE ?)::date <= ?::date', tz, q.get('to'));
  return w;
}
const QUOTE_SORTS = { number: 'q.id', customer: 'lower(c.name)', date: 'q.created_at', total: 'q.total', status: 'q.status' };

/* ---------- customers ---------- */
const CUSTOMER_FILTERS = {
  all: 'TRUE',
  owes: "EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id=c.id AND i.status='sent')",
  overdue: "EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id=c.id AND i.status='sent' AND i.due_date < CURRENT_DATE)",
  open_quote: "EXISTS (SELECT 1 FROM quotes q WHERE q.customer_id=c.id AND q.status='sent')",
  upcoming: "EXISTS (SELECT 1 FROM jobs j WHERE j.customer_id=c.id AND j.status<>'done' AND j.scheduled_at >= now())",
};
function customerWhere(bizId, q) {
  const w = where('c.business_id=?', bizId);
  w.add(CUSTOMER_FILTERS[q.get('f')] || CUSTOMER_FILTERS.all);
  if (str(q.get('q'))) w.add('(c.name ILIKE ? OR c.phone ILIKE ? OR c.address ILIKE ? OR c.email ILIKE ?)', like(q.get('q')));
  return w;
}
const CUSTOMER_SORTS = { name: 'lower(c.name)', last: 'last_activity', balance: 'balance', jobs: 'jobs', created: 'c.created_at' };

/* ---------- jobs (list view) ---------- */
const JOB_STATUS = {
  open: "j.status<>'done' AND NOT j.tentative",
  tentative: 'j.tentative',
  scheduled: "j.status='scheduled' AND NOT j.tentative",
  on_the_way: "j.status='on_the_way'",
  in_progress: "j.status='in_progress'",
  done: "j.status='done'",
  not_invoiced: "j.status='done' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.job_id=j.id AND i.status<>'void')",
  all: 'TRUE',
};
function jobWhere(bizId, tz, q, kinds) {
  const w = where('j.business_id=?', bizId);
  w.add(JOB_STATUS[q.get('status')] || JOB_STATUS.all);
  const who = q.get('assignee');
  if (who === 'none') w.add('j.assigned_user_id IS NULL');
  else if (num(who)) w.add('j.assigned_user_id=?', num(who));
  if (kinds.includes(q.get('kind'))) w.add('j.kind=?', q.get('kind'));
  if (q.get('when') === 'unscheduled') w.add('j.scheduled_at IS NULL');
  if (isDate(q.get('from'))) w.add('(j.scheduled_at AT TIME ZONE ?)::date >= ?::date', tz, q.get('from'));
  if (isDate(q.get('to'))) w.add('(j.scheduled_at AT TIME ZONE ?)::date <= ?::date', tz, q.get('to'));
  if (str(q.get('q'))) w.add('(j.title ILIKE ? OR c.name ILIKE ? OR j.address ILIKE ?)', like(q.get('q')));
  return w;
}
const JOB_SORTS = { when: 'j.scheduled_at', title: 'lower(j.title)', customer: 'lower(c.name)', assignee: 'lower(u.name)', status: 'j.status', price: 'j.price' };

module.exports = {
  where, paging, pageResult, num, str,
  invoiceWhere, INVOICE_SORTS, quoteWhere, QUOTE_SORTS, customerWhere, CUSTOMER_SORTS, jobWhere, JOB_SORTS,
  INVOICE_STATUS, QUOTE_STATUS, CUSTOMER_FILTERS, JOB_STATUS,
};
