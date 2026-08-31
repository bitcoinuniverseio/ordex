import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyPublicAskCompletion } from '../dist/index.js';

const vectorsPath = fileURLToPath(new URL('../../conformance/purchase-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

// The SDK port and the repository root verifier both run this exact vector
// file, so the two implementations cannot drift apart silently.
for (const vector of vectors.cases) {
  test(`vector: ${vector.name}`, () => {
    const verdict = verifyPublicAskCompletion(vector.transaction, vector.order);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (vector.expected.ok) {
      assert.equal(verdict.sharedIndex, vector.expected.sharedIndex);
    } else {
      assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
    }
  });
}
