/**
 * The cold signing and watch-only rules from spec/cold-signing.md, typed.
 *
 * This is the same verifier as verifier/offline-signing.js at the
 * repository root, ported to TypeScript for SDK consumers. Both
 * implementations are run against conformance/offline-signing-vectors.json,
 * so they cannot drift apart without a test failing.
 *
 * The nine refusal rules of compareSignedResultToManifest are the contract:
 * any difference between what was presented and what came back is a refusal
 * with a stable code, never an adaptation.
 */

import { createHash } from 'node:crypto';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const EVEN_HEX = /^(?:[0-9a-f]{2})+$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const SIGHASH = [
  'DEFAULT',
  'ALL',
  'NONE',
  'SINGLE',
  'ALL|ANYONECANPAY',
  'SINGLE|ANYONECANPAY',
  'NONE|ANYONECANPAY',
];

export const EXPECTED_TRANSACTION_MANIFEST_SCHEMA = 'ordex.expected-transaction-manifest/v1';
export const OFFLINE_SIGNING_SESSION_SCHEMA = 'ordex.offline-signing-session/v1';

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

export interface ExpectedTransactionInput {
  txid?: unknown;
  vout?: unknown;
  valueSats?: unknown;
  scriptPubKeyHex?: unknown;
  controlledByUser?: unknown;
  sighashType?: string;
  explanation?: unknown;
}

export interface ExpectedAsset {
  assetType?: unknown;
  assetId?: unknown;
  quantitySats?: unknown;
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
    inputs: ExpectedTransactionInput[];
    outputs: ExpectedTransactionOutput[];
  };
  fee: { feeSats?: unknown; maxFeeSats?: unknown };
  account?: { descriptor?: string };
  digest?: unknown;
  [key: string]: unknown;
}

export interface OfflineSigningResult {
  schema?: unknown;
  manifestDigest?: unknown;
  tx?: {
    inputs?: Array<{
      txid?: unknown;
      vout?: unknown;
      valueSats?: unknown;
      signaturePresent?: unknown;
      sighashType?: unknown;
    }>;
    outputs?: Array<{ scriptHex?: unknown; valueSats?: unknown }>;
    carriedAssets?: Array<{ outputIndex?: unknown; assetType?: unknown; assetId?: unknown }>;
  };
  unknownCriticalFields?: unknown[];
  [key: string]: unknown;
}

/**
 * SHA-256 over the exact unsigned transaction a signer must be presented:
 * network, inputs, outputs, and the sighash policy. Lowercase hex.
 */
export function expectedTransactionDigest(manifest: ExpectedTransactionManifest): string {
  return createHash('sha256')
    .update(
      sortedJson({
        network: manifest.network,
        inputs: manifest.unsignedTx.inputs.map((input) => ({
          txid: input.txid,
          vout: input.vout,
          valueSats: input.valueSats,
          scriptPubKeyHex: input.scriptPubKeyHex,
        })),
        outputs: manifest.unsignedTx.outputs.map((output) => ({
          scriptHex: output.scriptHex,
          valueSats: output.valueSats,
        })),
        sighash: manifest.unsignedTx.inputs.map((input) => input.sighashType || null),
      }),
      'utf8',
    )
    .digest('hex');
}

export type OfflineSigningRefusalCode =
  | 'MALFORMED_MANIFEST'
  | 'SCHEMA_UNSUPPORTED'
  | 'NETWORK_UNKNOWN'
  | 'PURPOSE_MISSING'
  | 'INPUT_DESCRIPTION_INVALID'
  | 'SIGHASH_UNKNOWN'
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
  | 'FEE_OUT_OF_BOUNDS'
  | 'INPUT_SET_CHANGED'
  | 'INPUT_REORDERED'
  | 'VALUE_CHANGED'
  | 'OUTPUT_SET_CHANGED'
  | 'SCRIPT_CHANGED'
  | 'SIGNATURE_ON_FOREIGN_INPUT'
  | 'SIGHASH_UNEXPECTED'
  | 'REQUIRED_SIGNATURE_MISSING'
  | 'PROTECTED_ASSET_MISPLACED';

export type ExpectedTransactionManifestVerdict =
  | { ok: true; digest: string }
  | { ok: false; code: OfflineSigningRefusalCode; reason: string };

const refuse = (code: OfflineSigningRefusalCode, reason: string): ExpectedTransactionManifestVerdict => ({
  ok: false,
  code,
  reason,
});

/**
 * Verify an expected transaction manifest.
 *
 * manifest:
 *   schema, network, purpose, watchOnly,
 *   unsignedTx {
 *     inputs  [{ txid, vout, valueSats, scriptPubKeyHex, controlledByUser,
 *                sighashType?, explanation }],
 *     outputs [{ scriptHex, valueSats, role, explanation,
 *                expectedAssets? [{ assetType, assetId, quantitySats? }] }]
 *   },
 *   fee { feeSats, maxFeeSats }, account { descriptor? }, digest
 *
 * Answers { ok: true, digest } or { ok: false, code, reason }.
 */
