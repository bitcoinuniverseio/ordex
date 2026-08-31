import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseSats, verifyPublicAskCompletion } from './purchase.js';

const vectorsPath = fileURLToPath(new URL('../conformance/purchase-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

test('the vector file names at least one accepting and one refusing case', () => {
  assert.ok(vectors.cases.some((c) => c.expected.ok === true));
  assert.ok(vectors.cases.some((c) => c.expected.ok === false));
});

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

test('parseSats accepts only exact non-negative decimal strings', () => {
  assert.equal(parseSats('0'), 0n);
  assert.equal(parseSats('546'), 546n);
  assert.equal(parseSats('340282366920938463463374607431768211455'), 2n ** 128n - 1n);
  for (const bad of ['', '-1', '1.5', '01', '1e3', ' 546', '546 ', null, undefined, 546, 546n]) {
    assert.equal(parseSats(bad), null, `expected ${String(bad)} to be refused`);
  }
});

test('a malformed transaction or order is refused, never thrown on', () => {
  assert.equal(verifyPublicAskCompletion(null, null).ok, false);
  assert.equal(verifyPublicAskCompletion({}, {}).ok, false);
  assert.equal(
    verifyPublicAskCompletion({ inputs: [], outputs: [] }, { offeredOutpoint: { txid: 'a', vout: 0 } }).code,
    'MALFORMED_ORDER',
  );
});
