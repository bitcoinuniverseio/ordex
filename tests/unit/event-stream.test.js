import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createSseParser, createStreamState, ingestEvent, runSse, runWebSocket, streamUrls, backoffDelay, MAX_BUFFER } from '../../site/src/lib/events/event-stream.mjs';
import { validateOrdexEvent } from '../../verifier/events.js';

// OX-S05: stream handling against real ordex-event/v1 envelopes from the conformance vectors.
const vectors = JSON.parse(await readFile(new URL('../../conformance/event-vectors.json', import.meta.url), 'utf8'));
const base = vectors.cases.find((c) => c.kind === 'event' && c.expected.ok === true).event;
const envelope = (n) => ({ ...base, id: `${String(n).padStart(8, '0')}-4b5a-4978-8796-a5b4c3d2e1f0`, sequence: 1000 + n });

test('the SSE parser handles chunk splits, CRLF, comments, multi-line data, id and retry', () => {
  const p = createSseParser();
  assert.deepEqual(p.push(': heartbeat\r\nid: a1\r\nevent: ordex\r\ndata: {"x":'), []);
  assert.deepEqual(p.push('1}\r\ndata: more\r\nretry: 5000\r\n\r\n'), [{ id: 'a1', event: 'ordex', data: '{"x":1}\nmore', retry: 5000 }]);
  assert.deepEqual(p.push('data:no-space\n\n'), [{ id: 'a1', event: 'message', data: 'no-space', retry: 5000 }]);
  assert.deepEqual(p.push('id: bad\0id\n\n'), [], 'an id with NUL is ignored and a block without data dispatches nothing');
});

test('ingest validates, deduplicates, bounds the buffer and advances the cursor only on processed events', () => {
  let s = createStreamState();
  let r = ingestEvent(s, JSON.stringify(envelope(1)), validateOrdexEvent, `${envelope(1).sequence}:${envelope(1).id}`);
  assert.equal(r.outcome, 'accepted');
  assert.equal(r.state.cursor, envelope(1).id);
  s = r.state;
  r = ingestEvent(s, JSON.stringify(envelope(1)), validateOrdexEvent);
  assert.equal(r.outcome, 'duplicate');
  assert.equal(r.state.counts.duplicate, 1);
  r = ingestEvent(s, '{bad json', validateOrdexEvent);
  assert.equal(r.outcome, 'invalid');
  assert.equal(r.state.cursor, s.cursor, 'invalid input never moves the cursor');
  r = ingestEvent(s, JSON.stringify({ ...envelope(2), schemaVersion: '9' }), validateOrdexEvent);
  assert.equal(r.outcome, 'invalid');
  r = ingestEvent(s, JSON.stringify(envelope(3)), validateOrdexEvent, envelope(3).id);
  assert.equal(r.outcome, 'invalid', 'the SSE id must be <sequence>:<eventId> of the envelope, not the bare event id');
  r = ingestEvent(ingestEvent(s, JSON.stringify(envelope(5)), validateOrdexEvent).state, JSON.stringify(envelope(4)), validateOrdexEvent);
  assert.equal(r.outcome, 'out-of-order');
  let big = createStreamState();
  for (let i = 0; i < MAX_BUFFER + 20; i++) big = ingestEvent(big, envelope(i + 10), validateOrdexEvent).state;
  assert.equal(big.events.length, MAX_BUFFER);
});

function sseResponse(chunks, status = 200) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    }
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

