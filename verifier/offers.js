// Reference verifier for Ordex funded offers.
//
// This file restates spec/offers.md as executable checks. It is the same
// verifier as sdk/src/offers.ts, and both are run against
// conformance/offer-vectors.json, so they cannot drift apart without a test
// failing.
//
// What a node would check about the funded output's two script paths is
// rechecked here from the transaction bytes: the exact leaf scripts, the
// Taproot commitment, the locktime and sequence rules, and every signature.
// Asset movement is derived by the owning protocol's rule
// (verifier/asset-flow.js). The node stays the final authority on relay and
// consensus, the ord index on what each input carries, and the independence
// of the two policy signer services is a deployment property.
//
// Every amount is an atomic integer carried as a decimal string and handled
// as BigInt. Floating point never appears here.

import { createHash } from 'node:crypto';

import { deriveAssetFlow, readInventory } from './asset-flow.js';
import {
  bytesToHex,
  dustThresholdSats,
  hexToBytes,
  parseTransaction,
  tapBranchHash,
  tapLeafHash,
  taprootSighash,
  verifyInputSignature,
} from './bitcoin-tx.js';
import { membershipProofRoot } from './collection-manifest.js';
import { liftX, taprootTweak, verifySchnorr } from './secp256k1.js';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const INSCRIPTION = /^[0-9a-f]{64}i[0-9]+$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const KINDS = ['ITEM', 'COLLECTION', 'TRAIT'];
export const OFFER_TERMS_SCHEMA = 'ordex.offer-terms/v1';
export const OFFER_ACCEPTANCE_SCHEMA = 'ordex.offer-acceptance/v2';
export const OFFER_RECOVERY_SCHEMA = 'ordex.offer-recovery/v2';
/** The largest expiry a height-domain locktime carries; 500000000 and above is a timestamp. */
export const OFFER_EXPIRY_HEIGHT_MAX = 499999999;
/** BIP341's unspendable point H. As the funded output's internal key, no key path exists. */
export const OFFER_INTERNAL_KEY_HEX = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';
const LOCKTIME_THRESHOLD = 500000000;
const SEQUENCE_FINAL = 0xffffffff;
const SEQUENCE_LOCKTIME_DISABLE_FLAG = 0x80000000;
const CRITERIA_DOMAIN = 'ordex.offer-criteria/v1';
const TRAIT_MEMBER_DOMAIN = 'ordex.offer-trait-member/v1';
const TRAIT_NODE_DOMAIN = 'ordex.offer-trait-node/v1';

export function parseSats(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  return BigInt(value);
}

/** Serialize any JSON value with object keys sorted recursively. */
export function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 over the exact serialized form of the terms, as lowercase hex. */
export function offerTermsHash(terms) {
  return createHash('sha256').update(sortedJson(terms), 'utf8').digest('hex');
}

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const refuse = (code, reason) => ({ ok: false, code, reason });
const isXOnlyKey = (hex) => typeof hex === 'string' && HEX64.test(hex) && liftX(BigInt(`0x${hex}`)) !== null;
const validOutpoint = (o) => !!o && typeof o.txid === 'string' && HEX64.test(o.txid) && Number.isInteger(o.vout) && o.vout >= 0 && o.vout <= 0xffffffff;
const sameOutpoint = (a, b) => a.txid === b.txid && a.vout === b.vout;

// ---------------------------------------------------------------------------
// Scope criteria.

const traitMemberLeaf = (scope, memberIdentity) =>
  sha256Hex(
    sortedJson({
      domain: TRAIT_MEMBER_DOMAIN,
      collectionId: scope.collectionId,
      collectionRoot: scope.collectionRoot,
      traitName: scope.traitName,
      traitValue: scope.traitValue,
      memberIdentity,
    }),
  );

function traitNode(left, right) {
  const [a, b] = left <= right ? [left, right] : [right, left];
  return sha256Hex(sortedJson({ domain: TRAIT_NODE_DOMAIN, left: a, right: b }));
}

function traitLeaves(scope, traitMembers) {
  if (!Array.isArray(traitMembers) || traitMembers.length === 0) return null;
  if (!traitMembers.every((m) => typeof m === 'string' && m.length > 0) || new Set(traitMembers).size !== traitMembers.length) return null;
  return traitMembers.map((m) => traitMemberLeaf(scope, m)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The criteriaHash an offer's terms carry. For ITEM and COLLECTION it is
 * SHA-256 over the scope the terms already state, so a verifier recomputes
 * it. For TRAIT it is the Merkle root over the members the buyer accepted as
 * carrying the trait (traitMembers), and each acceptance proves its Feline
 * against it. Returns lowercase hex, or null when no hash can be formed.
 */
// OX-P05: the collection root does not commit to trait values, so a TRAIT offer
// commits the eligible member set itself; a wrong trait can then never be proved.
export function offerCriteriaHash(scope, traitMembers) {
  if (!scope || typeof scope !== 'object') return null;
  if (scope.offerKind === 'ITEM' || scope.offerKind === 'COLLECTION') {
    return sha256Hex(
      sortedJson({
        domain: CRITERIA_DOMAIN,
        offerKind: scope.offerKind,
        collectionId: scope.collectionId,
        collectionRoot: scope.collectionRoot,
        itemInscriptionId: scope.offerKind === 'ITEM' ? scope.itemInscriptionId : undefined,
      }),
    );
  }
  if (scope.offerKind !== 'TRAIT') return null;
  let level = traitLeaves(scope, traitMembers);
  if (!level) return null;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 === level.length ? level[i] : traitNode(level[i], level[i + 1]));
    level = next;
  }
  return level[0];
}

