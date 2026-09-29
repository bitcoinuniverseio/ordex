import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { startStaticServer, startFakeGateway, configureGateway, launch, openPage } from './harness.mjs';

// OX-S05 browser gate for /build/playground against a deterministic local gateway (loopback
// only, never a production service): read mode refuses mutations, a schema-invalid 200 is
// not a pass, unreachable gateways fail, and cancellation shows no stale result.

const operations = JSON.parse(await readFile(new URL('../../site/src/data/operations.json', import.meta.url), 'utf8'));
const health = operations.find((o) => o.operationId === 'getHealth');

let site;
let gateway;
let browser;
before(async () => {
  site = await startStaticServer();
  gateway = await startFakeGateway(
    {
      'GET /api/ordex/health': (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(health.responseExample)),
      'GET /api/ordex/protocol': (req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"unexpected":true}'),
      'GET /api/ordex/catalog': (req, res) => setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('[]'), 5000)
    },
    site.origin
  );
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await gateway?.close();
  await site?.close();
});

test('every operation deep link renders its request form without errors', async () => {
  const { page, context, errors } = await openPage(browser, site.url('/build/playground/'));
  for (const op of operations) {
    await page.goto(site.url(`/build/playground/?operation=${op.operationId}`), { waitUntil: 'networkidle' });
    await page.getByText(op.path, { exact: true }).first().waitFor();
  }
  assert.deepEqual(errors, []);
  await context.close();
});

test('a schema-valid response passes, a schema-invalid 200 does not, and HTTP is reported separately', async () => {
  const { page, context } = await openPage(browser, site.url('/build/playground/?operation=getHealth'));
  await configureGateway(page, gateway.origin);
  await page.getByRole('button', { name: 'Send to gateway' }).click();
  await page.getByText('the body matches the documented schema').waitFor();
  await page.goto(site.url('/build/playground/?operation=getProtocol'), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Send to gateway' }).click();
  await page.getByText(/does not match/).waitFor();
  await page.getByText(/HTTP:.*200/).waitFor();
  await context.close();
});

test('read-only mode refuses a mutation without sending it', async () => {
  const { page, context } = await openPage(browser, site.url('/build/playground/?operation=publishAsk'));
  await configureGateway(page, gateway.origin, { mode: 'read-only' });
  const before = gateway.requests.length;
  await page.getByText(/Read-only mode never sends/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send to gateway' }).isDisabled(), true);
  assert.equal(gateway.requests.filter((r) => r.startsWith('POST')).length, 0);
  assert.equal(gateway.requests.length, before);
  await context.close();
});

test('an unreachable gateway fails and a cancelled request shows no stale result', async () => {
  const { page, context } = await openPage(browser, site.url('/build/playground/?operation=getHealth'));
  await configureGateway(page, 'http://127.0.0.1:1');
  await page.getByRole('button', { name: 'Send to gateway' }).click();
  await page.getByRole('alert').getByText(/NETWORK_ERROR/).waitFor();
  await page.goto(site.url('/build/playground/?operation=getCatalog'), { waitUntil: 'networkidle' });
  await configureGateway(page, gateway.origin);
  await page.getByRole('button', { name: 'Send to gateway' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByText(/CANCELLED/).waitFor();
  await page.waitForTimeout(5500);
  assert.equal(await page.getByText('Contract check:').count(), 0, 'the late response was suppressed');
  await context.close();
});
