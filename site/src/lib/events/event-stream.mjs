// OX-S05: Event Playground transports. Connected mode reads the gateway's documented
// streams (spec/asyncapi.json: SSE at /events/stream with Last-Event-ID resumption, and the
// WebSocket at /events/ws with a subscribe message carrying the cursor). Every envelope is
// validated with the ordex-event/v1 verifier, deduplicated by id and buffered within a
// bound; the cursor advances only after an event was processed. Reconnects back off, and an
// expired cursor stops the stream for an explicit resync instead of skipping events.

export const MAX_BUFFER = 200;
const MAX_SEEN = 5000;

/** Incremental text/event-stream parser (WHATWG HTML server-sent events). */
export function createSseParser() {
  let buffer = '';
  let data = [];
  let eventType = '';
  let id = null;
  let retry = null;
  return {
    push(chunk) {
      buffer += chunk;
      const out = [];
      let idx;
      while ((idx = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, idx);
        const sepLen = buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(idx + sepLen);
        if (line === '') {
          if (data.length) out.push({ id, event: eventType || 'message', data: data.join('\n'), retry });
          data = [];
          eventType = '';
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') data.push(value);
        else if (field === 'event') eventType = value;
        else if (field === 'id' && !value.includes('\0')) id = value;
        else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
      }
      return out;
    }
  };
}

/** A fresh stream state. */
export function createStreamState() {
  return { events: [], seen: [], cursor: null, lastSequence: null, counts: { accepted: 0, duplicate: 0, invalid: 0, outOfOrder: 0 } };
}

/**
 * Process one raw message: parse, validate, deduplicate, bound the buffer and advance the
 * cursor. `validate` is the ordex-event/v1 verifier. Returns { state, outcome, detail }.
 */
export function ingestEvent(state, rawText, validate, transportId = null) {
  let envelope;
  try {
    envelope = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
  } catch (err) {
    return { state: { ...state, counts: { ...state.counts, invalid: state.counts.invalid + 1 } }, outcome: 'invalid', detail: `Not JSON: ${err.message}` };
  }
  const verdict = validate(envelope);
  if (!verdict.ok) {
    return { state: { ...state, counts: { ...state.counts, invalid: state.counts.invalid + 1 } }, outcome: 'invalid', detail: `${verdict.code}: ${verdict.reason || ''}` };
  }
  if (transportId !== null && transportId !== envelope.id) {
    return { state: { ...state, counts: { ...state.counts, invalid: state.counts.invalid + 1 } }, outcome: 'invalid', detail: 'The transport event id does not match the envelope id.' };
  }
  if (state.seen.includes(envelope.id)) {
    return { state: { ...state, counts: { ...state.counts, duplicate: state.counts.duplicate + 1 } }, outcome: 'duplicate', detail: envelope.id };
  }
  const outOfOrder = state.lastSequence !== null && typeof envelope.sequence === 'number' && envelope.sequence <= state.lastSequence;
  const events = [{ ...envelope, _outOfOrder: outOfOrder }, ...state.events].slice(0, MAX_BUFFER);
  const seen = [...state.seen, envelope.id].slice(-MAX_SEEN);
  return {
    state: {
      events,
      seen,
      cursor: envelope.id,
      lastSequence: typeof envelope.sequence === 'number' && !outOfOrder ? envelope.sequence : state.lastSequence,
      counts: { ...state.counts, accepted: state.counts.accepted + 1, outOfOrder: state.counts.outOfOrder + (outOfOrder ? 1 : 0) }
    },
    outcome: outOfOrder ? 'out-of-order' : 'accepted',
    detail: envelope.id
  };
}

const wait = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

export function backoffDelay(attempt, initialMs = 1000, maxMs = 30000) {
  return Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt));
}

/**
 * Consume the SSE stream until `signal` aborts. `onMessage(message)` must resolve true once
 * the message is processed; only then is its id used as the resume cursor.
 */