/**
 * The proof that one member belongs to a TRAIT offer's eligible set:
 * [{ sibling, position }] from the leaf upward, or null for a non-member.
 */
export function buildTraitMemberProof(scope, traitMembers, memberIdentity) {
  let level = traitLeaves(scope, traitMembers);
  if (!level) return null;
  let index = level.indexOf(traitMemberLeaf(scope, memberIdentity));
  if (index === -1) return null;
  const proof = [];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]);
        if (i === index) index = next.length - 1;
        continue;
      }
      next.push(traitNode(level[i], level[i + 1]));
      if (i === index) proof.push({ sibling: level[i + 1], position: 'right' });
      if (i + 1 === index) proof.push({ sibling: level[i], position: 'left' });
      if (i === index || i + 1 === index) index = next.length - 1;
    }
    level = next;
  }
  return proof;
}

function traitProofRoot(scope, memberIdentity, proof) {
  if (!Array.isArray(proof) || !proof.every((s) => s && HEX64.test(s.sibling) && (s.position === 'left' || s.position === 'right'))) return null;
  let digest = traitMemberLeaf(scope, memberIdentity);
  for (const step of proof) digest = step.position === 'left' ? traitNode(step.sibling, digest) : traitNode(digest, step.sibling);
  return digest;
}

// ---------------------------------------------------------------------------
// Terms.

