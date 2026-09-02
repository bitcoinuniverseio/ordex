// Reference verifier for Counterparty UTXO-attached assets on Ordex.
//
// This file restates spec/counterparty-utxo-asset.md as executable checks.
// It validates a counterparty-utxo-asset/v1 record and it decides whether a
// spending transaction carries an attachment to the destination the plan
// named, using the same sat flow arithmetic the public ask uses. Reading the
// Counterparty ledger, proving server readiness, and confirming the expected
// event after confirmation remain the caller's responsibility.
//
// Asset identity is the authoritative Counterparty asset id plus its current
// ledger state. A ticker or name alone is never an identity. Every amount is
// an atomic integer carried as a decimal string and handled as BigInt.

import { createHash } from 'node:crypto';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
export const COUNTERPARTY_UTXO_ASSET_SCHEMA = 'ordex.counterparty-utxo-asset/v1';

export function parseSats(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  return BigInt(value);
}

const refuse = (code, reason) => ({ ok: false, code, reason });

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
export function verifyCounterpartyUtxoAsset(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return refuse('MALFORMED_RECORD', 'Expected an attachment record object.');
  }
  if (record.schema !== COUNTERPARTY_UTXO_ASSET_SCHEMA) {
    return refuse('SCHEMA_UNSUPPORTED', 'The record schema is not ordex.counterparty-utxo-asset/v1.');
  }
  if (typeof record.network !== 'string' || !NETWORKS.includes(record.network)) {
    return refuse('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  const asset = record.asset;
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
    !record.outpoint ||
    typeof record.outpoint.txid !== 'string' ||
    !HEX64.test(record.outpoint.txid) ||
    !Number.isInteger(record.outpoint.vout) ||
    record.outpoint.vout < 0
  ) {
    return refuse('OUTPOINT_INVALID', 'The record must name a lowercase txid and vout.');
  }
  if (typeof record.address !== 'string' || record.address.length === 0) {
    return refuse('ADDRESS_MISSING', 'The record must name the address that controls the outpoint.');
  }
  if (parseSats(record.sourceValueSats) === null) {
    return refuse('SOURCE_VALUE_INVALID', 'sourceValueSats must be an exact decimal string.');
  }
  if (
    !record.checkpoint ||
    !Number.isInteger(record.checkpoint.height) ||
    record.checkpoint.height < 0 ||
    typeof record.checkpoint.blockHash !== 'string' ||
    !HEX64.test(record.checkpoint.blockHash) ||
    typeof record.checkpoint.ledgerHash !== 'string' ||
    !HEX64.test(record.checkpoint.ledgerHash)
  ) {
    return refuse(
      'CHECKPOINT_INVALID',
      'The record must carry the block height, block hash, and Counterparty ledger hash it was read at.',
    );
  }
  if (!record.authority || record.authority.kind !== 'counterparty-core' || record.authority.ready !== true) {
    return refuse(
      'AUTHORITY_NOT_READY',
      'The record may only be produced while the self hosted Counterparty Core authority reports ready.',
    );
  }
  if (record.attached !== true) {
    return refuse('ATTACHMENT_STATE_UNKNOWN', 'The record must state that the attachment currently exists.');
  }
  if (record.coTravelingAssets !== undefined) {
    if (!Array.isArray(record.coTravelingAssets)) {
      return refuse('COTRAVELING_INVALID', 'coTravelingAssets must be an array.');
    }
    for (const other of record.coTravelingAssets) {
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
export function verifyAttachmentFollows(record, spendTx, expectedOutputIndex) {
  const recordVerdict = verifyCounterpartyUtxoAsset(record);
  if (!recordVerdict.ok) return recordVerdict;
  if (!spendTx || !Array.isArray(spendTx.inputs) || !Array.isArray(spendTx.outputs)) {
    return refuse('MALFORMED_TRANSACTION', 'Expected inputs and outputs arrays.');
  }
  if (!Number.isInteger(expectedOutputIndex) || !spendTx.outputs[expectedOutputIndex]) {
    return refuse('DESTINATION_MISSING', 'The plan names an output that does not exist.');
  }

  let index = -1;
  let inputValue = null;
  for (let i = 0; i < spendTx.inputs.length; i += 1) {
    const input = spendTx.inputs[i];
    if (input.txid === record.outpoint.txid && input.vout === record.outpoint.vout) {
      if (index !== -1) {
        return refuse('OUTPOINT_DUPLICATED', 'The attached outpoint appears at more than one index.');
      }
      index = i;
      inputValue = parseSats(input.valueSats);
    }
  }
  if (index === -1) {
    return refuse('OUTPOINT_NOT_SPENT', 'No input spends the attached outpoint.');
  }
  if (inputValue === null || inputValue !== parseSats(record.sourceValueSats)) {
    return refuse(
      'SOURCE_VALUE_MISMATCH',
      'The spent value does not match the record, so the sat range cannot be traced.',
    );
  }

  let inputsAhead = 0n;
  for (let i = 0; i < index; i += 1) {
    const value = parseSats(spendTx.inputs[i].valueSats);
    if (value === null) {
      return refuse('INPUT_VALUE_UNKNOWN', `Input ${i} has no readable value, so the sat range cannot be traced.`);
    }
    inputsAhead += value;
  }

  let carriedToIndex = -1;
  let outputsAhead = 0n;
  for (let i = 0; i < spendTx.outputs.length; i += 1) {
    const value = parseSats(spendTx.outputs[i] && spendTx.outputs[i].valueSats);
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
      `The sat range lands on output ${carriedToIndex}, not the planned output ${expectedOutputIndex}.`,
    );
  }
  return { ok: true, carriedToIndex };
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

/** SHA-256 over the sorted-key JSON of a record, for event references. */
export function counterpartyRecordDigest(record) {
  const binding = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'digest') continue;
    binding[key] = value;
  }
  return createHash('sha256').update(sortedJson(binding), 'utf8').digest('hex');
}