export async function runSse({ url, lastEventId = null, fetchImpl = fetch, onMessage, onStatus = () => {}, signal, initialBackoffMs = 1000, maxBackoffMs = 30000 }) {
  let cursor = lastEventId;
  let attempt = 0;
  while (!signal?.aborted) {
    onStatus({ state: attempt === 0 ? 'connecting' : 'reconnecting', attempt, cursor });
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'text/event-stream', ...(cursor ? { 'last-event-id': cursor } : {}) },
        signal,
        credentials: 'omit',
        cache: 'no-store'
      });
      if (response.status === 410) {
        onStatus({ state: 'cursor-expired', cursor });
        return { stopped: 'cursor-expired', cursor };
      }
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const type = (response.headers.get('content-type') || '').split(';')[0].trim();
      if (type !== 'text/event-stream') throw new Error(`Expected text/event-stream, got ${type || 'no content type'}`);
      onStatus({ state: 'open', cursor });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
          const processed = await onMessage(msg);
          if (processed && msg.id) {
            cursor = msg.id;
            attempt = 0;
          }
        }
      }
      throw new Error('The stream ended');
    } catch (err) {
      if (signal?.aborted) break;
      const delay = backoffDelay(attempt, initialBackoffMs, maxBackoffMs);
      onStatus({ state: 'waiting', attempt: attempt + 1, delayMs: delay, error: String(err?.message || err), cursor });
      attempt += 1;
      await wait(delay, signal);
    }
  }
  onStatus({ state: 'closed', cursor });
  return { stopped: 'aborted', cursor };
}

/**
 * Consume the WebSocket stream until `signal` aborts: subscribe with filters and the cursor,
 * advance the cursor after processing, reconnect with backoff.
 */
export function runWebSocket({ url, cursor = null, filters = {}, WebSocketImpl = globalThis.WebSocket, onMessage, onStatus = () => {}, signal, initialBackoffMs = 1000, maxBackoffMs = 30000 }) {
  return new Promise((resolve) => {
    let attempt = 0;
    let socket = null;
    let current = cursor;
    let timer = null;
    let done = false;
    const finish = (stopped) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      onStatus({ state: 'closed', cursor: current });
      resolve({ stopped, cursor: current });
    };
    const open = () => {
      if (signal?.aborted) return finish('aborted');
      onStatus({ state: attempt === 0 ? 'connecting' : 'reconnecting', attempt, cursor: current });
      try {
        socket = new WebSocketImpl(url);
      } catch (err) {
        return retry(String(err?.message || err));
      }
      socket.onopen = () => {
        onStatus({ state: 'open', cursor: current });
        socket.send(JSON.stringify({ op: 'subscribe', filters, ...(current ? { cursor: current } : {}) }));
      };
      socket.onmessage = async (event) => {
        const text = typeof event.data === 'string' ? event.data : '';
        const processed = await onMessage({ id: null, event: 'message', data: text });
        if (processed) {
          try {
            current = JSON.parse(text).id || current;
            attempt = 0;
          } catch {
            // invalid messages never move the cursor
          }
        }
      };
      socket.onclose = (event) => {
        if (signal?.aborted) return finish('aborted');
        if (event?.reason === 'cursor-expired') {
          onStatus({ state: 'cursor-expired', cursor: current });
          return finish('cursor-expired');
        }
        retry(`closed ${event?.code ?? ''}`);
      };
      socket.onerror = () => {
        // onclose follows and schedules the retry
      };
    };
    const retry = (error) => {
      const delay = backoffDelay(attempt, initialBackoffMs, maxBackoffMs);
      onStatus({ state: 'waiting', attempt: attempt + 1, delayMs: delay, error, cursor: current });
      attempt += 1;
      timer = setTimeout(open, delay);
    };
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      try {
        socket?.close(1000, 'client closed');
      } catch {
        // already closed
      }
      finish('aborted');
    }, { once: true });
    open();
  });
}

/** Stream URLs under a gateway origin, per spec/asyncapi.json. */
export function streamUrls(origin, filters = {}) {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const base = `${origin}/api/ordex/events`;
  const ws = `${origin.replace(/^http/, 'ws')}/api/ordex/events/ws`;
  return { sse: `${base}/stream${qs ? `?${qs}` : ''}`, ws };
}
