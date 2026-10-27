// Team invites: the one place with the rules for accepting an invite link.
// Used by every login path (Replit, dev, email + password, Google, Microsoft) and by /join/<token>.
//
// Rules
// - An invite is bound to the invited person's email address. Only a user with that address can accept it.
//   (Older invites made before this rule have no address and can be accepted by anyone with the link.)
// - Accepting never changes an existing active membership. An owner who opens a worker invite stays owner,
//   and the invite stays unused so the right person can still use it.
// - A removed (inactive) member who is invited again is reactivated with the invited role.
// - The invite is marked used in the same step that creates the membership, so one link makes one member.
'use strict';
const db = require('./db');

const normEmail = (e) => String(e || '').trim().toLowerCase();
const COLORS = ['#E8915F', '#4F5F80', '#8A5A9E', '#2F7A55', '#B23A32'];

const MESSAGES = {
  joined: 'You joined the team.',
  invalid: 'This invite link is no longer valid. Ask for a new one.',
  email: 'This invite is for a different email address. Log out, open the link again and sign in with the address the invite was sent to.',
  member: 'You are already a member of this company, so the invite did not change anything. Your role stays the same.',
};

const pending = (token) => (token ? db.one('SELECT * FROM invites WHERE token=$1 AND used_at IS NULL', [String(token)]) : null);

// Returns { status: 'joined' | 'invalid' | 'email' | 'member', business_id?, message }
async function acceptInvite(user, token) {
  const out = (status, extra = {}) => ({ status, message: MESSAGES[status], ...extra });
  const inv = await pending(token);
  if (!inv || !user) return out('invalid');
  if (inv.email && normEmail(inv.email) !== normEmail(user.email)) return out('email', { business_id: inv.business_id });
  const m = await db.one('SELECT id, active FROM memberships WHERE business_id=$1 AND user_id=$2', [inv.business_id, user.id]);
  if (m && m.active) return out('member', { business_id: inv.business_id });

  // Claim the invite first, so two logins with the same link cannot both join.
  const claimed = await db.one('UPDATE invites SET used_at=now() WHERE token=$1 AND used_at IS NULL RETURNING token', [inv.token]);
  if (!claimed) return out('invalid');
  if (m) {
    await db.query('UPDATE memberships SET role=$2, trade_role=$3, active=TRUE WHERE id=$1 AND active=FALSE', [m.id, inv.role, inv.trade_role || '']);
  } else {
    const row = await db.one(`INSERT INTO memberships(business_id, user_id, role, trade_role, color) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (business_id, user_id) DO NOTHING RETURNING id`, [inv.business_id, user.id, inv.role, inv.trade_role || '', COLORS[user.id % COLORS.length]]);
    if (!row) { // became a member in the meantime: give the invite back, change nothing
      await db.query('UPDATE invites SET used_at=NULL WHERE token=$1', [inv.token]);
      return out('member', { business_id: inv.business_id });
    }
  }
  if (inv.name && !user.name) await db.query("UPDATE users SET name=$2 WHERE id=$1 AND name=''", [user.id, inv.name]);
  return out('joined', { business_id: inv.business_id });
}

module.exports = { acceptInvite, pending, normEmail, MESSAGES };
