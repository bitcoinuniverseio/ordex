import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decipherRunestone, verifyRuneAllocation, verifyRuneBurnSafety } from '../dist/index.js';

const vectorsPath = fileURLToPath(
  new URL('../../conformance/rune-burn-vectors.json', import.meta.url)
);
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

// The SDK port and the repository root verifier both run this exact vector
// file, so the two implementations cannot drift apart silently.
// A vector with an expected allocation checks verifyRuneAllocation, the rest burn safety.
for (const vector of vectors.cases.filter((c) => c.expectedAllocation)) {
  test(`vector: ${vector.name}`, () => {
    const verdict = verifyRuneAllocation(vector.outputScriptsHex, vector.inputs, vector.expectedAllocation, vector.mint ? { mint: vector.mint } : {});
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    assert.equal(verdict.ok ? undefined : verdict.code, vector.expected.code, verdict.reason || '');
  });
}

for (const vector of vectors.cases.filter((c) => !c.expectedAllocation)) {
  test(`vector: ${vector.name}`, () => {
    const verdict = verifyRuneBurnSafety(
      vector.outputScriptsHex,
      vector.inputs,
      vector.outputCount
    );
    assert.equal(verdict.safe, vector.expected.safe, verdict.reason || '');
    assert.equal(verdict.runestone, vector.expected.runestone);
    if (vector.expected.safe) {
      assert.equal(verdict.code, undefined);
    } else {
      assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
      // Only a cenotaph has flaws; an allocation burn is a readable runestone.
      if (vector.expected.flaw) {
        assert.ok(
          verdict.flaws.includes(vector.expected.flaw),
          `expected flaw ${vector.expected.flaw}, got ${verdict.flaws.join(', ')}`
        );
      }
    }
  });
}

test('edict amounts survive as exact integers', () => {
  // A rune amount is a u128. Reading one through a JavaScript number would
  // silently round a large balance, so the reader must return BigInt.
  const single = vectors.cases.find((c) => c.name === 'single-edict');
  const runestone = decipherRunestone(single.outputScriptsHex, single.outputCount);
  assert.equal(runestone.kind, 'RUNESTONE');
  assert.equal(typeof runestone.edicts[0].amount, 'bigint');
  assert.equal(runestone.edicts[0].amount, 500n);
  assert.equal(runestone.edicts[0].id.block, 840000n);
  assert.equal(runestone.edicts[0].id.tx, 1n);
});
