import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../../worker/index.js';
import { createD1Database, applyMigrations } from '../../worker/node-host.mjs';

// The service's routes answer with behavior, not source strings. Detailed contracts are in
// worker-mcp.test.js (OX-P07) and worker-docs.test.js (OX-P08).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = () => {
  const DB = createD1Database(':memory:');
  applyMigrations(DB, resolve(root, 'worker', 'migrations'));
  return { DB };
};
const post = (path, body, headers = {}) => new Request(`http://svc${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('worker entry point exports a fetch handler', () => {
  assert.equal(typeof worker.fetch, 'function');
});

test('health reports the service, build identity and storage state', async () => {
  const res = await worker.fetch(new Request('http://svc/api/docs/health'), env());
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.service, 'ordex-docs');
  assert.equal(body.storage, 'available');
  const bare = await (await worker.fetch(new Request('http://svc/api/docs/health'), {})).json();
  assert.equal(bare.status, 'degraded');
  assert.equal(bare.storage, 'unavailable');
});

test('ask refuses key material and safety requests', async () => {
  const res = await worker.fetch(post('/api/docs/ask', { query: 'how do I send btc with my private key' }), env());
  const body = await res.json();
  assert.equal(body.refused, true);
  assert.equal(body.code, 'SAFETY');
});

test('feedback stores redacted text and returns a receipt', async () => {
  const e = env();
  const res = await worker.fetch(post('/api/docs/feedback', { submissionId: '6f1c2c1e-3b1a-4c2d-9e8f-0a1b2c3d4e5f', category: 'unclear', route: '/ordex/lab/', comment: 'address bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', protocolVersion: '1.2', buildRevision: 'unknown' }), e);
  assert.equal(res.status, 201);
  const row = e.DB.raw.prepare('SELECT comment_redacted FROM docs_feedback').get();
  assert.doesNotMatch(row.comment_redacted, /bc1q/);
});

test('telemetry accepts only allowlisted, consented events', async () => {
  const res = await worker.fetch(post('/api/docs/events', { eventId: '6f1c2c1e-3b1a-4c2d-9e8f-0a1b2c3d4e50', event: 'not_an_event', consent: 'analytics-v1', route: '/', product: 'other', protocolVersion: '1.2', buildRevision: 'unknown' }), env());
  assert.equal(res.status, 400);
});

test('the D1 migration creates the required tables', async () => {
  const sql = await readFile(resolve(root, 'worker', 'migrations', '0001_initial.sql'), 'utf8');
  for (const t of ['docs_feedback', 'docs_events_raw', 'docs_events_hourly']) assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${t}`));
  const tables = env().DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of ['docs_feedback', 'docs_events_raw', 'docs_events_hourly', '_ordex_migrations']) assert.ok(tables.includes(t), t);
});

test('the /mcp endpoint lists ten tools for a conformant 2026-07-28 request', async () => {
  const res = await worker.fetch(
    post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list', accept: 'application/json, text/event-stream' }),
    {}
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.result.resultType, 'complete');
  assert.equal(data.result.tools.length, 10);
});
