// Reference verifier for Counterparty UTXO-attached assets on Ordex.
//
// This file restates spec/counterparty-utxo-asset.md as executable checks.
// It validates a counterparty-utxo-asset/v1 record and it decides whether a
// spending transaction carries an attachment to the destination the plan
// named, using the destination rule of the pinned Counterparty Core parser.
// Reading the Counterparty ledger and proving server readiness remain the
// caller's responsibility; verifyCounterpartyLedgerEvents reconciles the events
// the ledger recorded after confirmation.
//
// Asset identity is the authoritative Counterparty asset id plus its current
// ledger state. A ticker or name alone is never an identity. Every amount is
// an atomic integer carried as a decimal string and handled as BigInt.

import { createHash } from 'node:crypto';

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NETWORKS = ['mainnet', 'testnet', 'testnet4', 'signet', 'regtest'];
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
 * Block heights at which the pinned Counterparty Core v11.4.0
 * (protocol_changes.json, commit e4d13156) turns on UTXO attachments and the
 * rule that spending an attached UTXO with no destination detaches it. The
 * legacy `testnet` label is testnet3, as Counterparty names it.
 */
export const COUNTERPARTY_UTXO_ACTIVATION = Object.freeze({
  mainnet: Object.freeze({ utxoSupport: 866000, spendUtxoToDetach: 871900 }),
  testnet: Object.freeze({ utxoSupport: 2925800, spendUtxoToDetach: 3195137 }),
  testnet4: Object.freeze({ utxoSupport: 0, spendUtxoToDetach: 0 }),
  signet: Object.freeze({ utxoSupport: 0, spendUtxoToDetach: 0 }),
  regtest: Object.freeze({ utxoSupport: 0, spendUtxoToDetach: 0 }),
});

const HEX = /^(?:[0-9a-f]{2})*$/;
const OP_RETURN = 0x6a;
const OP_CHECKMULTISIG = 0xae;
const MESSAGES = ['none', 'attach', 'detach', 'other'];

