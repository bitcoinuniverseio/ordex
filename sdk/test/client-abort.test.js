import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OrdexApiError, OrdexClient, OrdexResponseError } from '../dist/index.js';

// OX-P06: a caller abort ends a call at once with the caller's own reason and
// is never retried; reads retry inside one bounded deadline; configuration is
// validated; pages and streams refuse what they cannot interpret.

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that honors its signal the way the platform fetch does. */
function signalAwareFetch(behavior) {
  const calls = [];
  const stub = (url, init) => {
    calls.push({ url, init });
    return new Promise((resolve, reject) => {
      const { signal } = init;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      behavior(calls.length, resolve, reject);
    });
  };
  return { calls, stub };
}

const hang = () => {};
const answer = (response) => (_n, resolve) => resolve(response());

test('a custom Error abort reason is thrown as is and never retried', async () => {
  const { calls, stub } = signalAwareFetch(hang);
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub, retries: 4, retryDelayMs: 0 });
  const controller = new AbortController();
  const reason = new Error('the user closed the page');
  const pending = client.getHealth({ signal: controller.signal });
  setTimeout(() => controller.abort(reason), 10);
  await assert.rejects(pending, (thrown) => thrown === reason);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 1, 'no attempt follows an abort');
});

test('any abort reason value, not only an AbortError, ends the call', async () => {
  for (const reason of ['stop', 42, { why: 'navigation' }, null]) {
    const { calls, stub } = signalAwareFetch(hang);
    const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub, retries: 3, retryDelayMs: 0 });
    const controller = new AbortController();
    const pending = client.listOrders({}, { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 5);
    await assert.rejects(pending, (thrown) => thrown === reason);
    assert.equal(calls.length, 1);
  }
});

test('an already aborted signal sends nothing', async () => {
  const { calls, stub } = signalAwareFetch(hang);
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub, retries: 2 });
  const reason = new Error('already gone');
  await assert.rejects(client.getProtocol({ signal: AbortSignal.abort(reason) }), (thrown) => thrown === reason);
  assert.equal(calls.length, 0);
});

test('an abort during the retry wait settles promptly without a second request', async () => {
  const { calls, stub } = signalAwareFetch(answer(() => json({ statusCode: 503 }, 503)));
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub, retries: 3, retryDelayMs: 5_000, maxRetryDelayMs: 5_000, deadlineMs: 60_000 });
  const controller = new AbortController();
  const reason = new Error('cancelled while waiting');
  const started = Date.now();
  const pending = client.getCatalog({ signal: controller.signal });
  setTimeout(() => controller.abort(reason), 50);
  await assert.rejects(pending, (thrown) => thrown === reason);
  assert.ok(Date.now() - started < 1_000, `settled after ${Date.now() - started} ms`);
  assert.equal(calls.length, 1);
});

test('reads retry 502, 503 and 504 and stop at the first answer', async () => {
  let n = 0;
  const statuses = [502, 503, 504];
  const { calls, stub } = signalAwareFetch((_count, resolve) => {
    const status = statuses[n];
    n += 1;
    resolve(status ? json({ statusCode: status }, status) : json({ ok: true }));
  });
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub, retries: 5, retryDelayMs: 0 });
  assert.deepEqual(await client.getHealth(), { ok: true });
  assert.equal(calls.length, 4);
});

test('a client error, a 500 and an unreadable answer are not retried', async () => {
  for (const response of [() => json({ message: 'bad' }, 400), () => json({ message: 'boom' }, 500), () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })]) {
    const { calls, stub } = signalAwareFetch(answer(response));
    const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub, retries: 3, retryDelayMs: 0 });
    await assert.rejects(client.getHealth(), (error) => error instanceof OrdexApiError || error instanceof OrdexResponseError);
    assert.equal(calls.length, 1);
  }
});

test('one attempt times out on timeoutMs, and the whole call stops at deadlineMs', async () => {
  const { calls, stub } = signalAwareFetch(hang);
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub, timeoutMs: 40, retries: 10, retryDelayMs: 0, deadlineMs: 150 });
  const started = Date.now();
  await assert.rejects(client.getHealth(), (error) => error.name === 'TimeoutError');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 600, `took ${elapsed} ms`);
  assert.ok(calls.length >= 2 && calls.length <= 5, `${calls.length} attempts inside a 150 ms deadline`);
});

test('configuration outside safe bounds is refused at construction', () => {
  const base = { baseUrl: 'https://gateway.example', fetch: async () => json({}) };
  for (const bad of [
    { retries: -1 },
    { retries: 1.5 },
    { retries: 11 },
    { retries: Number.NaN },
    { timeoutMs: 0 },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { timeoutMs: 2 ** 31 },
    { retryDelayMs: -5 },
    { retryDelayMs: 60_001 },
    { maxRetryDelayMs: -1 },
    { deadlineMs: 0 },
    { deadlineMs: '1000' },
  ]) {
    assert.throws(() => new OrdexClient({ ...base, ...bad }), RangeError, JSON.stringify(bad));
  }
  assert.throws(() => new OrdexClient({ ...base, baseUrl: 'not a url' }), TypeError);
  assert.throws(() => new OrdexClient({ ...base, baseUrl: 'ftp://gateway.example' }), RangeError);
  assert.ok(new OrdexClient({ ...base, retries: 10, retryDelayMs: 0, timeoutMs: 1 }));
});

