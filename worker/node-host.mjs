#!/usr/bin/env node
// Self-hosted runtime for the Ordex docs service (integration owner decision, 2026-09-29):
// serves the standard fetch handler (worker/index.js, bundled to dist/server/index.js)
// over node:http with a D1-compatible binding on node:sqlite (Node 24 built-in). Migrations in
// worker/migrations apply at startup through a ledger that refuses a changed applied file.
// Binds to loopback unless told otherwise; TLS terminates in front of it.
//
// Environment:
//   ORDEX_DOCS_HOST            bind address (default 127.0.0.1)
//   ORDEX_DOCS_PORT            port (default 8787; 0 picks a free port)
//   ORDEX_DOCS_DB              SQLite file (default ./data/ordex-docs.sqlite)
//   ORDEX_ALLOWED_ORIGINS      comma-separated browser origins (default: the Pages origin and localhost:4321)
//   ORDEX_BUILD_REVISION       source revision (default: build-info.json next to the service bundle)
//   ORDEX_SITE_BASE            base path for citation links (default /ordex)
// Routes: GET /health plus everything the handler serves (/api/docs/*, /mcp).

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_DRAIN_BYTES = 16 * 1024 * 1024;

class D1PreparedStatement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...values) {
    return new D1PreparedStatement(this.db, this.sql, values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v)));
  }
  #stmt() {
    return this.db.prepare(this.sql);
  }
  async run() {
    const info = this.#stmt().run(...this.params);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) }, results: [] };
  }
  async all() {
    return { success: true, meta: {}, results: this.#stmt().all(...this.params) };
  }
  async first(column) {
    const row = this.#stmt().get(...this.params);
    if (row === undefined) return null;
    return column ? row[column] ?? null : row;
  }
  async raw() {
    return this.#stmt().all(...this.params).map((r) => Object.values(r));
  }
  runSync() {
    const info = this.#stmt().run(...this.params);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) }, results: [] };
  }
}

/** A D1-compatible database on node:sqlite. batch() is atomic, as in D1. */
export function createD1Database(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return {
    prepare: (sql) => new D1PreparedStatement(db, sql),
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((s) => s.runSync());
        db.exec('COMMIT');
        return results;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    close: () => db.close(),
    raw: db
  };
}

/**
 * Apply every migration in `dir` once, in name order, recording name and SHA-256 in a ledger.
 * An applied migration whose file changed stops startup instead of being reapplied.
 */
export function applyMigrations(d1, dir) {
  const db = d1.raw;
  db.exec('CREATE TABLE IF NOT EXISTS _ordex_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = new Map(db.prepare('SELECT name, sha256 FROM _ordex_migrations').all().map((r) => [r.name, r.sha256]));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const ran = [];
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    const digest = createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== digest) throw new Error(`Migration ${file} changed after it was applied (ledger ${applied.get(file)}, file ${digest})`);
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO _ordex_migrations (name, sha256, applied_at) VALUES (?, ?, ?)').run(file, digest, Math.floor(Date.now() / 1000));
      db.exec('COMMIT');
      ran.push(file);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }
  return ran;
}

/** The request body, or null once it passes MAX_REQUEST_BYTES (the excess is drained, bounded). */
function readRequestBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (over) {
        if (size > MAX_DRAIN_BYTES) req.destroy();
        return;
      }
      if (size > MAX_REQUEST_BYTES) {
        over = true;
        chunks.length = 0;
        resolveBody(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolveBody(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!over) reject(err);
    });
  });
}

function toRequest(req, host, body) {
  const url = new URL(req.url, `http://${req.headers.host || host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return new Request(url, { method: req.method, headers, body: hasBody ? body : undefined });
}

/**
 * Start the host. Returns { server, port, url, close }.
 * handler: an object with fetch(request, env); env values come from options.
 */
export async function startNodeHost({ handler, host = '127.0.0.1', port = 8787, dbPath = './data/ordex-docs.sqlite', migrationsDir = join(HERE, 'migrations'), allowedOrigins, revision = 'unknown', siteBase = '/ordex', log = (m) => process.stderr.write(`${m}\n`) }) {
  const db = createD1Database(dbPath);
  let ran;
  try {
    ran = applyMigrations(db, migrationsDir);
  } catch (err) {
    db.close();
    throw err;
  }
  if (ran.length) log(`applied migrations: ${ran.join(', ')}`);
  const env = { DB: db, ORDEX_BUILD_REVISION: revision, ORDEX_SITE_BASE: siteBase, ...(allowedOrigins ? { ORDEX_ALLOWED_ORIGINS: allowedOrigins } : {}) };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        let storage = 'available';
        try {
          db.raw.prepare('SELECT 1').get();
        } catch {
          storage = 'failing';
        }
        res.writeHead(storage === 'available' ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ status: storage === 'available' ? 'ok' : 'degraded', service: 'ordex-docs', revision, storage, time: new Date().toISOString() }));
        return;
      }
      const body = await readRequestBody(req);
      if (body === null) {
        // The rest of the upload is discarded (bounded) so the client reads the 413
        // instead of a reset connection.
        res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, code: 'BODY_TOO_LARGE' }));
        return;
      }
      const response = await handler.fetch(toRequest(req, `${host}:${port}`, body), env);
      const headers = {};
      response.headers.forEach((v, k) => {
        headers[k] = v;
      });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      log(`request failed: ${err?.message || err}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'INTERNAL_ERROR' }));
    }
  });
  await new Promise((r, reject) => {
    server.once('error', (err) => {
      db.close();
      reject(err);
    });
    server.listen(port, host, r);
  });
  const actual = server.address().port;
  let closing = null;
  const close = () =>
    (closing ??= new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => {
        db.close();
        r();
      });
    }));
  return { server, port: actual, url: `http://${host.includes(':') ? `[${host}]` : host}:${actual}`, close, db };
}

async function main() {
  const serviceCandidates = [join(HERE, 'index.js'), resolve(HERE, '../dist/server/index.js')].filter((p) => p !== fileURLToPath(import.meta.url));
  const servicePath = serviceCandidates.find((p) => existsSync(p));
  if (!servicePath) {
    process.stderr.write('The docs service bundle is missing. Run npm run build first.\n');
    process.exit(1);
  }
  const infoPath = join(dirname(servicePath), 'build-info.json');
  const info = existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, 'utf8')) : {};
  const handler = (await import(pathToFileURL(servicePath).href)).default;
  const host = await startNodeHost({
    handler,
    host: process.env.ORDEX_DOCS_HOST || '127.0.0.1',
    port: Number(process.env.ORDEX_DOCS_PORT ?? 8787),
    dbPath: process.env.ORDEX_DOCS_DB || './data/ordex-docs.sqlite',
    migrationsDir: existsSync(join(dirname(servicePath), 'migrations')) ? join(dirname(servicePath), 'migrations') : join(HERE, 'migrations'),
    allowedOrigins: process.env.ORDEX_ALLOWED_ORIGINS,
    revision: process.env.ORDEX_BUILD_REVISION || info.revision || 'unknown',
    siteBase: process.env.ORDEX_SITE_BASE ?? '/ordex'
  });
  process.stderr.write(`ordex-docs listening on ${host.url} (revision ${process.env.ORDEX_BUILD_REVISION || info.revision || 'unknown'})\n`);
  const shutdown = async (signal) => {
    process.stderr.write(`${signal}: closing\n`);
    await host.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`ordex-docs failed to start: ${err.message}\n`);
    process.exit(1);
  });
}
