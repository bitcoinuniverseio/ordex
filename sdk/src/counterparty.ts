/**
 * The Counterparty UTXO-attached asset rules from
 * spec/counterparty-utxo-asset.md, typed.
 *
 * This is the same verifier as verifier/counterparty-asset.js at the
 * repository root, ported to TypeScript for SDK consumers. Both
 * implementations are run against conformance/counterparty-asset-vectors.json,
 * so they cannot drift apart without a test failing.
 *
 * Asset identity is the authoritative Counterparty asset id plus its current
 * ledger state. A ticker or name alone is never an identity. Every amount is
 * an atomic integer carried as a decimal string and handled as BigInt.
 */

import { createHash } from 'node:crypto';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];

export const COUNTERPARTY_UTXO_ASSET_SCHEMA = 'ordex.counterparty-utxo-asset/v1';

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

export interface CounterpartyUtxoAssetRecord {
  schema?: unknown;
  network?: unknown;
  asset?: { name?: unknown; assetId?: unknown; divisible?: unknown; quantitySats?: unknown; issuer?: unknown };
  outpoint?: { txid?: unknown; vout?: unknown };
  address?: unknown;
  sourceValueSats?: unknown;
  coTravelingAssets?: Array<{ name?: unknown; assetId?: unknown; quantitySats?: unknown }>;
  checkpoint?: { height?: unknown; blockHash?: unknown; ledgerHash?: unknown };
  authority?: { kind?: unknown; ready?: unknown };
  attached?: unknown;
  digest?: unknown;
  [key: string]: unknown;
}

export interface CounterpartySpendTransaction {
  inputs?: Array<{ txid?: unknown; vout?: unknown; valueSats?: unknown }>;
  outputs?: Array<{ scriptHex?: unknown; valueSats?: unknown }>;
}

export type CounterpartyRefusalCode =
  | 'MALFORMED_RECORD'
  | 'SCHEMA_UNSUPPORTED'
  | 'NETWORK_UNKNOWN'
  | 'ASSET_IDENTITY_MISSING'
  | 'ASSET_ID_REQUIRED'
  | 'QUANTITY_INVALID'
  | 'OUTPOINT_INVALID'
  | 'ADDRESS_MISSING'
  | 'SOURCE_VALUE_INVALID'
  | 'CHECKPOINT_INVALID'
  | 'AUTHORITY_NOT_READY'
  | 'ATTACHMENT_STATE_UNKNOWN'
  | 'COTRAVELING_INVALID'
  | 'MALFORMED_TRANSACTION'
  | 'DESTINATION_MISSING'
  | 'OUTPOINT_DUPLICATED'
  | 'OUTPOINT_NOT_SPENT'
  | 'SOURCE_VALUE_MISMATCH'
  | 'INPUT_VALUE_UNKNOWN'
  | 'OUTPUT_VALUE_UNKNOWN'
  | 'SAT_FLOW_SHORTFALL'
  | 'DESTINATION_MISMATCH';

export type CounterpartyRecordVerdict =
  | { ok: true }
  | { ok: false; code: CounterpartyRefusalCode; reason: string };

export type CounterpartyAttachmentVerdict =
  | { ok: true; carriedToIndex: number }
  | { ok: false; code: CounterpartyRefusalCode; reason: string };

type CounterpartyRefusal = { ok: false; code: CounterpartyRefusalCode; reason: string };

const refuse = (code: CounterpartyRefusalCode, reason: string): CounterpartyRefusal => ({
  ok: false,
  code,
  reason,
});

/**
 * Verify a counterparty-utxo-asset/v1 record.
 *
 * record:
 *   schema, network, asset { name, assetId, divisible, quantitySats,
 *   issuer? }, outpoint { txid, vout }, address, sourceValueSats,
 *   coTravelingAssets? [{ name, assetId, quantitySats }],
 *   checkpoint { height, blockHash, ledgerHash }, authority { kind, ready },
 *   attached true
 *
 * Answers { ok: true } or { ok: false, code, reason }.
 */