export function verifyExpectedTransactionManifest(manifest: unknown): ExpectedTransactionManifestVerdict {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return refuse('MALFORMED_MANIFEST', 'Expected a manifest object.');
  }
  const m = manifest as ExpectedTransactionManifest;
  if (m.schema !== EXPECTED_TRANSACTION_MANIFEST_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The manifest schema is not ordex.expected-transaction-manifest/v1.');
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
  if (
    !tx ||
    !Array.isArray(tx.inputs) ||
    tx.inputs.length === 0 ||
    !Array.isArray(tx.outputs) ||
    tx.outputs.length === 0
  ) {
    return refuse('MALFORMED_MANIFEST', 'The manifest must describe at least one input and one output.');
  }
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const input = tx.inputs[i];
    if (
      !input ||
      typeof input.txid !== 'string' ||
      !HEX64.test(input.txid) ||
      !Number.isInteger(input.vout) ||
      (input.vout as number) < 0 ||
      parseSats(input.valueSats) === null ||
      typeof input.scriptPubKeyHex !== 'string' ||
      !EVEN_HEX.test(input.scriptPubKeyHex) ||
      typeof input.controlledByUser !== 'boolean' ||
      typeof input.explanation !== 'string' ||
      input.explanation.length === 0
    ) {
      return refuse(
        'INPUT_DESCRIPTION_INVALID',
        `Input ${i} needs an outpoint, an exact value and script, whether the user controls it, and why it is spent.`,
      );
    }
    if (input.sighashType !== undefined && !SIGHASH.includes(input.sighashType)) {
      return refuse('SIGHASH_UNKNOWN', `Input ${i} names a sighash this protocol does not define.`);
    }
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
      return refuse(
        'OUTPUT_DESCRIPTION_INVALID',
        `Output ${i} needs an exact script and value, a role, and who receives it.`,
      );
    }
    if (output.valueSats !== '0' && (parseSats(output.valueSats) as bigint) < 546n && output.role !== 'data') {
      return refuse('DUST_OUTPUT', `Output ${i} is below the 546 sat dust floor.`);
    }
    if (output.expectedAssets !== undefined) {
      if (
        !Array.isArray(output.expectedAssets) ||
        !output.expectedAssets.every(
          (asset) => asset && typeof asset.assetType === 'string' && typeof asset.assetId === 'string',
        )
      ) {
        return refuse('ASSET_EXPECTATION_INVALID', `Output ${i} carries a malformed asset expectation.`);
      }
    }
  }
  const declaredFee = parseSats(m.fee && m.fee.feeSats);
  const maxFee = parseSats(m.fee && m.fee.maxFeeSats);
  if (declaredFee === null || maxFee === null || declaredFee < 0n || declaredFee > maxFee) {
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
    if (
      typeof m.account !== 'object' ||
      (m.account.descriptor !== undefined && typeof m.account.descriptor !== 'string')
    ) {
      return refuse('ACCOUNT_INVALID', 'The account may carry only an output descriptor string.');
    }
  }
  const digest = expectedTransactionDigest(m);
  if (m.digest !== digest) {
    return refuse('DIGEST_MISMATCH', 'The manifest digest does not match the transaction it describes.');
  }
  return { ok: true, digest };
}

/**
 * Compare an imported signed result against the manifest.
 *
 * signed:
 *   schema, manifestDigest,
 *   tx {
 *     inputs  [{ txid, vout, valueSats, signaturePresent, sighashType? }],
 *     outputs [{ scriptHex, valueSats }],
 *     carriedAssets? [{ outputIndex, assetType, assetId }]
 *   },
 *   unknownCriticalFields? []
 *
 * Every refusal below is one of the binding rules: the unsigned
 * transaction changed, an input or output was added, removed, or
 * reordered, a script or amount changed, the fee left its approved bound,
 * a protected asset would move somewhere else, an unexpected signature or
 * sighash appeared, a required input is still unsigned, a signature
 * covers an input the user does not control, or an unknown critical
 * field appeared.
 */
