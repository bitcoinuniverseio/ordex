import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  OFFER_TERMS_SCHEMA,
  offerTermsHash,
  sortedJson,
  verifyOfferAcceptance,
  verifyOfferRecovery,
  verifyOfferTerms,
} from '../dist/index.js';

const vectorsPath = fileURLToPath(new URL('../../conformance/offer-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

const termsCases = vectors.cases.filter((c) => c.kind === 'terms');
const acceptanceCases = vectors.cases.filter((c) => c.kind === 'acceptance');
const recoveryCases = vectors.cases.filter((c) => c.kind === 'recovery');

test('the SDK answers every conformance case exactly as recorded', async (t) => {
  for (const vector of termsCases) {
    await t.test(`terms: ${vector.name}`, () => {
      const verdict = verifyOfferTerms(vector.terms);
      assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
      if (verdict.ok) assert.equal(verdict.offerTermsHash, vector.expected.offerTermsHash);
      else assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
    });
  }
  for (const vector of acceptanceCases) {
    await t.test(`acceptance: ${vector.name}`, () => {
      const verdict = verifyOfferAcceptance(vector.acceptance, vector.offer);
      assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
      if (verdict.ok) assert.equal(verdict.sharedIndex, vector.expected.sharedIndex);
      else assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
    });
  }
  for (const vector of recoveryCases) {
    await t.test(`recovery: ${vector.name}`, () => {
      const verdict = verifyOfferRecovery(vector.recovery, vector.offer);
      assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
      if (!verdict.ok) assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
    });
  }
});

test('the SDK hash matches the recorded hash and is key order independent', () => {
  const terms = termsCases.find((c) => c.expected.ok === true).terms;
  assert.equal(offerTermsHash(terms), vectors.termsHash);
  const reordered = Object.fromEntries(Object.entries(terms).reverse());
  assert.equal(offerTermsHash(reordered), offerTermsHash(terms));
  assert.equal(sortedJson({ b: 1, a: { d: 2, c: undefined } }), '{"a":{"d":2},"b":1}');
});

test('an unknown field is refused rather than ignored', () => {
  const terms = { ...termsCases[0].terms, extra: 1 };
  assert.equal(verifyOfferTerms(terms).code, 'MALFORMED_TERMS');
  assert.equal(OFFER_TERMS_SCHEMA, 'ordex.offer-terms/v1');
});
