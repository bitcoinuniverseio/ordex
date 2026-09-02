import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SWAP_ACCEPTANCE_SCHEMA,
  SWAP_INTENT_SCHEMA,
  swapIntentDigest,
  verifySwapAcceptance,
  verifySwapIntent,
} from '../dist/index.js';

const vectorsPath = fileURLToPath(new URL('../../conformance/swap-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

test('the vector file names at least one accepting and one refusing case', () => {
  assert.ok(vectors.cases.some((c) => c.expected.ok === true));
  assert.ok(vectors.cases.some((c) => c.expected.ok === false));
});

for (const vector of vectors.cases) {
  test(`vector: ${vector.name}`, () => {
    const verdict = vector.acceptance
      ? verifySwapAcceptance(vector.acceptance, vector.intent)
      : verifySwapIntent(vector.intent);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (vector.expected.ok) {
      if ('digest' in vector.expected) assert.equal(verdict.digest, vector.expected.digest);
    } else {
      assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
    }
  });
}

test('the schema names are stable', () => {
  assert.equal(SWAP_INTENT_SCHEMA, 'ordex.swap-intent/v1');
  assert.equal(SWAP_ACCEPTANCE_SCHEMA, 'ordex.swap-acceptance-plan/v1');
});

test('a malformed intent is refused, never thrown on', () => {
  assert.equal(verifySwapIntent(null).ok, false);
  assert.equal(verifySwapIntent([]).ok, false);
  assert.equal(verifySwapIntent({}).code, 'SCHEMA_UNSUPPORTED');
  assert.equal(verifySwapAcceptance(null, null).code, 'MALFORMED_ACCEPTANCE');
});

test('the intent digest excludes the digest and the maker identity proof', () => {
  const accepted = vectors.cases.find((c) => c.expected.ok && !c.acceptance && c.intent);
  const intent = accepted.intent;
  const reproofed = {
    ...intent,
    makerIdentityProof: { ...intent.makerIdentityProof, signature: 'a different signature over the same content' },
  };
  assert.equal(
    swapIntentDigest(reproofed),
    intent.digest,
    're-signing the same intent must not move its digest',
  );
  const moved = { ...intent, expiryHeight: intent.expiryHeight + 1 };
  assert.notEqual(swapIntentDigest(moved), intent.digest, 'a changed term must move the digest');
});

test('the accepted acceptance vector replays against its digest', () => {
  const accepted = vectors.cases.find((c) => c.acceptance && c.expected.ok);
  const intentVerdict = verifySwapIntent(accepted.intent);
  assert.equal(intentVerdict.ok, true);
  assert.equal(accepted.acceptance.intentDigest, intentVerdict.digest);
  assert.equal(verifySwapAcceptance(accepted.acceptance, accepted.intent).ok, true);
});