// OX-P05: expiry is a height-domain CHECKLOCKTIMEVERIFY argument, so it stays
// below 500000000 (P-R16); the recovery key must be a real point and the
// criteria hash is recomputed wherever the terms alone determine it.
export function verifyOfferTerms(terms) {
  if (!terms || typeof terms !== 'object' || Array.isArray(terms)) {
    return refuse('MALFORMED_TERMS', 'Expected a terms object.');
  }
  const t = terms;
  const known = new Set([
    'schema',
    'protocolVersion',
    'network',
    'offerKind',
    'collectionId',
    'collectionRoot',
    'itemInscriptionId',
    'traitName',
    'traitValue',
    'criteriaHash',
    'buyerReceiveScriptHex',
    'priceSats',
    'maxNetworkFeeSats',
    'expiryHeight',
    'buyerRecoveryKeyHex',
  ]);
  for (const key of Object.keys(t)) {
    if (!known.has(key)) return refuse('MALFORMED_TERMS', `Unknown field ${key}.`);
  }
  if (t.schema !== OFFER_TERMS_SCHEMA) {
    return refuse('TERMS_SCHEMA_UNSUPPORTED', 'The terms schema is not ordex.offer-terms/v1.');
  }
  if (typeof t.protocolVersion !== 'string' || !/^1\.[1-9][0-9]*$/.test(t.protocolVersion)) {
    return refuse('TERMS_PROTOCOL_UNSUPPORTED', 'The terms protocol version must be 1.1 or a later 1.x.');
  }
  if (typeof t.network !== 'string' || !NETWORKS.includes(t.network)) {
    return refuse('TERMS_NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (typeof t.offerKind !== 'string' || !KINDS.includes(t.offerKind)) {
    return refuse('TERMS_KIND_UNKNOWN', 'The offer kind is not one this protocol names.');
  }
  if (t.offerKind === 'ITEM') {
    if (typeof t.itemInscriptionId !== 'string' || !INSCRIPTION.test(t.itemInscriptionId)) {
      return refuse('TERMS_SCOPE_FIELDS', 'An ITEM offer must name exactly one inscription id.');
    }
    if (t.traitName !== undefined || t.traitValue !== undefined) {
      return refuse('TERMS_SCOPE_FIELDS', 'An ITEM offer must not carry trait fields.');
    }
  } else if (t.offerKind === 'TRAIT') {
    if (typeof t.traitName !== 'string' || t.traitName.length === 0 || t.traitName.length > 128) {
      return refuse('TERMS_SCOPE_FIELDS', 'A TRAIT offer must name one trait of at most 128 characters.');
    }
    if (typeof t.traitValue !== 'string' || t.traitValue.length === 0 || t.traitValue.length > 256) {
      return refuse('TERMS_SCOPE_FIELDS', 'A TRAIT offer must name one trait value of at most 256 characters.');
    }
    if (t.itemInscriptionId !== undefined) {
      return refuse('TERMS_SCOPE_FIELDS', 'A TRAIT offer must not carry an item inscription id.');
    }
  } else if (t.itemInscriptionId !== undefined || t.traitName !== undefined || t.traitValue !== undefined) {
    return refuse('TERMS_SCOPE_FIELDS', 'A COLLECTION offer must not scope further.');
  }
  if (typeof t.collectionId !== 'string' || t.collectionId.length === 0 || t.collectionId.length > 200) {
    return refuse('MALFORMED_TERMS', 'The terms must name a collection id.');
  }
  if (typeof t.collectionRoot !== 'string' || !HEX64.test(t.collectionRoot)) {
    return refuse('TERMS_ROOT_INVALID', 'The collection root must be 64 lowercase hex characters.');
  }
  if (typeof t.criteriaHash !== 'string' || !HEX64.test(t.criteriaHash)) {
    return refuse('TERMS_CRITERIA_INVALID', 'The criteria hash must be 64 lowercase hex characters.');
  }
  if (t.offerKind !== 'TRAIT' && t.criteriaHash !== offerCriteriaHash(t)) {
    return refuse('TERMS_CRITERIA_INVALID', 'The criteria hash is not the hash of the scope these terms state.');
  }
  if (typeof t.buyerReceiveScriptHex !== 'string' || !EVEN_HEX.test(t.buyerReceiveScriptHex) || t.buyerReceiveScriptHex.startsWith('6a')) {
    return refuse('TERMS_SCRIPT_INVALID', 'The buyer receive script must be lowercase hex bytes of a spendable script.');
  }
  if (parseSats(t.priceSats) === null) {
    return refuse('TERMS_AMOUNT_INVALID', 'priceSats must be an exact decimal string.');
  }
  if (parseSats(t.maxNetworkFeeSats) === null) {
    return refuse('TERMS_AMOUNT_INVALID', 'maxNetworkFeeSats must be an exact decimal string.');
  }
  if (!Number.isSafeInteger(t.expiryHeight) || t.expiryHeight < 0 || t.expiryHeight > OFFER_EXPIRY_HEIGHT_MAX) {
    return refuse('TERMS_EXPIRY_INVALID', 'expiryHeight must be a block height below 500000000, the locktime timestamp threshold.');
  }
  if (!isXOnlyKey(t.buyerRecoveryKeyHex)) {
    return refuse('TERMS_RECOVERY_KEY_INVALID', 'The buyer recovery key must be a valid x-only public key in 64 lowercase hex characters.');
  }
  return { ok: true, offerTermsHash: offerTermsHash(t) };
}

// ---------------------------------------------------------------------------
// The funded output.

/** The minimal push of a script number, as tapscript's MINIMALDATA rule requires. */
function scriptNumberPush(n) {
  if (n === 0) return '00';
  if (n <= 16) return (0x50 + n).toString(16);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.push(v % 256);
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return bytes.length.toString(16).padStart(2, '0') + bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The exact Taproot tree of a funded offer output: the acceptance and
 * recovery leaves, the internal key H, the output script, and the control
 * block each leaf is revealed with.
 *
 * policyKeysHex: [policyKeyA, policyKeyB], the two x-only policy signer keys
 * in leaf order. Answers { ok: true, offerTermsHash, acceptanceLeafHex,
 * recoveryLeafHex, acceptanceLeafHashHex, recoveryLeafHashHex, merkleRootHex,
 * internalKeyHex, outputKeyHex, scriptPubKeyHex, acceptanceControlBlockHex,
 * recoveryControlBlockHex } or a refusal.
 */
// OX-P05: every leaf byte is rebuilt, never matched by substring, so key or opcode
// bytes inside pushed data cannot pass for script policy.
export function offerOutputTree(terms, policyKeysHex) {
  const verdict = verifyOfferTerms(terms);
  if (!verdict.ok) return verdict;
  if (
    !Array.isArray(policyKeysHex) ||
    policyKeysHex.length !== 2 ||
    !policyKeysHex.every(isXOnlyKey) ||
    policyKeysHex[0] === policyKeysHex[1] ||
    policyKeysHex.includes(terms.buyerRecoveryKeyHex) ||
    policyKeysHex.includes(OFFER_INTERNAL_KEY_HEX)
  ) {
    return refuse(
      'POLICY_KEYS_INVALID',
      'An offer names two distinct valid policy signer keys, neither of them the buyer recovery key.',
    );
  }
  const acceptanceLeafHex = `20${verdict.offerTermsHash}7520${policyKeysHex[0]}ac20${policyKeysHex[1]}ba5287`;
  const recoveryLeafHex = `${scriptNumberPush(terms.expiryHeight)}b17520${terms.buyerRecoveryKeyHex}ac`;
  const acceptanceLeafHash = tapLeafHash(acceptanceLeafHex);
  const recoveryLeafHash = tapLeafHash(recoveryLeafHex);
  const merkleRoot = tapBranchHash(acceptanceLeafHash, recoveryLeafHash);
  const tweaked = taprootTweak(hexToBytes(OFFER_INTERNAL_KEY_HEX), merkleRoot);
  if (!tweaked) return refuse('POLICY_KEYS_INVALID', 'These leaves produce no valid Taproot output key.');
  const outputKeyHex = bytesToHex(tweaked.outputKey);
  const controlPrefix = (0xc0 | tweaked.parity).toString(16) + OFFER_INTERNAL_KEY_HEX;
  return {
    ok: true,
    offerTermsHash: verdict.offerTermsHash,
    acceptanceLeafHex,
    recoveryLeafHex,
    acceptanceLeafHashHex: bytesToHex(acceptanceLeafHash),
    recoveryLeafHashHex: bytesToHex(recoveryLeafHash),
    merkleRootHex: bytesToHex(merkleRoot),
    internalKeyHex: OFFER_INTERNAL_KEY_HEX,
    outputKeyHex,
    scriptPubKeyHex: `5120${outputKeyHex}`,
    acceptanceControlBlockHex: controlPrefix + bytesToHex(recoveryLeafHash),
    recoveryControlBlockHex: controlPrefix + bytesToHex(acceptanceLeafHash),
  };
}

/** offer: { terms, policyKeysHex, fundedOutput { outpoint, valueSats, scriptPubKeyHex } } */
function readOffer(offer) {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
    return refuse('MALFORMED_OFFER', 'Expected the offer terms, the two policy keys and the funded output.');
  }
  const tree = offerOutputTree(offer.terms, offer.policyKeysHex);
  if (!tree.ok) return tree;
  const funded = offer.fundedOutput;
  const fundedValue = parseSats(funded && funded.valueSats);
  if (!funded || !validOutpoint(funded.outpoint) || fundedValue === null || typeof funded.scriptPubKeyHex !== 'string') {
    return refuse('MALFORMED_OFFER', 'The funded output needs its outpoint, exact value and script.');
  }
  if (funded.scriptPubKeyHex !== tree.scriptPubKeyHex) {
    return refuse('OFFER_OUTPUT_MISMATCH', 'The funded output does not commit to the tree these terms and policy keys produce.');
  }
  return { ok: true, terms: offer.terms, tree, funded, fundedValue };
}

/**
 * Check one tapscript signature item. Answers VALID, MISSING, UNCLOSED (a
 * hash type that leaves part of the transaction uncommitted), or INVALID.
 */
function tapscriptSignature(sigHex, keyHex, digestFor) {
  const sig = hexToBytes(sigHex);
  if (!sig || sig.length === 0) return 'MISSING';
  if (sig.length !== 64 && sig.length !== 65) return 'INVALID';
  const hashType = sig.length === 65 ? sig[64] : 0x00;
  if (sig.length === 65 && hashType === 0x00) return 'INVALID';
  if (hashType !== 0x00 && hashType !== 0x01) return 'UNCLOSED';
  const digest = digestFor(hashType);
  return digest && verifySchnorr(digest, sig.subarray(0, 64), hexToBytes(keyHex)) ? 'VALID' : 'INVALID';
}

// ---------------------------------------------------------------------------
// Acceptance.

function checkEligibility(terms, inscriptionId, eligibility) {
  if (terms.offerKind === 'ITEM' && inscriptionId !== terms.itemInscriptionId) {
    return refuse('SCOPE_MISMATCH', 'The delivered inscription is not the one this ITEM offer names.');
  }
  if (!eligibility || typeof eligibility !== 'object') {
    return refuse('ELIGIBILITY_PROOF_MALFORMED', 'The acceptance must carry the membership proof of the delivered Feline.');
  }
  const root = membershipProofRoot(terms.collectionId, inscriptionId, eligibility.membershipProof);
  if (root === null) return refuse('ELIGIBILITY_PROOF_MALFORMED', 'Every membership proof step needs a sibling digest and a position.');
  if (root !== terms.collectionRoot) {
    return refuse('COLLECTION_MEMBERSHIP_NOT_PROVEN', 'The membership proof does not resolve to the collection root the terms commit to.');
  }
  if (terms.offerKind === 'TRAIT') {
    const traitRoot = traitProofRoot(terms, inscriptionId, eligibility.traitProof);
    if (traitRoot === null) return refuse('ELIGIBILITY_PROOF_MALFORMED', 'A TRAIT acceptance must carry a well formed trait proof.');
    if (traitRoot !== terms.criteriaHash) {
      return refuse('TRAIT_NOT_PROVEN', 'The trait proof does not resolve to the criteria hash, so this Feline is not one the buyer accepted.');
    }
  }
  return { ok: true };
}

/**
 * Everything about an acceptance except its signatures: the offer and its
 * tree, the transaction and its described inputs, the output layout, the fee,
 * and every derived asset movement.
 */
function checkAcceptance(acceptance, offer) {
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) {
    return refuse('MALFORMED_ACCEPTANCE', 'Expected an acceptance object.');
  }
  if (acceptance.schema !== OFFER_ACCEPTANCE_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The acceptance schema is not ordex.offer-acceptance/v2. Build the acceptance again.');
  }
  const context = readOffer(offer);
  if (!context.ok) return context;
  const { terms, tree, funded, fundedValue } = context;
  if (acceptance.network !== terms.network) {
    return refuse('NETWORK_MISMATCH', 'The acceptance was built for a different network than the terms.');
  }
  const height = offer.currentHeight;
  if (!Number.isSafeInteger(height) || height < 0 || height >= LOCKTIME_THRESHOLD) {
    return refuse('CURRENT_HEIGHT_INVALID', 'An acceptance is checked at a known block height.');
  }
  if (height >= terms.expiryHeight) {
    return refuse('OFFER_EXPIRED', 'The expiry height has been reached; recovery is the only remaining path.');
  }

  const seller = acceptance.seller;
  const script = (s) => typeof s === 'string' && EVEN_HEX.test(s) && !s.startsWith('6a');
  if (!seller || !script(seller.paymentScriptHex) || (seller.returnScriptHex !== undefined && !script(seller.returnScriptHex))) {
    return refuse('SELLER_INVALID', 'The acceptance must name the seller payment script, and a return script only as spendable hex.');
  }
  const sellerScripts = new Set([seller.paymentScriptHex, seller.returnScriptHex ?? seller.paymentScriptHex]);
  if (sellerScripts.has(terms.buyerReceiveScriptHex)) {
    return refuse('PARTY_SCRIPTS_OVERLAP', 'A seller script equals the buyer receive script, so no output could be attributed.');
  }

  const feline = acceptance.feline;
  if (!feline || typeof feline.inscriptionId !== 'string' || !INSCRIPTION.test(feline.inscriptionId) || !validOutpoint(feline.outpoint)) {
    return refuse('MALFORMED_ACCEPTANCE', 'The acceptance must name the delivered Feline and the outpoint holding it.');
  }
  const eligible = checkEligibility(terms, feline.inscriptionId, acceptance.eligibility);
  if (!eligible.ok) return eligible;

  const parsed = parseTransaction(acceptance.transactionHex);
  if (!parsed.ok) return refuse('TRANSACTION_INVALID', parsed.reason);
  const tx = parsed.tx;
  if (tx.version !== 1 && tx.version !== 2) {
    return refuse('TRANSACTION_INVALID', 'An acceptance is a version 1 or 2 transaction.');
  }
  if (tx.lockTime >= LOCKTIME_THRESHOLD || tx.lockTime > height) {
    return refuse('LOCKTIME_INVALID', 'The acceptance locktime must be a block height no later than the current one, so it can confirm before expiry.');
  }

  // Inputs: every one described, the seller's first, the offer output last.
  const described = acceptance.inputs;
  if (!Array.isArray(described) || described.length !== tx.inputs.length) {
    return refuse('INPUT_DESCRIPTION_MISMATCH', 'Every transaction input needs exactly one description, in order.');
  }
  const inputs = [];
  const seen = new Set();
  let offerIndex = -1;
  let felineIndex = -1;
  let sellerTotal = 0n;
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const d = described[i];
    const spent = tx.inputs[i];
    if (!d || !validOutpoint(d.outpoint) || !sameOutpoint(d.outpoint, spent)) {
      return refuse('INPUT_DESCRIPTION_MISMATCH', `Input ${i} is not described as the outpoint the transaction spends.`);
    }
    const key = `${spent.txid}:${spent.vout}`;
    if (seen.has(key)) return refuse('INPUT_DUPLICATED', `Input ${key} appears more than once.`);
    seen.add(key);
    if (tx.version >= 2 && spent.sequence < SEQUENCE_LOCKTIME_DISABLE_FLAG) {
      return refuse('SEQUENCE_INVALID', `Input ${i} carries a relative timelock that could hold the acceptance past expiry.`);
    }
    if (d.party === 'BUYER') {
      return refuse(
        'BUYER_INPUT_UNAUTHORIZED',
        `Input ${i} is a buyer input. The buyer signs nothing at acceptance; only the funded output is spent for the buyer.`,
      );
    }
    if (d.party !== 'SELLER' && d.party !== 'OFFER') {
      return refuse('INPUT_PARTY_INVALID', `Input ${i} must be a seller input or the funded offer output.`);
    }
    const value = parseSats(d.valueSats);
    if (value === null) return refuse('INPUT_VALUE_INVALID', `Input ${i} does not carry an exact decimal value.`);
    if (typeof d.scriptPubKeyHex !== 'string' || !EVEN_HEX.test(d.scriptPubKeyHex)) {
      return refuse('INPUT_SCRIPT_INVALID', `Input ${i} does not carry the script of the output it spends.`);
    }
    const isOffer = sameOutpoint(spent, funded.outpoint);
    if ((d.party === 'OFFER') !== isOffer) {
      return refuse('OFFER_INPUT_MISMATCH', `Input ${i} is described as ${d.party === 'OFFER' ? 'the offer but spends another output' : 'a seller input but spends the funded offer output'}.`);
    }
    if (isOffer) {
      if (value !== fundedValue || d.scriptPubKeyHex !== funded.scriptPubKeyHex) {
        return refuse('OFFER_INPUT_MISMATCH', 'The offer input is not described with the funded output value and script.');
      }
      offerIndex = i;
    } else {
      sellerTotal += value;
      if (sameOutpoint(spent, feline.outpoint)) felineIndex = i;
    }
    const read = readInventory(d.inventory, i, value, d.outpoint);
    if (!read.assets) return read;
    inputs.push({ outpoint: d.outpoint, party: d.party, value, scriptPubKeyHex: d.scriptPubKeyHex, assets: read.assets });
  }
  if (offerIndex === -1) return refuse('OFFER_OUTPOINT_MISSING', 'No input spends the funded offer output.');
  if (offerIndex !== inputs.length - 1) {
    return refuse('OFFER_INPUT_POSITION', 'The funded offer output must be the last input, so its sats never reach the Feline range.');
  }
  if (felineIndex === -1) return refuse('FELINE_OUTPOINT_MISSING', 'No seller input spends the outpoint holding the Feline.');
  if (!inputs[felineIndex].assets.some((a) => a.assetType === 'ORDINAL' && a.assetId === feline.inscriptionId)) {
    return refuse('FELINE_NOT_HELD', 'The authorities do not report the Feline on the outpoint the acceptance names.');
  }

  // Outputs: asset outputs that absorb exactly the seller's inputs, then the
  // seller payment, then at most one buyer change output.
  const values = tx.outputs.map((o) => BigInt(o.valueSats));
  for (let j = 0; j < tx.outputs.length; j += 1) {
    const outScript = tx.outputs[j].scriptHex;
    if (outScript.startsWith('6a')) return refuse('OUTPUT_UNDESCRIBED', `Output ${j} is a data output; an acceptance carries none.`);
    const dust = dustThresholdSats(outScript);
    if (values[j] < dust) return refuse('DUST_OUTPUT', `Output ${j} is below the ${dust} sat dust threshold for its script.`);
  }
  let assetCount = -1;
  let running = 0n;
  for (let j = 0; j < values.length && running < sellerTotal; j += 1) {
    running += values[j];
    if (running === sellerTotal) assetCount = j + 1;
  }
  if (assetCount === -1) {
    return refuse('ASSET_OUTPUTS_UNBALANCED', 'The outputs ahead of the seller payment must absorb exactly the sats of the seller inputs.');
  }
  const owners = [];
  let buyerAssetIndex = -1;
  for (let j = 0; j < assetCount; j += 1) {
    const outScript = tx.outputs[j].scriptHex;
    if (outScript === terms.buyerReceiveScriptHex) {
      if (buyerAssetIndex !== -1) return refuse('OUTPUT_UNDESCRIBED', 'Only one output ahead of the seller payment pays the buyer.');
      buyerAssetIndex = j;
      owners.push('buyer');
    } else if (sellerScripts.has(outScript)) {
      owners.push('seller');
    } else {
      return refuse('OUTPUT_UNDESCRIBED', `Output ${j} pays a script that is neither the buyer receive script nor a seller script.`);
    }
  }
  if (buyerAssetIndex === -1) return refuse('BUYER_ASSET_OUTPUT_MISSING', 'No output ahead of the seller payment pays the buyer receive script.');
  const sellerPaymentIndex = assetCount;
  const payment = tx.outputs[sellerPaymentIndex];
  if (!payment) return refuse('SELLER_OUTPUT_MISSING', 'No seller payment follows the asset outputs.');
  if (payment.scriptHex !== seller.paymentScriptHex) {
    return refuse('SELLER_SCRIPT_MISMATCH', 'The output after the asset outputs does not pay the seller payment script.');
  }
  if (values[sellerPaymentIndex] !== parseSats(terms.priceSats)) {
    return refuse('SELLER_VALUE_MISMATCH', 'The seller payment is not the exact offer price.');
  }
  owners.push('seller');
  if (tx.outputs.length > sellerPaymentIndex + 2) return refuse('OUTPUT_UNDESCRIBED', 'Only buyer change may follow the seller payment.');
  if (tx.outputs.length === sellerPaymentIndex + 2) {
    if (tx.outputs[sellerPaymentIndex + 1].scriptHex !== terms.buyerReceiveScriptHex) {
      return refuse('OUTPUT_UNDESCRIBED', 'The output after the seller payment must be buyer change to the buyer receive script.');
    }
    owners.push('buyer');
  }

  const totalIn = inputs.reduce((n, input) => n + input.value, 0n);
  const totalOut = values.reduce((n, v) => n + v, 0n);
  const fee = totalIn - totalOut;
  if (fee < 0n) return refuse('VALUE_NOT_CONSERVED', 'The outputs exceed the inputs.');
  if (fee > parseSats(terms.maxNetworkFeeSats)) {
    return refuse('FEE_OVER_MAXIMUM', 'The fee exceeds the maximum the terms committed to.');
  }

  // Assets: the Feline to the buyer asset output, everything else home.
  const flow = deriveAssetFlow({ network: terms.network, height: height + 1, inputs, outputs: tx.outputs });
  if (!flow.ok) return flow;
  const ownerOf = (i) => (inputs[i].party === 'OFFER' ? 'buyer' : 'seller');
  const runeNet = new Map();
  inputs.forEach((input, i) => {
    for (const a of input.assets) {
      if (a.assetType !== 'RUNE') continue;
      const k = `${ownerOf(i)}|${a.assetId}`;
      runeNet.set(k, (runeNet.get(k) ?? 0n) - BigInt(a.amount));
    }
  });
  let delivered = false;
  for (const m of flow.movements) {
    if (m.assetType === 'RUNE') {
      const k = `${owners[m.toOutput]}|${m.assetId}`;
      runeNet.set(k, (runeNet.get(k) ?? 0n) + BigInt(m.quantity));
      continue;
    }
    if (m.assetType === 'ORDINAL' && m.assetId === feline.inscriptionId && m.fromInput === felineIndex) {
      if (m.toOutput !== buyerAssetIndex) {
        return refuse('FELINE_NOT_DELIVERED', `The Feline would land in output ${m.toOutput}, not the buyer asset output ${buyerAssetIndex}.`);
      }
      delivered = true;
      continue;
    }
    const from = ownerOf(m.fromInput);
    if (owners[m.toOutput] !== from) {
      return refuse('ASSET_MISDIRECTED', `${m.assetType} ${m.assetId} belongs to the ${from} and would land with the ${owners[m.toOutput]}.`);
    }
  }
  if (!delivered) return refuse('FELINE_NOT_DELIVERED', 'The Feline is not moved to the buyer by this transaction.');
  for (const [k, net] of runeNet) {
    if (net !== 0n) return refuse('ASSET_MISDIRECTED', `Rune ${k.split('|')[1]} would move to or from the ${k.split('|')[0]}.`);
  }

  return {
    ok: true,
    parsed,
    tree,
    terms,
    inputs,
    offerIndex,
    felineIndex,
    buyerAssetIndex,
    sellerPaymentIndex,
    fee,
    prevouts: inputs.map((input) => ({ valueSats: input.value.toString(), scriptHex: input.scriptPubKeyHex })),
  };
}

