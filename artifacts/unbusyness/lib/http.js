// Tiny HTTP toolkit: router, body parsing, cookies, responses. No external packages.
'use strict';
const fs = require('fs');
const path = require('path');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path || '/'}`, 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.secure) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), parts.join('; ')]);
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Upload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const raw = await readBody(req);
  req.rawBody = raw;
  if (!raw.length) return {};
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try { return JSON.parse(raw.toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
  }
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  return {};
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveStatic(root) {
  return (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/' || !path.extname(p)) p = '/index.html';
    const file = path.join(root, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root)) return false;
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': p === '/index.html' ? 'no-cache' : 'public, max-age=300' });
      res.end(data);
      return true;
    } catch { return false; }
  };
}

// Router with :params
function createRouter() {
  const routes = [];
  const add = (method, pattern, ...handlers) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '\\/?$');
    routes.push({ method, re, keys, handlers });
  };
  const router = {
    get: (p, ...h) => add('GET', p, ...h),
    post: (p, ...h) => add('POST', p, ...h),
    put: (p, ...h) => add('PUT', p, ...h),
    del: (p, ...h) => add('DELETE', p, ...h),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = pathname.match(r.re);
        if (m) return { handlers: r.handlers, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      }
      return null;
    },
  };
  return router;
}

module.exports = { HttpError, fail, parseCookies, setCookie, parseBody, json, html, redirect, serveStatic, createRouter };
