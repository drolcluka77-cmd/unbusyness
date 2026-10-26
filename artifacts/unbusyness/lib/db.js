// Database layer. In production (Replit) this uses the `pg` driver with DATABASE_URL.
// For local testing without npm access, set PSQL_SHIM=1 to run queries through the psql CLI.
'use strict';
const fs = require('fs');
const path = require('path');

let impl;

if (process.env.PSQL_SHIM) {
  const { execFileSync } = require('child_process');
  const lit = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'::bytea`;
    if (v instanceof Date) return `'${v.toISOString()}'`;
    if (typeof v === 'object') v = JSON.stringify(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const run = (sql) => execFileSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fixRow = (r) => {
    for (const k of Object.keys(r)) {
      if (typeof r[k] === 'string' && r[k].startsWith('\\x') && /(^|_)(data|logo)$/.test(k)) r[k] = Buffer.from(r[k].slice(2), 'hex');
    }
    return r;
  };
  impl = {
    async query(text, params = []) {
      const sql = text.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]));
      const returns = /^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
      try {
        if (!returns) { run(sql); return { rows: [], rowCount: 0 }; }
        const out = run(`with q as (${sql}) select coalesce(json_agg(q), '[]'::json) from q`).trim();
        const rows = JSON.parse(out || '[]').map(fixRow);
        return { rows, rowCount: rows.length };
      } catch (e) {
        const msg = (e.stderr || e.message || '').toString();
        const err = new Error(msg.trim()); if (/duplicate key/.test(msg)) err.code = '23505';
        throw err;
      }
    },
    async exec(sql) { run(sql); },
  };
} else {
  const { Pool, types } = require('pg');
  types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric -> number
  types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // bigint -> number
  types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD' string, never shifted by time zones
  if (!process.env.DATABASE_URL) {
    console.error('\n  DATABASE_URL is missing. In Replit, open the "Database" tool and create a PostgreSQL database.\n');
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1|@helium|sslmode=disable/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: false },
    max: 10,
  });
  pool.on('error', (e) => console.error('Postgres pool error', e.message));
  impl = {
    query: (text, params) => pool.query(text, params),
    async exec(sql) { await pool.query(sql); },
  };
}

const db = {
  query: (t, p) => impl.query(t, p),
  async one(t, p) { const r = await impl.query(t, p); return r.rows[0] || null; },
  async many(t, p) { const r = await impl.query(t, p); return r.rows; },
  async migrate() {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await impl.exec(sql);
  },
};

module.exports = db;