/**
 * The message each policy signer signs: the BIP341 script path signature
 * hash (SIGHASH_DEFAULT) of the funded offer input under the acceptance leaf,
 * after every rule except signatures has passed. The transaction may be
 * unsigned or partly signed; signatures never change this hash.
 *
 * Answers { ok: true, offerTermsHash, offerInputIndex, sighashHex,
 * leafHashHex, controlBlockHex, feeSats } or the refusal verifyOfferAcceptance
 * would give before signatures.
 */
// OX-P05: the policy signer contract. Each independently keyed signer runs the
// full acceptance rules from its own evidence before signing this one hash.
export function offerPolicySighash(acceptance, offer) {
  const check = checkAcceptance(acceptance, offer);
  if (!check.ok) return check;
  const digest = taprootSighash(check.parsed.tx, check.offerIndex, check.prevouts, 0x00, { leafHash: hexToBytes(check.tree.acceptanceLeafHashHex) });
  return {
    ok: true,
    offerTermsHash: check.tree.offerTermsHash,
    offerInputIndex: check.offerIndex,
    sighashHex: bytesToHex(digest),
    leafHashHex: check.tree.acceptanceLeafHashHex,
    controlBlockHex: check.tree.acceptanceControlBlockHex,
    feeSats: check.fee.toString(),
  };
}