test('writes are sent once even with a retry budget', async () => {
  const { calls, stub } = signalAwareFetch(answer(() => json({ statusCode: 503 }, 503)));
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub, retries: 5, retryDelayMs: 0 });
  await assert.rejects(client.importOrder({ psbt: 'cHNidP8=' }), (error) => error.status === 503);
  assert.equal(calls.length, 1);
});

test('responses are decoded by status and media type', async () => {
  const cases = [
    [() => new Response(null, { status: 204 }), (value) => assert.equal(value, undefined)],
    [() => json({ fine: true }), (value) => assert.deepEqual(value, { fine: true })],
    [() => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/problem+json' } }), (value) => assert.deepEqual(value, { a: 1 })],
  ];
  for (const [response, check] of cases) {
    const { stub } = signalAwareFetch(answer(response));
    check(await new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub }).getHealth());
  }
  const refusals = [
    [() => new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } }), 'UNEXPECTED_MEDIA_TYPE'],
    [() => new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } }), 'MALFORMED_JSON'],
  ];
  for (const [response, code] of refusals) {
    const { stub } = signalAwareFetch(answer(response));
    await assert.rejects(new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub }).getHealth(), (error) => error instanceof OrdexResponseError && error.code === code);
  }
});

test('an iterator refuses a repeated cursor and an envelope that is not a page', async () => {
  const pages = [
    { orders: [{ id: 'a' }], total: 2, limit: 1, nextCursor: 'c1', hasMore: true },
    { orders: [{ id: 'b' }], total: 2, limit: 1, nextCursor: 'c1', hasMore: true },
  ];
  let n = 0;
  const { stub } = signalAwareFetch((_c, resolve) => resolve(json(pages[Math.min(n++, 1)])));
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub });
  const seen = [];
  await assert.rejects(
    (async () => {
      for await (const order of client.iterateOrders()) seen.push(order.id);
    })(),
    (error) => error instanceof OrdexResponseError && error.code === 'CURSOR_REPEATED',
  );
  assert.deepEqual(seen, ['a', 'b']);

  const { stub: broken } = signalAwareFetch(answer(() => json({ orders: 'nope', hasMore: false })));
  const client2 = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: broken });
  await assert.rejects(
    (async () => {
      for await (const order of client2.iterateOrders()) void order;
    })(),
    (error) => error instanceof OrdexResponseError && error.code === 'MALFORMED_PAGE',
  );
});

test('non-ASCII operator credentials are sent as UTF-8 Basic credentials', async () => {
  const { calls, stub } = signalAwareFetch(answer(() => json({ id: 'o1' }, 201)));
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub });
  await client.adminWithdrawOrder('o1', {}, { username: 'opérateur', password: 'пароль' });
  const expected = Buffer.from('opérateur:пароль', 'utf8').toString('base64');
  assert.equal(calls[0].init.headers.authorization, `Basic ${expected}`);
});

test('the event stream parses frames, keeps the last id, and ends on abort with the reason', async () => {
  const encoder = new TextEncoder();
  let push;
  const body = new ReadableStream({
    start(controller) {
      push = (text) => controller.enqueue(encoder.encode(text));
    },
  });
  const { calls, stub } = signalAwareFetch((_c, resolve) =>
    resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })),
  );
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub, timeoutMs: 50 });
  const controller = new AbortController();
  const reason = new Error('consumer left');
  const received = [];
  const run = (async () => {
    for await (const message of client.streamOrdexEvents({ network: 'signet' }, { signal: controller.signal, lastEventId: 'evt-1' })) {
      received.push(message);
      if (received.length === 2) setTimeout(() => controller.abort(reason), 5);
    }
  })();
  push(': connected\r\n\r\n');
  push('id: 7\nevent: ordex-event\ndata: {"a":\ndata: 1}\n\n');
  push('event: heartbeat\ndata: {"t":2}\n');
  push('\n');
  await assert.rejects(run, (thrown) => thrown === reason);
  assert.deepEqual(received, [
    { id: '7', event: 'ordex-event', data: { a: 1 } },
    { id: '7', event: 'heartbeat', data: { t: 2 } },
  ]);
  assert.equal(calls[0].init.headers['last-event-id'], 'evt-1');
  assert.equal(new URL(calls[0].url).searchParams.get('network'), 'signet');
});

test('the event stream refuses a body that is not an event stream, and a stream that never connects', async () => {
  const { stub } = signalAwareFetch(answer(() => json({})));
  const client = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: stub });
  await assert.rejects(
    (async () => {
      for await (const m of client.streamOrdexEvents()) void m;
    })(),
    (error) => error instanceof OrdexResponseError && error.code === 'UNEXPECTED_MEDIA_TYPE',
  );
  const { stub: silent } = signalAwareFetch(hang);
  const slow = new OrdexClient({ baseUrl: 'https://gateway.example', fetch: silent, timeoutMs: 30 });
  await assert.rejects(
    (async () => {
      for await (const m of slow.streamOrdexEvents()) void m;
    })(),
    (error) => error.name === 'TimeoutError',
  );
});
