import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bytesToHex, parseTransaction, serializeTransaction, unsignedCopy, verifyTaprootCommitment } from './bitcoin-tx.js';
import { membershipProofRoot, membershipRoot, buildMembershipProof } from './collection-manifest.js';
import {
  OFFER_EXPIRY_HEIGHT_MAX,
  OFFER_INTERNAL_KEY_HEX,
  buildTraitMemberProof,
  offerCriteriaHash,
  offerOutputTree,
  offerPolicySighash,
  verifyOfferAcceptance,
  verifyOfferRecovery,
  verifyOfferTerms,
} from './offers.js';
import { liftX, verifySchnorr } from './secp256k1.js';

// OX-P05: funded offer delivery and recovery, proved from transaction bytes.
// Bitcoin Core's own script verdicts for every vector transaction were
// recorded by conformance/script-differential/run.mjs.

const read = (path) => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));
const vectors = read('../conformance/offer-vectors.json');
const consensus = read('../conformance/script-differential/libbitcoinconsensus-26.0-results.json').cases;
const clone = (value) => JSON.parse(JSON.stringify(value));
const find = (kind, name) => {
  const found = vectors.cases.find((c) => c.kind === kind && c.name === name);
  assert.ok(found, `${kind}: ${name}`);
  return found;
};
const validAcceptance = find('acceptance', 'a valid ITEM acceptance settles through both policy signers');
const validTrait = find('acceptance', 'a valid TRAIT acceptance proves the Feline against the committed trait set');
const validRecovery = find('recovery', 'a valid recovery at the expiry height passes');
const itemTerms = validAcceptance.offer.terms;

const withTx = (acceptance, mutate) => {
  const { tx } = parseTransaction(acceptance.transactionHex);
  mutate(tx);
  return { ...clone(acceptance), transactionHex: bytesToHex(serializeTransaction(tx)) };
};

// Refusals caused by a script rule, which the node refuses too. Every other
// refusal is an Ordex rule on a transaction the node would confirm.
const SCRIPT_FAILURES = {
  acceptance: new Set([
    'POLICY_SIGNATURES_MISSING',
    'POLICY_SIGNATURE_INVALID',
    'ACCEPTANCE_LEAF_MISMATCH',
    'CONTROL_BLOCK_MISMATCH',
    'SIGNATURE_MISSING',
    'SIGNATURE_INVALID',
    'BUYER_INPUT_UNAUTHORIZED',
  ]),
  recovery: new Set(['RECOVERY_BEFORE_EXPIRY', 'LOCKTIME_INVALID', 'SEQUENCE_FINAL', 'RECOVERY_LEAF_MISMATCH', 'CONTROL_BLOCK_MISMATCH', 'SIGNATURE_MISSING', 'SIGNATURE_INVALID']),
};

test('Bitcoin Core script verification agrees with every vector transaction verdict', () => {
  let compared = 0;
  for (const c of vectors.cases) {
    const record = consensus[`${c.kind}: ${c.name}`];
    if (!record) continue;
    compared += 1;
    const txHex = c.kind === 'acceptance' ? c.acceptance.transactionHex : c.recovery.transactionHex;
    assert.equal(record.txHex, txHex, `${c.name}: the recorded transaction is stale; rerun conformance/script-differential/run.mjs`);
    const allValid = record.inputs.every((v) => v === 'VALID');
    if (c.expected.ok) assert.ok(allValid, `${c.name}: consensus refused a transaction the verifier accepts`);
    else if (SCRIPT_FAILURES[c.kind].has(c.expected.code)) assert.ok(!allValid, `${c.name}: consensus accepted a ${c.expected.code} transaction`);
    else assert.ok(allValid, `${c.name}: ${c.expected.code} should refuse a transaction the node would confirm`);
  }
  assert.ok(compared >= 45, `only ${compared} transactions were compared`);
});

test('P-R14: the Feline satpoint, not a buyer script ahead of the payment, decides delivery', () => {
  const vector = find('acceptance', 'a buyer script ahead of the payment that does not receive the Feline is refused');
  const { tx } = parseTransaction(vector.acceptance.transactionHex);
  const sellerIndex = tx.outputs.findIndex((o) => o.scriptHex === vector.acceptance.seller.paymentScriptHex);
  const buyerAhead = tx.outputs.slice(0, sellerIndex).filter((o) => o.scriptHex === itemTerms.buyerReceiveScriptHex);
  assert.equal(buyerAhead.length, 1, 'the old check saw exactly one buyer output ahead of the payment');
  const verdict = verifyOfferAcceptance(vector.acceptance, vector.offer);
  assert.equal(verdict.code, 'FELINE_NOT_DELIVERED', verdict.reason);
  assert.match(verdict.reason, /output 0/);
  const ok = verifyOfferAcceptance(validAcceptance.acceptance, validAcceptance.offer);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.buyerAssetOutputIndex, 0);
});

