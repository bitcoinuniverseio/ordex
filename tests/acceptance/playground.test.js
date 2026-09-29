import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { startStaticServer, configureGateway, launch, openPage } from '../e2e/harness.mjs';
import { validateSchema } from '../../site/src/lib/api/schema.mjs';
import { contractOperation, effectOf } from '../../site/src/lib/api/request-plan.mjs';
import { signWebhookDelivery, verifyWebhookSignature } from '../../verifier/events.js';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for the API Playground (OX-S-C700..C890) and the Event Playground
// (OX-S-C880..C889). Offline contract examples are shown for every operation and checked here
// against the schema of their documented status; read-only mode is shown to refuse every
// operation with an effect without a request reaching the gateway; the SSE and WebSocket
// transports run against a local stream serving the conformance event vectors.

const operations = JSON.parse(await readFile(new URL('../../site/src/data/operations.json', import.meta.url), 'utf8'));
const openapi = JSON.parse(await readFile(new URL('../../spec/openapi.json', import.meta.url), 'utf8'));
const vectors = JSON.parse(await readFile(new URL('../../conformance/event-vectors.json', import.meta.url), 'utf8'));
const api = rowsOf('API Playground');
const events = rowsOf('Event Playground');
const rec = rowRecorder('tests/acceptance/playground.test.js');

const NO_GATEWAY =
  'Pending release deployment: a connected request needs an Ordex gateway that serves the documentation origin. The Signet acceptance gateway (Core, 127.0.0.1:3043) answers CORS only for the Core frontend origins, and the documentation site is not deployed yet.';

// A local event source serving the conformance event envelopes over SSE and WebSocket.
const base = vectors.cases.find((c) => c.kind === 'event' && c.expected.ok).event;
const ev = (n) => ({ ...base, id: `${String(n).padStart(8, '0')}-4b5a-4978-8796-a5b4c3d2e1f0`, sequence: 5000 + n });
const seen = { sse: [], ws: [] };
let expireCursor = null;

function wsAccept(key) {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}
function wsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([head, payload]);
}
function wsRead(buf) {
  const len = buf[1] & 127;
  let off = 2;
  let n = len;
  if (len === 126) {
    n = buf.readUInt16BE(2);
    off = 4;
  }
  const mask = buf.subarray(off, off + 4);
  const data = buf.subarray(off + 4, off + 4 + n).map((b, i) => b ^ mask[i % 4]);
  return Buffer.from(data).toString('utf8');
}

