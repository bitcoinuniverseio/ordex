// OX-S07: dedicated verifier Worker. It has no network or DOM access and answers exactly
// one job per instance; the page terminates it on completion, timeout or cancel.

import { handleVerifierJob } from './verifier-jobs.mjs';

self.onmessage = (event) => {
  const { id, job } = event.data || {};
  try {
    const result = handleVerifierJob(job, (p) => self.postMessage({ id, type: 'progress', ...p }));
    self.postMessage({ id, type: 'result', result });
  } catch (err) {
    self.postMessage({
      id,
      type: 'error',
      error: { code: err?.code || 'VERIFIER_JOB_FAILED', message: String(err?.message || err) }
    });
  }
};
