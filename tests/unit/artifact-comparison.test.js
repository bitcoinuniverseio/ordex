import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArtifact, parsePsbtBytes, payloadToBytes, serializePsbt, serializeTransaction, bytesToHex } from '../../site/src/lib/artifacts/parser.js';
import { compareParsedArtifacts, deriveFee, purchaseCandidateFrom } from '../../site/src/lib/artifacts/comparison.js';
import { MUTATION_FIXTURES } from '../../site/src/lib/artifacts/mutation-fixtures.js';
import * as bip from '../../site/src/lib/artifacts/bip-fixtures.js';
import { evaluateCandidate } from '../../site/src/lib/conformance-engine.mjs';

// OX-S01 (PROPOSED NEW): semantic comparison must catch every equal-size mutation and never
// call different bytes identical.

const vectors = JSON.parse(await readFile(new URL('../fixtures/psbt/bip-vectors.json', import.meta.url), 'utf8'));
const compare = (a, b) => compareParsedArtifacts(parseArtifact(a), parseArtifact(b));

test('Lens fixtures are verbatim BIP174 vectors', () => {
  const roles = vectors.bip174.roleSequence;
  assert.equal(bip.UPDATED_WITH_SIGHASH, roles[2].hex);
  assert.equal(bip.SIGNED_BY_FIRST_SIGNER, roles[3].hex);
  assert.equal(bip.COMBINED, roles[5].hex);
  assert.equal(bip.FINALIZED, roles[6].hex);
  assert.equal(bip.UNKNOWN_FIELDS_ONE, roles[7].hex);
  assert.equal(bip.UNKNOWN_FIELDS_COMBINED, roles[9].hex);
  assert.equal(bip.EXTRACTED_TX, vectors.bip174.extractedTransaction);
});

test('every mutation fixture decodes and yields exactly the change its title names', () => {
  for (const f of MUTATION_FIXTURES) {
    const a = parseArtifact(f.rawFixtureHexA);
    const b = parseArtifact(f.rawFixtureHexB);
    assert.equal(a.status, 'decoded', f.id);
    assert.equal(b.status, 'decoded', f.id);
    const report = compareParsedArtifacts(a, b);
    const hit = report.differences.find((d) => d.id.startsWith(f.expectedDifferenceId));
    assert.ok(hit, `${f.id} did not produce ${f.expectedDifferenceId}: ${report.differences.map((d) => d.id).join(', ')}`);
    assert.equal(hit.severity, f.expectedSeverity, f.id);
  }
});

test('an output amount change of equal size is DANGEROUS, never identical or safe', () => {
  const f = MUTATION_FIXTURES.find((x) => x.id === 'mut-amount-plus-one');
  assert.equal(f.rawFixtureHexA.length, f.rawFixtureHexB.length);
  const report = compare(f.rawFixtureHexA, f.rawFixtureHexB);
  assert.equal(report.overallVerdict, 'DANGEROUS');
  assert.equal(report.byteIdentical, false);
  assert.ok(!report.differences.some((d) => /Safe to proceed/.test(d.nextAction)));
  assert.notEqual(report.artifactASha256, report.artifactBSha256);
});

test('reproduces handoff case OX-S01-R02: 1000 to 2000 sats with unchanged size is caught', () => {
  const base = parsePsbtBytes(payloadToBytes(bip.UPDATED_WITH_SIGHASH));
  const tx = JSON.parse(JSON.stringify(base.transaction));
  tx.outputs[1].valueSats = '1000';
  const withAmount = (sats) => {
    const t = JSON.parse(JSON.stringify(tx));
    t.outputs[1].valueSats = sats;
    const maps = { globalMap: { ...base.globalMap, entries: base.globalMap.entries.map((e) => (e.keyType === 0 ? { ...e, valueData: serializeTransaction(t) } : e)) }, inputMaps: base.inputMaps, outputMaps: base.outputMaps };
    return bytesToHex(serializePsbt(maps));
  };
  const a = withAmount('1000');
  const b = withAmount('2000');
  assert.equal(a.length, b.length);
  const report = compare(a, b);
  assert.equal(report.overallVerdict, 'DANGEROUS');
  assert.ok(report.differences.some((d) => d.id === 'diff-output-1-amount' && d.beforeValue === '1000 sats' && d.afterValue === '2000 sats'));
});

