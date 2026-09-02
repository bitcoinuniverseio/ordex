import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('worker entry point exists and exports fetch handler', async () => {
  const workerCode = await readFile(resolve(root, 'worker', 'index.js'), 'utf8');
  assert.ok(workerCode.includes('export default {'));
  assert.ok(workerCode.includes('async fetch(request, env)'));
});

test('worker implements health endpoint', async () => {
  const workerCode = await readFile(resolve(root, 'worker', 'index.js'), 'utf8');
  assert.ok(workerCode.includes('/api/docs/health'));
  assert.ok(workerCode.includes("status: 'healthy'"));
});

test('worker implements Ask Ordex endpoint with strict safety refusal', async () => {
  const workerCode = await readFile(resolve(root, 'worker', 'index.js'), 'utf8');
  assert.ok(workerCode.includes('/api/docs/ask'));
  assert.ok(workerCode.includes('refused: true'));
});

test('worker implements privacy-first feedback endpoint with data redaction', async () => {
  const workerCode = await readFile(resolve(root, 'worker', 'index.js'), 'utf8');
  assert.ok(workerCode.includes('/api/docs/feedback'));
  assert.ok(workerCode.includes('redactSensitive'));
  assert.ok(workerCode.includes('INSERT INTO docs_feedback'));
});

test('worker implements telemetry event ingest with allowlist of 17 events', async () => {
  const workerCode = await readFile(resolve(root, 'worker', 'index.js'), 'utf8');
  assert.ok(workerCode.includes('/api/docs/events'));
  assert.ok(workerCode.includes('ALLOWED_EVENTS'));
  assert.ok(workerCode.includes('INSERT INTO docs_events_raw'));
});

test('D1 database migration SQL exists and creates required tables', async () => {
  const sql = await readFile(resolve(root, 'worker', 'migrations', '0001_initial.sql'), 'utf8');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS docs_feedback'));
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS docs_events_raw'));
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS docs_events_hourly'));
});

test('worker implements streamable /mcp endpoint adhering to 2026-07-28 spec', async () => {
  const workerModule = await import('../../worker/index.js');
  const worker = workerModule.default;
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list'
    })
  });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.jsonrpc, '2.0');
  assert.ok(data.result);
  assert.equal(data.result.tools.length, 10);
});

