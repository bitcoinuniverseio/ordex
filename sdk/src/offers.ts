/**
 * The funded offer rules from spec/offers.md, typed.
 *
 * This is the same verifier as verifier/offers.js at the repository root,
 * ported to TypeScript for SDK consumers. Both implementations are run
 * against conformance/offer-vectors.json, so they cannot drift apart
 * without a test failing.
 *
 * Two sentences describe the trust model the way a buyer or a seller needs
 * them stated: a valid acceptance requires two independent policy signers,
 * and after the expiry height the buyer can recover alone. Before expiry the
 * two policy signers together could spend the funded output outside these
 * rules, so an offer is not trustless, and nothing here may describe it as
 * trustless.
 */

import { createHash } from 'node:crypto';

import { deriveAssetFlow, readInventory, type AssetInventory, type InventoryAsset } from './asset-flow.js';
import {
  bytesToHex,
  dustThresholdSats,
  hexToBytes,
  parseTransaction,
  tapBranchHash,
  tapLeafHash,
  taprootSighash,
  verifyInputSignature,
  type Prevout,
  type Transaction,
} from './bitcoin-tx.js';
import { membershipProofRoot } from './collection-manifest.js';
import { liftX, taprootTweak, verifySchnorr } from './secp256k1.js';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const INSCRIPTION = /^[0-9a-f]{64}i[0-9]+$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const KINDS = ['ITEM', 'COLLECTION', 'TRAIT'];
const LOCKTIME_THRESHOLD = 500000000;
const SEQUENCE_FINAL = 0xffffffff;
const SEQUENCE_LOCKTIME_DISABLE_FLAG = 0x80000000;
const CRITERIA_DOMAIN = 'ordex.offer-criteria/v1';
const TRAIT_MEMBER_DOMAIN = 'ordex.offer-trait-member/v1';
const TRAIT_NODE_DOMAIN = 'ordex.offer-trait-node/v1';

/** Parse an exact non-negative decimal string into a bigint, or null. */
export function parseSats(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  return BigInt(value);
}

export const OFFER_TERMS_SCHEMA = 'ordex.offer-terms/v1';
export const OFFER_ACCEPTANCE_SCHEMA = 'ordex.offer-acceptance/v2';
export const OFFER_RECOVERY_SCHEMA = 'ordex.offer-recovery/v2';
/** The largest expiry a height-domain locktime carries; 500000000 and above is a timestamp. */
export const OFFER_EXPIRY_HEIGHT_MAX = 499999999;
/** BIP341's unspendable point H. As the funded output's internal key, no key path exists. */
export const OFFER_INTERNAL_KEY_HEX = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';

export type OfferKind = 'ITEM' | 'COLLECTION' | 'TRAIT';

export interface OfferTerms {
  schema: string;
  protocolVersion: string;
  network: string;
  offerKind: OfferKind;
  collectionId: string;
  collectionRoot: string;
  itemInscriptionId?: string;
  traitName?: string;
  traitValue?: string;
  criteriaHash: string;
  buyerReceiveScriptHex: string;
  priceSats: string;
  maxNetworkFeeSats: string;
  expiryHeight: number;
  buyerRecoveryKeyHex: string;
}

export type OfferTermsRefusalCode =
  | 'MALFORMED_TERMS'
  | 'TERMS_SCHEMA_UNSUPPORTED'
  | 'TERMS_PROTOCOL_UNSUPPORTED'
  | 'TERMS_NETWORK_UNKNOWN'
  | 'TERMS_KIND_UNKNOWN'
  | 'TERMS_SCOPE_FIELDS'
  | 'TERMS_ROOT_INVALID'
  | 'TERMS_CRITERIA_INVALID'
  | 'TERMS_SCRIPT_INVALID'
  | 'TERMS_AMOUNT_INVALID'
  | 'TERMS_EXPIRY_INVALID'
  | 'TERMS_RECOVERY_KEY_INVALID';

export type OfferTermsVerdict =
  | { ok: true; offerTermsHash: string }
  | { ok: false; code: OfferTermsRefusalCode; reason: string };

interface Refusal<C extends string> {
  ok: false;
  code: C;
  reason: string;
}

const refuse = <C extends string>(code: C, reason: string): Refusal<C> => ({ ok: false, code, reason });

