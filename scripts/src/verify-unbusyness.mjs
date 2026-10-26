import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { globSync } from 'node:fs';

const base = 'http://localhost:80';
const executablePath = process.env.CHROMIUM_PATH || globSync('/nix/store/*playwright-chromium*/chrome-linux/chrome')[0];
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
const context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(12000);
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
const api = async (path, data, ctx = context, expected = 200, method) => {
  const res = await ctx.request.fetch(path, { method: method || (data === undefined ? 'GET' : 'POST'), data });
  assert.equal(res.status(), expected, `${path}: ${await res.text()}`);
  return res.headers()['content-type']?.includes('json') ? res.json() : res.text();
};
const wait = async (test) => {
  for (let n = 0; n < 40; n++) { if (await test()) return; await page.waitForTimeout(150); }
  throw new Error('State did not settle');
};
await fs.mkdir('generated-artifacts/verification', { recursive: true });
try {
  assert.deepEqual(await api('/healthz'), { ok: true });
  await page.goto('/');
  await page.getByText('Demo login (development only)', { exact: true }).click();
  await page.locator('#dn').fill('QA Owner');
  await page.locator('#de').fill(`qa-owner-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.locator('#bn').fill(`QA Plumbing ${Date.now()}`);
  await page.getByRole('button', { name: 'Create my business' }).click();
  await page.getByRole('button', { name: 'Test call', exact: true }).click();
  await page.waitForURL(/#\/calls\/\d+/);
  console.log('PASS demo login, company, Today Test call');
  await page.getByRole('button', { name: /quote/i }).first().click();
  await page.waitForURL(/#\/quotes\/\d+/);
  const quoteId = Number(page.url().split('/').pop());
  await page.getByRole('button', { name: 'Approve and send', exact: true }).click();
  await wait(async () => (await api(`/api/quotes/${quoteId}`)).quote.status === 'sent');
  const quote = await api(`/api/quotes/${quoteId}`);
  const customerContext = await browser.newContext({ baseURL: base });
  const customerPage = await customerContext.newPage();
  await customerPage.goto(new URL(quote.url).pathname);
  await customerPage.getByRole('button', { name: /Accept quote/ }).click();
  await customerPage.getByText('You accepted this quote.', { exact: false }).waitFor();
  await customerContext.close();
  console.log('PASS quote send and public customer acceptance');
  await page.reload();
  await page.getByRole('button', { name: 'Book the job', exact: true }).click();
  const when = new Date(Date.now() + 3600000).toISOString().slice(0, 16);
  await page.locator('#jw').fill(when);
  await page.locator('#jnotify').uncheck();
  await page.locator('#layer button[type=submit], #layer form button.primary').last().click();
  await page.waitForURL(/#\/jobs\/\d+/);
  const jobId = Number(page.url().split('/').pop());
  await page.getByRole('button', { name: "I'm on my way", exact: true }).click();
  await page.getByRole('button', { name: 'Start job', exact: true }).click();
  await page.getByRole('button', { name: 'Finish job', exact: true }).click();
  await wait(async () => Boolean((await api(`/api/jobs/${jobId}`)).invoice));
  const job = await api(`/api/jobs/${jobId}`);
  assert.equal(job.invoice.status, 'draft');
  console.log('PASS booking, on the way, start, finish, invoice draft');
  const image = await page.screenshot({ clip: { x: 0, y: 0, width: 100, height: 100 } });
  for (const label of ['job', 'invoice']) {
    await page.getByRole('button', { name: 'Add photo', exact: true }).click();
    await page.getByRole('button', { name: label === 'job' ? /Job photo/ : /Invoice.*Supplier/ }).click();
    await page.locator('#phIn').setInputFiles({ name: `${label}.png`, mimeType: 'image/png', buffer: image });
    await page.getByRole('dialog', { name: 'Job details', exact: true }).waitFor();
  }
  await page.getByAltText('Job photo', { exact: true }).waitFor();
  await page.getByAltText('Supplier invoice', { exact: true }).waitFor();
  assert.equal((await api(`/api/jobs/${jobId}`)).photos.length, 2);
  await page.goto(`/#/invoices/${job.invoice.id}`);
  await page.getByRole('button', { name: 'Send invoice', exact: true }).click();
  await page.getByRole('button', { name: 'Record payment', exact: true }).click();
  await page.getByRole('button', { name: /Mark as paid/ }).click();
  await wait(async () => (await api(`/api/invoices/${job.invoice.id}`)).invoice.status === 'paid');
  console.log('PASS both photo labels, invoice send and payment recorded');

  const me = await api('/api/me');
  const identities = {};
  for (const role of ['manager', 'worker']) {
    const invite = await api('/api/invites', { name: `QA ${role}`, role });
    const ctx = await browser.newContext({ baseURL: base, viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    await p.goto(new URL(invite.url).pathname);
    await p.getByText('Demo login (development only)', { exact: true }).click();
    await p.locator('#dn').fill(`QA ${role}`);
    await p.locator('#de').fill(`qa-${role}-${Date.now()}@example.com`);
    await p.getByRole('button', { name: 'Continue', exact: true }).click();
    await wait(async () => (await api('/api/me', undefined, ctx)).user?.role === role);
    const roleMe = await api('/api/me', undefined, ctx);
    assert.equal(roleMe.business.id, me.business.id);
    identities[role] = { ctx, p, user: roleMe.user };
    for (const route of ['/api/quotes', '/api/invoices', '/api/integrations']) await api(route, undefined, ctx, 403);
    await p.reload();
    await p.waitForTimeout(500);
    assert.equal(await p.locator('a[href="#/quotes"],a[href="#/invoices"],a[href="#/settings/integrations"]').count(), 0);
    console.log(`PASS ${role} invite login and forbidden money/integration routes`);
  }
  const worker = identities.worker;
  const ownJob = await api('/api/jobs', { title: 'Worker assigned QA job', assigned_user_id: worker.user.id, scheduled_at: new Date().toISOString(), notify_customer: false });
  const ownTask = await api('/api/tasks', { title: 'Worker assigned QA task', assigned_user_id: worker.user.id });
  await api('/api/tasks', { title: 'Private owner task', assigned_user_id: me.user.id });
  const wJobs = await api('/api/jobs', undefined, worker.ctx);
  const wTasks = await api('/api/tasks', undefined, worker.ctx);
  assert(wJobs.some(j => j.id === ownJob.id));
  assert(wJobs.every(j => j.assigned_user_id === worker.user.id && !('price' in j)));
  assert(wTasks.some(t => t.id === ownTask.id));
  assert(wTasks.every(t => t.assigned_user_id === worker.user.id));
  await api(`/api/jobs/${jobId}`, undefined, worker.ctx, 403);
  await api(`/api/photos/${(await api(`/api/jobs/${jobId}`)).photos[0].id}`, undefined, worker.ctx, 403);
  await worker.p.reload();
  await worker.p.getByText('Worker assigned QA job', { exact: true }).first().waitFor();
  await worker.p.screenshot({ path: 'generated-artifacts/verification/worker-mobile.png', fullPage: true });
  console.log('PASS worker assignment isolation including job photos');
  await page.goto('/#/settings/voice');
  const before = (await api('/api/voice/settings')).events.length;
  await page.getByRole('button', { name: 'Test call', exact: true }).click();
  await wait(async () => (await api('/api/voice/settings')).events.length > before);
  await page.getByRole('heading', { name: 'Recent deliveries', exact: true }).waitFor();
  assert(await page.getByText('OK', { exact: true }).count() > 0);
  console.log('PASS Voice agent Test call appears in Recent deliveries');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['today', 'quotes', 'jobs', 'invoices', 'settings/integrations']) {
    await page.goto(`/#/${route}`);
    await page.waitForTimeout(400);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Mobile overflow on ${route}`);
  }
  await page.screenshot({ path: 'generated-artifacts/verification/owner-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS phone layouts and no browser console/page errors');
  console.log(JSON.stringify({ businessId: me.business.id, quoteId, jobId, invoiceId: job.invoice.id, workerId: worker.user.id, managerId: identities.manager.user.id, redirectUris: (await api('/api/integrations')).redirectUris }, null, 2));
} catch (e) {
  console.error('FAIL', e);
  console.error('URL', page.url());
  console.error('BODY', (await page.locator('body').innerText()).slice(0, 8000));
  console.error('CONSOLE', errors);
  await page.screenshot({ path: 'generated-artifacts/verification/failure.png', fullPage: true });
  process.exitCode = 1;
} finally {
  await browser.close();
}
