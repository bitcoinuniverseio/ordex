// OX-S07: page-side runner for verifier jobs. Each job gets its own dedicated Worker so
// the UI thread stays responsive, and a timeout or cancel terminates that Worker outright.

export const DEFAULT_TIMEOUT_MS = 15000;

export class VerifierJobError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VerifierJobError';
    this.code = code;
  }
}

function defaultCreateWorker() {
  if (typeof Worker === 'undefined') {
    throw new VerifierJobError('WORKER_UNAVAILABLE', 'This browser cannot start a Web Worker, so verifiers cannot run here.');
  }
  return new Worker(new URL('./verifier-worker.mjs', import.meta.url), { type: 'module', name: 'ordex-verifier' });
}

let nextId = 1;

/**
 * Run a job in a fresh Worker.
 * @param {object} job see verifier-jobs.mjs
 * @param {{ timeoutMs?: number, signal?: AbortSignal, onProgress?: (p: {completed:number,total:number}) => void,
 *   createWorker?: () => Worker }} [options]
 */
export function runVerifierJob(job, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, onProgress, createWorker = defaultCreateWorker } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new VerifierJobError('VERIFIER_CANCELLED', 'The verifier run was cancelled.'));
      return;
    }
    let worker;
    try {
      worker = createWorker();
    } catch (err) {
      reject(err instanceof VerifierJobError ? err : new VerifierJobError('WORKER_UNAVAILABLE', String(err?.message || err)));
      return;
    }
    const id = nextId++;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      try {
        worker.terminate();
      } catch {
        // already gone
      }
      fn(value);
    };
    const onAbort = () => finish(reject, new VerifierJobError('VERIFIER_CANCELLED', 'The verifier run was cancelled.'));
    const timer = setTimeout(
      () => finish(reject, new VerifierJobError('VERIFIER_TIMEOUT', `The verifier did not finish within ${timeoutMs} ms.`)),
      timeoutMs
    );
    signal?.addEventListener?.('abort', onAbort, { once: true });
    worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.id !== id) return;
      if (msg.type === 'progress') onProgress?.({ completed: msg.completed, total: msg.total });
      else if (msg.type === 'result') finish(resolve, msg.result);
      else if (msg.type === 'error') finish(reject, new VerifierJobError(msg.error?.code || 'VERIFIER_JOB_FAILED', msg.error?.message || 'Verifier job failed.'));
    };
    worker.onerror = (event) => {
      event?.preventDefault?.();
      finish(reject, new VerifierJobError('VERIFIER_WORKER_ERROR', String(event?.message || 'The verifier Worker failed to load.')));
    };
    worker.postMessage({ id, job });
  });
}
