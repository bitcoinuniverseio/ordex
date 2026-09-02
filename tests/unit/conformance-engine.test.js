import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAMILIES, loadVectorFamily, executeVector } from '../../site/src/lib/conformance-engine.mjs';

test('conformance-engine exports all 9 vector families', () => {
  assert.equal(FAMILIES.length, 9);
  assert.ok(FAMILIES.includes('purchase'));
  assert.ok(FAMILIES.includes('offers'));
  assert.ok(FAMILIES.includes('runes'));
  assert.ok(FAMILIES.includes('safeops'));
  assert.ok(FAMILIES.includes('swaps'));
  assert.ok(FAMILIES.includes('events'));
  assert.ok(FAMILIES.includes('collection-manifest'));
  assert.ok(FAMILIES.includes('counterparty-asset'));
  assert.ok(FAMILIES.includes('offline-signing'));
});

test('loadVectorFamily loads purchase vectors properly', () => {
  const vectors = loadVectorFamily('purchase');
  assert.ok(vectors.length > 0);
  const first = vectors[0];
  assert.equal(first.family, 'purchase');
  assert.ok(first.expected);
});

test('executeVector accurately passes an accepted purchase vector', () => {
  const vectors = loadVectorFamily('purchase');
  const validCase = vectors.find((v) => v.expected?.ok === true);
  assert.ok(validCase);

  const res = executeVector('purchase', validCase);
  assert.equal(res.passed, true);
  assert.equal(res.actual.ok, true);
});

test('executeVector accurately identifies a refused shortfall vector', () => {
  const vectors = loadVectorFamily('purchase');
  const refusedCase = vectors.find((v) => v.expected?.ok === false && v.expected?.code === 'SAT_FLOW_SHORTFALL');
  assert.ok(refusedCase);

  const res = executeVector('purchase', refusedCase);
  assert.equal(res.passed, true);
  assert.equal(res.actual.ok, false);
  assert.equal(res.actual.code, 'SAT_FLOW_SHORTFALL');
});
