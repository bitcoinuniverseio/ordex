import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runGatewayDoctor, reportDigest, nonDecimalAmounts, CHECKS } from '../../site/src/lib/doctor/gateway-doctor.mjs';
import { exampleForSchema } from '../../site/src/lib/api/schema.mjs';
import { stableJson } from '../../site/src/lib/lab-report.mjs';

// OX-S02 (PROPOSED NEW): the Doctor against deterministic gateway doubles. Only a compliant
// gateway passes; unreachable, malformed, stale, wrong-network and cancelled runs never do.

const doc = JSON.parse(await readFile(new URL('../../spec/openapi.json', import.meta.url), 'utf8'));
const operations = JSON.parse(await readFile(new URL('../../site/src/data/operations.json', import.meta.url), 'utf8'));
const S = doc.components.schemas;
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const example = (schema) => {
  const r = exampleForSchema(schema, doc);
  assert.ok(r.ok, r.reason);
  return structuredClone(r.value);
};

function compliant(network = 'signet') {
  const health = example(S.HealthReport);
  Object.assign(health, { ok: true, status: 'active', network, storageWritable: true, configurationComplete: true, maxVerificationAgeSeconds: 120 });
  Object.assign(health.listingReadiness, { ready: true, reason: null, lagBlocks: 0, maxLagBlocks: 2, coreHeight: 100, ordHeight: 100, checkedAt: new Date(NOW - 30000).toISOString() });
  const protocol = example(S.ProtocolContract);
  Object.assign(protocol, { network, protocolVersion: '1.2.1', version: '1.2.1' });
  const catalog = [example(S.ProtocolTemplate)];
  const error = example(S.ErrorResponse);
  return { health, protocol, catalog, page: { orders: [], total: 0, limit: 2, nextCursor: '', hasMore: false }, error };
}

function gateway(fixture, overrides = {}) {
  const calls = [];
  const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}${u.search}`);
    const key = `${init.method} ${u.pathname}`;
    if (overrides[key]) return overrides[key](u, init);
    if (key === 'GET /api/ordex/health') return json(200, fixture.health);
    if (key === 'GET /api/ordex/protocol') return json(200, fixture.protocol);
    if (key === 'GET /api/ordex/catalog') return json(200, fixture.catalog);
    if (key === 'GET /api/ordex/orders') return u.searchParams.get('cursor') ? json(400, { ...fixture.error, statusCode: 400 }) : json(200, fixture.page);
    if (key.startsWith('GET /api/ordex/orders/')) return json(404, { ...fixture.error, statusCode: 404 });
    return json(404, fixture.error);
  };
  return { fetchImpl, calls };
}

const run = (fetchImpl, extra = {}) =>
  runGatewayDoctor({ doc, operations, origin: 'https://gw.example', network: 'signet', protocolVersion: '1.2', sourceBuild: 'abcdef1', fetchImpl, now: () => NOW, inBrowser: false, ...extra });

const byId = (report) => Object.fromEntries(report.checks.map((c) => [c.id, c.status]));

test('a compliant gateway passes every check and the digest is a real SHA-256 of the report', async () => {
  const r = await run(gateway(compliant()).fetchImpl);
  const s = byId(r);
  for (const c of CHECKS) if (c.id !== 'cors') assert.equal(s[c.id], 'passed', `${c.id}: ${r.checks.find((x) => x.id === c.id).details}`);
  assert.equal(s.cors, 'not-run');
  assert.equal(r.success, true);
  const { digest, ...rest } = r;
  assert.equal(digest, createHash('sha256').update(stableJson(rest)).digest('hex'));
  assert.equal(reportDigest(r), digest);
});

test('an unreachable gateway fails and nothing else passes (the http://127.0.0.1:1 repro)', async () => {
  const r = await run(async () => {
    throw new TypeError('fetch failed');
  });
  const s = byId(r);
  assert.equal(s.reach, 'failed');
  assert.equal(r.passed, 0);
  assert.equal(r.success, false);
  for (const c of CHECKS.filter((c) => c.id !== 'reach')) assert.equal(s[c.id], 'blocked', c.id);
});

test('a malformed 200 health body fails its schema check and blocks readiness', async () => {
  const g = gateway(compliant(), { 'GET /api/ordex/health': () => new Response('{"status":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } }) });
  const s = byId(await run(g.fetchImpl));
  assert.equal(s.reach, 'passed');
  assert.equal(s['health-schema'], 'failed');
  assert.equal(s['health-ready'], 'blocked');
  assert.equal(s.network, 'blocked');
});

test('stale readiness and a lagging index fail the readiness check', async () => {
  const f = compliant();
  f.health.listingReadiness.checkedAt = new Date(NOW - 3600 * 1000).toISOString();
  f.health.listingReadiness.lagBlocks = 9;
  const r = await run(gateway(f).fetchImpl);
  const ready = r.checks.find((c) => c.id === 'health-ready');
  assert.equal(ready.status, 'failed');
  assert.match(ready.details, /lags Core by 9 blocks/);
  assert.match(ready.details, /3600 s old/);
});

test('a gateway on another network or protocol fails', async () => {
  const s = byId(await run(gateway(compliant('mainnet')).fetchImpl));
  assert.equal(s.network, 'failed');
  const f = compliant();
  f.protocol.protocolVersion = '1.1.0';
  f.protocol.version = '1.1.0';
  assert.equal(byId(await run(gateway(f).fetchImpl)).protocol, 'failed');
});

test('a page answered for a malformed cursor, a 200 for a missing order and numeric amounts all fail', async () => {
  const f = compliant();
  const g = gateway(f, {
    'GET /api/ordex/orders': (u) => new Response(JSON.stringify(f.page), { status: 200, headers: { 'content-type': 'application/json' } }),
    'GET /api/ordex/orders/x': () => null
  });
  const s = byId(await run(g.fetchImpl));
  assert.equal(s['malformed-cursor'], 'failed');
  assert.deepEqual(nonDecimalAmounts({ a: { priceSats: 100 }, b: [{ feeSats: '1' }, { valueSats: '01' }] }), ['$.a.priceSats', '$.b[1].valueSats']);
  // A list of amounts (OrderSummary.inspection.outputValuesSats) is checked item by item.
  assert.deepEqual(nonDecimalAmounts({ inspection: { outputValuesSats: ['45000', '330'] } }), []);
  assert.deepEqual(nonDecimalAmounts({ inspection: { outputValuesSats: ['45000', 330] } }), ['$.inspection.outputValuesSats[1]']);
});

test('inconsistent paging is caught', async () => {
  const f = compliant();
  f.page.hasMore = true;
  assert.equal(byId(await run(gateway(f).fetchImpl)).paging, 'failed');
});

test('a cancelled run marks the remaining checks cancelled and does not pass', async () => {
  const c = new AbortController();
  const g = gateway(compliant(), {
    'GET /api/ordex/protocol': (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  });
  const pending = run(g.fetchImpl, { signal: c.signal });
  setTimeout(() => c.abort(), 20);
  const r = await pending;
  assert.equal(r.success, false);
  assert.ok(r.cancelled > 0 || r.checks.some((x) => x.status === 'failed'));
  assert.equal(r.checks.find((x) => x.id === 'catalog').status, 'cancelled');
});
