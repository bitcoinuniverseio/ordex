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
const NETWORKS = ['mainnet', 'testnet', 'testnet4', 'signet', 'regtest'];

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

/** One asset the Counterparty ledger holds on an outpoint. */
export interface CounterpartyAttachment {
  name: string;
  assetId: string;
  quantitySats: string;
}

export interface CounterpartySpendTransaction {
  inputs?: Array<{ txid?: unknown; vout?: unknown; valueSats?: unknown; attachments?: unknown }>;
  outputs?: Array<{ scriptHex?: unknown; valueSats?: unknown }>;
  /** Which Counterparty message the spend carries, if any. Default none. */
  counterpartyMessage?: unknown;
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
  | 'CONTEXT_INVALID'
  | 'COUNTERPARTY_MESSAGE_UNKNOWN'
  | 'INPUT_ATTACHMENTS_UNKNOWN'
  | 'OUTPUT_SCRIPT_INVALID'
  | 'UTXO_SUPPORT_INACTIVE'
  | 'ATTACHMENT_INVENTORY_MISMATCH'
  | 'OTHER_ATTACHMENTS_COMOVE'
  | 'DETACH_NOT_A_MOVE'
  | 'NO_DESTINATION_DETACHES'
  | 'NO_DESTINATION_STRANDS'
  | 'DESTINATION_MISMATCH'
  | 'DESTINATION_UNSPENDABLE'
  | 'EVENTS_MALFORMED'
  | 'LEDGER_EVENT_INVALID'
  | 'LEDGER_EVENT_UNEXPECTED'
  | 'LEDGER_EVENT_MISSING';

export type CounterpartyRecordVerdict =
  | { ok: true }
  | { ok: false; code: CounterpartyRefusalCode; reason: string };

export type CounterpartyAttachmentVerdict =
  | { ok: true; carriedToIndex: number; operation: 'MOVE'; moved: CounterpartyMovedAsset[] }
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
 * Block heights at which the pinned Counterparty Core v11.4.0
 * (protocol_changes.json, commit e4d13156) turns on UTXO attachments and the
 * rule that spending an attached UTXO with no destination detaches it. The
 * legacy `testnet` label is testnet3, as Counterparty names it.
 */
export const COUNTERPARTY_UTXO_ACTIVATION: Readonly<
  Record<string, Readonly<{ utxoSupport: number; spendUtxoToDetach: number }>>
> = Object.freeze({
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

function hexBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !HEX.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

type Instruction = { op: number } | { push: Uint8Array };

/**
 * The instructions of a script the way rust-bitcoin 0.32 `instructions()`
 * reads them (non-minimal pushes allowed), or null when a push runs past the
 * end.
 */
function scriptInstructions(bytes: Uint8Array): Instruction[] | null {
  const out: Instruction[] = [];
  let cursor = 0;
  const at = (i: number): number | undefined => bytes[i];
  while (cursor < bytes.length) {
    const opcode = at(cursor);
    if (opcode === undefined) return null;
    cursor += 1;
    let length: number;
    if (opcode <= 0x4b) length = opcode;
    else if (opcode === 0x4c) {
      const b0 = at(cursor);
      if (b0 === undefined) return null;
      length = b0;
      cursor += 1;
    } else if (opcode === 0x4d) {
      const b0 = at(cursor);
      const b1 = at(cursor + 1);
      if (b0 === undefined || b1 === undefined) return null;
      length = b0 | (b1 << 8);
      cursor += 2;
    } else if (opcode === 0x4e) {
      const b0 = at(cursor);
      const b1 = at(cursor + 1);
      const b2 = at(cursor + 2);
      const b3 = at(cursor + 3);
      if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) return null;
      length = b0 + b1 * 0x100 + b2 * 0x10000 + b3 * 0x1000000;
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
function asmByteIs(instruction: Instruction | undefined, byte: number): boolean {
  if (!instruction) return false;
  if ('op' in instruction) return instruction.op === byte;
  return instruction.push.length === 1 && instruction.push[0] === byte;
}

/**
 * Whether Counterparty's select_utxo_destination passes over this output. It
 * decodes the whole script: a script that fails to decode, is empty, or ends in
 * OP_CHECKMULTISIG is never passed over, and otherwise the output is skipped
 * when its first asm element is OP_RETURN.
 */
function counterpartySkipsOutput(bytes: Uint8Array): boolean {
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
export function counterpartyMoveDestination(outputScriptsHex: unknown): number | null | undefined {
  if (!Array.isArray(outputScriptsHex)) return undefined;
  for (let index = 0; index < outputScriptsHex.length; index += 1) {
    const bytes = hexBytes(outputScriptsHex[index]);
    if (!bytes) return undefined;
    if (!counterpartySkipsOutput(bytes)) return index;
  }
  return null;
}

export interface CounterpartyUtxoGates {
  utxoSupport: boolean;
  spendUtxoToDetach: boolean;
}

/** The UTXO gates active at a block height on a network, or null if unknown. */
export function counterpartyUtxoGates(network: unknown, height: unknown): CounterpartyUtxoGates | null {
  const table = typeof network === 'string' ? COUNTERPARTY_UTXO_ACTIVATION[network] : undefined;
  if (!table || typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) return null;
  return { utxoSupport: height >= table.utxoSupport, spendUtxoToDetach: height >= table.spendUtxoToDetach };
}

function validAttachments(list: unknown): list is CounterpartyAttachment[] {
  if (!Array.isArray(list)) return false;
  return list.every((a: CounterpartyAttachment | null | undefined) => {
    if (!a || typeof a.name !== 'string' || a.name.length === 0) return false;
    if (typeof a.assetId !== 'string' || !DECIMAL.test(a.assetId)) return false;
    const quantity = parseSats(a.quantitySats);
    return quantity !== null && quantity > 0n;
  });
}

export type CounterpartyOperation = 'NONE' | 'MOVE' | 'DETACH_BY_SPEND' | 'STRANDED' | 'DETACH_MESSAGE';

export interface CounterpartyMovedAsset {
  fromInput: number;
  source: string;
  name: string;
  assetId: string;
  quantitySats: string;
  toOutput?: number;
}

export type CounterpartyMoveOutcome =
  | {
      ok: true;
      operation: CounterpartyOperation;
      destinationIndex: number | null;
      gates: CounterpartyUtxoGates;
      moved: CounterpartyMovedAsset[];
      detached: CounterpartyMovedAsset[];
      stranded: CounterpartyMovedAsset[];
    }
  | CounterpartyRefusal;

/**
 * What the pinned Counterparty parser does with every asset attached to the
 * inputs of a spending transaction. Every input must carry the attachments the
 * ledger holds on it at the checkpoint, [] for none.
 */
// OX-P10: attach, detach and the automatic move are distinct operations. blocks.py
// parse_tx runs move_assets before any message except attach and detach, after an
// attach, and never for a detach; move.py credits every attached balance of every
// source to the one destination, or detaches it once spend_utxo_to_detach is active.
export function counterpartyMoveOutcome(
  spendTx: CounterpartySpendTransaction | null | undefined,
  context: { network?: unknown; height?: unknown } | null | undefined
): CounterpartyMoveOutcome {
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
  if (typeof message !== 'string' || !MESSAGES.includes(message)) {
    return refuse('COUNTERPARTY_MESSAGE_UNKNOWN', 'counterpartyMessage must be none, attach, detach or other.');
  }

  const seen = new Set<string>();
  const sources: Array<{ index: number; source: string; attachments: CounterpartyAttachment[] }> = [];
  for (let i = 0; i < spendTx.inputs.length; i += 1) {
    const input = spendTx.inputs[i];
    if (
      !input ||
      typeof input.txid !== 'string' ||
      !HEX64.test(input.txid) ||
      typeof input.vout !== 'number' ||
      !Number.isInteger(input.vout) ||
      input.vout < 0
    ) {
      return refuse('MALFORMED_TRANSACTION', `Input ${i} does not name a txid and vout.`);
    }
    const key = `${input.txid}:${input.vout}`;
    if (seen.has(key)) return refuse('OUTPOINT_DUPLICATED', `Input ${i} spends ${key} a second time.`);
    seen.add(key);
    const attachments = input.attachments;
    if (!validAttachments(attachments)) {
      return refuse(
        'INPUT_ATTACHMENTS_UNKNOWN',
        `Input ${i} does not carry the Counterparty attachments read for it, so what it moves is unknown.`
      );
    }
    if (attachments.length > 0) sources.push({ index: i, source: key, attachments });
  }

  const destinationIndex = counterpartyMoveDestination(spendTx.outputs.map((o) => o?.scriptHex));
  if (destinationIndex === undefined) {
    return refuse('OUTPUT_SCRIPT_INVALID', 'Every output needs its script as lowercase hex.');
  }

  const base = {
    ok: true as const,
    destinationIndex,
    gates,
    moved: [] as CounterpartyMovedAsset[],
    detached: [] as CounterpartyMovedAsset[],
    stranded: [] as CounterpartyMovedAsset[],
  };
  if (sources.length === 0) return { ...base, operation: 'NONE' };
  if (!gates.utxoSupport) {
    return refuse('UTXO_SUPPORT_INACTIVE', 'Counterparty UTXO attachments do not exist at this height on this network.');
  }

  const entries: CounterpartyMovedAsset[] = sources.flatMap((s) =>
    s.attachments.map((a) => ({
      fromInput: s.index,
      source: s.source,
      name: a.name,
      assetId: a.assetId,
      quantitySats: a.quantitySats,
    }))
  );

  if (message === 'detach' && gates.spendUtxoToDetach) return { ...base, operation: 'DETACH_MESSAGE' };
  if (destinationIndex !== null) {
    return { ...base, operation: 'MOVE', moved: entries.map((e) => ({ ...e, toOutput: destinationIndex })) };
  }
  if (gates.spendUtxoToDetach) return { ...base, operation: 'DETACH_BY_SPEND', detached: entries };
  return { ...base, operation: 'STRANDED', stranded: entries };
}

function sameAttachments(a: readonly CounterpartyAttachment[], b: readonly CounterpartyAttachment[]): boolean {
  const key = (x: CounterpartyAttachment): string => `${x.assetId}|${x.name}|${x.quantitySats}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/**
 * Verify that a spending transaction moves the recorded attachment, and only
 * it, to the output the plan named. context.height defaults to the record's
 * checkpoint height plus one, the earliest block the spend can confirm in.
 */
// OX-P10: the attachment follows Counterparty's first-spendable-output rule, never
// the sat range. The verifier also demands the ledger's attachment list for every
// input, so an undeclared co-traveling asset or another input's attachment that
// would co-move to the same output is refused instead of silently carried along.
export function verifyAttachmentFollows(
  record: unknown,
  spendTx: CounterpartySpendTransaction | null | undefined,
  expectedOutputIndex: number,
  context: { height?: number } = {}
): CounterpartyAttachmentVerdict {
  const recordVerdict = verifyCounterpartyUtxoAsset(record);
  if (!recordVerdict.ok) return recordVerdict;
  const r = record as CounterpartyUtxoAssetRecord & {
    outpoint: { txid: string; vout: number };
    checkpoint: { height: number };
    network: string;
    asset: CounterpartyAttachment;
  };
  if (!spendTx || !Array.isArray(spendTx.inputs) || !Array.isArray(spendTx.outputs)) {
    return refuse('MALFORMED_TRANSACTION', 'Expected inputs and outputs arrays.');
  }
  if (!Number.isInteger(expectedOutputIndex) || !spendTx.outputs[expectedOutputIndex]) {
    return refuse('DESTINATION_MISSING', 'The plan names an output that does not exist.');
  }

  let index = -1;
  for (let i = 0; i < spendTx.inputs.length; i += 1) {
    const input = spendTx.inputs[i];
    if (input && input.txid === r.outpoint.txid && input.vout === r.outpoint.vout) {
      if (index !== -1) {
        return refuse('OUTPOINT_DUPLICATED', 'The attached outpoint appears at more than one index.');
      }
      index = i;
    }
  }
  const spent = spendTx.inputs[index];
  if (index === -1 || !spent) {
    return refuse('OUTPOINT_NOT_SPENT', 'No input spends the attached outpoint.');
  }
  const spentValue = parseSats(spent.valueSats);
  if (spentValue === null || spentValue !== parseSats(r.sourceValueSats)) {
    return refuse(
      'SOURCE_VALUE_MISMATCH',
      'The spent value does not match the record, so this is not the recorded outpoint state.'
    );
  }

  const height = context.height ?? r.checkpoint.height + 1;
  const outcome = counterpartyMoveOutcome(spendTx, { network: r.network, height });
  if (!outcome.ok) return outcome;

  const declared: CounterpartyAttachment[] = [r.asset, ...(r.coTravelingAssets ?? [])].map((a) => ({
    name: a.name as string,
    assetId: a.assetId as string,
    quantitySats: a.quantitySats as string,
  }));
  if (!sameAttachments((spent.attachments ?? []) as CounterpartyAttachment[], declared)) {
    return refuse(
      'ATTACHMENT_INVENTORY_MISMATCH',
      'The ledger lists different assets on the recorded outpoint than the record declares.'
    );
  }
  const others = spendTx.inputs.findIndex(
    (input, i) => i !== index && Array.isArray(input?.attachments) && input.attachments.length > 0
  );
  if (others !== -1) {
    return refuse(
      'OTHER_ATTACHMENTS_COMOVE',
      `Input ${others} also carries Counterparty assets, and every attached input moves to the same output.`
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
      `Counterparty credits output ${String(outcome.destinationIndex)}, not the planned output ${String(expectedOutputIndex)}.`
    );
  }
  const destination = hexBytes(spendTx.outputs[expectedOutputIndex]?.scriptHex);
  if (destination && destination.length > 0 && destination[0] === OP_RETURN) {
    return refuse(
      'DESTINATION_UNSPENDABLE',
      'Counterparty would credit an output whose script begins OP_RETURN, which nobody can spend.'
    );
  }
  return { ok: true, carriedToIndex: expectedOutputIndex, operation: 'MOVE', moved: outcome.moved };
}

const LEDGER_EVENTS = ['UTXO_MOVE', 'ATTACH_TO_UTXO', 'DETACH_FROM_UTXO'];

export interface CounterpartyLedgerEvent {
  event: 'UTXO_MOVE' | 'ATTACH_TO_UTXO' | 'DETACH_FROM_UTXO';
  /** 'txid:vout' for a UTXO, else an address. */
  source: string;
  destination: string;
  asset: string;
  quantity: string;
}

export interface CounterpartyObservedEvent extends CounterpartyLedgerEvent {
  txHash: string;
  status: string;
}

export type CounterpartyLedgerVerdict =
  | { ok: true; checkpoint: { height: number; blockHash: string; ledgerHash: string } }
  | CounterpartyRefusal;

/**
 * Reconcile the Counterparty ledger events a confirmed transaction produced
 * against the exact events its plan expected. Every UTXO_MOVE, ATTACH_TO_UTXO
 * and DETACH_FROM_UTXO event of the transaction must match one expected event,
 * with status valid, and every expected event must be matched.
 */
// OX-P10: a broadcast is settled by the ledger's own events, not by the plan.
export function verifyCounterpartyLedgerEvents(
  expected: { txHash?: unknown; events?: unknown } | null | undefined,
  observed:
    | { checkpoint?: { height?: unknown; blockHash?: unknown; ledgerHash?: unknown }; events?: unknown }
    | null
    | undefined
): CounterpartyLedgerVerdict {
  if (!expected || typeof expected.txHash !== 'string' || !HEX64.test(expected.txHash) || !Array.isArray(expected.events)) {
    return refuse('EVENTS_MALFORMED', 'The expectation must name a txid and a list of events.');
  }
  const checkpoint = observed?.checkpoint;
  if (
    !checkpoint ||
    typeof checkpoint.height !== 'number' ||
    !Number.isInteger(checkpoint.height) ||
    checkpoint.height < 0 ||
    typeof checkpoint.blockHash !== 'string' ||
    !HEX64.test(checkpoint.blockHash) ||
    typeof checkpoint.ledgerHash !== 'string' ||
    !HEX64.test(checkpoint.ledgerHash)
  ) {
    return refuse(
      'CHECKPOINT_INVALID',
      'The observation must carry the block height, block hash and ledger hash it was read at.'
    );
  }
  if (!Array.isArray(observed?.events)) return refuse('EVENTS_MALFORMED', 'The observation must list events.');
  const key = (e: CounterpartyLedgerEvent): string =>
    `${e.event}|${e.source}|${e.destination}|${e.asset}|${e.quantity}`;
  const wellFormed = (e: unknown): e is CounterpartyLedgerEvent => {
    const x = e as Partial<CounterpartyLedgerEvent> | null;
    return (
      !!x &&
      typeof x.event === 'string' &&
      LEDGER_EVENTS.includes(x.event) &&
      typeof x.source === 'string' &&
      typeof x.destination === 'string' &&
      typeof x.asset === 'string' &&
      parseSats(x.quantity) !== null
    );
  };
  if (!expected.events.every(wellFormed)) return refuse('EVENTS_MALFORMED', 'An expected event is malformed.');

  const remaining = new Map<string, number>();
  for (const e of expected.events as CounterpartyLedgerEvent[]) remaining.set(key(e), (remaining.get(key(e)) ?? 0) + 1);
  for (const raw of observed.events as unknown[]) {
    const e = raw as Partial<CounterpartyObservedEvent> | null;
    if (!e || e.txHash !== expected.txHash || typeof e.event !== 'string' || !LEDGER_EVENTS.includes(e.event)) continue;
    if (e.status !== 'valid' || !wellFormed(e)) {
      return refuse('LEDGER_EVENT_INVALID', `The ledger recorded a ${e.event} event that is not valid.`);
    }
    const count = remaining.get(key(e)) ?? 0;
    if (count === 0) {
      return refuse(
        'LEDGER_EVENT_UNEXPECTED',
        `The ledger moved ${e.quantity} ${e.asset} from ${e.source} to ${e.destination}, which the plan did not expect.`
      );
    }
    remaining.set(key(e), count - 1);
  }
  for (const [slot, count] of remaining) {
    if (count > 0) return refuse('LEDGER_EVENT_MISSING', `The ledger holds no ${slot.split('|')[0]} event for ${slot}.`);
  }
  return {
    ok: true,
    checkpoint: { height: checkpoint.height, blockHash: checkpoint.blockHash, ledgerHash: checkpoint.ledgerHash },
  };
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
