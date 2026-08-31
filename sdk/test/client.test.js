import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OrdexApiError, OrdexClient } from '../dist/index.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function recordingFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const stub = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error('No response queued.');
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, stub };
}

test('a read builds the exact URL and skips undefined query values', async () => {
  const { calls, stub } = recordingFetch([json({ orders: [], total: 0, limit: 50, nextCursor: '', hasMore: false })]);
  const client = new OrdexClient({ baseUrl: 'https://gateway.example/', fetch: stub });
  await client.listOrders({ protocol: 'ordinals', cursor: undefined, sort: 'price_asc' });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/ordex/orders');
  assert.equal(url.searchParams.get('protocol'), 'ordinals');
  assert.equal(url.searchParams.get('sort'), 'price_asc');
  assert.equal(url.searchParams.has('cursor'), false);
  assert.equal(calls[0].init.method, 'GET');
});

test('a write sends a JSON body and is answered with the parsed 201 payload', async () => {
  const summary = { id: 'o1', state: 'LIVE' };
  const { calls, stub } = recordingFetch([json(summary, 201)]);
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub });
  const answer = await client.importOrder({ psbt: 'cHNidP8=' });
  assert.deepEqual(answer, summary);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { psbt: 'cHNidP8=' });
});

test('a failed response becomes an OrdexApiError carrying the envelope', async () => {
  const envelope = { statusCode: 400, error: 'Bad Request', message: 'Malformed cursor.', requestId: 'r1' };
  const { stub } = recordingFetch([json(envelope, 400)]);
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub });
  const error = await client.listOrders({ cursor: 'nonsense' }).then(
    () => assert.fail('expected a throw'),
    (thrown) => thrown,
  );
  assert.ok(error instanceof OrdexApiError);
  assert.equal(error.status, 400);
  assert.equal(error.message, 'Malformed cursor.');
  assert.deepEqual(error.envelope, envelope);
});

test('a read is retried on 503, and answers once the gateway recovers', async () => {
  const envelope = { statusCode: 503, error: 'Service Unavailable', message: 'ord unreachable' };
  const page = { entries: [], limit: 50, nextCursor: '', hasMore: false };
  const { calls, stub } = recordingFetch([json(envelope, 503), json(envelope, 503), json(page)]);
  const client = new OrdexClient({
    baseUrl: 'https://gateway.example',
    fetch: stub,
    retries: 2,
    retryDelayMs: 1,
  });
  const answer = await client.listActivity();
  assert.deepEqual(answer, page);
  assert.equal(calls.length, 3);
});

test('a write is never retried, whatever the retry setting says', async () => {
  const envelope = { statusCode: 503, error: 'Service Unavailable', message: 'try later' };
  const { calls, stub } = recordingFetch([json(envelope, 503), json({ id: 'o1' }, 201)]);
  const client = new OrdexClient({
    baseUrl: 'https://gateway.example',
    fetch: stub,
    retries: 5,
    retryDelayMs: 1,
  });
  await assert.rejects(
    () => client.revalidateOrder('o1'),
    (error) => error instanceof OrdexApiError && error.status === 503,
  );
  assert.equal(calls.length, 1);
});

test('a non-retriable read status is not retried', async () => {
  const envelope = { statusCode: 404, error: 'Not Found', message: 'No such order.' };
  const { calls, stub } = recordingFetch([json(envelope, 404), json({ id: 'o1' })]);
  const client = new OrdexClient({
    baseUrl: 'https://gateway.example',
    fetch: stub,
    retries: 3,
    retryDelayMs: 1,
  });
  await assert.rejects(() => client.getOrder('missing'));
  assert.equal(calls.length, 1);
});

test('an abort stops a read instead of being retried', async () => {
  const abortError = new Error('This operation was aborted');
  abortError.name = 'AbortError';
  const { calls, stub } = recordingFetch([abortError, json({ ok: true })]);
  const client = new OrdexClient({
    baseUrl: 'https://gateway.example',
    fetch: stub,
    retries: 3,
    retryDelayMs: 1,
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => client.getHealth({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});

test('the order iterator follows the keyset cursor to the last page', async () => {
  const pageOne = {
    orders: [{ id: 'a' }, { id: 'b' }],
    total: 3,
    limit: 2,
    nextCursor: 'cursor-2',
    hasMore: true,
  };
  const pageTwo = { orders: [{ id: 'c' }], total: 3, limit: 2, nextCursor: '', hasMore: false };
  const { calls, stub } = recordingFetch([json(pageOne), json(pageTwo)]);
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub });
  const seen = [];
  for await (const order of client.iterateOrders({ protocol: 'ordinals' })) {
    seen.push(order.id);
  }
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get('cursor'), 'cursor-2');
});

test('operator withdrawal sends Basic credentials and nothing else does', async () => {
  const { calls, stub } = recordingFetch([json({ id: 'o1' }, 201), json({ id: 'o1' })]);
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub });
  await client.adminWithdrawOrder('o1', { reason: 'copycat' }, { username: 'ops', password: 'secret' });
  assert.equal(
    calls[0].init.headers.authorization,
    `Basic ${Buffer.from('ops:secret').toString('base64')}`,
  );
  await client.getOrder('o1');
  assert.equal(calls[1].init.headers.authorization, undefined);
});
