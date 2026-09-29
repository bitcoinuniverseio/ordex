import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { startStaticServer, startFakeGateway, configureGateway, launch, openPage } from './harness.mjs';

// OX-S05 (PROPOSED NEW) browser gate for the Event Playground: deterministic example replay
// survives pause, the SSE transport validates, deduplicates and resumes with Last-Event-ID
// against a local deterministic stream, and webhook verification uses nowSeconds.

const vectors = JSON.parse(await readFile(new URL('../../conformance/event-vectors.json', import.meta.url), 'utf8'));
const base = vectors.cases.find((c) => c.kind === 'event' && c.expected.ok).event;
const ev = (n) => ({ ...base, id: `${String(n).padStart(8, '0')}-4b5a-4978-8796-a5b4c3d2e1f0`, sequence: 5000 + n });

let site;
let gateway;
let browser;
const lastEventIds = [];
before(async () => {
  site = await startStaticServer();
  gateway = await startFakeGateway(
    {
      'GET /api/ordex/events/stream': (req, res) => {
        lastEventIds.push(req.headers['last-event-id'] || null);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        const start = req.headers['last-event-id'] ? 3 : 1;
        for (let n = start; n < start + 2; n++) res.write(`id: ${ev(n).id}\ndata: ${JSON.stringify(ev(n))}\n\n`);
        res.write(`id: ${ev(start).id}\ndata: ${JSON.stringify(ev(start))}\n\n`); // duplicate
        res.write('data: {"not":"an event"}\n\n');
        res.end();
      }
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

test('the deterministic example keeps its position across pause', async () => {
  const { page, context, errors } = await openPage(browser, site.url('/build/playground/'));
  await page.getByRole('button', { name: 'Play' }).click();
  await page.getByText(/Played 1 of/).waitFor();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.getByText(/Played 2 of/).waitFor();
  assert.deepEqual(errors, []);
  await context.close();
});

test('SSE events are validated, deduplicated and resumed from the processed cursor', async () => {
  const { page, context } = await openPage(browser, site.url('/build/playground/'));
  await configureGateway(page, gateway.origin);
  await page.getByRole('tab', { name: 'SSE stream' }).click();
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByText(/Accepted 4, duplicates [12]/).waitFor({ timeout: 20000 });
  await page.getByText(/invalid [12]/).first().waitFor();
  assert.equal(lastEventIds[0], null);
  assert.equal(lastEventIds[1], ev(2).id, 'reconnect resumes after the last processed event');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await context.close();
});

test('webhook verification accepts a vector delivery at its nowSeconds and refuses a tampered body', async () => {
  const good = vectors.cases.find((c) => c.kind === 'webhook' && c.expected.ok);
  const { page, context } = await openPage(browser, site.url('/build/playground/'));
  await page.getByRole('tab', { name: 'Webhook signature' }).click();
  await page.getByLabel('Subscription secret').fill(good.signing.secret);
  await page.getByLabel('Raw body, exactly as received').fill(good.signing.body);
  const { signWebhookDelivery } = await import('../../verifier/events.js');
  await page.getByLabel('X-Ordex-Signature header').fill(signWebhookDelivery(good.signing));
  await page.getByLabel('nowSeconds').fill(String(good.verifying.nowSeconds));
  await page.getByRole('button', { name: 'Verify signature' }).click();
  await page.getByText('Signature valid').waitFor();
  await page.getByLabel('Raw body, exactly as received').fill('{"ok":false}');
  await page.getByRole('button', { name: 'Verify signature' }).click();
  await page.getByText('Refused: SIGNATURE_INVALID').waitFor();
  await page.getByLabel('nowSeconds').fill(String(good.verifying.nowSeconds + 100000));
  await page.getByLabel('Raw body, exactly as received').fill(good.signing.body);
  await page.getByRole('button', { name: 'Verify signature' }).click();
  await page.getByText('Refused: TIMESTAMP_OUT_OF_TOLERANCE').waitFor();
  await context.close();
});