let site;
let stream;
let browser;
before(async () => {
  site = await startStaticServer();
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('access-control-allow-origin', site.origin);
    res.setHeader('access-control-allow-headers', 'content-type, accept, last-event-id');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/ordex/events/stream') {
      const last = req.headers['last-event-id'] || null;
      seen.sse.push(last);
      if (expireCursor && last === expireCursor) return res.writeHead(410, { 'content-type': 'application/json' }).end('{"statusCode":410,"error":"Gone","message":"cursor expired","requestId":"r"}');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const start = last ? Number(last.slice(0, 8)) + 1 : 1;
      for (let n = start; n < start + 2; n++) res.write(`id: ${ev(n).id}\ndata: ${JSON.stringify(ev(n))}\n\n`);
      res.write(`id: ${ev(start).id}\ndata: ${JSON.stringify(ev(start))}\n\n`); // duplicate
      const older = { ...ev(start + 2), sequence: 4000 }; // out of order
      res.write(`id: ${older.id}\ndata: ${JSON.stringify(older)}\n\n`);
      res.write('data: {"not":"an event"}\n\n');
      return res.end();
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"statusCode":404,"error":"Not Found","message":"no route","requestId":"r"}');
  });
  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/api/ordex/events/ws')) return socket.destroy();
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`);
    socket.once('data', (buf) => {
      const sub = JSON.parse(wsRead(buf));
      seen.ws.push(sub);
      const start = sub.cursor ? Number(sub.cursor.slice(0, 8)) + 1 : 11;
      for (let n = start; n < start + 3; n++) socket.write(wsFrame(JSON.stringify(ev(n))));
      socket.write(wsFrame(JSON.stringify(ev(start))));
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  stream = { origin: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await stream?.close();
  await site?.close();
});

const successSchema = (op) => {
  const raw = contractOperation(openapi, op);
  const content = raw?.responses?.[op.successStatus]?.content?.['application/json'];
  return content?.schema || null;
};

test('API Playground rows: offline contract examples, read-only refusal, connected requests', { timeout: 900000 }, async () => {
  const { page, context, errors } = await openPage(browser, site.url('/build/playground/'));
  for (const row of api.filter((r) => r.operation.includes(': connected '))) {
    rec.record(row.id, 'BLOCKED', row.operation, NO_GATEWAY);
  }
  for (const row of api.filter((r) => r.operation.endsWith(': offline example and schema verdict'))) {
    const id = row.operation.split(':')[0];
    const op = operations.find((o) => o.operationId === id);
    await page.goto(site.url(`/build/playground/?operation=${id}`), { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Contract example' }).click();
    const panel = page.locator('.panel[aria-live="polite"]');
    const text = await panel.innerText();
    const schema = successSchema(op);
    if (!schema) {
      if (text.includes('No example is available') && op.responseExampleIssue) {
        rec.record(row.id, 'NOT APPLICABLE', row.operation, `${id} answers ${op.successStatus} without a JSON body (${op.responseExampleIssue}); the playground says no example is available and shows no schema verdict. Its event envelopes are covered by the Event Playground rows.`, { shown: 'No example is available' });
      } else {
        await rec.check(row.id, row.operation, async () => expect(false, `no JSON schema and the page shows: ${text.slice(0, 200)}`));
      }
      continue;
    }
    await rec.check(row.id, row.operation, async () => {
      expect(text.includes(`Contract example for the ${op.successStatus} response. It validates against the schema; no request was sent.`), 'example label missing');
      const shown = JSON.parse(await panel.locator('pre code').first().innerText());
      expect(JSON.stringify(shown) === JSON.stringify(op.responseExample), 'shown example differs from the published one');
      const errs = validateSchema(shown, schema, openapi);
      expect(errs.length === 0, `example does not validate: ${JSON.stringify(errs.slice(0, 3))}`);
      return { status: op.successStatus, schemaErrors: 0, sha256: createHash('sha256').update(JSON.stringify(shown)).digest('hex') };
    });
  }

  const readOnly = api.find((r) => r.operation.startsWith('Read-only mode refuses'));
  await rec.check(readOnly.id, readOnly.operation, async () => {
    const effects = operations.filter((o) => effectOf(o, contractOperation(openapi, o) || {}) !== 'read');
    await page.goto(site.url('/build/playground/?operation=getHealth'), { waitUntil: 'networkidle' });
    await configureGateway(page, stream.origin, { network: 'signet', mode: 'read-only' });
    const before = stream.requests.length;
    const checked = [];
    for (const op of effects) {
      await page.goto(site.url(`/build/playground/?operation=${op.operationId}`), { waitUntil: 'networkidle' });
      const send = page.getByRole('button', { name: 'Send to gateway' });
      expect(await send.isDisabled(), `${op.operationId}: Send is enabled in read-only mode`);
      const status = await page.locator('p[role="status"]').allInnerTexts();
      expect(status.some((s) => /Read-only mode never sends|Operator routes need operator credentials/.test(s)), `${op.operationId}: no refusal shown (${status.join(' | ')})`);
      checked.push(op.operationId);
    }
    expect(stream.requests.length === before, `requests reached the gateway: ${stream.requests.slice(before).join(', ')}`);
    return { operationsWithEffect: checked.length, requestsSent: 0 };
  });
  assert.deepEqual(errors.filter((e) => !/Failed to load resource|requestfailed/.test(e)), []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});

const byOp = (s) => events.find((r) => r.operation.startsWith(s));

test('Event Playground rows', { timeout: 300000 }, async () => {
  const { page, context, errors } = await openPage(browser, site.url('/build/playground/'));

  await rec.check([byOp('Deterministic simulator').id, byOp('Pause/resume').id], 'deterministic example replay with pause and resume', async () => {
    await page.getByRole('tab', { name: 'Deterministic example' }).click().catch(() => {});
    await page.getByRole('button', { name: 'Play' }).click();
    await page.getByText(/Played 1 of/).waitFor();
    await page.getByRole('button', { name: 'Pause' }).click();
    const paused = await page.getByText(/Played \d+ of/).innerText();
    await page.getByRole('button', { name: 'Resume' }).click();
    await page.getByText(/Played [2-9] of/).waitFor();
    const rows = await page.locator('table tbody tr').count();
    expect(rows >= 2, `history has ${rows} rows after resume`);
    return { paused, historyRows: rows };
  });

  await configureGateway(page, stream.origin, { network: 'signet' });

  await rec.check([byOp('SSE connection').id, byOp('Duplicate/out-of-order').id], 'SSE stream from a local source of conformance envelopes', async () => {
    await page.getByRole('tab', { name: 'SSE stream' }).click();
    await page.getByRole('button', { name: 'Forget cursor' }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText(/Accepted [3-9]\d*, duplicates [1-9]/).waitFor({ timeout: 20000 });
    const counts = await page.getByText(/^Accepted \d+, duplicates/).innerText();
    expect(/out of order [1-9]/.test(counts), `no out-of-order count: ${counts}`);
    expect(/invalid [1-9]/.test(counts), `invalid message not counted: ${counts}`);
    await page.getByRole('button', { name: 'Disconnect' }).click();
    return { counts, lastEventIds: seen.sse.slice(0, 3) };
  });

  await rec.check(byOp('Replay cursor').id, 'reconnect and reload resume after the last processed event', async () => {
    const cursor = (await page.getByText(/^Resume cursor/).innerText()).split(': ').pop().trim();
    expect(/^\d{8}-/.test(cursor), `no cursor saved: ${cursor}`);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'SSE stream' }).click();
    const n = seen.sse.length;
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText(/Accepted [1-9]/).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Disconnect' }).click();
    expect(seen.sse[n] === cursor, `after reload the stream resumed from ${seen.sse[n]}, not ${cursor}`);
    return { cursorBeforeReload: cursor, lastEventIdAfterReload: seen.sse[n] };
  });

  await rec.check(byOp('Expired cursor').id, 'an expired cursor stops the stream until the cursor is forgotten', async () => {
    const cursor = (await page.getByText(/^Resume cursor/).innerText()).split(': ').pop().trim();
    expireCursor = cursor;
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText(/no longer holds events after the saved cursor/).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Forget cursor' }).click();
    const n = seen.sse.length;
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText(/Accepted [1-9]/).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Disconnect' }).click();
    expireCursor = null;
    expect(seen.sse[n] === null, `resync still sent ${seen.sse[n]}`);
    return { expiredCursor: cursor, resyncLastEventId: null };
  });

  await rec.check(byOp('WebSocket connection').id, 'WebSocket stream from a local source of conformance envelopes', async () => {
    await page.getByRole('tab', { name: 'WebSocket' }).click();
    await page.getByRole('button', { name: 'Forget cursor' }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText(/Accepted 3, duplicates 1/).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Disconnect' }).click();
    expect(seen.ws[0]?.op === 'subscribe' && seen.ws[0].filters?.network === 'signet', `subscribe message: ${JSON.stringify(seen.ws[0])}`);
    return { subscribe: seen.ws[0], counts: await page.getByText(/^Accepted \d+, duplicates/).innerText() };
  });

  const good = vectors.cases.find((c) => c.kind === 'webhook' && c.expected.ok);
  await rec.check(byOp('Webhook HMAC generation').id, 'sign a raw body in the page and verify it with the reference verifier', async () => {
    await page.getByRole('tab', { name: 'Webhook signature' }).click();
    const body = '{"type":"ordex.test","bytes":"é\\u0000 ok"}';
    await page.getByLabel('Subscription secret').fill(good.signing.secret);
    await page.getByLabel('Raw body, exactly as received').fill(body);
    await page.getByRole('button', { name: 'Sign this body now (test)' }).click();
    const header = await page.getByLabel('X-Ordex-Signature header').inputValue();
    const now = Number(await page.getByLabel('nowSeconds').inputValue());
    const t = Number(/t=(\d+)/.exec(header)[1]);
    const d = /d=([^,]+)/.exec(header)[1];
    expect(header === signWebhookDelivery({ secret: good.signing.secret, timestamp: t, deliveryId: d, body }), 'page header differs from verifier/events.js over the same bytes');
    expect(verifyWebhookSignature({ header, secret: good.signing.secret, body, nowSeconds: now, toleranceSeconds: 300 }).ok, 'node verifier refuses the page signature');
    await page.getByRole('button', { name: 'Verify signature' }).click();
    await page.getByText('Signature valid').waitFor();
    return { header };
  });

  await rec.check(byOp('Webhook expiry').id, 'a vector delivery verifies at its nowSeconds and is refused outside the window', async () => {
    await page.getByLabel('Raw body, exactly as received').fill(good.signing.body);
    await page.getByLabel('X-Ordex-Signature header').fill(signWebhookDelivery(good.signing));
    await page.getByLabel('nowSeconds').fill(String(good.verifying.nowSeconds));
    await page.getByRole('button', { name: 'Verify signature' }).click();
    await page.getByText('Signature valid').waitFor();
    await page.getByLabel('nowSeconds').fill(String(good.verifying.nowSeconds + 100000));
    await page.getByRole('button', { name: 'Verify signature' }).click();
    const refused = await page.getByText(/^Refused: /).innerText();
    expect(/TIMESTAMP|EXPIRED|OUTSIDE/.test(refused), refused);
    return { atNow: 'Signature valid', later: refused };
  });

  rec.record(byOp('Real signed test webhook').id, 'BLOCKED', byOp('Real signed test webhook').operation, `${NO_GATEWAY} A real test delivery also needs a subscription on that gateway and a reachable receiver.`);
  assert.deepEqual(errors.filter((e) => !/Failed to load resource|requestfailed|WebSocket/.test(e)), []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});
