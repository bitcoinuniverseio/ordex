import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runVerifierJob } from '../../site/src/lib/verifier-client.mjs';
import { handleVerifierJob } from '../../site/src/lib/verifier-jobs.mjs';
import { loadAllFamilies } from '../../scripts/docs/vector-loader.mjs';

// A Worker stand-in that runs the real job handler asynchronously, so these tests exercise
// the client's message, timeout, cancel and termination logic against real verifier output.
function makeWorker({ delayMs = 0, hang = false, loadError = false } = {}) {
  const w = {
    terminated: false,
    onmessage: null,
    onerror: null,
    terminate() {
      this.terminated = true;
    },
    postMessage({ id, job }) {
      if (loadError) {
        setTimeout(() => w.onerror?.({ message: 'boom', preventDefault() {} }), 0);
        return;
      }
      if (hang) return;
      setTimeout(() => {
        if (w.terminated) return;
        try {
          const result = handleVerifierJob(job, (p) => w.onmessage?.({ data: { id, type: 'progress', ...p } }));
          w.onmessage?.({ data: { id, type: 'result', result } });
        } catch (err) {
          w.onmessage?.({ data: { id, type: 'error', error: { code: err.code, message: err.message } } });
        }
      }, delayMs);
    }
  };
  return w;
}

test('a suite job resolves with real results and reports progress, then the worker is terminated', async () => {
  let worker;
  const progress = [];
  const result = await runVerifierJob(
    { type: 'suite', familiesData: loadAllFamilies() },
    { createWorker: () => (worker = makeWorker()), onProgress: (p) => progress.push(p) }
  );
  assert.equal(result.total, 353);
  assert.equal(result.success, true);
  assert.ok(progress.length >= 1);
  assert.equal(worker.terminated, true);
});

test('a job error rejects with the verifier code', async () => {
  await assert.rejects(
    runVerifierJob({ type: 'candidate', family: 'safeops', variant: 'signed', args: { plan: {} } }, { createWorker: () => makeWorker() }),
    (err) => err.code === 'MISSING_ARGUMENTS'
  );
});

test('a hung worker is terminated at the timeout', async () => {
  let worker;
  await assert.rejects(
    runVerifierJob({ type: 'case' }, { timeoutMs: 30, createWorker: () => (worker = makeWorker({ hang: true })) }),
    (err) => err.code === 'VERIFIER_TIMEOUT'
  );
  assert.equal(worker.terminated, true);
});

test('cancel terminates the worker and rejects, and an already aborted signal never starts one', async () => {
  const controller = new AbortController();
  let worker;
  const pending = runVerifierJob({ type: 'case' }, { signal: controller.signal, createWorker: () => (worker = makeWorker({ hang: true })) });
  controller.abort();
  await assert.rejects(pending, (err) => err.code === 'VERIFIER_CANCELLED');
  assert.equal(worker.terminated, true);
  let created = false;
  await assert.rejects(
    runVerifierJob({ type: 'case' }, { signal: controller.signal, createWorker: () => ((created = true), makeWorker()) }),
    (err) => err.code === 'VERIFIER_CANCELLED'
  );
  assert.equal(created, false);
});

test('a worker that fails to load rejects instead of hanging', async () => {
  await assert.rejects(
    runVerifierJob({ type: 'case' }, { createWorker: () => makeWorker({ loadError: true }) }),
    (err) => err.code === 'VERIFIER_WORKER_ERROR'
  );
});

test('with no Worker support the run is refused, not run on the page thread', async () => {
  assert.equal(typeof globalThis.Worker === 'undefined' || typeof globalThis.Worker === 'function', true);
  const saved = globalThis.Worker;
  try {
    delete globalThis.Worker;
    await assert.rejects(runVerifierJob({ type: 'case' }), (err) => err.code === 'WORKER_UNAVAILABLE');
  } finally {
    if (saved) globalThis.Worker = saved;
  }
});
