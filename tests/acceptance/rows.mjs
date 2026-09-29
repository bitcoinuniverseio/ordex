// Acceptance row recorder (Documentation coverage rows OX-S-C*). Each browser check proves the
// rows that name exactly the operation it exercised. A check records PASS with what it saw, or
// FAIL with the error; the test fails when any row fails. Every record is printed as one
// `ORDEX-ROW {json}` line so the CI log carries the per-row results with the run and commit.

import { execFileSync } from 'node:child_process';

let revision = process.env.GITHUB_SHA || null;
if (!revision) {
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    revision = 'unknown';
  }
}

export function rowRecorder(file) {
  const rows = [];
  const emit = (r) => {
    const line = { ...r, file, revision, runId: process.env.GITHUB_RUN_ID || null, at: new Date().toISOString() };
    rows.push(line);
    console.log(`ORDEX-ROW ${JSON.stringify(line)}`);
  };
  return {
    rows,
    /** Run `fn` for the rows it proves; its return value is the observed result. */
    async check(ids, operation, fn, { evidenceClass = 'browser-gate', timeoutMs = 600000 } = {}) {
      const list = Array.isArray(ids) ? ids : [ids];
      console.log(`ORDEX-ROW-START ${list.join(',')} ${operation}`);
      let timer;
      try {
        // A check that stops making progress fails its rows instead of stalling the run.
        const actual = await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no result within ${timeoutMs / 1000} s`)), timeoutMs)))]);
        clearTimeout(timer);
        for (const id of list) emit({ id, status: 'PASS', evidenceClass, operation, actual: actual ?? null });
        return actual;
      } catch (err) {
        clearTimeout(timer);
        for (const id of list) emit({ id, status: 'FAIL', evidenceClass, operation, error: String(err?.message || err).slice(0, 2000) });
        return undefined;
      }
    },
    /**
     * A row that is not a PASS by design: NOT APPLICABLE (the operation no longer exists, with
     * what was checked instead) or BLOCKED (a named prerequisite this gate cannot provide).
     */
    record(ids, status, operation, reason, actual = null) {
      for (const id of Array.isArray(ids) ? ids : [ids]) emit({ id, status, operation, reason, actual });
    },
    failures() {
      return rows.filter((r) => r.status === 'FAIL').map((r) => `${r.id}: ${r.error}`);
    }
  };
}

/** Throw unless `cond` holds, with the observed value in the message. */
export function expect(cond, message) {
  if (!cond) throw new Error(message);
}

import { readFileSync } from 'node:fs';

const ALL = JSON.parse(readFileSync(new URL('./documentation-rows.json', import.meta.url), 'utf8')).rows;

/** The Documentation rows of one product, in matrix order. */
export function rowsOf(product) {
  return ALL.filter((r) => r.product === product);
}
