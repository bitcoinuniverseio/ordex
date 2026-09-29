/**
 * The cold signing and watch-only rules from spec/cold-signing.md, typed.
 *
 * This is the same verifier as verifier/offline-signing.js at the repository
 * root, ported to TypeScript for SDK consumers. Both implementations are run
 * against conformance/offline-signing-vectors.json, so they cannot drift apart
 * without a test failing. Signed results are read from their PSBT or raw
 * transaction bytes and every signature is verified cryptographically.
 */

import { createHash } from 'node:crypto';

import {
  bytesToHex,
  dustThresholdSats,
  extractPsbtTransaction,
  parsePsbt,
  parseTransaction,
  serializeTransaction,
  transactionId,
  unsignedCopy,
  verifyInputSignature,
  verifyPsbtPartialSignatures,
  type Psbt,
  type SignatureStatus,
  type Transaction,
} from './bitcoin-tx.js';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})*$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const NETWORKS = ['mainnet', 'testnet', 'testnet4', 'signet', 'regtest'];
const SIGHASH_BYTES: Record<string, number> = {
  DEFAULT: 0x00,
  ALL: 0x01,
  NONE: 0x02,
  SINGLE: 0x03,
  'ALL|ANYONECANPAY': 0x81,
  'NONE|ANYONECANPAY': 0x82,
  'SINGLE|ANYONECANPAY': 0x83,
};
const U32_MAX = 0xffffffff;
const SIGNED_FIELDS = ['schema', 'manifestDigest', 'psbt', 'signedTxHex', 'observedAssets', 'unknownCriticalFields'];

export const EXPECTED_TRANSACTION_MANIFEST_SCHEMA = 'ordex.expected-transaction-manifest/v2';
export const OFFLINE_SIGNING_SESSION_SCHEMA = 'ordex.offline-signing-session/v2';

/** Parse an exact non-negative decimal string into a bigint, or null. */
export function parseSats(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  return BigInt(value);
}

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

export interface PreservedSignature {
  scriptSigHex: string;
  witness: string[];
}

export interface ExpectedTransactionInput {
  txid?: unknown;
  vout?: unknown;
  sequence?: unknown;
  valueSats?: unknown;
  scriptPubKeyHex?: unknown;
  controlledByUser?: unknown;
  sighashType?: string;
  explanation?: unknown;
  /** A foreign input's signature, already present, that must be preserved. */
  preservedSignature?: PreservedSignature;
}

export interface ExpectedAsset {
  assetType?: unknown;
  assetId?: unknown;
  quantity?: unknown;
}

export interface ExpectedTransactionOutput {
  scriptHex?: unknown;
  valueSats?: unknown;
  role?: unknown;
  explanation?: unknown;
  expectedAssets?: ExpectedAsset[];
}

export interface ExpectedTransactionManifest {
  schema?: unknown;
  network?: unknown;
  purpose?: unknown;
  watchOnly?: unknown;
  unsignedTx: {
    version?: unknown;
    lockTime?: unknown;
    inputs: ExpectedTransactionInput[];
    outputs: ExpectedTransactionOutput[];
  };
  fee: { feeSats?: unknown; maxFeeSats?: unknown };
  account?: { descriptor?: string };
  digest?: unknown;
  [key: string]: unknown;
}

export interface ObservedAsset {
  assetType: string;
  assetId: string;
  quantity: string;
  outputIndex: number;
}

export interface OfflineSigningResult {
  schema?: unknown;
  manifestDigest?: unknown;
  /** A PSBT (v0 or v2), base64 or hex. Exactly one of psbt and signedTxHex. */
  psbt?: unknown;
  /** A signed raw transaction, lowercase hex. */
  signedTxHex?: unknown;
  /** Protected asset movements derived independently from the signed bytes. */
  observedAssets?: unknown;
  unknownCriticalFields?: unknown[];
  [key: string]: unknown;
}

const isU32 = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= U32_MAX;

/** The exact unsigned transaction a manifest presents. */
export function manifestUnsignedTransaction(manifest: ExpectedTransactionManifest): Transaction {
  const tx = manifest.unsignedTx;
  return {
    version: tx.version as number,
    lockTime: tx.lockTime as number,
    inputs: tx.inputs.map((input) => ({
      txid: input.txid as string,
      vout: input.vout as number,
      scriptSigHex: '',
      sequence: input.sequence as number,
      witness: [],
    })),
    outputs: tx.outputs.map((output) => ({ valueSats: String(parseSats(output.valueSats)), scriptHex: output.scriptHex as string })),
  };
}