export function verifyCounterpartyUtxoAsset(record: unknown): CounterpartyRecordVerdict {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return refuse('MALFORMED_RECORD', 'Expected an attachment record object.');
  }
  const r = record as CounterpartyUtxoAssetRecord;
  if (r.schema !== COUNTERPARTY_UTXO_ASSET_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The record schema is not ordex.counterparty-utxo-asset/v1.');
  }
  if (typeof r.network !== 'string' || !NETWORKS.includes(r.network)) {
    return refuse('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  const asset = r.asset;
  if (!asset || typeof asset !== 'object') {
    return refuse('ASSET_IDENTITY_MISSING', 'The record must describe the attached asset.');
  }
  if (typeof asset.name !== 'string' || asset.name.length === 0) {
    return refuse('ASSET_IDENTITY_MISSING', 'The record must carry the asset name.');
  }
  if (typeof asset.assetId !== 'string' || !DECIMAL.test(asset.assetId)) {
    return refuse(
      'ASSET_ID_REQUIRED',
      'Asset identity is the authoritative numeric Counterparty asset id; a name alone is never an identity.',
    );
  }
  if (typeof asset.divisible !== 'boolean') {
    return refuse('ASSET_IDENTITY_MISSING', 'The record must state whether the asset is divisible.');
  }
  if (parseSats(asset.quantitySats) === null) {
    return refuse('QUANTITY_INVALID', 'quantitySats must be an exact decimal string of atomic units.');
  }
  if (
    !r.outpoint ||
    typeof r.outpoint.txid !== 'string' ||
    !HEX64.test(r.outpoint.txid) ||
    !Number.isInteger(r.outpoint.vout) ||
    (r.outpoint.vout as number) < 0
  ) {
    return refuse('OUTPOINT_INVALID', 'The record must name a lowercase txid and vout.');
  }
  if (typeof r.address !== 'string' || r.address.length === 0) {
    return refuse('ADDRESS_MISSING', 'The record must name the address that controls the outpoint.');
  }
  if (parseSats(r.sourceValueSats) === null) {
    return refuse('SOURCE_VALUE_INVALID', 'sourceValueSats must be an exact decimal string.');
  }
  if (
    !r.checkpoint ||
    !Number.isInteger(r.checkpoint.height) ||
    (r.checkpoint.height as number) < 0 ||
    typeof r.checkpoint.blockHash !== 'string' ||
    !HEX64.test(r.checkpoint.blockHash) ||
    typeof r.checkpoint.ledgerHash !== 'string' ||
    !HEX64.test(r.checkpoint.ledgerHash)
  ) {
    return refuse(
      'CHECKPOINT_INVALID',
      'The record must carry the block height, block hash, and Counterparty ledger hash it was read at.',
    );
  }
  if (!r.authority || r.authority.kind !== 'counterparty-core' || r.authority.ready !== true) {
    return refuse(
      'AUTHORITY_NOT_READY',
      'The record may only be produced while the self hosted Counterparty Core authority reports ready.',
    );
  }
  if (r.attached !== true) {
    return refuse('ATTACHMENT_STATE_UNKNOWN', 'The record must state that the attachment currently exists.');
  }
  if (r.coTravelingAssets !== undefined) {
    if (!Array.isArray(r.coTravelingAssets)) {
      return refuse('COTRAVELING_INVALID', 'coTravelingAssets must be an array.');
    }
    for (const other of r.coTravelingAssets) {
      if (
        !other ||
        typeof other.name !== 'string' ||
        typeof other.assetId !== 'string' ||
        parseSats(other.quantitySats) === null
      ) {
        return refuse('COTRAVELING_INVALID', 'Every co-traveling asset needs a name, an asset id, and an exact quantity.');
      }
    }
  }
  return { ok: true };
}

/**
 * Verify that a spending transaction carries the attachment to the output
 * the plan named, and that every co-traveling asset rides along.
 *
 * spendTx:
 *   inputs  [{ txid, vout, valueSats }]  in transaction order.
 *   outputs [{ scriptHex, valueSats }]   in transaction order.
 *
 * The attachment follows the input range, so the destination is decided by
 * the same rule an inscription transfer uses: the destination is the first
 * output whose accumulated value passes the sat range start of the attached
 * outpoint. Returns { ok: true, carriedToIndex } or a refusal.
 */
export function verifyAttachmentFollows(
  record: unknown,
  spendTx: unknown,
  expectedOutputIndex: unknown,
): CounterpartyAttachmentVerdict {
  const recordVerdict = verifyCounterpartyUtxoAsset(record);
  if (!recordVerdict.ok) return recordVerdict;
  const r = record as CounterpartyUtxoAssetRecord;
  if (!spendTx || !Array.isArray((spendTx as CounterpartySpendTransaction).inputs) || !Array.isArray((spendTx as CounterpartySpendTransaction).outputs)) {
    return refuse('MALFORMED_TRANSACTION', 'Expected inputs and outputs arrays.');
  }
  const spend = spendTx as CounterpartySpendTransaction;
  const inputs = spend.inputs as Array<{ txid?: unknown; vout?: unknown; valueSats?: unknown }>;
  const outputs = spend.outputs as Array<{ scriptHex?: unknown; valueSats?: unknown }>;
  if (!Number.isInteger(expectedOutputIndex) || !outputs[expectedOutputIndex as number]) {
    return refuse('DESTINATION_MISSING', 'The plan names an output that does not exist.');
  }

  let index = -1;
  let inputValue: bigint | null = null;
  for (let i = 0; i < inputs.length; i += 1) {
    const input = inputs[i];
    if (input?.txid === r.outpoint?.txid && input?.vout === r.outpoint?.vout) {
      if (index !== -1) {
        return refuse('OUTPOINT_DUPLICATED', 'The attached outpoint appears at more than one index.');
      }
      index = i;
      inputValue = parseSats(input?.valueSats);
    }
  }
  if (index === -1) {
    return refuse('OUTPOINT_NOT_SPENT', 'No input spends the attached outpoint.');
  }
  if (inputValue === null || inputValue !== parseSats(r.sourceValueSats)) {
    return refuse(
      'SOURCE_VALUE_MISMATCH',
      'The spent value does not match the record, so the sat range cannot be traced.',
    );
  }

  let inputsAhead = 0n;
  for (let i = 0; i < index; i += 1) {
    const value = parseSats(inputs[i]?.valueSats);
    if (value === null) {
      return refuse('INPUT_VALUE_UNKNOWN', `Input ${i} has no readable value, so the sat range cannot be traced.`);
    }
    inputsAhead += value;
  }

  let carriedToIndex = -1;
  let outputsAhead = 0n;
  for (let i = 0; i < outputs.length; i += 1) {
    const value = parseSats(outputs[i]?.valueSats);
    if (value === null) {
      return refuse('OUTPUT_VALUE_UNKNOWN', `Output ${i} has no readable value, so the sat range cannot be traced.`);
    }
    outputsAhead += value;
    if (carriedToIndex === -1 && outputsAhead > inputsAhead) {
      carriedToIndex = i;
    }
  }
  if (carriedToIndex === -1) {
    return refuse('SAT_FLOW_SHORTFALL', 'No output absorbs the start of the attached outpoint range; the attachment would be lost.');
  }
  if (carriedToIndex !== expectedOutputIndex) {
    return refuse(
      'DESTINATION_MISMATCH',
      `The sat range lands on output ${carriedToIndex}, not the planned output ${String(expectedOutputIndex)}.`,
    );
  }
  return { ok: true, carriedToIndex };
}

/** SHA-256 over the sorted-key JSON of a record, for event references. */
export function counterpartyRecordDigest(record: CounterpartyUtxoAssetRecord): string {
  const binding: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'digest') continue;
    binding[key] = value;
  }
  return createHash('sha256').update(sortedJson(binding), 'utf8').digest('hex');
}