test('P-R15: the recovery locktime, its domain and the sequence are read from the bytes', () => {
  assert.equal(verifyOfferRecovery(validRecovery.recovery, validRecovery.offer).ok, true);
  assert.equal(find('recovery', 'a recovery with no locktime is refused').expected.code, 'RECOVERY_BEFORE_EXPIRY');
  const legacy = find('recovery', 'the unversioned v1 recovery shape is refused');
  assert.equal(legacy.recovery.nLockTime, undefined);
  assert.equal(verifyOfferRecovery(legacy.recovery, legacy.offer).code, 'SCHEMA_UNSUPPORTED');
  for (const [name, code] of [
    ['a recovery one block before expiry is refused', 'RECOVERY_BEFORE_EXPIRY'],
    ['a timestamp locktime is refused', 'LOCKTIME_INVALID'],
    ['a final sequence is refused because it disables the locktime', 'SEQUENCE_FINAL'],
  ]) {
    const vector = find('recovery', name);
    assert.equal(verifyOfferRecovery(vector.recovery, vector.offer).code, code, name);
  }
});

test('P-R16: expiry stays a height below the locktime timestamp threshold', () => {
  assert.equal(OFFER_EXPIRY_HEIGHT_MAX, 499999999);
  assert.equal(verifyOfferTerms({ ...itemTerms, expiryHeight: 499999999 }).ok, true);
  for (const bad of [500000000, 2147483647, -1, 1.5, Number.NaN, '900100', null]) {
    assert.equal(verifyOfferTerms({ ...itemTerms, expiryHeight: bad }).code, 'TERMS_EXPIRY_INVALID', String(bad));
  }
});

test('the recovery leaf pushes the expiry as a minimal script number', () => {
  const key = itemTerms.buyerRecoveryKeyHex;
  const keys = validAcceptance.offer.policyKeysHex;
  for (const [height, push] of [
    [0, '00'],
    [1, '51'],
    [16, '60'],
    [17, '0111'],
    [127, '017f'],
    [128, '028000'],
    [255, '02ff00'],
    [256, '020001'],
    [32767, '02ff7f'],
    [32768, '03008000'],
    [120000, '03c0d401'],
    [8388608, '0400008000'],
    [499999999, '04ff64cd1d'],
  ]) {
    const tree = offerOutputTree({ ...itemTerms, expiryHeight: height }, keys);
    assert.equal(tree.recoveryLeafHex, `${push}b17520${key}ac`, String(height));
  }
});