test('SSE resumes after a drop with Last-Event-ID set to the last processed event', async () => {
  const calls = [];
  const e1 = envelope(1);
  const e2 = envelope(2);
  const responses = [
    sseResponse([`id: ${e1.sequence}:${e1.id}\ndata: ${JSON.stringify(e1)}\n\n`]),
    sseResponse([`id: ${e2.sequence}:${e2.id}\ndata: ${JSON.stringify(e2)}\n\n`])
  ];
  const controller = new AbortController();
  let state = createStreamState();
  const statuses = [];
  const done = runSse({
    url: 'https://gw.example/api/ordex/events/stream',
    fetchImpl: async (url, init) => {
      calls.push(init.headers['last-event-id'] || null);
      if (responses.length) return responses.shift();
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    },
    onMessage: async (m) => {
      const r = ingestEvent(state, m.data, validateOrdexEvent, m.id);
      state = r.state;
      return r.outcome === 'accepted';
    },
    onStatus: (s) => statuses.push(s.state),
    signal: controller.signal,
    initialBackoffMs: 1
  });
  const result = await done;
  assert.deepEqual(calls.slice(0, 3), [null, `${e1.sequence}:${e1.id}`, `${e2.sequence}:${e2.id}`]);
  assert.equal(result.cursor, `${e2.sequence}:${e2.id}`);
  assert.equal(state.counts.accepted, 2);
  assert.ok(statuses.includes('waiting'));
});

test('an expired cursor stops for resync and never skips ahead', async () => {
  const r = await runSse({ url: 'u', lastEventId: 'old', fetchImpl: async () => new Response('gone', { status: 410 }), onMessage: async () => true, signal: new AbortController().signal });
  assert.deepEqual(r, { stopped: 'cursor-expired', cursor: 'old' });
  const wrongType = [];
  const c = new AbortController();
  await runSse({
    url: 'u',
    fetchImpl: async () => {
      if (wrongType.length) c.abort();
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    onMessage: async () => true,
    onStatus: (s) => s.error && wrongType.push(s.error),
    signal: c.signal,
    initialBackoffMs: 1
  });
  assert.match(wrongType[0], /Expected text\/event-stream/);
});

test('the WebSocket client subscribes with filters and the cursor, and resubscribes after a drop', async () => {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      sockets.push(this);
      setTimeout(() => this.onopen?.(), 0);
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.onclose?.({ code: 1000 });
    }
  }
  const controller = new AbortController();
  let state = createStreamState();
  const done = runWebSocket({
    url: 'wss://gw.example/api/ordex/events/ws',
    cursor: 'start',
    filters: { network: 'signet' },
    WebSocketImpl: FakeSocket,
    onMessage: async (m) => {
      const r = ingestEvent(state, m.data, validateOrdexEvent);
      state = r.state;
      return r.outcome === 'accepted';
    },
    signal: controller.signal,
    initialBackoffMs: 1
  });
  for (let i = 0; i < 200 && !sockets[0]?.sent.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sockets[0].sent[0], { op: 'subscribe', id: 'playground', filters: { network: 'signet' }, cursor: 'start' });
  await sockets[0].onmessage({ data: JSON.stringify({ op: 'subscribed', id: 'playground' }) });
  await sockets[0].onmessage({ data: JSON.stringify({ op: 'event', id: 'other', cursor: 'c-other', event: envelope(6) }) });
  await sockets[0].onmessage({ data: JSON.stringify({ op: 'event', id: 'playground', cursor: 'c7', event: envelope(7) }) });
  assert.equal(state.counts.accepted, 1, 'only wrapped events of this subscription are ingested');
  sockets[0].onclose({ code: 1006 });
  for (let i = 0; i < 200 && !sockets[1]?.sent.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(sockets[1].sent[0].cursor, 'c7', 'resubscribes from the processed event cursor');
  controller.abort();
  assert.deepEqual(await done, { stopped: 'aborted', cursor: 'c7' });
});

test('stream URLs and backoff follow the contract', () => {
  assert.deepEqual(streamUrls('https://gw.example', { network: 'signet' }), { sse: 'https://gw.example/api/ordex/events/stream?network=signet', ws: 'wss://gw.example/api/ordex/events/ws' });
  assert.equal(streamUrls('http://127.0.0.1:3001').ws, 'ws://127.0.0.1:3001/api/ordex/events/ws');
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(10), 30000);
});
