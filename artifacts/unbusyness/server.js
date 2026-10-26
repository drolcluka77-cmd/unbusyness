// Unbusyness Business MVP — entry point.
'use strict';
const http = require('http');
const path = require('path');
const db = require('./lib/db');
const { createRouter, parseBody, json, serveStatic, HttpError } = require('./lib/http');
const auth = require('./lib/auth');
const api = require('./lib/api');
const voice = require('./lib/voice');
const integrations = require('./lib/integrations');
const accounts = require('./lib/accounts');

const PORT = Number(process.env.PORT || 3000);
const router = createRouter();
auth.routes(router);
api.routes(router);
voice.routes(router, api);
integrations.routes(router);
accounts.routes(router);
const statics = serveStatic(path.join(__dirname, 'public'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (!accounts.originAllowed(req, url.pathname)) return json(res, 403, { error: 'Request blocked (wrong origin)' });
    const m = router.match(req.method, url.pathname);
    if (!m) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && statics(req, res)) return;
      return json(res, 404, { error: 'Not found' });
    }
    await auth.loadSession(req, res);
    const ctx = { params: m.params, query: url.searchParams, body: await parseBody(req) };
    let out;
    for (const h of m.handlers) { out = await h(req, res, ctx); if (res.headersSent) return; }
    if (!res.headersSent) json(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    if (res.headersSent) return;
    if (e instanceof HttpError) return json(res, e.status, { error: e.message });
    console.error(req.method, url.pathname, e);
    json(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});

(async () => {
  try {
    // Managed production schemas are applied by Publish, not by the web process.
    if (process.env.NODE_ENV !== 'production') await db.migrate();
  } catch (e) {
    console.error('Database setup failed:', e.message);
    process.exit(1);
  }
  server.listen(PORT, '0.0.0.0', () => console.log(`Unbusyness is running on port ${PORT}${auth.DEV_LOGIN ? ' (dev login enabled)' : ''}`));
  const tick = () => api.runReminders().catch((e) => console.error('Reminders failed:', e.message));
  setTimeout(tick, 30e3);
  setInterval(tick, 15 * 60e3);
})();
