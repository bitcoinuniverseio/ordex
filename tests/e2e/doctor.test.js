import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { startStaticServer, startFakeGateway, configureGateway, launch, openPage } from './harness.mjs';
import { exampleForSchema } from '../../site/src/lib/api/schema.mjs';

// OX-S02 browser gate at /verify: the handoff repro (http://127.0.0.1:1) must fail, a
// compliant loopback gateway must pass, and a wrong-network gateway must fail.

const doc = JSON.parse(await readFile(new URL('../../spec/openapi.json', import.meta.url), 'utf8'));
const S = doc.components.schemas;
const ex = (s) => structuredClone(exampleForSchema(s, doc).value);

function fixture(network) {
  const health = ex(S.HealthReport);
  Object.assign(health, { ok: true, status: 'active', network, storageWritable: true, configurationComplete: true, maxVerificationAgeSeconds: 600 });
  Object.assign(health.listingReadiness, { ready: true, reason: null, lagBlocks: 0, maxLagBlocks: 2, checkedAt: new Date().toISOString() });
  const protocol = Object.assign(ex(S.ProtocolContract), { network, protocolVersion: '1.2.1', version: '1.2.1' });
  return { health, protocol, catalog: [ex(S.ProtocolTemplate)], page: { orders: [], total: 0, limit: 2, nextCursor: '', hasMore: false }, error: ex(S.ErrorResponse) };
}

function routes(f) {
  const send = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  return {
    'GET /api/ordex/health': (req, res) => send(res, 200, { ...f.health, listingReadiness: { ...f.health.listingReadiness, checkedAt: new Date().toISOString() } }),
    'GET /api/ordex/protocol': (req, res) => send(res, 200, f.protocol),
    'GET /api/ordex/catalog': (req, res) => send(res, 200, f.catalog),
    'GET /api/ordex/orders': (req, res, body, url) => (url.searchParams.get('cursor') ? send(res, 400, { ...f.error, statusCode: 400 }) : send(res, 200, f.page))
  };
}

let site;
let signetGw;
let mainnetGw;
let browser;
before(async () => {
  site = await startStaticServer();
  signetGw = await startFakeGateway(routes(fixture('signet')), site.origin);
  mainnetGw = await startFakeGateway(routes(fixture('mainnet')), site.origin);
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await signetGw?.close();
  await mainnetGw?.close();
  await site?.close();
});

test('an unreachable gateway fails every dependent check', async () => {
  const { page, context } = await openPage(browser, site.url('/verify/'));
  await page.getByLabel('Gateway to check').fill('http://127.0.0.1:1');
  await page.getByRole('button', { name: 'Run Gateway Doctor' }).click();
  await page.getByText('The gateway is not compatible').waitFor({ timeout: 30000 });
  assert.equal(await page.getByText('Every check passed').count(), 0);
  await context.close();
});

test('a compliant gateway passes and a wrong-network gateway fails', async () => {
  const { page, context, errors } = await openPage(browser, site.url('/verify/'));
  await configureGateway(page, signetGw.origin, { network: 'signet' });
  await page.locator('#doctor-origin').fill(signetGw.origin);
  await page.getByRole('button', { name: 'Run Gateway Doctor' }).click();
  await page.getByText('Every check passed').waitFor({ timeout: 30000 });
  await page.locator('#doctor-origin').fill(mainnetGw.origin);
  await page.getByRole('button', { name: 'Run Gateway Doctor' }).click();
  await page.getByText('The gateway is not compatible').waitFor({ timeout: 30000 });
  assert.deepEqual(errors.filter((e) => !/requestfailed|Failed to load resource/.test(e)), []);
  await context.close();
});