function allowedSighash(name: string, scriptHex: string): number | undefined {
  const byte = SIGHASH_BYTES[name];
  if (byte === 0x00 && !scriptHex.startsWith('5120')) return 0x01;
  return byte;
}

/**
 * SHA-256 committing to the schema, the network, the exact unsigned
 * transaction bytes, every prevout, and the protection policy. Display text
 * sits outside it. The manifest must already be structurally valid.
 */
// OX-P03: v1 hashed outpoints, values and scripts only, so a changed version,
// locktime, sequence or asset policy kept the same digest (P-R12, P-R13). v2 hashes
// the unsigned bytes and the whole security policy under a new schema name, so no
// v1 digest is ever read with v2 meaning.
export function expectedTransactionDigest(manifest: ExpectedTransactionManifest): string {
  const tx = manifest.unsignedTx;
  return createHash('sha256')
    .update(
      sortedJson({
        schema: EXPECTED_TRANSACTION_MANIFEST_SCHEMA,
        network: manifest.network,
        unsignedTxHex: bytesToHex(serializeTransaction(manifestUnsignedTransaction(manifest))),
        prevouts: tx.inputs.map((input) => ({ valueSats: input.valueSats, scriptPubKeyHex: input.scriptPubKeyHex })),
        policy: {
          inputs: tx.inputs.map((input) => ({
            controlledByUser: input.controlledByUser,
            sighashType: input.sighashType ?? null,
            preservedSignature: input.preservedSignature ?? null,
          })),
          expectedAssets: tx.outputs.map((output) => output.expectedAssets ?? []),
          feeSats: manifest.fee.feeSats,
          maxFeeSats: manifest.fee.maxFeeSats,
        },
      }),
      'utf8'
    )
    .digest('hex');
}

export type OfflineSigningRefusalCode =
  | 'MALFORMED_MANIFEST'
  | 'SCHEMA_UNSUPPORTED'
  | 'NETWORK_UNKNOWN'
  | 'PURPOSE_MISSING'
  | 'TRANSACTION_INVALID'
  | 'INPUT_DESCRIPTION_INVALID'
  | 'INPUT_DUPLICATED'
  | 'SIGHASH_UNKNOWN'
  | 'SIGNING_POLICY_INVALID'
  | 'PRESERVED_SIGNATURE_INVALID'
  | 'OUTPUT_DESCRIPTION_INVALID'
  | 'DUST_OUTPUT'
  | 'ASSET_EXPECTATION_INVALID'
  | 'FEE_INVALID'
  | 'VALUE_NOT_CONSERVED'
  | 'ACCOUNT_INVALID'
  | 'DIGEST_MISMATCH'
  | 'MALFORMED_SIGNED_RESULT'
  | 'MANIFEST_DIGEST_MISMATCH'
  | 'UNKNOWN_CRITICAL_FIELDS'
  | 'LOCKTIME_UNDETERMINED'
  | 'FEE_OUT_OF_BOUNDS'
  | 'TRANSACTION_CHANGED'
  | 'INPUT_SET_CHANGED'
  | 'INPUT_REORDERED'
  | 'SEQUENCE_CHANGED'
  | 'PREVOUT_MISMATCH'
  | 'VALUE_CHANGED'
  | 'OUTPUT_SET_CHANGED'
  | 'SCRIPT_CHANGED'
  | 'SIGNATURE_ON_FOREIGN_INPUT'
  | 'SIGNATURE_INVALID'
  | 'SIGNATURE_UNVERIFIABLE'
  | 'FOREIGN_SIGNATURE_CHANGED'
  | 'FOREIGN_SIGNATURE_INVALID'
  | 'SIGHASH_UNEXPECTED'
  | 'REQUIRED_SIGNATURE_MISSING'
  | 'PROTECTED_ASSET_OBSERVATION_MISSING'
  | 'PROTECTED_ASSET_MISPLACED';

type Refusal = { ok: false; code: OfflineSigningRefusalCode; reason: string };

export type ExpectedTransactionManifestVerdict = { ok: true; digest: string } | Refusal;

export type SignedResultVerdict = { ok: true; txid: string; complete: boolean } | Refusal;

const refuse = (code: OfflineSigningRefusalCode, reason: string): Refusal => ({ ok: false, code, reason });

