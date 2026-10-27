// Team invite checks against a short-lived instance of the same Node server (development database, QA accounts).
// Covers: the silent-demotion scenario, email-bound links, correct-address acceptance, one-time use,
// and who may invite whom. Never touches existing companies: everything runs in a fresh QA company.
// Run: node scripts/src/verify-unbusyness-invites.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const port = '3108';
const base = `http://127.0.0.1:${port}`;
let serverLog = '';
const server = spawn(process.execPath, ['artifacts/unbusyness/server.js'], {
  env: { ...process.env, PORT: port, NODE_ENV: 'development', REPLIT_DEPLOYMENT: '0', DEV_LOGIN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (b) => { serverLog += b; });
server.stderr.on('data', (b) => { serverLog += b; });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiny cookie-keeping client: one per person
function person() {
  let cookie = '';
  const keep = (res) => { for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; if (kv.startsWith('ub_sid=')) cookie = /max-age=0/i.test(c) ? '' : kv; } };
  return {
    async call(method, path, body, status = 200) {
      const res = await fetch(base + path, { method, redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      keep(res);
      const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      assert.equal(res.status, status, `${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
      return data;
    },
    async open(path) { const res = await fetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} }); keep(res); return res.headers.get('location'); },
    reset() { cookie = ''; },
  };
}
const me = (p) => p.call('GET', '/api/me');
const roleIn = (m, bizId) => (m.memberships || []).find((x) => x.business_id === bizId)?.role;
const tokenOf = (url) => url.split('/join/')[1];

const sfx = Date.now().toString(36) + randomBytes(2).toString('hex');
const mail = (who) => `qa-inv-${who}-${sfx}@example.com`;
let failed = false;
const check = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (e) { failed = true; console.log('FAIL', name, '\n     ', e.message); } };

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* starting */ } await delay(150); }

  const owner = person();
  await owner.call('POST', '/api/dev-login', { email: mail('owner'), name: 'QA Owner' });
  const biz = await owner.call('POST', '/api/business', { name: `Invites QA ${sfx}`, trade: 'Plumbing' });
  let m = await me(owner); const bizId = m.business.id; assert.ok(bizId, 'company created ' + JSON.stringify(biz));

  await check('an invite needs the email address of the invited person', async () => {
    await owner.call('POST', '/api/invites', { role: 'worker', name: 'No email' }, 400);
  });

  await check('silent demotion: owner opens a worker invite made for their own address → stays owner, invite unused', async () => {
    // The owner cannot even create it (already in the team) …
    await owner.call('POST', '/api/invites', { role: 'worker', email: mail('owner') }, 409);
    // … and opening any worker invite while signed in never changes the owner's role.
    const inv = await owner.call('POST', '/api/invites', { role: 'worker', email: mail('worker') });
    const loc = await owner.open('/join/' + tokenOf(inv.url));
    assert.equal(loc, '/');
    m = await me(owner);
    assert.equal(roleIn(m, bizId), 'owner');
    assert.equal(m.notice && m.notice.status, 'email');
    assert.ok(m.notice.message.length > 20, 'clear message');
    // the right person can still use the same link
    const worker = person();
    await worker.open('/join/' + tokenOf(inv.url));
    await worker.call('POST', '/api/dev-login', { email: mail('worker'), name: 'QA Worker' });
    const wm = await me(worker);
    assert.equal(roleIn(wm, bizId), 'worker');
    assert.equal(wm.notice.status, 'joined');
  });

  await check('a different address cannot claim an email-bound invite (dev login and new password account)', async () => {
    const inv = await owner.call('POST', '/api/invites', { role: 'worker', email: mail('rightperson') });
    const t = tokenOf(inv.url);
    const other = person();
    await other.open('/join/' + t);
    assert.equal((await me(other)).inviteEmail, mail('rightperson'), 'login page knows the invited address');
    await other.call('POST', '/api/dev-login', { email: mail('intruder'), name: 'Intruder' });
    let om = await me(other);
    assert.equal(roleIn(om, bizId), undefined, 'intruder did not join');
    assert.equal(om.notice.status, 'email');
    const signup = person();
    await signup.open('/join/' + t);
    await signup.call('POST', '/api/auth/signup', { name: 'Intruder 2', email: mail('intruder2'), password: randomBytes(12).toString('hex') });
    om = await me(signup);
    assert.equal(roleIn(om, bizId), undefined, 'password signup with another address did not join');
    // still usable by the right person, then only once
    const right = person();
    await right.open('/join/' + t);
    await right.call('POST', '/api/auth/signup', { name: 'Right Person', email: mail('rightperson'), password: randomBytes(12).toString('hex') });
    assert.equal(roleIn(await me(right), bizId), 'worker', 'correct address joined through sign up');
    const late = person();
    const loc = await late.open('/join/' + t);
    assert.match(loc, /error=invite/, 'used link no longer works');
  });

  await check('an existing member who opens an invite for their own address keeps their role', async () => {
    // Make a manager, then try to "re-invite" them as a worker by address: refused at creation (409).
    const inv = await owner.call('POST', '/api/invites', { role: 'manager', email: mail('manager') });
    const mgr = person(); await mgr.open('/join/' + tokenOf(inv.url));
    await mgr.call('POST', '/api/dev-login', { email: mail('manager'), name: 'QA Manager' });
    assert.equal(roleIn(await me(mgr), bizId), 'manager');
    await owner.call('POST', '/api/invites', { role: 'worker', email: mail('manager') }, 409);
  });

  await check('manager and worker permissions for invites', async () => {
    const mgr = person(); await mgr.call('POST', '/api/dev-login', { email: mail('manager') });
    await mgr.call('POST', '/api/companies/switch', { business_id: bizId });
    await mgr.call('POST', '/api/invites', { role: 'owner', email: mail('wannabe-owner') }, 403);
    const ok = await mgr.call('POST', '/api/invites', { role: 'worker', email: mail('worker2') });
    assert.ok(ok.url.includes('/join/'));
    const wk = person(); await wk.call('POST', '/api/dev-login', { email: mail('worker') });
    await wk.call('POST', '/api/companies/switch', { business_id: bizId });
    await wk.call('POST', '/api/invites', { role: 'worker', email: mail('worker3') }, 403);
    await wk.call('GET', '/api/invoices', null, 403);
  });

  await check('a removed member who is invited again comes back with the invited role', async () => {
    const team = (await me(owner)).team;
    const w = team.find((t) => t.email === mail('worker'));
    await owner.call('PUT', `/api/team/${w.id}`, { active: false });
    const inv = await owner.call('POST', '/api/invites', { role: 'worker', email: mail('worker') });
    const wk = person(); await wk.open('/join/' + tokenOf(inv.url));
    await wk.call('POST', '/api/dev-login', { email: mail('worker') });
    const after = (await me(owner)).team.find((t) => t.id === w.id);
    assert.equal(after.active, true); assert.equal(after.role, 'worker');
  });

  await check('the owner is still the owner at the end', async () => {
    assert.equal(roleIn(await me(owner), bizId), 'owner');
  });
} catch (e) {
  failed = true; console.error(e); console.error(serverLog.slice(-2000));
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
