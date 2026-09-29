// OX-S04: MCP 2026-07-28 stdio transport. One JSON-RPC message per line on stdin; stdout
// carries protocol messages only; diagnostics go to stderr. Lines are bounded, malformed
// JSON gets a -32700 error with a null id, notifications get no response, a
// notifications/cancelled message suppresses the response of that request, and the server
// exits when stdin closes.

export const MAX_LINE_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 8;

/**
 * Run the transport. `dispatch(message)` returns a response object or null.
 * Resolves when the input ends and every in-flight request has settled.
 */
export function runStdio({ dispatch, input, output, error, maxLineBytes = MAX_LINE_BYTES }) {
  return new Promise((resolve) => {
    let buffer = '';
    let discarding = false;
    const cancelled = new Set();
    const inFlight = new Set();
    const queue = [];
    let ended = false;

    const write = (msg) => output.write(`${JSON.stringify(msg)}\n`);
    const log = (text) => error.write(`${text}\n`);

    const finishIfDone = () => {
      if (ended && inFlight.size === 0 && queue.length === 0) resolve();
    };

    const pump = () => {
      while (inFlight.size < MAX_IN_FLIGHT && queue.length) {
        const message = queue.shift();
        const job = Promise.resolve()
          .then(() => dispatch(message))
          .then((response) => {
            if (!response) return;
            if (response.id !== null && cancelled.has(response.id)) {
              cancelled.delete(response.id);
              return;
            }
            write(response);
          })
          .catch((err) => {
            log(`internal error: ${err?.message || err}`);
            if (message && message.id !== undefined) write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Internal error' } });
          })
          .finally(() => {
            inFlight.delete(job);
            pump();
            finishIfDone();
          });
        inFlight.add(job);
      }
    };

    const handleLine = (line) => {
      const text = line.replace(/\r$/, '');
      if (text.trim() === '') return;
      let message;
      try {
        message = JSON.parse(text);
      } catch (err) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${err.message}` } });
        return;
      }
      if (message && typeof message === 'object' && !('id' in message) && message.method === 'notifications/cancelled') {
        const target = message.params?.requestId;
        if (typeof target === 'string' || typeof target === 'number') cancelled.add(target);
        return;
      }
      queue.push(message);
      pump();
    };

    const refuseOversized = () => write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `A message line exceeds ${maxLineBytes} bytes` } });

    input.setEncoding?.('utf8');
    input.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (discarding) {
          discarding = false;
          continue;
        }
        // A complete line can arrive in one chunk, so the bound applies here too.
        if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
          refuseOversized();
          continue;
        }
        handleLine(line);
      }
      if (discarding) {
        // Still inside a refused line: drop it without accumulating.
        buffer = '';
      } else if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
        // Oversized partial line: refuse it once and drop the rest of it.
        refuseOversized();
        buffer = '';
        discarding = true;
      }
    });
    input.on('end', () => {
      if (buffer.trim() && !discarding) handleLine(buffer);
      buffer = '';
      ended = true;
      finishIfDone();
    });
  });
}