test('the funded output commits both exact leaves to the unspendable internal key', () => {
  const { terms, policyKeysHex, fundedOutput } = validAcceptance.offer;
  const tree = offerOutputTree(terms, policyKeysHex);
  assert.equal(tree.ok, true, tree.reason);
  assert.equal(OFFER_INTERNAL_KEY_HEX, '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
  assert.ok(liftX(BigInt(`0x${OFFER_INTERNAL_KEY_HEX}`)));
  assert.equal(tree.internalKeyHex, OFFER_INTERNAL_KEY_HEX);
  assert.equal(tree.acceptanceLeafHex, `20${tree.offerTermsHash}7520${policyKeysHex[0]}ac20${policyKeysHex[1]}ba5287`);
  assert.equal(fundedOutput.scriptPubKeyHex, tree.scriptPubKeyHex);
  for (const [leaf, control] of [
    [tree.acceptanceLeafHex, tree.acceptanceControlBlockHex],
    [tree.recoveryLeafHex, tree.recoveryControlBlockHex],
  ]) {
    const commitment = verifyTaprootCommitment(tree.outputKeyHex, leaf, control);
    assert.equal(commitment.ok, true);
    assert.equal(commitment.internalKey, OFFER_INTERNAL_KEY_HEX);
  }
  const otherTerms = offerOutputTree({ ...terms, priceSats: '1' }, policyKeysHex);
  assert.notEqual(otherTerms.scriptPubKeyHex, tree.scriptPubKeyHex, 'every term changes the address');
});

test('the two policy keys must be distinct valid keys, neither the buyer recovery key', () => {
  const [a, b] = validAcceptance.offer.policyKeysHex;
  for (const keys of [[a], [a, a], [a, itemTerms.buyerRecoveryKeyHex], [a, OFFER_INTERNAL_KEY_HEX], [a, 'f'.repeat(64)], [a, b, a], 'x', null]) {
    assert.equal(offerOutputTree(itemTerms, keys).code, 'POLICY_KEYS_INVALID', JSON.stringify(keys));
  }
});

test('each policy signer signs the one hash offerPolicySighash states, and no signature is assumed', () => {
  const { acceptance, offer } = validAcceptance;
  const signed = parseTransaction(acceptance.transactionHex).tx;
  const unsigned = { ...clone(acceptance), transactionHex: bytesToHex(serializeTransaction(unsignedCopy(signed))) };
  const review = offerPolicySighash(unsigned, offer);
  assert.equal(review.ok, true, review.reason);
  assert.equal(review.offerInputIndex, 1);
  assert.deepEqual(offerPolicySighash(acceptance, offer), review, 'signatures never change the policy hash');
  const [sigB, sigA] = signed.inputs[1].witness;
  const digest = Buffer.from(review.sighashHex, 'hex');
  assert.ok(verifySchnorr(digest, Buffer.from(sigA, 'hex'), Buffer.from(offer.policyKeysHex[0], 'hex')));
  assert.ok(verifySchnorr(digest, Buffer.from(sigB, 'hex'), Buffer.from(offer.policyKeysHex[1], 'hex')));
  assert.ok(!verifySchnorr(digest, Buffer.from(sigA, 'hex'), Buffer.from(offer.policyKeysHex[1], 'hex')), 'the keys are separate');

  assert.equal(verifyOfferAcceptance(unsigned, offer).code, 'SIGNATURE_MISSING');
  const noSeller = withTx(acceptance, (tx) => {
    tx.inputs[0].witness = [];
  });
  assert.equal(verifyOfferAcceptance(noSeller, offer).code, 'SIGNATURE_MISSING');
  const noPolicy = withTx(acceptance, (tx) => {
    tx.inputs[1].witness = [];
  });
  assert.equal(verifyOfferAcceptance(noPolicy, offer).code, 'POLICY_SIGNATURES_MISSING');
  const annexed = withTx(acceptance, (tx) => {
    tx.inputs[1].witness.push('50');
  });
  assert.equal(verifyOfferAcceptance(annexed, offer).code, 'POLICY_WITNESS_INVALID');
});

test('the policy review refuses exactly what acceptance refuses before signatures', () => {
  const signatureCodes = new Set([
    'POLICY_SIGNATURES_MISSING',
    'POLICY_SIGNATURE_INVALID',
    'POLICY_WITNESS_INVALID',
    'ACCEPTANCE_LEAF_MISMATCH',
    'CONTROL_BLOCK_MISMATCH',
    'SIGNATURE_MISSING',
    'SIGNATURE_INVALID',
    'SIGNATURE_UNVERIFIABLE',
    'UNCLOSED_SIGHASH',
  ]);
  for (const c of vectors.cases.filter((v) => v.kind === 'acceptance')) {
    const review = offerPolicySighash(c.acceptance, c.offer);
    if (c.expected.ok || signatureCodes.has(c.expected.code)) assert.equal(review.ok, true, `${c.name}: ${review.reason}`);
    else assert.equal(review.code, c.expected.code, c.name);
  }
});

test('the buyer signs nothing at acceptance, and the funded output is spent only as the offer', () => {
  const padding = find('acceptance', 'a buyer padding input is refused because the buyer signs nothing at acceptance');
  assert.equal(verifyOfferAcceptance(padding.acceptance, padding.offer).code, 'BUYER_INPUT_UNAUTHORIZED');
  const relabelled = clone(validAcceptance.acceptance);
  relabelled.inputs[1].party = 'SELLER';
  assert.equal(verifyOfferAcceptance(relabelled, validAcceptance.offer).code, 'OFFER_INPUT_MISMATCH');
  const overvalued = clone(validAcceptance.acceptance);
  overvalued.inputs[1].valueSats = '93001';
  assert.equal(verifyOfferAcceptance(overvalued, validAcceptance.offer).code, 'OFFER_INPUT_MISMATCH');
});

test('outputs are the described ones only: no data output, no dust, the exact seller script', () => {
  const { acceptance, offer } = validAcceptance;
  const data = withTx(acceptance, (tx) => {
    tx.outputs.push({ valueSats: '0', scriptHex: '6a0100' });
  });
  assert.equal(verifyOfferAcceptance(data, offer).code, 'OUTPUT_UNDESCRIBED');
  const dust = withTx(acceptance, (tx) => {
    tx.outputs[2].valueSats = '100';
  });
  assert.equal(verifyOfferAcceptance(dust, offer).code, 'DUST_OUTPUT');
  const otherSeller = { ...clone(acceptance), seller: { ...acceptance.seller, paymentScriptHex: `0014${'4'.repeat(40)}` } };
  assert.equal(verifyOfferAcceptance(otherSeller, offer).code, 'SELLER_SCRIPT_MISMATCH');
  const sameAsBuyer = { ...clone(acceptance), seller: { paymentScriptHex: itemTerms.buyerReceiveScriptHex } };
  assert.equal(verifyOfferAcceptance(sameAsBuyer, offer).code, 'PARTY_SCRIPTS_OVERLAP');
});

test('criteria hashes: recomputed for ITEM and COLLECTION, a committed member set for TRAIT', () => {
  assert.equal(itemTerms.criteriaHash, offerCriteriaHash(itemTerms));
  assert.equal(verifyOfferTerms({ ...itemTerms, criteriaHash: 'b'.repeat(64) }).code, 'TERMS_CRITERIA_INVALID');
  const traitTerms = validTrait.offer.terms;
  const members = [validTrait.acceptance.feline.inscriptionId];
  const proof = validTrait.acceptance.eligibility.traitProof;
  assert.ok(Array.isArray(proof) && proof.length > 0);
  const traitMembers = ['1', '2', '3', '4', '5'].map((n) => `${'a'.repeat(63)}${n}i0`);
  const root = offerCriteriaHash(traitTerms, traitMembers);
  for (const member of traitMembers) {
    const memberProof = buildTraitMemberProof(traitTerms, traitMembers, member);
    assert.ok(memberProof, member);
  }
  assert.equal(buildTraitMemberProof(traitTerms, traitMembers, members[0]), null, 'a non-member has no proof');
  assert.notEqual(offerCriteriaHash({ ...traitTerms, traitValue: 'other' }, traitMembers), root);
  assert.equal(offerCriteriaHash(traitTerms, []), null);
  assert.equal(offerCriteriaHash(traitTerms, [traitMembers[0], traitMembers[0]]), null);
  assert.equal(offerCriteriaHash({ offerKind: 'OTHER' }), null);
  const wrongValue = { ...clone(validTrait.acceptance) };
  const offer = clone(validTrait.offer);
  offer.terms.traitValue = 'other';
  assert.equal(verifyOfferAcceptance(wrongValue, offer).code, 'OFFER_OUTPUT_MISMATCH', 'a changed trait is a different funded output');
});

test('membership proofs resolve to the bare collection root', () => {
  const collectionId = 'forked-felines';
  const members = ['1', '2', '3', '4', '5'].map((n) => `${'f'.repeat(63)}${n}i0`);
  const root = membershipRoot(collectionId, members);
  for (const member of members) {
    assert.equal(membershipProofRoot(collectionId, member, buildMembershipProof(collectionId, members, member)), root);
  }
  assert.equal(membershipProofRoot(collectionId, members[0], [{ sibling: 'zz', position: 'left' }]), null);
  assert.equal(membershipProofRoot(collectionId, members[0], 'nope'), null);
});

test('malformed acceptances, recoveries and offers are refused, never thrown on', () => {
  const junk = [null, undefined, 0, 'x', [], {}, { schema: 'ordex.offer-acceptance/v2' }, { schema: 'ordex.offer-recovery/v2', transactionHex: 7 }];
  for (const a of junk) {
    for (const o of [...junk, validAcceptance.offer]) {
      const accepted = verifyOfferAcceptance(a, o);
      const recovered = verifyOfferRecovery(a, o);
      const reviewed = offerPolicySighash(a, o);
      for (const verdict of [accepted, recovered, reviewed]) {
        assert.equal(verdict.ok, false);
        assert.equal(typeof verdict.code, 'string');
      }
    }
  }
  const noHeight = clone(validAcceptance.offer);
  delete noHeight.currentHeight;
  assert.equal(verifyOfferAcceptance(validAcceptance.acceptance, noHeight).code, 'CURRENT_HEIGHT_INVALID');
});
