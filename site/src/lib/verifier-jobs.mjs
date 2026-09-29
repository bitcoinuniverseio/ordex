// OX-S07: bounded verifier jobs. The dedicated Worker (verifier-worker.mjs) runs these;
// the same pure function is exercised directly by Node tests, so the browser and CLI
// share one execution path.

import { runConformanceSuite, executeVector, evaluateCandidate, compareExpected, isKnownFamily, ConformanceError } from './conformance-engine.mjs';

export const JOB_LIMITS = Object.freeze({
  maxCases: 5000,
  maxInputBytes: 2 * 1024 * 1024
});

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value ?? null)).length;
}

/**
 * Run one job:
 *   { type: 'suite', familiesData, families? }
 *   { type: 'case', family, vectorCase }
 *   { type: 'candidate', family, variant, args }
 * `progress` is called with { completed, total } during suites.
 */
export function handleVerifierJob(job, progress = () => {}) {
  if (!job || typeof job !== 'object') throw new ConformanceError('MALFORMED_JOB', 'A verifier job must be an object.');
  if (byteLength(job) > JOB_LIMITS.maxInputBytes * 4) {
    throw new ConformanceError('INPUT_TOO_LARGE', 'The job exceeds the verifier input bound.');
  }
  switch (job.type) {
    case 'suite': {
      const families = job.families || Object.keys(job.familiesData || {});
      let total = 0;
      for (const f of families) total += (job.familiesData?.[f]?.cases || []).length;
      if (total > JOB_LIMITS.maxCases) throw new ConformanceError('INPUT_TOO_LARGE', `A suite may hold at most ${JOB_LIMITS.maxCases} cases.`);
      progress({ completed: 0, total });
      const result = runConformanceSuite(job.familiesData, families);
      progress({ completed: result.total, total });
      return result;
    }
    case 'case': {
      if (!isKnownFamily(job.family)) throw new ConformanceError('UNKNOWN_FAMILY', `Unsupported verifier family: ${job.family}`);
      return executeVector(job.family, job.vectorCase);
    }
    case 'candidate': {
      if (byteLength(job.args) > JOB_LIMITS.maxInputBytes) {
        throw new ConformanceError('INPUT_TOO_LARGE', `Candidate input exceeds ${JOB_LIMITS.maxInputBytes} bytes.`);
      }
      const result = evaluateCandidate(job.family, job.variant, job.args);
      // A conformance comparison is reported separately and only when the caller supplies
      // the vector's expectation; the candidate verdict never depends on it.
      if (job.expected !== undefined) {
        result.conformance = result.raw ? compareExpected(job.family, job.expected, result.raw) : { passed: false, mismatches: [{ field: 'execution', expected: 'verdict', actual: result.verdict.reason }] };
      }
      return result;
    }
    default:
      throw new ConformanceError('MALFORMED_JOB', `Unknown verifier job type: ${job.type}`);
  }
}