function hexBytes(value) {
  if (typeof value !== 'string' || !HEX.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * The instructions of a script the way rust-bitcoin 0.32 `instructions()`
 * reads them (non-minimal pushes allowed), or null when a push runs past the
 * end. Each entry is { op } or { push }.
 */
function scriptInstructions(bytes) {
  const out = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    const opcode = bytes[cursor];
    cursor += 1;
    let length;
    if (opcode <= 0x4b) length = opcode;
    else if (opcode === 0x4c) {
      if (cursor + 1 > bytes.length) return null;
      length = bytes[cursor];
      cursor += 1;
    } else if (opcode === 0x4d) {
      if (cursor + 2 > bytes.length) return null;
      length = bytes[cursor] | (bytes[cursor + 1] << 8);
      cursor += 2;
    } else if (opcode === 0x4e) {
      if (cursor + 4 > bytes.length) return null;
      length = bytes[cursor] + bytes[cursor + 1] * 0x100 + bytes[cursor + 2] * 0x10000 + bytes[cursor + 3] * 0x1000000;
      cursor += 4;
    } else {
      out.push({ op: opcode });
      continue;
    }
    if (cursor + length > bytes.length) return null;
    out.push({ push: bytes.slice(cursor, cursor + length) });
    cursor += length;
  }
  return out;
}

/** counterparty-rs script_to_asm renders an opcode and a one-byte push alike. */
function asmByteIs(instruction, byte) {
  if (instruction.op !== undefined) return instruction.op === byte;
  return instruction.push.length === 1 && instruction.push[0] === byte;
}

/**
 * Whether Counterparty's select_utxo_destination passes over this output. It
 * decodes the whole script: a script that fails to decode, is empty, or ends in
 * OP_CHECKMULTISIG is never passed over, and otherwise the output is skipped
 * when its first asm element is OP_RETURN.
 */
function counterpartySkipsOutput(bytes) {
  const asm = scriptInstructions(bytes);
  if (!asm || asm.length === 0) return false;
  if (asmByteIs(asm[asm.length - 1], OP_CHECKMULTISIG)) return false;
  return asmByteIs(asm[0], OP_RETURN);
}

/**
 * The output an ordinary Counterparty UTXO move credits: the first output
 * select_utxo_destination does not pass over, independent of any BTC value.
 * Returns its index, null when there is none, or undefined when a script is not
 * lowercase hex.
 */
// OX-P10: Counterparty Core v11.4.0 gettxinfo.py (blob 38671492) picks one
// destination for every attached input from raw script bytes. Sat positions and
// output values play no part, which is why the old first-sat trace was wrong.
export function counterpartyMoveDestination(outputScriptsHex) {
  if (!Array.isArray(outputScriptsHex)) return undefined;
  for (let index = 0; index < outputScriptsHex.length; index += 1) {
    const bytes = hexBytes(outputScriptsHex[index]);
    if (!bytes) return undefined;
    if (!counterpartySkipsOutput(bytes)) return index;
  }
  return null;
}

/** The UTXO gates active at a block height on a network, or null if unknown. */
export function counterpartyUtxoGates(network, height) {
  const table = COUNTERPARTY_UTXO_ACTIVATION[network];
  if (!table || !Number.isSafeInteger(height) || height < 0) return null;
  return { utxoSupport: height >= table.utxoSupport, spendUtxoToDetach: height >= table.spendUtxoToDetach };
}

function validAttachments(list) {
  if (!Array.isArray(list)) return false;
  return list.every(
    (a) =>
      a &&
      typeof a.name === 'string' &&
      a.name.length > 0 &&
      typeof a.assetId === 'string' &&
      DECIMAL.test(a.assetId) &&
      parseSats(a.quantitySats) !== null &&
      parseSats(a.quantitySats) > 0n
  );
}

/**
 * What the pinned Counterparty parser does with every asset attached to the
 * inputs of a spending transaction.
 *
 * spendTx:
 *   inputs  [{ txid, vout, attachments: [{ name, assetId, quantitySats }] }]
 *           attachments is what the Counterparty ledger holds on that outpoint
 *           at the checkpoint; [] for none. It is required for every input.
 *   outputs [{ scriptHex }]
 *   counterpartyMessage  'none' (default) | 'attach' | 'detach' | 'other'
 * context: { network, height }  the height the spend is evaluated at.
 *
 * operation is one of:
 *   NONE            no input carries an attachment
 *   MOVE            every attachment is credited to destinationIndex
 *   DETACH_BY_SPEND no destination; each attachment returns to its owner address
 *   STRANDED        no destination before spend_utxo_to_detach; nothing moves
 *   DETACH_MESSAGE  a detach message governs; move_assets does not run
 */
// OX-P10: attach, detach and the automatic move are distinct operations. blocks.py
// parse_tx runs move_assets before any message except attach and detach, after an
// attach, and never for a detach; move.py credits every attached balance of every
// source to the one destination, or detaches it once spend_utxo_to_detach is active.
export function counterpartyMoveOutcome(spendTx, context) {
  if (!spendTx || !Array.isArray(spendTx.inputs) || !Array.isArray(spendTx.outputs)) {
    return refuse('MALFORMED_TRANSACTION', 'Expected inputs and outputs arrays.');
  }
  if (spendTx.inputs.length === 0 || spendTx.outputs.length === 0) {
    return refuse('MALFORMED_TRANSACTION', 'A transaction has at least one input and one output.');
  }
  const gates = counterpartyUtxoGates(context?.network, context?.height);
  if (!gates) {
    return refuse('CONTEXT_INVALID', 'The spend needs a known network and a block height to apply Counterparty rules.');
  }
  const message = spendTx.counterpartyMessage ?? 'none';
  if (!MESSAGES.includes(message)) {
    return refuse('COUNTERPARTY_MESSAGE_UNKNOWN', 'counterpartyMessage must be none, attach, detach or other.');
  }

  const seen = new Set();
  const sources = [];
  for (let i = 0; i < spendTx.inputs.length; i += 1) {
    const input = spendTx.inputs[i];
    if (!input || typeof input.txid !== 'string' || !HEX64.test(input.txid) || !Number.isInteger(input.vout) || input.vout < 0) {
      return refuse('MALFORMED_TRANSACTION', `Input ${i} does not name a txid and vout.`);
    }
    const key = `${input.txid}:${input.vout}`;
    if (seen.has(key)) return refuse('OUTPOINT_DUPLICATED', `Input ${i} spends ${key} a second time.`);
    seen.add(key);
    if (!validAttachments(input.attachments)) {
      return refuse(
        'INPUT_ATTACHMENTS_UNKNOWN',
        `Input ${i} does not carry the Counterparty attachments read for it, so what it moves is unknown.`,
      );
    }
    if (input.attachments.length > 0) sources.push(i);
  }

  const destinationIndex = counterpartyMoveDestination(spendTx.outputs.map((o) => o && o.scriptHex));
  if (destinationIndex === undefined) {
    return refuse('OUTPUT_SCRIPT_INVALID', 'Every output needs its script as lowercase hex.');
  }

  const base = { ok: true, destinationIndex, gates, moved: [], detached: [], stranded: [] };
  if (sources.length === 0) return { ...base, operation: 'NONE' };
  if (!gates.utxoSupport) {
    return refuse('UTXO_SUPPORT_INACTIVE', 'Counterparty UTXO attachments do not exist at this height on this network.');
  }

  const entries = sources.flatMap((i) =>
    spendTx.inputs[i].attachments.map((a) => ({
      fromInput: i,
      source: `${spendTx.inputs[i].txid}:${spendTx.inputs[i].vout}`,
      name: a.name,
      assetId: a.assetId,
      quantitySats: a.quantitySats,
    })),
  );

  if (message === 'detach' && gates.spendUtxoToDetach) return { ...base, operation: 'DETACH_MESSAGE' };
  if (destinationIndex !== null) {
    return { ...base, operation: 'MOVE', moved: entries.map((e) => ({ ...e, toOutput: destinationIndex })) };
  }
  if (gates.spendUtxoToDetach) return { ...base, operation: 'DETACH_BY_SPEND', detached: entries };
  return { ...base, operation: 'STRANDED', stranded: entries };
}

function sameAttachments(a, b) {
  const key = (x) => `${x.assetId}|${x.name}|${x.quantitySats}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/**
 * Verify that a spending transaction moves the recorded attachment, and only
 * it, to the output the plan named.
 *
 * spendTx is as counterpartyMoveOutcome takes it; the recorded input also
 * carries valueSats. context.height defaults to the record's checkpoint height
 * plus one, the earliest block the spend can confirm in.
 *
 * Returns { ok: true, carriedToIndex, operation: 'MOVE', moved } or a refusal.
 */
// OX-P10: the attachment follows Counterparty's first-spendable-output rule, never
// the sat range. The verifier also demands the ledger's attachment list for every
// input, so an undeclared co-traveling asset or another input's attachment that
// would co-move to the same output is refused instead of silently carried along.
export function verifyAttachmentFollows(record, spendTx, expectedOutputIndex, context = {}) {
  const recordVerdict = verifyCounterpartyUtxoAsset(record);
  if (!recordVerdict.ok) return recordVerdict;
  if (!spendTx || !Array.isArray(spendTx.inputs) || !Array.isArray(spendTx.outputs)) {
    return refuse('MALFORMED_TRANSACTION', 'Expected inputs and outputs arrays.');
  }
  if (!Number.isInteger(expectedOutputIndex) || !spendTx.outputs[expectedOutputIndex]) {
    return refuse('DESTINATION_MISSING', 'The plan names an output that does not exist.');
  }

  let index = -1;
  for (let i = 0; i < spendTx.inputs.length; i += 1) {
    const input = spendTx.inputs[i];
    if (input && input.txid === record.outpoint.txid && input.vout === record.outpoint.vout) {
      if (index !== -1) {
        return refuse('OUTPOINT_DUPLICATED', 'The attached outpoint appears at more than one index.');
      }
      index = i;
    }
  }
  if (index === -1) {
    return refuse('OUTPOINT_NOT_SPENT', 'No input spends the attached outpoint.');
  }
  const spent = spendTx.inputs[index];
  if (parseSats(spent.valueSats) === null || parseSats(spent.valueSats) !== parseSats(record.sourceValueSats)) {
    return refuse('SOURCE_VALUE_MISMATCH', 'The spent value does not match the record, so this is not the recorded outpoint state.');
  }

  const height = context.height ?? record.checkpoint.height + 1;
  const outcome = counterpartyMoveOutcome(spendTx, { network: record.network, height });
  if (!outcome.ok) return outcome;

  const declared = [record.asset, ...(record.coTravelingAssets || [])].map((a) => ({
    name: a.name,
    assetId: a.assetId,
    quantitySats: a.quantitySats,
  }));
  if (!sameAttachments(spent.attachments, declared)) {
    return refuse(
      'ATTACHMENT_INVENTORY_MISMATCH',
      'The ledger lists different assets on the recorded outpoint than the record declares.',
    );
  }
  const others = spendTx.inputs.findIndex((input, i) => i !== index && input.attachments.length > 0);
  if (others !== -1) {
    return refuse(
      'OTHER_ATTACHMENTS_COMOVE',
      `Input ${others} also carries Counterparty assets, and every attached input moves to the same output.`,
    );
  }

  if (outcome.operation === 'DETACH_MESSAGE') {
    return refuse('DETACH_NOT_A_MOVE', 'A detach message sends the assets to an address, not to an output.');
  }
  if (outcome.operation === 'DETACH_BY_SPEND') {
    return refuse('NO_DESTINATION_DETACHES', 'No output can receive the attachment, so spending detaches it to its owner.');
  }
  if (outcome.operation === 'STRANDED') {
    return refuse('NO_DESTINATION_STRANDS', 'No output can receive the attachment and detach on spend is not active yet.');
  }
  if (outcome.destinationIndex !== expectedOutputIndex) {
    return refuse(
      'DESTINATION_MISMATCH',
      `Counterparty credits output ${outcome.destinationIndex}, not the planned output ${expectedOutputIndex}.`,
    );
  }
  const destination = hexBytes(spendTx.outputs[expectedOutputIndex].scriptHex);
  if (destination.length > 0 && destination[0] === OP_RETURN) {
    return refuse('DESTINATION_UNSPENDABLE', 'Counterparty would credit an output whose script begins OP_RETURN, which nobody can spend.');
  }
  return { ok: true, carriedToIndex: expectedOutputIndex, operation: 'MOVE', moved: outcome.moved };
}

const LEDGER_EVENTS = ['UTXO_MOVE', 'ATTACH_TO_UTXO', 'DETACH_FROM_UTXO'];

/**
 * Reconcile the Counterparty ledger events a confirmed transaction produced
 * against the exact events its plan expected.
 *
 * expected: { txHash, events: [{ event, source, destination, asset, quantity }] }
 *           source and destination are 'txid:vout' for UTXOs, else an address.
 * observed: { checkpoint: { height, blockHash, ledgerHash },
 *             events: [{ event, txHash, source, destination, asset, quantity, status }] }
 *
 * Every UTXO_MOVE, ATTACH_TO_UTXO and DETACH_FROM_UTXO event of the transaction
 * must match one expected event exactly, with status valid, and every expected
 * event must be matched. Observations are read again after a reorg.
 */
// OX-P10: a broadcast is settled by the ledger's own events, not by the plan.
export function verifyCounterpartyLedgerEvents(expected, observed) {
  if (!expected || typeof expected.txHash !== 'string' || !HEX64.test(expected.txHash) || !Array.isArray(expected.events)) {
    return refuse('EVENTS_MALFORMED', 'The expectation must name a txid and a list of events.');
  }
  const checkpoint = observed?.checkpoint;
  if (
    !checkpoint ||
    !Number.isInteger(checkpoint.height) ||
    checkpoint.height < 0 ||
    typeof checkpoint.blockHash !== 'string' ||
    !HEX64.test(checkpoint.blockHash) ||
    typeof checkpoint.ledgerHash !== 'string' ||
    !HEX64.test(checkpoint.ledgerHash)
  ) {
    return refuse('CHECKPOINT_INVALID', 'The observation must carry the block height, block hash and ledger hash it was read at.');
  }
  if (!Array.isArray(observed.events)) return refuse('EVENTS_MALFORMED', 'The observation must list events.');
  const key = (e) => `${e.event}|${e.source}|${e.destination}|${e.asset}|${e.quantity}`;
  const wellFormed = (e) =>
    e &&
    LEDGER_EVENTS.includes(e.event) &&
    typeof e.source === 'string' &&
    typeof e.destination === 'string' &&
    typeof e.asset === 'string' &&
    parseSats(e.quantity) !== null;
  if (!expected.events.every(wellFormed)) return refuse('EVENTS_MALFORMED', 'An expected event is malformed.');

  const remaining = new Map();
  for (const e of expected.events) remaining.set(key(e), (remaining.get(key(e)) ?? 0) + 1);
  for (const e of observed.events) {
    if (!e || e.txHash !== expected.txHash || !LEDGER_EVENTS.includes(e.event)) continue;
    if (!wellFormed(e) || e.status !== 'valid') {
      return refuse('LEDGER_EVENT_INVALID', `The ledger recorded a ${e.event} event that is not valid.`);
    }
    const count = remaining.get(key(e)) ?? 0;
    if (count === 0) {
      return refuse('LEDGER_EVENT_UNEXPECTED', `The ledger moved ${e.quantity} ${e.asset} from ${e.source} to ${e.destination}, which the plan did not expect.`);
    }
    remaining.set(key(e), count - 1);
  }
  for (const [slot, count] of remaining) {
    if (count > 0) return refuse('LEDGER_EVENT_MISSING', `The ledger holds no ${slot.split('|')[0]} event for ${slot}.`);
  }
  return { ok: true, checkpoint };
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
