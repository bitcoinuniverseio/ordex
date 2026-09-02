import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  OFFER_TERMS_SCHEMA,
  offerTermsHash,
  parseSats,
  sortedJson,
  verifyOfferAcceptance,
  verifyOfferRecovery,
  verifyOfferTerms,
} from './offers.js';

const vectorsPath = fileURLToPath(new URL('../conformance/offer-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

const termsCases = vectors.cases.filter((c) => c.kind === 'terms');
const acceptanceCases = vectors.cases.filter((c) => c.kind === 'acceptance');
const recoveryCases = vectors.cases.filter((c) => c.kind === 'recovery');

test('the vector file covers terms, acceptance, and recovery on both verdicts', () => {
  assert.ok(termsCases.some((c) => c.expected.ok === true));
  assert.ok(termsCases.some((c) => c.expected.ok === false));
  assert.ok(acceptanceCases.some((c) => c.expected.ok === true));
  assert.ok(acceptanceCases.some((c) => c.expected.ok === false));
  assert.ok(recoveryCases.some((c) => c.expected.ok === true));
  assert.ok(recoveryCases.some((c) => c.expected.ok === false));
});

for (const vector of termsCases) {
  test(`terms vector: ${vector.name}`, () => {
    const verdict = verifyOfferTerms(vector.terms);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (verdict.ok) {
      assert.equal(verdict.offerTermsHash, vector.expected.offerTermsHash);
    } else {
      assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
    }
  });
}

for (const vector of acceptanceCases) {
  test(`acceptance vector: ${vector.name}`, () => {
    const verdict = verifyOfferAcceptance(vector.acceptance, vector.offer);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (verdict.ok) {
      assert.equal(verdict.sharedIndex, vector.expected.sharedIndex);
    } else {
      assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
    }
  });
}

for (const vector of recoveryCases) {
  test(`recovery vector: ${vector.name}`, () => {
    const verdict = verifyOfferRecovery(vector.recovery, vector.offer);
    assert.equal(verdict.ok, vector.expected.ok, verdict.reason || '');
    if (!verdict.ok) {
      assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
    }
  });
}

test('the recorded terms hash equals a direct hash of the sorted terms', () => {
  const terms = termsCases.find((c) => c.expected.ok === true).terms;
  assert.equal(offerTermsHash(terms), vectors.termsHash);
  assert.equal(sortedJson(terms), sortedJson(JSON.parse(sortedJson(terms))));
});

test('the terms hash changes when any term changes', () => {
  const terms = termsCases.find((c) => c.expected.ok === true).terms;
  const changed = { ...terms, priceSats: `${Number(terms.priceSats) + 1}` };
  assert.notEqual(offerTermsHash(changed), offerTermsHash(terms));
  const reordered = {};
  for (const key of Object.keys(terms).reverse()) reordered[key] = terms[key];
  assert.equal(offerTermsHash(reordered), offerTermsHash(terms), 'key order must not change the hash');
});

test('sortedJson sorts recursively and drops undefined', () => {
  assert.equal(sortedJson({ b: 1, a: { d: 2, c: undefined } }), '{"a":{"d":2},"b":1}');
});

test('parseSats accepts only exact non-negative decimal strings', () => {
  assert.equal(parseSats('0'), 0n);
  assert.equal(parseSats('92000'), 92000n);
  for (const bad of ['', '-1', '1.5', '01', '1e3', ' 1', '1 ', null, undefined, 1, 1n]) {
    assert.equal(parseSats(bad), null, `expected ${String(bad)} to be refused`);
  }
});

test('a malformed acceptance or recovery is refused, never thrown on', () => {
  const offer = recoveryCases[0].offer;
  assert.equal(verifyOfferAcceptance(null, null).ok, false);
  assert.equal(verifyOfferAcceptance({}, { offerOutpoint: {}, felineOutpoint: {} }).code, 'MALFORMED_ACCEPTANCE');
  assert.equal(verifyOfferRecovery(null, offer).ok, false);
  assert.equal(verifyOfferRecovery({ inputs: [], outputs: [], nLockTime: 0 }, offer).code, 'OFFER_OUTPOINT_MISSING');
});

test('the schema constant names the version this verifier carries', () => {
  assert.equal(OFFER_TERMS_SCHEMA, 'ordex.offer-terms/v1');
});