/**
 * Verify a complete acceptance transaction against its funded offer.
 *
 * acceptance: { schema: 'ordex.offer-acceptance/v2', network,
 *   seller { paymentScriptHex, returnScriptHex? },
 *   feline { inscriptionId, outpoint },
 *   eligibility { membershipProof, traitProof? },
 *   inputs [{ outpoint, party: 'SELLER' | 'OFFER', valueSats,
 *             scriptPubKeyHex, inventory }],
 *   transactionHex }
 * offer: { terms, policyKeysHex [A, B], fundedOutput { outpoint, valueSats,
 *   scriptPubKeyHex }, currentHeight }
 *
 * Success needs every rule of spec/offers.md and every signature: both
 * policy signatures under the exact acceptance leaf and control block, and a
 * closing signature on every seller input. A missing signature is refused,
 * never assumed. Answers { ok: true, txid, offerTermsHash, offerInputIndex,
 * felineInputIndex, buyerAssetOutputIndex, sellerPaymentIndex, feeSats }.
 */
// OX-P05: P-R14 passed when the buyer script merely appeared before the seller
// index. Delivery is now derived from the Feline's satpoint, the leaf, tree and
// signatures are proved from the bytes, and no buyer input is ever spent.
export function verifyOfferAcceptance(acceptance, offer) {
  const check = checkAcceptance(acceptance, offer);
  if (!check.ok) return check;
  const tx = check.parsed.tx;
  for (let i = 0; i < tx.inputs.length; i += 1) {
    if (i === check.offerIndex) {
      const input = tx.inputs[i];
      if (input.scriptSigHex !== '') return refuse('POLICY_WITNESS_INVALID', 'The offer input carries a scriptSig.');
      if (input.witness.length === 0) return refuse('POLICY_SIGNATURES_MISSING', 'The offer input carries no policy signatures.');
      if (input.witness.length !== 4) {
        return refuse('POLICY_WITNESS_INVALID', 'The offer input witness must be two signatures, the acceptance leaf and its control block.');
      }
      const [sigB, sigA, leafHex, controlHex] = input.witness;
      if (leafHex !== check.tree.acceptanceLeafHex) {
        return refuse('ACCEPTANCE_LEAF_MISMATCH', 'The revealed leaf is not the exact acceptance leaf for these terms and policy keys.');
      }
      if (controlHex !== check.tree.acceptanceControlBlockHex) {
        return refuse('CONTROL_BLOCK_MISMATCH', 'The control block does not commit the acceptance leaf to the funded output.');
      }
      const leafHash = hexToBytes(check.tree.acceptanceLeafHashHex);
      const policyKeys = offer.policyKeysHex;
      for (const [sigHex, keyHex] of [
        [sigA, policyKeys[0]],
        [sigB, policyKeys[1]],
      ]) {
        const status = tapscriptSignature(sigHex, keyHex, (hashType) => taprootSighash(tx, i, check.prevouts, hashType, { leafHash }));
        if (status === 'MISSING') return refuse('POLICY_SIGNATURES_MISSING', 'A valid acceptance carries a signature from each independent policy signer.');
        if (status === 'UNCLOSED') return refuse('UNCLOSED_SIGHASH', 'A policy signature does not commit to every input and output.');
        if (status !== 'VALID') return refuse('POLICY_SIGNATURE_INVALID', `The signature for policy key ${keyHex} does not verify.`);
      }
      continue;
    }
    const verdict = verifyInputSignature(tx, i, check.prevouts);
    if (verdict.status === 'UNSIGNED') return refuse('SIGNATURE_MISSING', `Seller input ${i} is unsigned.`);
    if (verdict.status === 'UNSUPPORTED') return refuse('SIGNATURE_UNVERIFIABLE', `Seller input ${i} spends a script this verifier cannot check.`);
    if (verdict.status !== 'VALID') return refuse('SIGNATURE_INVALID', `Seller input ${i} carries a signature that does not verify.`);
    const closing = verdict.type === 'p2tr' ? [0x00, 0x01] : [0x01];
    if (!closing.includes(verdict.sighashType)) {
      return refuse('UNCLOSED_SIGHASH', `Seller input ${i} was signed without committing to every input and output.`);
    }
  }
  return {
    ok: true,
    txid: check.parsed.txid,
    offerTermsHash: check.tree.offerTermsHash,
    offerInputIndex: check.offerIndex,
    felineInputIndex: check.felineIndex,
    buyerAssetOutputIndex: check.buyerAssetIndex,
    sellerPaymentIndex: check.sellerPaymentIndex,
    feeSats: check.fee.toString(),
  };
}