/** Serialize any JSON value with object keys sorted recursively. */
export function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 over the exact serialized form of the terms, as lowercase hex. */
export function offerTermsHash(terms: OfferTerms): string {
  return createHash('sha256').update(sortedJson(terms), 'utf8').digest('hex');
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const isXOnlyKey = (hex: unknown): hex is string => typeof hex === 'string' && HEX64.test(hex) && liftX(BigInt(`0x${hex}`)) !== null;

export interface OfferOutpoint {
  txid: string;
  vout: number;
}

const validOutpoint = (o: unknown): o is OfferOutpoint => {
  const p = o as { txid?: unknown; vout?: unknown } | null;
  return !!p && typeof p.txid === 'string' && HEX64.test(p.txid) && Number.isInteger(p.vout) && (p.vout as number) >= 0 && (p.vout as number) <= 0xffffffff;
};
const sameOutpoint = (a: OfferOutpoint, b: OfferOutpoint): boolean => a.txid === b.txid && a.vout === b.vout;

// ---------------------------------------------------------------------------
// Scope criteria.

/** The scope fields of offer terms the criteria hash is formed from. */
export interface OfferScope {
  offerKind?: unknown;
  collectionId?: unknown;
  collectionRoot?: unknown;
  itemInscriptionId?: unknown;
  traitName?: unknown;
  traitValue?: unknown;
}

export interface OfferProofStep {
  sibling: string;
  position: 'left' | 'right';
}

const traitMemberLeaf = (scope: OfferScope, memberIdentity: string): string =>
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

function traitNode(left: string, right: string): string {
  const [a, b] = left <= right ? [left, right] : [right, left];
  return sha256Hex(sortedJson({ domain: TRAIT_NODE_DOMAIN, left: a, right: b }));
}

function traitLeaves(scope: OfferScope, traitMembers: unknown): string[] | null {
  if (!Array.isArray(traitMembers) || traitMembers.length === 0) return null;
  if (!traitMembers.every((m) => typeof m === 'string' && m.length > 0) || new Set(traitMembers).size !== traitMembers.length) return null;
  return (traitMembers as string[]).map((m) => traitMemberLeaf(scope, m)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
export function offerCriteriaHash(scope: OfferScope, traitMembers?: readonly string[]): string | null {
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
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 === level.length ? (level[i] as string) : traitNode(level[i] as string, level[i + 1] as string));
    }
    level = next;
  }
  return level[0] as string;
}

/**
 * The proof that one member belongs to a TRAIT offer's eligible set:
 * [{ sibling, position }] from the leaf upward, or null for a non-member.
 */
export function buildTraitMemberProof(scope: OfferScope, traitMembers: readonly string[], memberIdentity: string): OfferProofStep[] | null {
  let level = traitLeaves(scope, traitMembers);
  if (!level) return null;
  let index = level.indexOf(traitMemberLeaf(scope, memberIdentity));
  if (index === -1) return null;
  const proof: OfferProofStep[] = [];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i] as string);
        if (i === index) index = next.length - 1;
        continue;
      }
      next.push(traitNode(level[i] as string, level[i + 1] as string));
      if (i === index) proof.push({ sibling: level[i + 1] as string, position: 'right' });
      if (i + 1 === index) proof.push({ sibling: level[i] as string, position: 'left' });
      if (i === index || i + 1 === index) index = next.length - 1;
    }
    level = next;
  }
  return proof;
}

function traitProofRoot(scope: OfferScope, memberIdentity: string, proof: unknown): string | null {
  if (
    !Array.isArray(proof) ||
    !proof.every((s: { sibling?: unknown; position?: unknown }) => !!s && HEX64.test(s.sibling as string) && (s.position === 'left' || s.position === 'right'))
  ) {
    return null;
  }
  let digest = traitMemberLeaf(scope, memberIdentity);
  for (const step of proof as OfferProofStep[]) digest = step.position === 'left' ? traitNode(step.sibling, digest) : traitNode(digest, step.sibling);
  return digest;
}

// ---------------------------------------------------------------------------
// Terms.

/**
 * Verify offer terms field by field and answer their hash. A hash that
 * matches nothing is refused everywhere; verifiers recompute it.
 */
// OX-P05: expiry is a height-domain CHECKLOCKTIMEVERIFY argument, so it stays
// below 500000000 (P-R16); the recovery key must be a real point and the
// criteria hash is recomputed wherever the terms alone determine it.
export function verifyOfferTerms(terms: unknown): OfferTermsVerdict {
  if (!terms || typeof terms !== 'object' || Array.isArray(terms)) {
    return refuse('MALFORMED_TERMS', 'Expected a terms object.');
  }
  const t = terms as Record<string, unknown>;
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
  if (!Number.isSafeInteger(t.expiryHeight) || (t.expiryHeight as number) < 0 || (t.expiryHeight as number) > OFFER_EXPIRY_HEIGHT_MAX) {
    return refuse('TERMS_EXPIRY_INVALID', 'expiryHeight must be a block height below 500000000, the locktime timestamp threshold.');
  }
  if (!isXOnlyKey(t.buyerRecoveryKeyHex)) {
    return refuse('TERMS_RECOVERY_KEY_INVALID', 'The buyer recovery key must be a valid x-only public key in 64 lowercase hex characters.');
  }
  return { ok: true, offerTermsHash: offerTermsHash(t as unknown as OfferTerms) };
}

// ---------------------------------------------------------------------------
// The funded output.

