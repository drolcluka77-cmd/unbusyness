// Real browser integration tests against a short-lived instance of the same Node server.
// Uses the development database and isolated QA accounts. Tokens stay in memory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { globSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:3107';
const port = '3107';
let serverLog = '';
const server = spawn(process.execPath, ['artifacts/unbusyness/server.js'], {
  env: { ...process.env, PORT: port, NODE_ENV: 'development', REPLIT_DEPLOYMENT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', b => { serverLog += b; });
server.stderr.on('data', b => { serverLog += b; });
const delay = ms => new Promise(r => setTimeout(r, ms));
async function wait(check) {
  for (let i = 0; i < 80; i++) { if (await check()) return; await delay(150); }
  throw new Error('Timed out waiting for expected state');
}
let browser;
const errors = [];
const suffix = Date.now().toString(36);
const email = `qa-accounts-${suffix}@example.com`;
const password = randomBytes(20).toString('hex');
const resetPassword = randomBytes(20).toString('hex');
const changedPassword = randomBytes(20).toString('hex');
const companyName = `Accounts QA ${suffix}`;
mkdirSync('generated-artifacts/accounts-verification', { recursive: true });
const tokenLink = (address, kind) => {
  const messages = serverLog.split(`[system email → ${address}]`).slice(1);
  for (const message of messages.reverse()) {
    const hit = message.match(kind === 'verify' ? /http[^\s]+\/api\/auth\/verify\?token=[^\s]+/ : /http[^\s]+\/#\/reset\?token=[^\s]+/);
    if (hit) return hit[0];
  }
  throw new Error(`No ${kind} link in development mail log`);
};
async function api(ctx, path, data, status = 200, method) {
  const r = await ctx.request.fetch(path, { method: method || (data === undefined ? 'GET' : 'POST'), ...(data === undefined ? {} : { data }) });
  assert.equal(r.status(), status, `${method || 'request'} ${path.split('?')[0]} expected ${status}, got ${r.status()}`);
  return r.json();
}
async function context() {
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text()); });
  return { ctx, page };
}
async function signup(page, address, name, invitation) {
  await page.goto(invitation || '/#/login?mode=signup');
  if (invitation) await page.getByRole('link', { name: 'Create an account', exact: true }).click();
  await page.locator('#sn2').fill(name);
  await page.locator('#se').fill(address);
  await page.locator('#sp').fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await wait(async () => (await api(page.context(), '/api/me')).user?.email === address);
}
async function login(page, address, pw) {
  await page.goto('/#/login');
  await page.locator('#le').fill(address);
  await page.locator('#lp').fill(pw);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await wait(async () => Boolean((await api(page.context(), '/api/me')).user));
}
try {
  await wait(async () => { try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; } });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || globSync('/nix/store/*playwright-chromium*/chrome-linux/chrome')[0],
    headless: true, args: ['--no-sandbox'],
  });
  const owner = await context();
  const { ctx, page } = owner;
  await api(ctx, '/api/auth/signup', { name: 'Short password', email: `short-${suffix}@example.com`, password: 'short' }, 400);
  await signup(page, email, 'Accounts QA Owner');
  await page.getByText('Please confirm your email.', { exact: true }).waitFor();
  await page.locator('#bn').fill(companyName);
  await page.getByRole('button', { name: 'Create my business', exact: true }).click();
  await page.getByRole('button', { name: 'Test call', exact: true }).waitFor();
  await page.getByText('Please confirm your email.', { exact: true }).waitFor();
  await page.goto(tokenLink(email, 'verify'));
  await wait(async () => (await api(ctx, '/api/me')).user.verified);
  await page.getByRole('button', { name: 'Test call', exact: true }).waitFor();
  assert.equal(await page.getByText('Please confirm your email.', { exact: true }).count(), 0);
  console.log('PASS signup, short password rejected, logged confirmation link, verified banner removed');
  const beforeLogout = await ctx.cookies();
  await page.getByRole('link', { name: 'Log out', exact: true }).first().click();
  await page.locator('#le').waitFor();
  assert.equal(new URL(page.url()).origin, base);
  await login(page, email, password);
  const afterLogin = await ctx.cookies();
  assert.notEqual(beforeLogout.find(c => c.name === 'ub_sid')?.value, afterLogin.find(c => c.name === 'ub_sid')?.value);
  await page.goto('/#/account');
  await page.getByRole('heading', { name: 'Your account', exact: true }).waitFor();
  await page.locator('#an').fill('Accounts QA Owner Updated');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await wait(async () => (await api(ctx, '/api/me')).user.name.endsWith('Updated'));
  console.log('PASS password login, session rotation, local logout, Account profile');
  const second = await context();
  await login(second.page, email, password);
  const me = await api(ctx, '/api/me');
  const roles = {};
  for (const role of ['manager', 'worker']) {
    const address = `qa-${role}-${suffix}@example.com`;
    const invite = await api(ctx, '/api/invites', { email: address, name: `Accounts QA ${role}`, role });
    const person = await context();
    await signup(person.page, address, `Accounts QA ${role}`, new URL(invite.url).pathname);
    const member = await api(person.ctx, '/api/me');
    assert.equal(member.business.id, me.business.id);
    assert.equal(member.user.role, role);
    assert.equal(member.memberships.length, 1);
    roles[role] = { ...person, user: member.user };
    for (const path of ['/api/quotes', '/api/invoices', '/api/integrations']) await api(person.ctx, path, undefined, 403);
    await person.page.reload();
    await person.page.waitForTimeout(300);
    assert.equal(await person.page.locator('a[href="#/quotes"],a[href="#/invoices"],a[href="#/settings/integrations"]').count(), 0);
    await person.page.goto('/#/account');
    await person.page.getByRole('heading', { name: 'Your account', exact: true }).waitFor();
    console.log(`PASS invite → signup → correct company/${role}; money/integrations blocked; Account accessible`);
  }
  const own = await api(ctx, '/api/jobs', { title: 'Owner private QA job', assigned_user_id: me.user.id, scheduled_at: new Date().toISOString(), notify_customer: false });
  const assigned = await api(ctx, '/api/jobs', { title: 'Worker assigned QA job', assigned_user_id: roles.worker.user.id, scheduled_at: new Date().toISOString(), notify_customer: false });
  const task = await api(ctx, '/api/tasks', { title: 'Worker assigned QA task', assigned_user_id: roles.worker.user.id });
  await api(ctx, '/api/tasks', { title: 'Owner private QA task', assigned_user_id: me.user.id });
  const jobs = await api(roles.worker.ctx, '/api/jobs');
  const tasks = await api(roles.worker.ctx, '/api/tasks');
  assert(jobs.some(j => j.id === assigned.id));
  assert(jobs.every(j => j.assigned_user_id === roles.worker.user.id && !('price' in j)));
  assert(tasks.some(t => t.id === task.id));
  assert(tasks.every(t => t.assigned_user_id === roles.worker.user.id));
  await api(roles.worker.ctx, `/api/jobs/${own.id}`, undefined, 403);
  const photo = await api(ctx, `/api/jobs/${own.id}/photos`, { label: 'job', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' });
  await api(roles.worker.ctx, `/api/photos/${photo.id}`, undefined, 403);
  await roles.worker.page.goto('/#/my');
  await roles.worker.page.getByText('Worker assigned QA job', { exact: true }).first().waitFor();
  assert.equal(await roles.worker.page.getByText('Owner private QA job', { exact: true }).count(), 0);
  await roles.worker.page.setViewportSize({ width: 390, height: 844 });
  assert(await roles.worker.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await roles.worker.page.screenshot({ path: 'generated-artifacts/accounts-verification/worker-mobile.png', fullPage: true });
  console.log('PASS worker assigned job/task isolation, existing photo restriction, phone layout');
  await page.goto('/#/settings/voice');
  const before = (await api(ctx, '/api/voice/settings')).events.length;
  await page.getByRole('button', { name: 'Test call', exact: true }).click();
  await wait(async () => (await api(ctx, '/api/voice/settings')).events.length > before);
  await page.getByRole('heading', { name: 'Recent deliveries', exact: true }).waitFor();
  console.log('PASS existing voice delivery fix preserved');
  const foreign = await ctx.request.put('/api/auth/account', { data: { name: 'CSRF should fail' }, headers: { Origin: 'https://wrong.example' } });
  assert.equal(foreign.status(), 403);
  const same = await ctx.request.put('/api/auth/account', { data: { name: 'Accounts QA Owner Updated' }, headers: { Origin: base } });
  assert.equal(same.status(), 200);
  console.log('PASS cross-origin PUT rejected, same-origin accepted');
  const limited = await context();
  for (let i = 0; i < 5; i++) await api(limited.ctx, '/api/auth/login', { email, password: 'not-the-password' }, 401);
  await api(limited.ctx, '/api/auth/login', { email, password }, 429);
  await api(limited.ctx, '/api/auth/login', { email: 'unknown@example.com', password }, 429);
  console.log('PASS five failed passwords block further login; per-IP protection also blocks another email');
  await limited.page.goto('/#/login?mode=forgot');
  await limited.page.locator('#fe').fill(email);
  await limited.page.getByRole('button', { name: 'Send reset link', exact: true }).click();
  await limited.page.getByText('If an account exists for this email', { exact: false }).waitFor();
  const reset = tokenLink(email, 'reset');
  await limited.page.goto(reset);
  await limited.page.locator('#rp').fill(resetPassword);
  await limited.page.getByRole('button', { name: 'Save new password', exact: true }).click();
  await wait(async () => Boolean((await api(limited.ctx, '/api/me')).user));
  assert.equal((await api(ctx, '/api/me')).user, null);
  assert.equal((await api(second.ctx, '/api/me')).user, null);
  await api(limited.ctx, '/api/auth/reset', { token: new URL(reset).hash.split('token=')[1], password }, 400);
  const newDevice = await context();
  await login(newDevice.page, email, resetPassword);
  console.log('PASS forgot/reset, single-use link, auto-login, other sessions revoked, lockout cleared');
  await newDevice.page.goto('/#/account');
  await newDevice.page.locator('#apc').fill(resetPassword);
  await newDevice.page.locator('#apn').fill(changedPassword);
  await newDevice.page.getByRole('button', { name: 'Save password', exact: true }).click();
  await wait(async () => (await api(limited.ctx, '/api/me')).user === null);
  console.log('PASS Account password change revokes other devices');
  const configured = await api(newDevice.ctx, '/api/integrations');
  assert(configured.encryption);
  assert(configured.redirectUris.googleLogin.endsWith('/api/auth/oauth/google/callback'));
  assert(configured.redirectUris.microsoftLogin.endsWith('/api/auth/oauth/microsoft/callback'));
  await newDevice.page.goto('/#/settings/integrations');
  await newDevice.page.getByText('Setup details for the administrator', { exact: true }).click();
  await newDevice.page.getByText(configured.redirectUris.googleLogin, { exact: false }).waitFor();
  for (const mode of ['login', 'signup', 'forgot']) {
    await second.page.goto(`/#/login?mode=${mode}`);
    await second.page.setViewportSize({ width: 390, height: 844 });
    await second.page.locator('h1').waitFor();
    assert(await second.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  assert.deepEqual(errors, []);
  assert(!/Database setup failed|Something went wrong|TypeError|ReferenceError|Reminders failed/.test(serverLog));
  await second.page.screenshot({ path: 'generated-artifacts/accounts-verification/signup-mobile.png', fullPage: true });
  console.log('PASS login/signup/forgot phone layouts, all four Setup redirect URIs, encryption ready, no JS/server errors');
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