// ---------------------------------------------------------------------------
// Recovery.

/**
 * Verify a complete recovery transaction: the funded output alone, spent by
 * the exact recovery leaf and control block with a closing signature by the
 * buyer recovery key, a height-domain locktime at or after expiry, a
 * non-final sequence, and one output paying the buyer receive script.
 *
 * recovery: { schema: 'ordex.offer-recovery/v2', transactionHex }
 * offer: { terms, policyKeysHex, fundedOutput }
 *
 * Answers { ok: true, txid, feeSats } or a refusal.
 */
// OX-P05: P-R15 accepted a recovery with no locktime. The locktime, its domain,
// the sequence and the leaf are now read from the bytes the node will judge.
export function verifyOfferRecovery(recovery, offer) {
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) {
    return refuse('MALFORMED_RECOVERY', 'Expected a recovery object.');
  }
  if (recovery.schema !== OFFER_RECOVERY_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The recovery schema is not ordex.offer-recovery/v2.');
  }
  const context = readOffer(offer);
  if (!context.ok) return context;
  const { terms, tree, funded, fundedValue } = context;
  const parsed = parseTransaction(recovery.transactionHex);
  if (!parsed.ok) return refuse('TRANSACTION_INVALID', parsed.reason);
  const tx = parsed.tx;
  if (tx.inputs.length !== 1) return refuse('RECOVERY_INPUTS_INVALID', 'A recovery spends the funded output and nothing else.');
  const input = tx.inputs[0];
  if (!sameOutpoint(input, funded.outpoint)) return refuse('OFFER_OUTPOINT_MISSING', 'The recovery does not spend the funded output.');
  if (tx.lockTime >= LOCKTIME_THRESHOLD) {
    return refuse('LOCKTIME_INVALID', 'The locktime is a timestamp; the recovery leaf compares a block height.');
  }
  if (tx.lockTime < terms.expiryHeight) {
    return refuse('RECOVERY_BEFORE_EXPIRY', 'The locktime is below the expiry height, so CHECKLOCKTIMEVERIFY fails.');
  }
  if (input.sequence === SEQUENCE_FINAL) {
    return refuse('SEQUENCE_FINAL', 'A final sequence disables the locktime, so CHECKLOCKTIMEVERIFY fails.');
  }
  if (tx.outputs.length !== 1 || tx.outputs[0].scriptHex !== terms.buyerReceiveScriptHex) {
    return refuse('RECOVERY_OUTPUT_WRONG', 'A recovery pays one output, the buyer receive script.');
  }
  const paid = BigInt(tx.outputs[0].valueSats);
  if (paid > fundedValue) return refuse('VALUE_NOT_CONSERVED', 'The recovery pays more than the funded output holds.');
  const dust = dustThresholdSats(tx.outputs[0].scriptHex);
  if (paid < dust) return refuse('DUST_OUTPUT', `The recovery output is below the ${dust} sat dust threshold for its script.`);
  if (input.scriptSigHex !== '') return refuse('RECOVERY_WITNESS_INVALID', 'The recovery input carries a scriptSig.');
  if (input.witness.length === 0) return refuse('SIGNATURE_MISSING', 'The recovery input is unsigned.');
  if (input.witness.length !== 3) {
    return refuse('RECOVERY_WITNESS_INVALID', 'The recovery witness must be one signature, the recovery leaf and its control block.');
  }
  const [sigHex, leafHex, controlHex] = input.witness;
  if (leafHex !== tree.recoveryLeafHex) {
    return refuse('RECOVERY_LEAF_MISMATCH', 'The revealed leaf is not the exact recovery leaf for these terms.');
  }
  if (controlHex !== tree.recoveryControlBlockHex) {
    return refuse('CONTROL_BLOCK_MISMATCH', 'The control block does not commit the recovery leaf to the funded output.');
  }
  const prevouts = [{ valueSats: funded.valueSats, scriptHex: funded.scriptPubKeyHex }];
  const leafHash = hexToBytes(tree.recoveryLeafHashHex);
  const status = tapscriptSignature(sigHex, terms.buyerRecoveryKeyHex, (hashType) => taprootSighash(tx, 0, prevouts, hashType, { leafHash }));
  if (status === 'MISSING') return refuse('SIGNATURE_MISSING', 'The recovery carries no buyer signature.');
  if (status === 'UNCLOSED') return refuse('UNCLOSED_SIGHASH', 'The buyer signature does not commit to the whole recovery.');
  if (status !== 'VALID') return refuse('SIGNATURE_INVALID', 'The buyer signature does not verify against the recovery key.');
  return { ok: true, txid: parsed.txid, feeSats: (fundedValue - paid).toString() };
}