test('digests are real SHA-256 over the original bytes', () => {
  const f = MUTATION_FIXTURES.find((x) => x.id === 'mut-script-byte');
  const report = compare(f.rawFixtureHexA, f.rawFixtureHexB);
  assert.equal(report.artifactASha256, createHash('sha256').update(Buffer.from(f.rawFixtureHexA, 'hex')).digest('hex'));
  assert.equal(report.artifactBSha256, createHash('sha256').update(Buffer.from(f.rawFixtureHexB, 'hex')).digest('hex'));
});

test('identical bytes are the only IDENTICAL verdict', () => {
  const same = compare(bip.UPDATED_WITH_SIGHASH, bip.UPDATED_WITH_SIGHASH);
  assert.equal(same.overallVerdict, 'IDENTICAL');
  assert.equal(same.byteIdentical, true);
  for (const f of MUTATION_FIXTURES.filter((x) => x.id !== 'mut-preserve')) {
    assert.notEqual(compare(f.rawFixtureHexA, f.rawFixtureHexB).overallVerdict, 'IDENTICAL', f.id);
  }
});

test('undecodable input is UNKNOWN and inconclusive', () => {
  const report = compare(bip.UPDATED_WITH_SIGHASH, '70736274ff00');
  assert.equal(report.overallVerdict, 'UNKNOWN');
  assert.equal(report.conclusive, false);
  assert.equal(report.byteIdentical, false);
  const both = compare('00', '00');
  assert.equal(both.overallVerdict, 'UNKNOWN');
});

test('signer and finalizer changes are expected additions, stripped unknown fields need review', () => {
  assert.equal(compare(bip.UPDATED_WITH_SIGHASH, bip.SIGNED_BY_FIRST_SIGNER).overallVerdict, 'EXPECTED_SIGNER_ADDITIONS');
  assert.equal(compare(bip.COMBINED, bip.FINALIZED).overallVerdict, 'EXPECTED_SIGNER_ADDITIONS');
  assert.equal(compare(bip.FINALIZED, bip.EXTRACTED_TX).overallVerdict, 'EXPECTED_SIGNER_ADDITIONS');
  const stripped = compare(bip.UNKNOWN_FIELDS_COMBINED, bip.UNKNOWN_FIELDS_ONE);
  assert.equal(stripped.overallVerdict, 'REVIEW_REQUIRED');
  assert.ok(stripped.differences.some((d) => d.id.startsWith('Input 0-removed-')), 'dropped fields are reported per map');
});

test('fees come only from prevout amounts the artifact carries', () => {
  const psbt = parseArtifact(bip.UPDATED_WITH_SIGHASH);
  assert.match(deriveFee(psbt).fee, /^\d+$/);
  const raw = parseArtifact(bip.EXTRACTED_TX);
  assert.equal(deriveFee(raw).fee, null);
  assert.match(deriveFee(raw).reason, /Prevout amounts are missing/);
  assert.equal(purchaseCandidateFrom(raw), null, 'no purchase check without prevout amounts');
});

test('purchase invariants run on decoded values through the real verifier', () => {
  const psbt = parseArtifact(bip.UPDATED_WITH_SIGHASH);
  const candidate = purchaseCandidateFrom(psbt);
  assert.ok(candidate);
  const order = {
    offeredOutpoint: { txid: psbt.inputs[0].txid, vout: psbt.inputs[0].vout },
    sellerPaymentScriptHex: psbt.outputs[0].scriptHex,
    sellerPaymentValueSats: psbt.outputs[0].valueSats
  };
  const ok = evaluateCandidate('purchase', 'completion', { transaction: candidate.transaction, order });
  assert.ok(['accepted', 'refused'].includes(ok.verdict.state));
  const wrongPrice = evaluateCandidate('purchase', 'completion', { transaction: candidate.transaction, order: { ...order, sellerPaymentValueSats: '1' } });
  assert.equal(wrongPrice.verdict.code, 'SELLER_VALUE_MISMATCH');
});
