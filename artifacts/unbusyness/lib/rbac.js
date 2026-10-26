// Company-based roles and permissions.
// A user can belong to several companies (memberships). Each membership has ONE role.
// Roles are lists of permissions. Add a new permission here, then check it with need(req, 'x').
// Add a new built-in role in ROLES, or a company-specific one in the company_roles table.
'use strict';
const db = require('./db');
const { fail } = require('./http');

const PERMISSIONS = {
  'company.settings': 'Company profile, price list, voice agent, payments',
  'integrations.manage': 'Connect email and calendar accounts',
  'team.manage': 'Invite people and change their role',
  'customers.manage': 'See and edit all customers',
  'calls.manage': 'See calls from the voice agent and act on them',
  'jobs.manage': 'Create, schedule, assign and delete any job',
  'jobs.assigned': 'See and update jobs assigned to me',
  'tasks.manage': 'Create, assign and close any task',
  'tasks.assigned': 'See and close tasks assigned to me',
  'calendar.manage': 'See the whole team calendar and sync it',
  'money.manage': 'Quotes, invoices, prices, payments, exports',
  'email.use': 'Read the company mailbox and send email',
};

const ROLES = {
  owner: { label: 'Owner / Director', rank: 3, permissions: ['*'] },
  manager: {
    label: 'Manager', rank: 2,
    permissions: ['team.manage', 'customers.manage', 'calls.manage', 'jobs.manage', 'jobs.assigned', 'tasks.manage', 'tasks.assigned', 'calendar.manage', 'email.use'],
  },
  worker: { label: 'Employee / Worker', rank: 1, permissions: ['jobs.assigned', 'tasks.assigned'] },
};

async function permissionsFor(businessId, role) {
  if (ROLES[role]) return ROLES[role].permissions;
  const custom = await db.one('SELECT permissions FROM company_roles WHERE business_id=$1 AND key=$2', [businessId, role]);
  return custom ? (Array.isArray(custom.permissions) ? custom.permissions : []) : [];
}
const can = (req, perm) => !!(req.perms && (req.perms.includes('*') || req.perms.includes(perm)));
function need(req, perm) {
  if (!req.user) fail(401, 'Please log in');
  if (!req.membership) fail(409, 'Create or join a company first');
  if (!can(req, perm)) fail(403, 'Your role does not allow this');
}
const rank = (role) => (ROLES[role] ? ROLES[role].rank : 1);
const roleList = () => Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, permissions: r.permissions }));

module.exports = { PERMISSIONS, ROLES, permissionsFor, can, need, rank, roleList };