function validPreservedSignature(signature: unknown): signature is PreservedSignature {
  const s = signature as Partial<PreservedSignature> | null;
  return (
    !!s &&
    typeof s === 'object' &&
    typeof s.scriptSigHex === 'string' &&
    HEX.test(s.scriptSigHex) &&
    Array.isArray(s.witness) &&
    s.witness.every((item) => typeof item === 'string' && HEX.test(item)) &&
    (s.scriptSigHex !== '' || s.witness.length > 0)
  );
}

/** Verify an expected transaction manifest. */
export function verifyExpectedTransactionManifest(manifest: unknown): ExpectedTransactionManifestVerdict {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return refuse('MALFORMED_MANIFEST', 'Expected a manifest object.');
  }
  const m = manifest as ExpectedTransactionManifest;
  if (m.schema !== EXPECTED_TRANSACTION_MANIFEST_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The manifest schema is not ordex.expected-transaction-manifest/v2. Present the transaction again.');
  }
  if (typeof m.network !== 'string' || !NETWORKS.includes(m.network)) {
    return refuse('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (typeof m.purpose !== 'string' || m.purpose.length === 0 || m.purpose.length > 200) {
    return refuse('PURPOSE_MISSING', 'The manifest must state in one line what the transaction is for.');
  }
  if (typeof m.watchOnly !== 'boolean') {
    return refuse('MALFORMED_MANIFEST', 'The manifest must state whether it was prepared by a watch-only profile.');
  }
  const tx = m.unsignedTx;
  if (!tx || typeof tx !== 'object' || !Array.isArray(tx.inputs) || tx.inputs.length === 0 || !Array.isArray(tx.outputs) || tx.outputs.length === 0) {
    return refuse('MALFORMED_MANIFEST', 'The manifest must describe at least one input and one output.');
  }
  if (!isU32(tx.version) || tx.version < 1 || !isU32(tx.lockTime)) {
    return refuse('TRANSACTION_INVALID', 'The manifest must fix the transaction version and locktime.');
  }
  const outpoints = new Set<string>();
  let signedByUser = 0;
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const input = tx.inputs[i];
    if (
      !input ||
      typeof input.txid !== 'string' ||
      !HEX64.test(input.txid) ||
      typeof input.vout !== 'number' ||
      !Number.isInteger(input.vout) ||
      input.vout < 0 ||
      !isU32(input.sequence) ||
      parseSats(input.valueSats) === null ||
      typeof input.scriptPubKeyHex !== 'string' ||
      !EVEN_HEX.test(input.scriptPubKeyHex) ||
      typeof input.controlledByUser !== 'boolean' ||
      typeof input.explanation !== 'string' ||
      input.explanation.length === 0
    ) {
      return refuse(
        'INPUT_DESCRIPTION_INVALID',
        `Input ${i} needs an outpoint, a sequence, an exact value and script, whether the user controls it, and why it is spent.`
      );
    }
    const key = `${input.txid}:${input.vout}`;
    if (outpoints.has(key)) return refuse('INPUT_DUPLICATED', `Input ${i} spends ${key} a second time.`);
    outpoints.add(key);
    if (input.sighashType !== undefined && SIGHASH_BYTES[input.sighashType] === undefined) {
      return refuse('SIGHASH_UNKNOWN', `Input ${i} names a sighash this protocol does not define.`);
    }
    if (input.controlledByUser) {
      signedByUser += 1;
      if (input.sighashType === undefined) {
        return refuse('SIGNING_POLICY_INVALID', `Input ${i} is signed by the user and must name the one sighash allowed.`);
      }
      if (input.preservedSignature !== undefined) {
        return refuse('SIGNING_POLICY_INVALID', `Input ${i} is signed by the user, so it has no foreign signature to preserve.`);
      }
    } else if (input.preservedSignature !== undefined && !validPreservedSignature(input.preservedSignature)) {
      return refuse('PRESERVED_SIGNATURE_INVALID', `Input ${i} records a foreign signature that is not a scriptSig and witness.`);
    }
  }
  if (signedByUser === 0) {
    return refuse('SIGNING_POLICY_INVALID', 'A signing session asks the user to sign at least one input.');
  }
  for (let i = 0; i < tx.outputs.length; i += 1) {
    const output = tx.outputs[i];
    if (
      !output ||
      typeof output.scriptHex !== 'string' ||
      !EVEN_HEX.test(output.scriptHex) ||
      parseSats(output.valueSats) === null ||
      typeof output.role !== 'string' ||
      typeof output.explanation !== 'string' ||
      output.explanation.length === 0
    ) {
      return refuse('OUTPUT_DESCRIPTION_INVALID', `Output ${i} needs an exact script and value, a role, and who receives it.`);
    }
    const value = parseSats(output.valueSats) as bigint;
    const dust = dustThresholdSats(output.scriptHex) ?? 0n;
    if (output.scriptHex.startsWith('6a')) {
      if (value !== 0n) return refuse('DUST_OUTPUT', `Output ${i} would burn ${String(output.valueSats)} sats in an OP_RETURN.`);
    } else if (value < dust) {
      return refuse('DUST_OUTPUT', `Output ${i} is below the ${dust} sat dust threshold for its script.`);
    }
    if (output.expectedAssets !== undefined) {
      if (
        !Array.isArray(output.expectedAssets) ||
        !output.expectedAssets.every(
          (asset) =>
            asset &&
            typeof asset.assetType === 'string' &&
            asset.assetType.length > 0 &&
            typeof asset.assetId === 'string' &&
            asset.assetId.length > 0 &&
            parseSats(asset.quantity) !== null
        )
      ) {
        return refuse('ASSET_EXPECTATION_INVALID', `Output ${i} carries an asset expectation without a type, an id and an exact quantity.`);
      }
    }
  }
  const declaredFee = parseSats(m.fee?.feeSats);
  const maxFee = parseSats(m.fee?.maxFeeSats);
  if (declaredFee === null || maxFee === null || declaredFee > maxFee) {
    return refuse('FEE_INVALID', 'feeSats and maxFeeSats must be exact decimal strings and fee <= maxFee.');
  }
  let totalIn = 0n;
  let totalOut = 0n;
  for (const input of tx.inputs) totalIn += parseSats(input.valueSats) as bigint;
  for (const output of tx.outputs) totalOut += parseSats(output.valueSats) as bigint;
  if (totalIn !== totalOut + declaredFee) {
    return refuse('VALUE_NOT_CONSERVED', 'The inputs do not equal the outputs plus the declared fee.');
  }
  if (m.account !== undefined) {
    if (!m.account || typeof m.account !== 'object' || (m.account.descriptor !== undefined && typeof m.account.descriptor !== 'string')) {
      return refuse('ACCOUNT_INVALID', 'The account may carry only an output descriptor string.');
    }
  }
  const digest = expectedTransactionDigest(m);
  if (m.digest !== digest) {
    return refuse('DIGEST_MISMATCH', 'The manifest digest does not match the transaction and policy it describes.');
  }
  return { ok: true, digest };
}

