import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SWAP_INTENT_SCHEMA, parseSats, swapIntentDigest, verifySwapAcceptance, verifySwapIntent } from './swaps.js';

const vectorsPath = fileURLToPath(new URL('../conformance/swap-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

test('the vector file names at least one accepting and one refusing case', () => {
  assert.ok(vectors.cases.some((c) => c.expected.ok === true));
  assert.ok(vectors.cases.some((c) => c.expected.ok === false));
});

for (const vector of vectors.cases) {
  test(`vector: ${vector.name}`, () => {
    if (!vector.acceptance) {
      const verdict = verifySwapIntent(vector.intent);
      assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
      if (vector.expected.ok) assert.equal(verdict.digest, vector.intent.digest);
      else assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
      return;
    }
    const verdict = verifySwapAcceptance(vector.acceptance, vector.intent);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (!vector.expected.ok) assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
  });
}

test('the intent schema name is stable', () => {
  assert.equal(SWAP_INTENT_SCHEMA, 'ordex.swap-intent/v1');
});

test('the digest excludes the identity proof and the digest itself', () => {
  const intent = { schema: SWAP_INTENT_SCHEMA, nonce: 'n1', digest: 'x' };
  const withProof = { ...intent, makerIdentityProof: { kind: 'bip322', address: 'bc1q', signature: 'sig' } };
  assert.equal(swapIntentDigest(intent), swapIntentDigest(withProof));
});

test('an acceptance plan against a refused intent is refused', () => {
  const verdict = verifySwapAcceptance({ schema: 'ordex.swap-acceptance-plan/v1' }, { schema: 'ordex.swap-intent/v1' });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'PROTOCOL_UNSUPPORTED');
});

test('a malformed acceptance is refused, never thrown on', () => {
  assert.equal(verifySwapAcceptance(null, null).ok, false);
  assert.equal(verifySwapAcceptance({}, {}).code, 'SCHEMA_UNSUPPORTED');
});

test('parseSats accepts only exact non-negative decimal strings', () => {
  assert.equal(parseSats('0'), 0n);
  assert.equal(parseSats('546'), 546n);
  for (const bad of ['', '-1', '1.5', '01', null, 546]) {
    assert.equal(parseSats(bad), null, `expected ${String(bad)} to be refused`);
  }
});
