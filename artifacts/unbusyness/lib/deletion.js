// Deleting accounts and companies, used by Account › Delete account and by the team console.
//
// Rules
// - A company never ends up without an owner while other people still work in it:
//   the only owner must first make someone else owner, or delete the company.
// - Deleting a company removes all of its data (customers, calls, jobs, quotes, invoices, photos, messages,
//   connections). Connected Google/Microsoft access is revoked first.
// - Deleting a person removes their account, logins and sessions. Jobs and tasks they had stay with the company,
//   unassigned. Companies where they were the only member are deleted with them.
'use strict';
const db = require('./db');

// What deleting this user would do: companies that go with them, and companies that block the deletion.
async function plan(userId) {
  const rows = await db.many(`SELECT m.business_id, m.role, b.name,
      (SELECT COUNT(*)::int FROM memberships x WHERE x.business_id=m.business_id AND x.active AND x.user_id<>m.user_id) AS others,
      (SELECT COUNT(*)::int FROM memberships x WHERE x.business_id=m.business_id AND x.active AND x.role='owner' AND x.user_id<>m.user_id) AS other_owners
    FROM memberships m JOIN businesses b ON b.id=m.business_id WHERE m.user_id=$1 AND m.active ORDER BY b.name`, [userId]);
  return {
    deleteWith: rows.filter((r) => r.others === 0).map((r) => ({ id: r.business_id, name: r.name })),
    blockedBy: rows.filter((r) => r.role === 'owner' && r.others > 0 && r.other_owners === 0).map((r) => ({ id: r.business_id, name: r.name })),
    staysIn: rows.filter((r) => r.others > 0 && !(r.role === 'owner' && r.other_owners === 0)).map((r) => ({ id: r.business_id, name: r.name, role: r.role })),
  };
}

async function deleteCompany(bizId) {
  const b = await db.one('SELECT id, name FROM businesses WHERE id=$1', [bizId]);
  if (!b) return null;
  // Revoke Google/Microsoft access the company connected (best effort)
  try {
    const { revoke } = require('./integrations/oauth');
    for (const row of await db.many("SELECT * FROM integrations WHERE business_id=$1 AND provider<>'imap'", [bizId])) await revoke(row);
  } catch (e) { console.error('Revoke on delete failed:', e.message); }
  // line_items are linked by document id, not by company
  await db.query(`DELETE FROM line_items WHERE (doc_type='quote' AND doc_id IN (SELECT id FROM quotes WHERE business_id=$1))
    OR (doc_type='invoice' AND doc_id IN (SELECT id FROM invoices WHERE business_id=$1))`, [bizId]);
  // users.business_id is an old column with ON DELETE CASCADE: detach people first so no account is deleted with the company
  await db.query('UPDATE users SET business_id=NULL WHERE business_id=$1', [bizId]);
  await db.query("UPDATE sessions SET data = data - 'business_id' WHERE data->>'business_id' = $1", [String(bizId)]);
  await db.query('DELETE FROM businesses WHERE id=$1', [bizId]); // everything else cascades
  return b;
}

async function deleteUser(userId) {
  const p = await plan(userId);
  if (p.blockedBy.length) {
    const names = p.blockedBy.map((b) => b.name).join(', ');
    throw Object.assign(new Error(`You are the only owner of ${names}, and other people work there. Make someone else owner first (Settings › Team), or delete the company.`), { status: 409, blockedBy: p.blockedBy });
  }
  const companies = [];
  for (const b of p.deleteWith) { const d = await deleteCompany(b.id); if (d) companies.push(d.name); }
  await db.query('DELETE FROM users WHERE id=$1', [userId]); // memberships, sessions, logins and tokens cascade
  return { companies };
}

module.exports = { plan, deleteCompany, deleteUser };