export function compareSignedResultToManifest(
  signed: unknown,
  manifest: unknown,
): { ok: true } | { ok: false; code: OfflineSigningRefusalCode; reason: string } {
  if (!signed || typeof signed !== 'object' || Array.isArray(signed)) {
    return refuse('MALFORMED_SIGNED_RESULT', 'Expected a signed result object.');
  }
  const s = signed as OfflineSigningResult;
  if (s.schema !== OFFLINE_SIGNING_SESSION_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The signed result schema is not ordex.offline-signing-session/v1.');
  }
  const manifestVerdict = verifyExpectedTransactionManifest(manifest);
  if (!manifestVerdict.ok) return manifestVerdict;
  const m = manifest as ExpectedTransactionManifest;
  if (s.manifestDigest !== m.digest) {
    return refuse(
      'MANIFEST_DIGEST_MISMATCH',
      'The signed result was not produced from this manifest. Present the manifest again and sign it fresh.',
    );
  }
  const tx = m.unsignedTx;
  const result = s.tx;
  if (!result || !Array.isArray(result.inputs) || !Array.isArray(result.outputs)) {
    return refuse('MALFORMED_SIGNED_RESULT', 'The signed result must carry inputs and outputs.');
  }

  if (Array.isArray(s.unknownCriticalFields) && s.unknownCriticalFields.length > 0) {
    return refuse(
      'UNKNOWN_CRITICAL_FIELDS',
      `The signed result carries fields this protocol does not define: ${s.unknownCriticalFields.join(', ')}.`,
    );
  }

  const resultInputs = result.inputs;
  const resultOutputs = result.outputs;
  let totalIn = 0n;
  let totalOut = 0n;
  for (const input of resultInputs) {
    const value = parseSats(input && input.valueSats);
    if (value === null) return refuse('MALFORMED_SIGNED_RESULT', 'Every input needs an exact decimal value.');
    totalIn += value;
  }
  for (const output of resultOutputs) {
    const value = parseSats(output && output.valueSats);
    if (value === null) return refuse('MALFORMED_SIGNED_RESULT', 'Every output needs an exact decimal value.');
    totalOut += value;
  }
  const fee = totalIn - totalOut;
  if (fee > (parseSats(m.fee.maxFeeSats) as bigint)) {
    return refuse('FEE_OUT_OF_BOUNDS', 'The signed transaction fee left the bound the manifest approved.');
  }

  if (resultInputs.length !== tx.inputs.length) {
    return refuse('INPUT_SET_CHANGED', 'The signed transaction spends a different set of inputs than the manifest presented.');
  }
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const expected = tx.inputs[i];
    const actual = resultInputs[i];
    if (!actual || actual.txid !== expected?.txid || actual.vout !== expected?.vout) {
      return refuse('INPUT_REORDERED', `Input ${i} was reordered or substituted.`);
    }
    if (parseSats(actual?.valueSats) !== parseSats(expected?.valueSats)) {
      return refuse('VALUE_CHANGED', `Input ${i} no longer carries its presented value.`);
    }
  }

  if (resultOutputs.length !== tx.outputs.length) {
    return refuse('OUTPUT_SET_CHANGED', 'The signed transaction carries a different set of outputs than the manifest presented.');
  }
  for (let i = 0; i < tx.outputs.length; i += 1) {
    const expected = tx.outputs[i];
    const actual = resultOutputs[i];
    if (!actual || actual.scriptHex !== expected?.scriptHex) {
      return refuse('SCRIPT_CHANGED', `Output ${i} no longer pays its presented script.`);
    }
    if (parseSats(actual?.valueSats) !== parseSats(expected?.valueSats)) {
      return refuse('VALUE_CHANGED', `Output ${i} no longer carries its presented value.`);
    }
  }

  for (let i = 0; i < tx.inputs.length; i += 1) {
    const expected = tx.inputs[i];
    const actual = resultInputs[i];
    const hasSignature = actual?.signaturePresent === true;
    if (!expected?.controlledByUser && hasSignature) {
      return refuse('SIGNATURE_ON_FOREIGN_INPUT', `Input ${i} belongs to another party and must never be signed here.`);
    }
    if (expected?.sighashType && hasSignature && actual?.sighashType !== expected?.sighashType) {
      return refuse('SIGHASH_UNEXPECTED', `Input ${i} was signed with a sighash the manifest did not approve.`);
    }
    if (expected?.controlledByUser && !hasSignature) {
      return refuse('REQUIRED_SIGNATURE_MISSING', `Input ${i} is still unsigned; the result is incomplete.`);
    }
  }

  const expectedMovements = new Map<string, number>();
  for (let i = 0; i < tx.outputs.length; i += 1) {
    for (const asset of tx.outputs[i]?.expectedAssets || []) {
      expectedMovements.set(`${String(asset.assetType)}:${String(asset.assetId)}`, i);
    }
  }
  const carried = Array.isArray(result.carriedAssets) ? result.carriedAssets : [];
  for (const movement of carried) {
    const key = `${String(movement.assetType)}:${String(movement.assetId)}`;
    const expectedIndex = expectedMovements.get(key);
    if (expectedIndex === undefined) {
      return refuse('PROTECTED_ASSET_MISPLACED', `Asset ${key} was not part of the presented plan at all.`);
    }
    if (movement.outputIndex !== expectedIndex) {
      return refuse(
        'PROTECTED_ASSET_MISPLACED',
        `Asset ${key} landed on output ${String(movement.outputIndex)} instead of the presented output ${expectedIndex}.`,
      );
    }
  }

  return { ok: true };
}