/** The minimal push of a script number, as tapscript's MINIMALDATA rule requires. */
function scriptNumberPush(n: number): string {
  if (n === 0) return '00';
  if (n <= 16) return (0x50 + n).toString(16);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.push(v % 256);
  if ((bytes[bytes.length - 1] as number) & 0x80) bytes.push(0);
  return bytes.length.toString(16).padStart(2, '0') + bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface OfferOutputTree {
  ok: true;
  offerTermsHash: string;
  acceptanceLeafHex: string;
  recoveryLeafHex: string;
  acceptanceLeafHashHex: string;
  recoveryLeafHashHex: string;
  merkleRootHex: string;
  internalKeyHex: string;
  outputKeyHex: string;
  scriptPubKeyHex: string;
  acceptanceControlBlockHex: string;
  recoveryControlBlockHex: string;
}

export type OfferTreeVerdict = OfferOutputTree | Refusal<OfferTermsRefusalCode | 'POLICY_KEYS_INVALID'>;

/**
 * The exact Taproot tree of a funded offer output: the acceptance and
 * recovery leaves, the internal key H, the output script, and the control
 * block each leaf is revealed with. policyKeysHex lists the two x-only
 * policy signer keys in leaf order.
 */
// OX-P05: every leaf byte is rebuilt, never matched by substring, so key or opcode
// bytes inside pushed data cannot pass for script policy.
export function offerOutputTree(terms: unknown, policyKeysHex: unknown): OfferTreeVerdict {
  const verdict = verifyOfferTerms(terms);
  if (!verdict.ok) return verdict;
  const t = terms as OfferTerms;
  if (
    !Array.isArray(policyKeysHex) ||
    policyKeysHex.length !== 2 ||
    !policyKeysHex.every(isXOnlyKey) ||
    policyKeysHex[0] === policyKeysHex[1] ||
    policyKeysHex.includes(t.buyerRecoveryKeyHex) ||
    policyKeysHex.includes(OFFER_INTERNAL_KEY_HEX)
  ) {
    return refuse('POLICY_KEYS_INVALID', 'An offer names two distinct valid policy signer keys, neither of them the buyer recovery key.');
  }
  const [keyA, keyB] = policyKeysHex as [string, string];
  const acceptanceLeafHex = `20${verdict.offerTermsHash}7520${keyA}ac20${keyB}ba5287`;
  const recoveryLeafHex = `${scriptNumberPush(t.expiryHeight)}b17520${t.buyerRecoveryKeyHex}ac`;
  const acceptanceLeafHash = tapLeafHash(acceptanceLeafHex);
  const recoveryLeafHash = tapLeafHash(recoveryLeafHex);
  const merkleRoot = tapBranchHash(acceptanceLeafHash, recoveryLeafHash);
  const tweaked = taprootTweak(hexToBytes(OFFER_INTERNAL_KEY_HEX) as Uint8Array, merkleRoot);
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

/** The funded offer as the authorities report it. */
export interface FundedOffer {
  terms: OfferTerms;
  /** [policyKeyA, policyKeyB], x-only, in leaf order. */
  policyKeysHex: [string, string];
  fundedOutput: { outpoint: OfferOutpoint; valueSats: string; scriptPubKeyHex: string };
  /** The chain height an acceptance is checked at. */
  currentHeight?: number;
}

/** The offer an acceptance is checked against: the funded offer at a known height. */
export type OfferAcceptanceContext = FundedOffer & { currentHeight: number };

type OfferContextCode = OfferTermsRefusalCode | 'MALFORMED_OFFER' | 'POLICY_KEYS_INVALID' | 'OFFER_OUTPUT_MISMATCH';

interface OfferContext {
  ok: true;
  terms: OfferTerms;
  tree: OfferOutputTree;
  funded: FundedOffer['fundedOutput'];
  fundedValue: bigint;
}

function readOffer(offer: unknown): OfferContext | Refusal<OfferContextCode> {
  if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
    return refuse('MALFORMED_OFFER', 'Expected the offer terms, the two policy keys and the funded output.');
  }
  const o = offer as Partial<FundedOffer>;
  const tree = offerOutputTree(o.terms, o.policyKeysHex);
  if (!tree.ok) return tree;
  const funded = o.fundedOutput;
  const fundedValue = parseSats(funded?.valueSats);
  if (!funded || !validOutpoint(funded.outpoint) || fundedValue === null || typeof funded.scriptPubKeyHex !== 'string') {
    return refuse('MALFORMED_OFFER', 'The funded output needs its outpoint, exact value and script.');
  }
  if (funded.scriptPubKeyHex !== tree.scriptPubKeyHex) {
    return refuse('OFFER_OUTPUT_MISMATCH', 'The funded output does not commit to the tree these terms and policy keys produce.');
  }
  return { ok: true, terms: o.terms as OfferTerms, tree, funded, fundedValue };
}

type TapscriptStatus = 'VALID' | 'MISSING' | 'UNCLOSED' | 'INVALID';

function tapscriptSignature(sigHex: string | undefined, keyHex: string, digestFor: (hashType: number) => Uint8Array | null): TapscriptStatus {
  const sig = hexToBytes(sigHex);
  if (!sig || sig.length === 0) return 'MISSING';
  if (sig.length !== 64 && sig.length !== 65) return 'INVALID';
  const hashType = sig.length === 65 ? (sig[64] as number) : 0x00;
  if (sig.length === 65 && hashType === 0x00) return 'INVALID';
  if (hashType !== 0x00 && hashType !== 0x01) return 'UNCLOSED';
  const digest = digestFor(hashType);
  return digest && verifySchnorr(digest, sig.subarray(0, 64), hexToBytes(keyHex) as Uint8Array) ? 'VALID' : 'INVALID';
}

// ---------------------------------------------------------------------------
// Acceptance.

export type OfferAcceptanceRefusalCode =
  | OfferContextCode
  | 'MALFORMED_ACCEPTANCE'
  | 'SCHEMA_UNSUPPORTED'
  | 'NETWORK_MISMATCH'
  | 'CURRENT_HEIGHT_INVALID'
  | 'OFFER_EXPIRED'
  | 'SELLER_INVALID'
  | 'PARTY_SCRIPTS_OVERLAP'
  | 'SCOPE_MISMATCH'
  | 'ELIGIBILITY_PROOF_MALFORMED'
  | 'COLLECTION_MEMBERSHIP_NOT_PROVEN'
  | 'TRAIT_NOT_PROVEN'
  | 'TRANSACTION_INVALID'
  | 'LOCKTIME_INVALID'
  | 'INPUT_DESCRIPTION_MISMATCH'
  | 'INPUT_DUPLICATED'
  | 'SEQUENCE_INVALID'
  | 'BUYER_INPUT_UNAUTHORIZED'
  | 'INPUT_PARTY_INVALID'
  | 'INPUT_VALUE_INVALID'
  | 'INPUT_SCRIPT_INVALID'
  | 'OFFER_INPUT_MISMATCH'
  | 'OFFER_OUTPOINT_MISSING'
  | 'OFFER_INPUT_POSITION'
  | 'FELINE_OUTPOINT_MISSING'
  | 'FELINE_NOT_HELD'
  | 'OUTPUT_UNDESCRIBED'
  | 'DUST_OUTPUT'
  | 'ASSET_OUTPUTS_UNBALANCED'
  | 'BUYER_ASSET_OUTPUT_MISSING'
  | 'SELLER_OUTPUT_MISSING'
  | 'SELLER_SCRIPT_MISMATCH'
  | 'SELLER_VALUE_MISMATCH'
  | 'VALUE_NOT_CONSERVED'
  | 'FEE_OVER_MAXIMUM'
  | 'FELINE_NOT_DELIVERED'
  | 'ASSET_MISDIRECTED'
  | 'POLICY_WITNESS_INVALID'
  | 'POLICY_SIGNATURES_MISSING'
  | 'ACCEPTANCE_LEAF_MISMATCH'
  | 'CONTROL_BLOCK_MISMATCH'
  | 'POLICY_SIGNATURE_INVALID'
  | 'UNCLOSED_SIGHASH'
  | 'SIGNATURE_MISSING'
  | 'SIGNATURE_UNVERIFIABLE'
  | 'SIGNATURE_INVALID'
  // Inventory and asset-flow refusals pass through unchanged (asset-flow.ts).
  | (string & {});

/** One described input of an acceptance. The buyer contributes none. */
export interface OfferAcceptanceInput {
  outpoint: OfferOutpoint;
  party: 'SELLER' | 'OFFER';
  valueSats: string;
  scriptPubKeyHex: string;
  /** What the authorities report the outpoint carries; see readInventory. */
  inventory: AssetInventory;
}

/** An acceptance: the transaction bytes and what the verifier needs to judge them. */
export interface OfferAcceptanceTransaction {
  schema: string;
  network: string;
  seller: { paymentScriptHex: string; returnScriptHex?: string };
  feline: { inscriptionId: string; outpoint: OfferOutpoint };
  eligibility: { membershipProof: OfferProofStep[]; traitProof?: OfferProofStep[] };
  inputs: OfferAcceptanceInput[];
  /** Unsigned, partly signed or complete; verifyOfferAcceptance needs complete. */
  transactionHex: string;
}

export type OfferAcceptanceVerdict =
  | {
      ok: true;
      txid: string;
      offerTermsHash: string;
      offerInputIndex: number;
      felineInputIndex: number;
      buyerAssetOutputIndex: number;
      sellerPaymentIndex: number;
      feeSats: string;
    }
  | { ok: false; code: OfferAcceptanceRefusalCode; reason: string };

export type OfferPolicySighashVerdict =
  | {
      ok: true;
      offerTermsHash: string;
      offerInputIndex: number;
      sighashHex: string;
      leafHashHex: string;
      controlBlockHex: string;
      feeSats: string;
    }
  | { ok: false; code: OfferAcceptanceRefusalCode; reason: string };

interface CheckedInput {
  outpoint: OfferOutpoint;
  party: 'SELLER' | 'OFFER';
  value: bigint;
  scriptPubKeyHex: string;
  assets: InventoryAsset[];
}

interface CheckedAcceptance {
  ok: true;
  tx: Transaction;
  txid: string;
  tree: OfferOutputTree;
  offerIndex: number;
  felineIndex: number;
  buyerAssetIndex: number;
  sellerPaymentIndex: number;
  fee: bigint;
  prevouts: Prevout[];
}

type AcceptanceRefusal = { ok: false; code: OfferAcceptanceRefusalCode; reason: string };

function checkEligibility(terms: OfferTerms, inscriptionId: string, eligibility: unknown): { ok: true } | AcceptanceRefusal {
  if (terms.offerKind === 'ITEM' && inscriptionId !== terms.itemInscriptionId) {
    return refuse('SCOPE_MISMATCH', 'The delivered inscription is not the one this ITEM offer names.');
  }
  if (!eligibility || typeof eligibility !== 'object') {
    return refuse('ELIGIBILITY_PROOF_MALFORMED', 'The acceptance must carry the membership proof of the delivered Feline.');
  }
  const e = eligibility as { membershipProof?: unknown; traitProof?: unknown };
  const root = membershipProofRoot(terms.collectionId, inscriptionId, e.membershipProof);
  if (root === null) return refuse('ELIGIBILITY_PROOF_MALFORMED', 'Every membership proof step needs a sibling digest and a position.');
  if (root !== terms.collectionRoot) {
    return refuse('COLLECTION_MEMBERSHIP_NOT_PROVEN', 'The membership proof does not resolve to the collection root the terms commit to.');
  }
  if (terms.offerKind === 'TRAIT') {
    const traitRoot = traitProofRoot(terms, inscriptionId, e.traitProof);
    if (traitRoot === null) return refuse('ELIGIBILITY_PROOF_MALFORMED', 'A TRAIT acceptance must carry a well formed trait proof.');
    if (traitRoot !== terms.criteriaHash) {
      return refuse('TRAIT_NOT_PROVEN', 'The trait proof does not resolve to the criteria hash, so this Feline is not one the buyer accepted.');
    }
  }
  return { ok: true };
}

/** Everything about an acceptance except its signatures. */
function checkAcceptance(acceptance: unknown, offer: unknown): CheckedAcceptance | AcceptanceRefusal {
  if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) {
    return refuse('MALFORMED_ACCEPTANCE', 'Expected an acceptance object.');
  }
  const a = acceptance as Partial<OfferAcceptanceTransaction>;
  if (a.schema !== OFFER_ACCEPTANCE_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The acceptance schema is not ordex.offer-acceptance/v2. Build the acceptance again.');
  }
  const context = readOffer(offer);
  if (!context.ok) return context;
  const { terms, tree, funded, fundedValue } = context;
  if (a.network !== terms.network) {
    return refuse('NETWORK_MISMATCH', 'The acceptance was built for a different network than the terms.');
  }
  const height = (offer as { currentHeight?: unknown }).currentHeight;
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0 || height >= LOCKTIME_THRESHOLD) {
    return refuse('CURRENT_HEIGHT_INVALID', 'An acceptance is checked at a known block height.');
  }
  if (height >= terms.expiryHeight) {
    return refuse('OFFER_EXPIRED', 'The expiry height has been reached; recovery is the only remaining path.');
  }

  const seller = a.seller;
  const script = (s: unknown): s is string => typeof s === 'string' && EVEN_HEX.test(s) && !s.startsWith('6a');
  if (!seller || !script(seller.paymentScriptHex) || (seller.returnScriptHex !== undefined && !script(seller.returnScriptHex))) {
    return refuse('SELLER_INVALID', 'The acceptance must name the seller payment script, and a return script only as spendable hex.');
  }
  const sellerScripts = new Set([seller.paymentScriptHex, seller.returnScriptHex ?? seller.paymentScriptHex]);
  if (sellerScripts.has(terms.buyerReceiveScriptHex)) {
    return refuse('PARTY_SCRIPTS_OVERLAP', 'A seller script equals the buyer receive script, so no output could be attributed.');
  }

  const feline = a.feline;
  if (!feline || typeof feline.inscriptionId !== 'string' || !INSCRIPTION.test(feline.inscriptionId) || !validOutpoint(feline.outpoint)) {
    return refuse('MALFORMED_ACCEPTANCE', 'The acceptance must name the delivered Feline and the outpoint holding it.');
  }
  const eligible = checkEligibility(terms, feline.inscriptionId, a.eligibility);
  if (!eligible.ok) return eligible;

  const parsed = parseTransaction(a.transactionHex);
  if (!parsed.ok) return refuse('TRANSACTION_INVALID', parsed.reason);
  const tx = parsed.tx;
  if (tx.version !== 1 && tx.version !== 2) {
    return refuse('TRANSACTION_INVALID', 'An acceptance is a version 1 or 2 transaction.');
  }
  if (tx.lockTime >= LOCKTIME_THRESHOLD || tx.lockTime > height) {
    return refuse('LOCKTIME_INVALID', 'The acceptance locktime must be a block height no later than the current one, so it can confirm before expiry.');
  }

  // Inputs: every one described, the seller's first, the offer output last.
  const described = a.inputs;
  if (!Array.isArray(described) || described.length !== tx.inputs.length) {
    return refuse('INPUT_DESCRIPTION_MISMATCH', 'Every transaction input needs exactly one description, in order.');
  }
  const inputs: CheckedInput[] = [];
  const seen = new Set<string>();
  let offerIndex = -1;
  let felineIndex = -1;
  let sellerTotal = 0n;
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const d = described[i] as Partial<Omit<OfferAcceptanceInput, 'party'>> & { party?: unknown };
    const party = d?.party;
    const spent = tx.inputs[i] as Transaction['inputs'][number];
    if (!d || !validOutpoint(d.outpoint) || !sameOutpoint(d.outpoint, spent)) {
      return refuse('INPUT_DESCRIPTION_MISMATCH', `Input ${i} is not described as the outpoint the transaction spends.`);
    }
    const key = `${spent.txid}:${spent.vout}`;
    if (seen.has(key)) return refuse('INPUT_DUPLICATED', `Input ${key} appears more than once.`);
    seen.add(key);
    if (tx.version >= 2 && spent.sequence < SEQUENCE_LOCKTIME_DISABLE_FLAG) {
      return refuse('SEQUENCE_INVALID', `Input ${i} carries a relative timelock that could hold the acceptance past expiry.`);
    }
    if (party === 'BUYER') {
      return refuse(
        'BUYER_INPUT_UNAUTHORIZED',
        `Input ${i} is a buyer input. The buyer signs nothing at acceptance; only the funded output is spent for the buyer.`,
      );
    }
    if (party !== 'SELLER' && party !== 'OFFER') {
      return refuse('INPUT_PARTY_INVALID', `Input ${i} must be a seller input or the funded offer output.`);
    }
    const value = parseSats(d.valueSats);
    if (value === null) return refuse('INPUT_VALUE_INVALID', `Input ${i} does not carry an exact decimal value.`);
    if (typeof d.scriptPubKeyHex !== 'string' || !EVEN_HEX.test(d.scriptPubKeyHex)) {
      return refuse('INPUT_SCRIPT_INVALID', `Input ${i} does not carry the script of the output it spends.`);
    }
    const isOffer = sameOutpoint(spent, funded.outpoint);
    if ((party === 'OFFER') !== isOffer) {
      return refuse(
        'OFFER_INPUT_MISMATCH',
        `Input ${i} is described as ${party === 'OFFER' ? 'the offer but spends another output' : 'a seller input but spends the funded offer output'}.`,
      );
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
    if (!('assets' in read)) return read;
    inputs.push({ outpoint: d.outpoint, party, value, scriptPubKeyHex: d.scriptPubKeyHex, assets: read.assets });
  }
  if (offerIndex === -1) return refuse('OFFER_OUTPOINT_MISSING', 'No input spends the funded offer output.');
  if (offerIndex !== inputs.length - 1) {
    return refuse('OFFER_INPUT_POSITION', 'The funded offer output must be the last input, so its sats never reach the Feline range.');
  }
  if (felineIndex === -1) return refuse('FELINE_OUTPOINT_MISSING', 'No seller input spends the outpoint holding the Feline.');
  if (!(inputs[felineIndex] as CheckedInput).assets.some((x) => x.assetType === 'ORDINAL' && x.assetId === feline.inscriptionId)) {
    return refuse('FELINE_NOT_HELD', 'The authorities do not report the Feline on the outpoint the acceptance names.');
  }

  // Outputs: asset outputs that absorb exactly the seller's inputs, then the
  // seller payment, then at most one buyer change output.
  const values = tx.outputs.map((o) => BigInt(o.valueSats));
  for (let j = 0; j < tx.outputs.length; j += 1) {
    const outScript = (tx.outputs[j] as Transaction['outputs'][number]).scriptHex;
    if (outScript.startsWith('6a')) return refuse('OUTPUT_UNDESCRIBED', `Output ${j} is a data output; an acceptance carries none.`);
    const dust = dustThresholdSats(outScript) as bigint;
    if ((values[j] as bigint) < dust) return refuse('DUST_OUTPUT', `Output ${j} is below the ${dust} sat dust threshold for its script.`);
  }
  let assetCount = -1;
  let running = 0n;
  for (let j = 0; j < values.length && running < sellerTotal; j += 1) {
    running += values[j] as bigint;
    if (running === sellerTotal) assetCount = j + 1;
  }
  if (assetCount === -1) {
    return refuse('ASSET_OUTPUTS_UNBALANCED', 'The outputs ahead of the seller payment must absorb exactly the sats of the seller inputs.');
  }
  const owners: Array<'buyer' | 'seller'> = [];
  let buyerAssetIndex = -1;
  for (let j = 0; j < assetCount; j += 1) {
    const outScript = (tx.outputs[j] as Transaction['outputs'][number]).scriptHex;
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
    if ((tx.outputs[sellerPaymentIndex + 1] as Transaction['outputs'][number]).scriptHex !== terms.buyerReceiveScriptHex) {
      return refuse('OUTPUT_UNDESCRIBED', 'The output after the seller payment must be buyer change to the buyer receive script.');
    }
    owners.push('buyer');
  }

  const totalIn = inputs.reduce((n, input) => n + input.value, 0n);
  const totalOut = values.reduce((n, v) => n + v, 0n);
  const fee = totalIn - totalOut;
  if (fee < 0n) return refuse('VALUE_NOT_CONSERVED', 'The outputs exceed the inputs.');
  if (fee > (parseSats(terms.maxNetworkFeeSats) as bigint)) {
    return refuse('FEE_OVER_MAXIMUM', 'The fee exceeds the maximum the terms committed to.');
  }

  // Assets: the Feline to the buyer asset output, everything else home.
  const flow = deriveAssetFlow({ network: terms.network, height: height + 1, inputs, outputs: tx.outputs });
  if (!flow.ok) return flow;
  const ownerOf = (i: number): 'buyer' | 'seller' => ((inputs[i] as CheckedInput).party === 'OFFER' ? 'buyer' : 'seller');
  const runeNet = new Map<string, bigint>();
  inputs.forEach((input, i) => {
    for (const x of input.assets) {
      if (x.assetType !== 'RUNE') continue;
      const k = `${ownerOf(i)}|${x.assetId}`;
      runeNet.set(k, (runeNet.get(k) ?? 0n) - BigInt(x.amount));
    }
  });
  let delivered = false;
  for (const m of flow.movements) {
    const landsWith = owners[m.toOutput] as 'buyer' | 'seller';
    if (m.assetType === 'RUNE') {
      const k = `${landsWith}|${m.assetId}`;
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
    const from = ownerOf(m.fromInput as number);
    if (landsWith !== from) {
      return refuse('ASSET_MISDIRECTED', `${m.assetType} ${m.assetId} belongs to the ${from} and would land with the ${landsWith}.`);
    }
  }
  if (!delivered) return refuse('FELINE_NOT_DELIVERED', 'The Feline is not moved to the buyer by this transaction.');
  for (const [k, net] of runeNet) {
    const [party, runeId] = k.split('|');
    if (net !== 0n) return refuse('ASSET_MISDIRECTED', `Rune ${runeId} would move to or from the ${party}.`);
  }

  return {
    ok: true,
    tx,
    txid: parsed.txid,
    tree,
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
 */
// OX-P05: the policy signer contract. Each independently keyed signer runs the
// full acceptance rules from its own evidence before signing this one hash.
export function offerPolicySighash(acceptance: unknown, offer: unknown): OfferPolicySighashVerdict {
  const check = checkAcceptance(acceptance, offer);
  if (!check.ok) return check;
  const digest = taprootSighash(check.tx, check.offerIndex, check.prevouts, 0x00, {
    leafHash: hexToBytes(check.tree.acceptanceLeafHashHex) as Uint8Array,
  }) as Uint8Array;
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
 * Verify a complete acceptance transaction against its funded offer. Success
 * needs every rule of spec/offers.md and every signature: both policy
 * signatures under the exact acceptance leaf and control block, and a
 * closing signature on every seller input. A missing signature is refused,
 * never assumed.
 */
// OX-P05: P-R14 passed when the buyer script merely appeared before the seller
// index. Delivery is now derived from the Feline's satpoint, the leaf, tree and
// signatures are proved from the bytes, and no buyer input is ever spent.
export function verifyOfferAcceptance(acceptance: OfferAcceptanceTransaction, offer: OfferAcceptanceContext): OfferAcceptanceVerdict {
  const check = checkAcceptance(acceptance, offer);
  if (!check.ok) return check;
  const tx = check.tx;
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const input = tx.inputs[i] as Transaction['inputs'][number];
    if (i === check.offerIndex) {
      if (input.scriptSigHex !== '') return refuse('POLICY_WITNESS_INVALID', 'The offer input carries a scriptSig.');
      if (input.witness.length === 0) return refuse('POLICY_SIGNATURES_MISSING', 'The offer input carries no policy signatures.');
      if (input.witness.length !== 4) {
        return refuse('POLICY_WITNESS_INVALID', 'The offer input witness must be two signatures, the acceptance leaf and its control block.');
      }
      const [sigB, sigA, leafHex, controlHex] = input.witness as [string, string, string, string];
      if (leafHex !== check.tree.acceptanceLeafHex) {
        return refuse('ACCEPTANCE_LEAF_MISMATCH', 'The revealed leaf is not the exact acceptance leaf for these terms and policy keys.');
      }
      if (controlHex !== check.tree.acceptanceControlBlockHex) {
        return refuse('CONTROL_BLOCK_MISMATCH', 'The control block does not commit the acceptance leaf to the funded output.');
      }
      const leafHash = hexToBytes(check.tree.acceptanceLeafHashHex) as Uint8Array;
      const [keyA, keyB] = offer.policyKeysHex;
      for (const [sigHex, keyHex] of [
        [sigA, keyA],
        [sigB, keyB],
      ] as Array<[string, string]>) {
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
    if (!closing.includes(verdict.sighashType as number)) {
      return refuse('UNCLOSED_SIGHASH', `Seller input ${i} was signed without committing to every input and output.`);
    }
  }
  return {
    ok: true,
    txid: check.txid,
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

export type OfferRecoveryRefusalCode =
  | OfferContextCode
  | 'MALFORMED_RECOVERY'
  | 'SCHEMA_UNSUPPORTED'
  | 'TRANSACTION_INVALID'
  | 'RECOVERY_INPUTS_INVALID'
  | 'OFFER_OUTPOINT_MISSING'
  | 'LOCKTIME_INVALID'
  | 'RECOVERY_BEFORE_EXPIRY'
  | 'SEQUENCE_FINAL'
  | 'RECOVERY_OUTPUT_WRONG'
  | 'VALUE_NOT_CONSERVED'
  | 'DUST_OUTPUT'
  | 'RECOVERY_WITNESS_INVALID'
  | 'RECOVERY_LEAF_MISMATCH'
  | 'CONTROL_BLOCK_MISMATCH'
  | 'SIGNATURE_MISSING'
  | 'UNCLOSED_SIGHASH'
  | 'SIGNATURE_INVALID';

/** A recovery: the complete transaction bytes. */
export interface OfferRecoveryTransaction {
  schema: string;
  transactionHex: string;
}

export type OfferRecoveryVerdict =
  | { ok: true; txid: string; feeSats: string }
  | { ok: false; code: OfferRecoveryRefusalCode; reason: string };

/**
 * Verify a complete recovery transaction: the funded output alone, spent by
 * the exact recovery leaf and control block with a closing signature by the
 * buyer recovery key, a height-domain locktime at or after expiry, a
 * non-final sequence, and one output paying the buyer receive script.
 */
// OX-P05: P-R15 accepted a recovery with no locktime. The locktime, its domain,
// the sequence and the leaf are now read from the bytes the node will judge.
export function verifyOfferRecovery(recovery: OfferRecoveryTransaction, offer: FundedOffer): OfferRecoveryVerdict {
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
  const input = tx.inputs[0] as Transaction['inputs'][number];
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
  const output = tx.outputs[0];
  if (tx.outputs.length !== 1 || !output || output.scriptHex !== terms.buyerReceiveScriptHex) {
    return refuse('RECOVERY_OUTPUT_WRONG', 'A recovery pays one output, the buyer receive script.');
  }
  const paid = BigInt(output.valueSats);
  if (paid > fundedValue) return refuse('VALUE_NOT_CONSERVED', 'The recovery pays more than the funded output holds.');
  const dust = dustThresholdSats(output.scriptHex) as bigint;
  if (paid < dust) return refuse('DUST_OUTPUT', `The recovery output is below the ${dust} sat dust threshold for its script.`);
  if (input.scriptSigHex !== '') return refuse('RECOVERY_WITNESS_INVALID', 'The recovery input carries a scriptSig.');
  if (input.witness.length === 0) return refuse('SIGNATURE_MISSING', 'The recovery input is unsigned.');
  if (input.witness.length !== 3) {
    return refuse('RECOVERY_WITNESS_INVALID', 'The recovery witness must be one signature, the recovery leaf and its control block.');
  }
  const [sigHex, leafHex, controlHex] = input.witness as [string, string, string];
  if (leafHex !== tree.recoveryLeafHex) {
    return refuse('RECOVERY_LEAF_MISMATCH', 'The revealed leaf is not the exact recovery leaf for these terms.');
  }
  if (controlHex !== tree.recoveryControlBlockHex) {
    return refuse('CONTROL_BLOCK_MISMATCH', 'The control block does not commit the recovery leaf to the funded output.');
  }
  const prevouts: Prevout[] = [{ valueSats: funded.valueSats, scriptHex: funded.scriptPubKeyHex }];
  const leafHash = hexToBytes(tree.recoveryLeafHashHex) as Uint8Array;
  const status = tapscriptSignature(sigHex, terms.buyerRecoveryKeyHex, (hashType) => taprootSighash(tx, 0, prevouts, hashType, { leafHash }));
  if (status === 'MISSING') return refuse('SIGNATURE_MISSING', 'The recovery carries no buyer signature.');
  if (status === 'UNCLOSED') return refuse('UNCLOSED_SIGHASH', 'The buyer signature does not commit to the whole recovery.');
  if (status !== 'VALID') return refuse('SIGNATURE_INVALID', 'The buyer signature does not verify against the recovery key.');
  return { ok: true, txid: parsed.txid, feeSats: (fundedValue - paid).toString() };
}