const assetKey = (a: { assetType: unknown; assetId: unknown; quantity: unknown; outputIndex: unknown }): string =>
  `${String(a.assetType)}|${String(a.assetId)}|${String(a.quantity)}|${String(a.outputIndex)}`;

/**
 * Compare a signed result with the manifest the user reviewed. Answers
 * { ok: true, txid, complete } or a refusal.
 */
// OX-P03: the result is read from bytes. Every user signature must verify under the
// approved sighash, a foreign input stays unsigned unless its recorded signature is
// preserved byte for byte, and protected assets need a complete, equal observation;
// a missing one is a refusal (P-R11), never a pass.
export function compareSignedResultToManifest(signed: unknown, manifest: unknown): SignedResultVerdict {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)) {
    return refuse('MALFORMED_SIGNED_RESULT', 'Expected a signed result object.');
  }
  const result = signed as OfflineSigningResult;
  if (result.schema !== OFFLINE_SIGNING_SESSION_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The signed result schema is not ordex.offline-signing-session/v2.');
  }
  const manifestVerdict = verifyExpectedTransactionManifest(manifest);
  if (!manifestVerdict.ok) return manifestVerdict;
  const m = manifest as ExpectedTransactionManifest;
  if (result.manifestDigest !== m.digest) {
    return refuse(
      'MANIFEST_DIGEST_MISMATCH',
      'The signed result was not produced from this manifest. Present the manifest again and sign it fresh.'
    );
  }
  const unknown = Object.keys(result).filter((key) => !SIGNED_FIELDS.includes(key));
  const declaredUnknown = Array.isArray(result.unknownCriticalFields) ? result.unknownCriticalFields.map(String) : [];
  if (unknown.length > 0 || declaredUnknown.length > 0) {
    return refuse('UNKNOWN_CRITICAL_FIELDS', `The signed result carries fields this protocol does not define: ${[...unknown, ...declaredUnknown].join(', ')}.`);
  }
  if ((result.psbt === undefined) === (result.signedTxHex === undefined)) {
    return refuse('MALFORMED_SIGNED_RESULT', 'The signed result carries exactly one of a PSBT or a signed transaction.');
  }

  const presented = m.unsignedTx;
  const prevouts = presented.inputs.map((input) => ({
    valueSats: String(parseSats(input.valueSats)),
    scriptHex: input.scriptPubKeyHex as string,
  }));
  let psbt: Psbt | null = null;
  let extracted: Transaction;
  if (result.psbt !== undefined) {
    const parsed = parsePsbt(result.psbt);
    if (!parsed.ok) return refuse('MALFORMED_SIGNED_RESULT', parsed.reason);
    psbt = parsed.psbt;
    const tx = extractPsbtTransaction(psbt);
    if (!tx) {
      return refuse('LOCKTIME_UNDETERMINED', 'The PSBT inputs require both a time and a height locktime, so no transaction can be signed.');
    }
    extracted = tx;
  } else {
    const parsed = parseTransaction(result.signedTxHex);
    if (!parsed.ok) return refuse('MALFORMED_SIGNED_RESULT', parsed.reason);
    extracted = parsed.tx;
  }
  const tx = extracted;

  let totalIn = 0n;
  let totalOut = 0n;
  for (const input of presented.inputs) totalIn += parseSats(input.valueSats) as bigint;
  for (const output of tx.outputs) totalOut += BigInt(output.valueSats);
  if (totalIn - totalOut > (parseSats(m.fee.maxFeeSats) as bigint)) {
    return refuse('FEE_OUT_OF_BOUNDS', 'The signed transaction fee left the bound the manifest approved.');
  }
  if (tx.version !== presented.version || tx.lockTime !== presented.lockTime) {
    return refuse('TRANSACTION_CHANGED', 'The signed transaction changed its version or locktime.');
  }
  if (tx.inputs.length !== presented.inputs.length) {
    return refuse('INPUT_SET_CHANGED', 'The signed transaction spends a different set of inputs than the manifest presented.');
  }
  for (let i = 0; i < presented.inputs.length; i += 1) {
    const expected = presented.inputs[i] as ExpectedTransactionInput;
    const actual = tx.inputs[i];
    if (!actual || actual.txid !== expected.txid || actual.vout !== expected.vout) {
      return refuse('INPUT_REORDERED', `Input ${i} was reordered or substituted.`);
    }
    if (actual.sequence !== expected.sequence) {
      return refuse('SEQUENCE_CHANGED', `Input ${i} changed its sequence number.`);
    }
    if (psbt) {
      const prevout = psbt.inputs[i]?.prevout;
      const wanted = prevouts[i];
      if (!prevout || !wanted || prevout.valueSats !== wanted.valueSats || prevout.scriptHex !== wanted.scriptHex) {
        return refuse('PREVOUT_MISMATCH', `Input ${i} names a different spent output than the manifest presented.`);
      }
    }
  }
  if (tx.outputs.length !== presented.outputs.length) {
    return refuse('OUTPUT_SET_CHANGED', 'The signed transaction carries a different set of outputs than the manifest presented.');
  }
  for (let i = 0; i < presented.outputs.length; i += 1) {
    const expected = presented.outputs[i] as ExpectedTransactionOutput;
    const actual = tx.outputs[i];
    if (!actual || actual.scriptHex !== expected.scriptHex) {
      return refuse('SCRIPT_CHANGED', `Output ${i} no longer pays its presented script.`);
    }
    if (actual.valueSats !== String(parseSats(expected.valueSats))) {
      return refuse('VALUE_CHANGED', `Output ${i} no longer carries its presented value.`);
    }
  }
  if (bytesToHex(serializeTransaction(unsignedCopy(tx))) !== bytesToHex(serializeTransaction(manifestUnsignedTransaction(m)))) {
    return refuse('TRANSACTION_CHANGED', 'The signed transaction is not the presented transaction.');
  }

  let complete = true;
  for (let i = 0; i < presented.inputs.length; i += 1) {
    const expected = presented.inputs[i] as ExpectedTransactionInput;
    const psbtInput = psbt ? psbt.inputs[i] : null;
    const finalized = !psbtInput || psbtInput.finalScriptSig !== undefined || psbtInput.finalWitness !== undefined;
    let status: SignatureStatus;
    let sighashType: number | undefined;
    if (finalized || !psbt) {
      const verdict = verifyInputSignature(tx, i, prevouts);
      status = verdict.status;
      sighashType = verdict.sighashType;
    } else {
      const checks = verifyPsbtPartialSignatures(psbt, i);
      if (checks.length === 0) status = 'UNSIGNED';
      else if (checks.some((c) => c.unsupported)) status = 'UNSUPPORTED';
      else if (checks.every((c) => c.valid)) status = 'VALID';
      else status = 'INVALID';
      const hashTypes = new Set(checks.map((c) => c.sighashType));
      sighashType = hashTypes.size === 1 ? [...hashTypes][0] : -1;
    }
    const actual = tx.inputs[i];
    if (expected.controlledByUser) {
      if (status === 'UNSIGNED') return refuse('REQUIRED_SIGNATURE_MISSING', `Input ${i} is still unsigned; the result is incomplete.`);
      if (status === 'UNSUPPORTED') return refuse('SIGNATURE_UNVERIFIABLE', `Input ${i} spends a script this verifier cannot check.`);
      if (status !== 'VALID') return refuse('SIGNATURE_INVALID', `Input ${i} carries a signature that does not verify against the presented transaction.`);
      if (sighashType !== allowedSighash(expected.sighashType as string, expected.scriptPubKeyHex as string)) {
        return refuse('SIGHASH_UNEXPECTED', `Input ${i} was signed with a sighash the manifest did not approve.`);
      }
      if (!finalized) complete = false;
    } else if (expected.preservedSignature !== undefined) {
      const kept = expected.preservedSignature;
      if (
        !finalized ||
        !actual ||
        actual.scriptSigHex !== kept.scriptSigHex ||
        actual.witness.length !== kept.witness.length ||
        actual.witness.some((item, j) => item !== kept.witness[j])
      ) {
        return refuse('FOREIGN_SIGNATURE_CHANGED', `Input ${i} no longer carries the other party's signature exactly as it was presented.`);
      }
      if (status !== 'VALID') {
        return refuse('FOREIGN_SIGNATURE_INVALID', `The other party's signature on input ${i} does not verify against this transaction.`);
      }
    } else if (status !== 'UNSIGNED') {
      return refuse('SIGNATURE_ON_FOREIGN_INPUT', `Input ${i} belongs to another party and must never be signed here.`);
    } else {
      complete = false;
    }
  }

  const expectedAssets: Array<{ assetType: unknown; assetId: unknown; quantity: unknown; outputIndex: number }> = [];
  presented.outputs.forEach((output, outputIndex) => {
    for (const asset of output.expectedAssets ?? []) {
      expectedAssets.push({ assetType: asset.assetType, assetId: asset.assetId, quantity: asset.quantity, outputIndex });
    }
  });
  const observed = result.observedAssets;
  if (observed === undefined) {
    if (expectedAssets.length > 0) {
      return refuse(
        'PROTECTED_ASSET_OBSERVATION_MISSING',
        'The manifest protects assets, and the result carries no independent observation of where they landed.'
      );
    }
  } else {
    if (
      !Array.isArray(observed) ||
      !observed.every((a: Partial<ObservedAsset> | null) =>
        !!a &&
        typeof a.assetType === 'string' &&
        typeof a.assetId === 'string' &&
        parseSats(a.quantity) !== null &&
        typeof a.outputIndex === 'number' &&
        Number.isInteger(a.outputIndex)
      )
    ) {
      return refuse('MALFORMED_SIGNED_RESULT', 'Every observed asset names its type, id, exact quantity and output.');
    }
    const remaining = new Map<string, number>();
    for (const a of expectedAssets) remaining.set(assetKey(a), (remaining.get(assetKey(a)) ?? 0) + 1);
    for (const a of observed as ObservedAsset[]) {
      const count = remaining.get(assetKey(a)) ?? 0;
      if (count === 0) {
        return refuse('PROTECTED_ASSET_MISPLACED', `${a.assetType} ${a.assetId} x${a.quantity} landed on output ${a.outputIndex}, which the manifest did not present.`);
      }
      remaining.set(assetKey(a), count - 1);
    }
    for (const [key, count] of remaining) {
      if (count > 0) {
        const [assetType, assetId, quantity, outputIndex] = key.split('|');
        return refuse('PROTECTED_ASSET_MISPLACED', `${assetType} ${assetId} x${quantity} was presented for output ${outputIndex} and was not observed there.`);
      }
    }
  }

  return { ok: true, txid: transactionId(tx), complete };
}
