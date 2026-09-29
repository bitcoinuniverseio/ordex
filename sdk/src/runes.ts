/**
 * The rune burn rule from spec/runes.md, typed.
 *
 * This is the same verifier as verifier/runes.js at the repository root,
 * ported to TypeScript for SDK consumers. Both implementations are run
 * against conformance/rune-burn-vectors.json and the ord 0.29.0 differential
 * answers in conformance/ord-differential, so they cannot drift apart, or
 * away from ord, without a test failing.
 *
 * A cenotaph is a runestone the protocol cannot read. The transaction stays
 * perfectly valid to Bitcoin, confirms normally, and destroys every rune
 * balance its inputs carried. No fee check and no mempool acceptance test
 * finds one, because nothing about the transaction is invalid.
 */

const OP_RETURN = 0x6a;

/** OP_13, the magic number that marks the runestone output. */
const RUNESTONE_MAGIC = 0x5d;

/** Highest opcode that is still a direct push of its own length. */
const OP_PUSHBYTES_MAX = 0x4b;

const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;

// Tag numbers from ord 0.29.0 crates/ordinals/src/runestone/tag.rs.
const TAG_BODY = 0n;
const TAG_FLAGS = 2n;
const TAG_RUNE = 4n;
const TAG_PREMINE = 6n;
const TAG_CAP = 8n;
const TAG_AMOUNT = 10n;
const TAG_HEIGHT_START = 12n;
const TAG_HEIGHT_END = 14n;
const TAG_OFFSET_START = 16n;
const TAG_OFFSET_END = 18n;
const TAG_MINT = 20n;
const TAG_POINTER = 22n;
const TAG_DIVISIBILITY = 1n;
const TAG_SPACERS = 3n;
const TAG_SYMBOL = 5n;

// Flag bits from ord 0.29.0 runestone/flag.rs.
const FLAG_ETCHING = 1n;
const FLAG_TERMS = 2n;
const FLAG_TURBO = 4n;

const U32_MAX = 0xffff_ffffn;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const U128_MAX = (1n << 128n) - 1n;

/** Etching::MAX_DIVISIBILITY and Etching::MAX_SPACERS in ord 0.29.0. */
const MAX_DIVISIBILITY = 38n;
const MAX_SPACERS = 0x07ff_ffffn;

const HEX = /^(?:[0-9a-f]{2})*$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const RUNE_ID = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/;

export type RunestoneFlaw =
  | 'INVALID_SCRIPT'
  | 'OPCODE'
  | 'VARINT'
  | 'TRUNCATED_FIELD'
  | 'UNRECOGNIZED_EVEN_TAG'
  | 'UNRECOGNIZED_FLAG'
  | 'EDICT_RUNE_ID'
  | 'EDICT_OUTPUT'
  | 'TRAILING_INTEGERS'
  | 'SUPPLY_OVERFLOW';

export interface RuneId {
  block: bigint;
  tx: bigint;
}

export interface RuneEdict {
  id: RuneId;
  amount: bigint;
  /** Output index, or the output count itself, meaning split across all. */
  output: number;
}

export interface RuneTerms {
  cap?: bigint;
  heightStart?: bigint;
  heightEnd?: bigint;
  amount?: bigint;
  offsetStart?: bigint;
  offsetEnd?: bigint;
}

export interface RuneEtching {
  divisibility?: number;
  premine?: bigint;
  rune?: bigint;
  spacers?: number;
  symbol?: string;
  terms?: RuneTerms;
  turbo: boolean;
}

export type Runestone =
  | { kind: 'NONE' }
  | {
      kind: 'RUNESTONE';
      edicts: RuneEdict[];
      pointer?: number;
      etching?: RuneEtching;
      mint?: RuneId;
    }
  | { kind: 'CENOTAPH'; flaws: RunestoneFlaw[]; mint?: RuneId; etching?: bigint };

/** One exact balance the rune index reports at an output being spent. */
export interface RuneBalance {
  /** 'block:tx' */
  runeId: string;
  /** u128 as a decimal string. */
  amount: string;
}

/** What the rune index reports about one output being spent. */
export interface RuneInputObservation {
  /** False when the index has not examined this output at all. */
  indexed: boolean;
  /** How many distinct rune balances the index reports at this output. */
  runes?: number;
  /** The exact balances, when the index supplied them. */
  balances?: RuneBalance[];
}

export type RuneRefusalCode =
  | 'CENOTAPH_BURNS_BALANCE'
  | 'CENOTAPH_WITH_UNPROVEN_INPUT'
  | 'ALLOCATION_BURNS_BALANCE'
  | 'BURN_PATH_WITH_UNPROVEN_INPUT'
  | 'RUNE_BALANCES_REQUIRED'
  | 'RUNE_OUTPUTS_INCOMPLETE'
  | 'RUNE_MINT_UNRESOLVED'
  | 'RUNE_INPUT_UNPROVEN'
  | 'MALFORMED_RUNE_BALANCE'
  | 'MALFORMED_OUTPUT_SCRIPT';

export type RuneBurnCause = 'CENOTAPH' | 'OP_RETURN_OUTPUT' | 'NO_DESTINATION';

export interface RuneAllocation {
  output: number;
  runeId: string;
  amount: string;
}

export interface RuneBurn {
  runeId: string;
  cause: RuneBurnCause;
  amount: string;
}

export interface RuneSafetyVerdict {
  /** False whenever signing this transaction could destroy a rune balance. */
  safe: boolean;
  runestone: Runestone['kind'];
  runeBearingInputs: number;
  unindexedInputs: number;
  code?: RuneRefusalCode;
  flaws?: RunestoneFlaw[];
  burned?: RuneBurn[];
  reason?: string;
}

export interface RuneMintResult {
  runeId: string;
  amount: string;
}

export type RuneAllocationResult =
  | {
      ok: true;
      runestone: Runestone['kind'];
      flaws?: RunestoneFlaw[];
      allocations: RuneAllocation[];
      burned: RuneBurn[];
      mintUnresolved?: true;
    }
  | { ok: false; code: RuneRefusalCode; reason: string };

export type RuneAllocationRefusalCode =
  | RuneRefusalCode
  | 'RUNE_ALLOCATION_MISMATCH'
  | 'MALFORMED_RUNE_EXPECTATION';

export type RuneAllocationVerdict =
  | { ok: true; safe: true; runestone: Runestone['kind']; allocations: RuneAllocation[]; burned: RuneBurn[] }
  | {
      ok: false;
      code: RuneAllocationRefusalCode;
      reason: string;
      /** The burn safety of the same transaction, whatever the plan says. */
      safe?: boolean;
      runestone?: Runestone['kind'];
      allocations?: RuneAllocation[];
      burned?: RuneBurn[];
    };

/** Parse a lowercase hex string into bytes. Returns null for anything else. */
export function parseScriptHex(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || !HEX.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Decode one base-128 varint as the protocol does, rejecting both overlong
 * encodings and values that do not fit a u128.
 */
function decodeVarint(
  bytes: Uint8Array,
  start: number
): { value: bigint; length: number } | null {
  let result = 0n;
  for (let index = 0; start + index < bytes.length; index += 1) {
    if (index > 18) return null; // overlong
    const byte = bytes[start + index];
    if (byte === undefined) return null; // unterminated
    // The nineteenth group carries only the two bits left inside a u128.
    if (index === 18 && (byte & 0b0111_1100) !== 0) return null; // overflow
    result |= BigInt(byte & 0b0111_1111) << BigInt(7 * index);
    if ((byte & 0b1000_0000) === 0) return { value: result, length: index + 1 };
  }
  return null; // unterminated
}

/**
 * The concatenated data pushes of the runestone output, the flaw that makes the
 * transaction a cenotaph before any integer is read, or undefined when no
 * output carries the prefix.
 *
 * The script is walked directly rather than through a general decompiler. A
 * decompiler is free to rewrite a push into its minimal opcode form, and that
 * rewrite is lossy exactly here: a one byte payload comes back as an opcode and
 * is read as a cenotaph it is not.
 */
function runestonePayload(scripts: Uint8Array[]): Uint8Array | RunestoneFlaw | undefined {
  for (const script of scripts) {
    if (script.length < 2) continue;
    if (script[0] !== OP_RETURN || script[1] !== RUNESTONE_MAGIC) continue;

    const parts: number[] = [];
    let cursor = 2;
    while (cursor < script.length) {
      // Every read is guarded rather than bounds-checked in advance. A script
      // that ends mid push is exactly the malformed case this must catch, so
      // the missing byte and the truncated script are one answer.
      const opcode = script[cursor];
      if (opcode === undefined) return 'INVALID_SCRIPT';
      cursor += 1;
      let length: number;
      if (opcode <= OP_PUSHBYTES_MAX) {
        // Includes OP_0, which the protocol reads as an empty push.
        length = opcode;
      } else if (opcode === OP_PUSHDATA1) {
        const low = script[cursor];
        if (low === undefined) return 'INVALID_SCRIPT';
        length = low;
        cursor += 1;
      } else if (opcode === OP_PUSHDATA2) {
        const low = script[cursor];
        const high = script[cursor + 1];
        if (low === undefined || high === undefined) return 'INVALID_SCRIPT';
        length = low | (high << 8);
        cursor += 2;
      } else if (opcode === OP_PUSHDATA4) {
        const b0 = script[cursor];
        const b1 = script[cursor + 1];
        const b2 = script[cursor + 2];
        const b3 = script[cursor + 3];
        if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
          return 'INVALID_SCRIPT';
        }
        length = b0 + b1 * 0x100 + b2 * 0x10000 + b3 * 0x1000000;
        cursor += 4;
      } else {
        // Any true opcode after the magic number is a cenotaph.
        return 'OPCODE';
      }
      if (cursor + length > script.length) return 'INVALID_SCRIPT';
      for (let at = cursor; at < cursor + length; at += 1) {
        const byte = script[at];
        if (byte === undefined) return 'INVALID_SCRIPT';
        parts.push(byte);
      }
      cursor += length;
    }
    return Uint8Array.from(parts);
  }
  return undefined;
}

/**
 * Apply one edict's delta encoding. Rune ids ascend, so a block delta of zero
 * continues the previous block and any other delta restarts the tx counter.
 * Block zero with a nonzero tx is not a rune any block ever produced.
 */
function nextRuneId(current: RuneId, blockDelta: bigint, txDelta: bigint): RuneId | null {
  const block = current.block + blockDelta;
  if (block > U64_MAX) return null;
  const tx = blockDelta === 0n ? current.tx + txDelta : txDelta;
  if (tx > U32_MAX) return null;
  if (block === 0n && tx > 0n) return null;
  return { block, tx };
}

interface Message {
  flaw: RunestoneFlaw | undefined;
  fields: Map<bigint, bigint[]>;
  edicts: RuneEdict[];
}

/**
 * ord's Message::from_integers: tag/value pairs until the body tag, then edicts
 * in groups of four. Only the first flaw is kept, exactly as ord keeps it.
 */
function messageFromIntegers(integers: bigint[], outputCount: number): Message {
  let flaw: RunestoneFlaw | undefined;
  const fields = new Map<bigint, bigint[]>();
  const edicts: RuneEdict[] = [];
  for (let index = 0; index < integers.length; index += 2) {
    const tag = integers[index];
    if (tag === undefined) break;
    if (tag === TAG_BODY) {
      let id: RuneId = { block: 0n, tx: 0n };
      for (let at = index + 1; at < integers.length; at += 4) {
        // Edicts come in groups of four. A short final group is a cenotaph,
        // and reading each member explicitly is what proves the group whole.
        const blockDelta = integers[at];
        const txDelta = integers[at + 1];
        const amount = integers[at + 2];
        const output = integers[at + 3];
        if (
          blockDelta === undefined ||
          txDelta === undefined ||
          amount === undefined ||
          output === undefined
        ) {
          flaw ??= 'TRAILING_INTEGERS';
          break;
        }
        const next = nextRuneId(id, blockDelta, txDelta);
        if (!next) {
          flaw ??= 'EDICT_RUNE_ID';
          break;
        }
        // The output count itself is allowed: it means split across every
        // non-OP_RETURN output.
        if (output > U32_MAX || output > BigInt(outputCount)) {
          flaw ??= 'EDICT_OUTPUT';
          break;
        }
        id = next;
        edicts.push({ id, amount, output: Number(output) });
      }
      break;
    }
    const value = integers[index + 1];
    if (value === undefined) {
      flaw ??= 'TRUNCATED_FIELD';
      break;
    }
    const bucket = fields.get(tag);
    if (bucket) bucket.push(value);
    else fields.set(tag, [value]);
  }
  return { flaw, fields, edicts };
}

/**
 * ord's Tag::take. The field is consumed only when it holds `arity` values and
 * `decode` accepts them; a rejected value stays in the map, and an even tag
 * left in the map is what makes the runestone a cenotaph.
 */
function takeField<T>(
  fields: Map<bigint, bigint[]>,
  tag: bigint,
  arity: number,
  decode: (values: bigint[]) => T | undefined
): T | undefined {
  const field = fields.get(tag);
  if (!field || field.length < arity) return undefined;
  const value = decode(field.slice(0, arity));
  if (value === undefined) return undefined;
  field.splice(0, arity);
  if (field.length === 0) fields.delete(tag);
  return value;
}

/** ord's Flag::take: report and clear one bit. */
function takeFlag(state: { flags: bigint }, mask: bigint): boolean {
  const set = (state.flags & mask) !== 0n;
  state.flags &= ~mask;
  return set;
}

const anyValue = (values: bigint[]): bigint | undefined => values[0];
const u64Value = (values: bigint[]): bigint | undefined => {
  const value = values[0];
  return value !== undefined && value <= U64_MAX ? value : undefined;
};

/** char::from_u32 after u32::try_from: a Unicode scalar value or nothing. */
function symbolFromValue(values: bigint[]): string | undefined {
  const value = values[0];
  if (value === undefined || value > 0x10ffffn) return undefined;
  if (value >= 0xd800n && value <= 0xdfffn) return undefined;
  return String.fromCodePoint(Number(value));
}

/** Etching::supply: premine + cap * amount, or undefined on u128 overflow. */
function etchingSupply(etching: RuneEtching): bigint | undefined {
  const premine = etching.premine ?? 0n;
  const cap = etching.terms?.cap ?? 0n;
  const amount = etching.terms?.amount ?? 0n;
  const supply = premine + cap * amount;
  return supply > U128_MAX ? undefined : supply;
}

/**
 * Decipher the runestone of a transaction from its output scripts, given as
 * lowercase hex strings in transaction order.
 *
 * outputCount is the transaction's real output count, including the runestone
 * itself, because an edict may address it to mean "split across every
 * non-OP_RETURN output". It defaults to the number of scripts given.
 *
 * This is a format verdict only. Whether signing is safe for the balances the
 * inputs carry is decided by verifyRuneBurnSafety and verifyRuneAllocation.
 */
// OX-P04: field consumption follows ord 0.29.0 Runestone::decipher exactly
// (commit 7e37a3bd, runestone.rs blob 98022fb2). A recognized tag number is not a
// consumed field: Tag::take validates arity and range and removes values only on
// success, flags are consumed conditionally on Etching, and any even field or flag
// bit left over, or an etching whose supply overflows u128, makes a cenotaph.
export function decipherRunestone(
  outputScriptsHex: readonly string[],
  outputCount?: number
): Runestone {
  if (!Array.isArray(outputScriptsHex)) return { kind: 'CENOTAPH', flaws: ['INVALID_SCRIPT'] };
  const count = outputCount ?? outputScriptsHex.length;
  const scripts: Uint8Array[] = [];
  for (const hex of outputScriptsHex) {
    const bytes = parseScriptHex(hex);
    // An unreadable script is not a runestone this verifier can speak about.
    // The caller gave bytes that never came off a chain.
    if (!bytes) return { kind: 'CENOTAPH', flaws: ['INVALID_SCRIPT'] };
    scripts.push(bytes);
  }

  const payload = runestonePayload(scripts);
  if (payload === undefined) return { kind: 'NONE' };
  if (typeof payload === 'string') return { kind: 'CENOTAPH', flaws: [payload] };

  const integers: bigint[] = [];
  let cursor = 0;
  while (cursor < payload.length) {
    const decoded = decodeVarint(payload, cursor);
    // A payload that cannot be read as integers is a cenotaph outright.
    if (!decoded) return { kind: 'CENOTAPH', flaws: ['VARINT'] };
    integers.push(decoded.value);
    cursor += decoded.length;
  }

  const message = messageFromIntegers(integers, count);
  let flaw = message.flaw;
  const { fields, edicts } = message;

  const state = { flags: takeField(fields, TAG_FLAGS, 1, anyValue) ?? 0n };

  let etching: RuneEtching | undefined;
  if (takeFlag(state, FLAG_ETCHING)) {
    const divisibility = takeField(fields, TAG_DIVISIBILITY, 1, (values) => {
      const value = values[0];
      return value !== undefined && value <= MAX_DIVISIBILITY ? Number(value) : undefined;
    });
    const premine = takeField(fields, TAG_PREMINE, 1, anyValue);
    const rune = takeField(fields, TAG_RUNE, 1, anyValue);
    const spacers = takeField(fields, TAG_SPACERS, 1, (values) => {
      const value = values[0];
      return value !== undefined && value <= MAX_SPACERS ? Number(value) : undefined;
    });
    const symbol = takeField(fields, TAG_SYMBOL, 1, symbolFromValue);
    let terms: RuneTerms | undefined;
    if (takeFlag(state, FLAG_TERMS)) {
      terms = {};
      const cap = takeField(fields, TAG_CAP, 1, anyValue);
      const heightStart = takeField(fields, TAG_HEIGHT_START, 1, u64Value);
      const heightEnd = takeField(fields, TAG_HEIGHT_END, 1, u64Value);
      const amount = takeField(fields, TAG_AMOUNT, 1, anyValue);
      const offsetStart = takeField(fields, TAG_OFFSET_START, 1, u64Value);
      const offsetEnd = takeField(fields, TAG_OFFSET_END, 1, u64Value);
      if (cap !== undefined) terms.cap = cap;
      if (heightStart !== undefined) terms.heightStart = heightStart;
      if (heightEnd !== undefined) terms.heightEnd = heightEnd;
      if (amount !== undefined) terms.amount = amount;
      if (offsetStart !== undefined) terms.offsetStart = offsetStart;
      if (offsetEnd !== undefined) terms.offsetEnd = offsetEnd;
    }
    const turbo = takeFlag(state, FLAG_TURBO);
    etching = { turbo };
    if (divisibility !== undefined) etching.divisibility = divisibility;
    if (premine !== undefined) etching.premine = premine;
    if (rune !== undefined) etching.rune = rune;
    if (spacers !== undefined) etching.spacers = spacers;
    if (symbol !== undefined) etching.symbol = symbol;
    if (terms !== undefined) etching.terms = terms;
  }

  const mint = takeField<RuneId>(fields, TAG_MINT, 2, (values) => {
    const [block, tx] = values;
    if (block === undefined || tx === undefined) return undefined;
    if (block > U64_MAX || tx > U32_MAX) return undefined;
    if (block === 0n && tx > 0n) return undefined;
    return { block, tx };
  });

  const pointer = takeField(fields, TAG_POINTER, 1, (values) => {
    const value = values[0];
    return value !== undefined && value <= U32_MAX && value < BigInt(count) ? Number(value) : undefined;
  });

  if (etching && etchingSupply(etching) === undefined) flaw ??= 'SUPPLY_OVERFLOW';
  if (state.flags !== 0n) flaw ??= 'UNRECOGNIZED_FLAG';
  for (const tag of fields.keys()) {
    if (tag % 2n === 0n) {
      flaw ??= 'UNRECOGNIZED_EVEN_TAG';
      break;
    }
  }

  if (flaw) {
    const cenotaph: Runestone = { kind: 'CENOTAPH', flaws: [flaw] };
    if (mint) cenotaph.mint = mint;
    if (etching?.rune !== undefined) cenotaph.etching = etching.rune;
    return cenotaph;
  }

  const runestone: Runestone = { kind: 'RUNESTONE', edicts };
  if (etching) runestone.etching = etching;
  if (mint) runestone.mint = mint;
  if (pointer !== undefined) runestone.pointer = pointer;
  return runestone;
}

/** 'block:tx' for a deciphered rune id. */
function runeKey(id: RuneId): string {
  return `${id.block}:${id.tx}`;
}

function parseRuneId(value: unknown): RuneId | null {
  if (typeof value !== 'string') return null;
  const match = RUNE_ID.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  const block = BigInt(match[1]);
  const tx = BigInt(match[2]);
  if (block > U64_MAX || tx > U32_MAX) return null;
  if (block === 0n && tx > 0n) return null;
  return { block, tx };
}

function parseU128(value: unknown): bigint | null {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null;
  const amount = BigInt(value);
  return amount > U128_MAX ? null : amount;
}

function isOpReturn(script: Uint8Array | null | undefined): boolean {
  return !!script && script.length > 0 && script[0] === OP_RETURN;
}

function compareKeys(a: string, b: string): number {
  const [ab = 0n, at = 0n] = a.split(':').map(BigInt);
  const [bb = 0n, bt = 0n] = b.split(':').map(BigInt);
  if (ab !== bb) return ab < bb ? -1 : 1;
  if (at !== bt) return at < bt ? -1 : 1;
  return 0;
}

type Refusal = { code: RuneRefusalCode; reason: string };

/**
 * Sum what the rune index reports for every input into one balance per rune.
 * Every input must have been examined and must list exact balances.
 */
function inputBalances(inputs: unknown): { totals: Map<string, bigint> } | Refusal {
  if (!Array.isArray(inputs)) return { code: 'MALFORMED_RUNE_BALANCE', reason: 'Inputs must be an array.' };
  const totals = new Map<string, bigint>();
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index] as RuneInputObservation | null | undefined;
    if (!input || typeof input !== 'object' || input.indexed !== true) {
      return {
        code: 'RUNE_INPUT_UNPROVEN',
        reason: `Input ${index} has not been examined by the rune index, so its balances are unknown.`,
      };
    }
    if (!Array.isArray(input.balances)) {
      return { code: 'MALFORMED_RUNE_BALANCE', reason: `Input ${index} lists no exact rune balances.` };
    }
    const seen = new Set<string>();
    for (const balance of input.balances) {
      const id = parseRuneId(balance?.runeId);
      const amount = parseU128(balance?.amount);
      if (!id || amount === null) {
        return { code: 'MALFORMED_RUNE_BALANCE', reason: `Input ${index} carries a malformed rune balance.` };
      }
      const key = runeKey(id);
      if (seen.has(key)) {
        return { code: 'MALFORMED_RUNE_BALANCE', reason: `Input ${index} lists rune ${key} twice.` };
      }
      seen.add(key);
      const total = (totals.get(key) ?? 0n) + amount;
      if (total > U128_MAX) {
        return { code: 'MALFORMED_RUNE_BALANCE', reason: `Rune ${key} balances overflow a u128.` };
      }
      totals.set(key, total);
    }
  }
  return { totals };
}

/**
 * Allocate every input rune balance exactly as ord 0.29.0's rune updater does
 * (src/index/updater/rune_updater.rs, blob bce2ae16), given the complete output
 * scripts of the final transaction and what the rune index reports each input
 * carries.
 *
 * options.mint is the authoritative result of this transaction's mint, when
 * its runestone mints. A mint of a rune the inputs also carry changes where
 * that rune's balance goes, so without it such a transaction is refused as
 * RUNE_MINT_UNRESOLVED.
 *
 * An etching's new rune never appears in the inputs, so its premine and any
 * edict for rune 0:0 are outside the input allocation reported here.
 */
// OX-P04: allocation is the ord 0.29.0 updater, not a format check. Edicts take
// exact amounts in order, the output count splits across non-OP_RETURN outputs,
// leftovers go to the pointer or the first non-OP_RETURN output, and anything
// that lands on an OP_RETURN, has no destination, or sits under a cenotaph burns.
export function allocateRunes(
  outputScriptsHex: readonly string[],
  inputs: readonly RuneInputObservation[],
  options: { mint?: RuneMintResult } = {}
): RuneAllocationResult {
  const scripts: Uint8Array[] = [];
  for (const hex of Array.isArray(outputScriptsHex) ? outputScriptsHex : []) {
    const bytes = parseScriptHex(hex);
    if (!bytes) {
      return { ok: false, code: 'MALFORMED_OUTPUT_SCRIPT', reason: 'An output script is not lowercase hex.' };
    }
    scripts.push(bytes);
  }
  if (scripts.length === 0) {
    return { ok: false, code: 'MALFORMED_OUTPUT_SCRIPT', reason: 'A transaction has at least one output.' };
  }

  const balances = inputBalances(inputs);
  if (!('totals' in balances)) return { ok: false, ...balances };
  const unallocated = balances.totals;

  const runestone = decipherRunestone(outputScriptsHex, scripts.length);

  let mintUnresolved = false;
  const decodedMint = runestone.kind === 'NONE' ? undefined : runestone.mint;
  if (decodedMint) {
    const key = runeKey(decodedMint);
    const supplied = options?.mint;
    if (supplied !== undefined) {
      const id = parseRuneId(supplied?.runeId);
      const amount = parseU128(supplied?.amount);
      if (!id || amount === null || runeKey(id) !== key) {
        return {
          ok: false,
          code: 'RUNE_MINT_UNRESOLVED',
          reason: `The supplied mint result does not describe the mint of rune ${key} in this runestone.`,
        };
      }
      const total = (unallocated.get(key) ?? 0n) + amount;
      if (total > U128_MAX) {
        return { ok: false, code: 'MALFORMED_RUNE_BALANCE', reason: `Rune ${key} balances overflow a u128.` };
      }
      unallocated.set(key, total);
    } else if (unallocated.has(key)) {
      return {
        ok: false,
        code: 'RUNE_MINT_UNRESOLVED',
        reason: `This runestone mints rune ${key}, which the inputs also carry, and the mint result was not supplied.`,
      };
    } else {
      mintUnresolved = true;
    }
  }

  const allocated = scripts.map(() => new Map<string, bigint>());
  const credit = (output: number, key: string, amount: bigint): void => {
    const slot = allocated[output];
    if (amount > 0n && slot) {
      unallocated.set(key, (unallocated.get(key) ?? 0n) - amount);
      slot.set(key, (slot.get(key) ?? 0n) + amount);
    }
  };

  if (runestone.kind === 'RUNESTONE') {
    for (const edict of runestone.edicts) {
      // Rune 0:0 names this transaction's own etching, never an input rune.
      if (edict.id.block === 0n && edict.id.tx === 0n) continue;
      const key = runeKey(edict.id);
      if (!unallocated.has(key)) continue;

      if (edict.output === scripts.length) {
        const destinations: number[] = [];
        scripts.forEach((script, output) => {
          if (!isOpReturn(script)) destinations.push(output);
        });
        if (destinations.length === 0) continue;
        if (edict.amount === 0n) {
          const count = BigInt(destinations.length);
          const balance = unallocated.get(key) ?? 0n;
          const share = balance / count;
          const remainder = balance % count;
          destinations.forEach((output, position) => {
            credit(output, key, BigInt(position) < remainder ? share + 1n : share);
          });
        } else {
          for (const output of destinations) {
            const balance = unallocated.get(key) ?? 0n;
            credit(output, key, edict.amount < balance ? edict.amount : balance);
          }
        }
      } else {
        const balance = unallocated.get(key) ?? 0n;
        const amount = edict.amount === 0n || edict.amount > balance ? balance : edict.amount;
        credit(edict.output, key, amount);
      }
    }
  }

  const burned = new Map<string, bigint>();
  const burn = (key: string, cause: RuneBurnCause, amount: bigint): void => {
    if (amount <= 0n) return;
    const slot = `${key}|${cause}`;
    burned.set(slot, (burned.get(slot) ?? 0n) + amount);
  };

  if (runestone.kind === 'CENOTAPH') {
    for (const [key, balance] of unallocated) burn(key, 'CENOTAPH', balance);
  } else {
    let destination = runestone.kind === 'RUNESTONE' ? runestone.pointer : undefined;
    if (destination === undefined) {
      const first = scripts.findIndex((script) => !isOpReturn(script));
      if (first >= 0) destination = first;
    }
    for (const [key, balance] of unallocated) {
      if (balance <= 0n) continue;
      const slot = destination === undefined ? undefined : allocated[destination];
      if (!slot) burn(key, 'NO_DESTINATION', balance);
      else slot.set(key, (slot.get(key) ?? 0n) + balance);
    }
  }

  const allocations: RuneAllocation[] = [];
  allocated.forEach((entries, output) => {
    const keys = [...entries.keys()].sort(compareKeys);
    for (const key of keys) {
      const amount = entries.get(key) ?? 0n;
      if (isOpReturn(scripts[output])) burn(key, 'OP_RETURN_OUTPUT', amount);
      else allocations.push({ output, runeId: key, amount: amount.toString() });
    }
  });

  const burnedList: RuneBurn[] = [...burned.entries()]
    .map(([slot, amount]) => {
      const [runeId = '', cause = 'CENOTAPH'] = slot.split('|');
      return { runeId, cause: cause as RuneBurnCause, amount: amount.toString() };
    })
    .sort(
      (a, b) =>
        compareKeys(a.runeId, b.runeId) || (a.cause < b.cause ? -1 : a.cause > b.cause ? 1 : 0)
    );

  const result: RuneAllocationResult = {
    ok: true,
    runestone: runestone.kind,
    allocations,
    burned: burnedList,
  };
  if (runestone.kind === 'CENOTAPH') result.flaws = runestone.flaws;
  if (mintUnresolved) result.mintUnresolved = true;
  return result;
}

interface Observation {
  indexed: boolean;
  malformed?: boolean;
  bearing?: boolean;
  exact?: boolean;
  balances?: RuneBalance[];
}

/** Normalize one index observation for the burn check. */
function observation(input: RuneInputObservation | null | undefined): Observation {
  if (!input || typeof input !== 'object' || input.indexed !== true) return { indexed: false };
  if (Array.isArray(input.balances)) {
    const bearing = input.balances.length > 0;
    // A count that contradicts the listed balances is not an observation to
    // reason from.
    if (input.runes !== undefined && input.runes > 0 !== bearing) return { indexed: false, malformed: true };
    return { indexed: true, bearing, exact: true, balances: input.balances };
  }
  const bearing = typeof input.runes === 'number' && input.runes > 0;
  return { indexed: true, bearing, exact: !bearing, balances: [] };
}

/**
 * Whether a final transaction is safe to sign with respect to runes.
 *
 * A cenotaph burns every rune carried by every input. A readable runestone, or
 * no runestone at all, still burns whatever it allocates to an OP_RETURN output
 * and whatever is left with no non-OP_RETURN output to fall to. When the answer
 * depends on exact balances the index did not supply, or on an input the index
 * never examined, the transaction is refused rather than guessed about.
 */
// OX-P04: P-R08 showed a readable runestone with pointer 0 on its own OP_RETURN
// declared safe. Burn safety now follows the ord 0.29.0 allocation: any burn path
// (cenotaph, explicit OP_RETURN pointer or edict, no spendable destination) that
// can reach a rune balance refuses, and no path is assumed empty without proof.
export function verifyRuneBurnSafety(
  outputScriptsHex: readonly string[],
  inputs: readonly RuneInputObservation[],
  outputCount?: number
): RuneSafetyVerdict {
  const runestone = decipherRunestone(outputScriptsHex, outputCount);
  const observations = (Array.isArray(inputs) ? inputs : []).map(observation);
  const runeBearingInputs = observations.filter((i) => i.indexed && i.bearing).length;
  const unindexedInputs = observations.filter((i) => !i.indexed && !i.malformed).length;

  const base = { runestone: runestone.kind, runeBearingInputs, unindexedInputs };
  const refuse = (
    code: RuneRefusalCode,
    reason: string,
    extra: { flaws?: RunestoneFlaw[]; burned?: RuneBurn[] } = {}
  ): RuneSafetyVerdict => ({ ...base, safe: false, code, ...extra, reason });

  if (observations.some((i) => i.malformed)) {
    return refuse(
      'MALFORMED_RUNE_BALANCE',
      'An input reports a rune count that contradicts the balances it lists.'
    );
  }

  if (runestone.kind === 'CENOTAPH') {
    if (runeBearingInputs > 0) {
      return refuse(
        'CENOTAPH_BURNS_BALANCE',
        'This transaction carries a malformed runestone. Confirming it would destroy every rune balance it spends.',
        { flaws: runestone.flaws }
      );
    }
    if (unindexedInputs > 0) {
      return refuse(
        'CENOTAPH_WITH_UNPROVEN_INPUT',
        'This transaction carries a malformed runestone and spends an output the rune index has not examined, so it cannot be proven to hold no runes.',
        { flaws: runestone.flaws }
      );
    }
    return { ...base, safe: true };
  }

  if (runeBearingInputs === 0 && unindexedInputs === 0) return { ...base, safe: true };

  // A readable runestone was found among the scripts given. Where its balances
  // go depends on every output, so the whole output list must be present.
  if (outputCount !== undefined && outputCount !== outputScriptsHex.length) {
    return refuse(
      'RUNE_OUTPUTS_INCOMPLETE',
      'Rune allocation depends on every output script, and not every output was supplied.'
    );
  }
  const scripts = outputScriptsHex.map(parseScriptHex);
  const edicts = runestone.kind === 'RUNESTONE' ? runestone.edicts : [];
  let destination = runestone.kind === 'RUNESTONE' ? runestone.pointer : undefined;
  if (destination === undefined) {
    const first = scripts.findIndex((script) => !isOpReturn(script));
    if (first >= 0) destination = first;
  }
  const defaultBurns = destination === undefined || isOpReturn(scripts[destination]);
  const edictBurns = edicts.some(
    (edict) => edict.output < scripts.length && isOpReturn(scripts[edict.output])
  );

  if (!defaultBurns && !edictBurns) return { ...base, safe: true };

  if (unindexedInputs > 0) {
    return refuse(
      'BURN_PATH_WITH_UNPROVEN_INPUT',
      'This transaction can send rune balances to an OP_RETURN or to no output at all, and it spends an output the rune index has not examined.'
    );
  }

  if (observations.every((i) => i.exact)) {
    const allocation = allocateRunes(
      outputScriptsHex,
      observations.map((i) => ({ indexed: true, balances: i.balances ?? [] }))
    );
    if (!allocation.ok) return refuse(allocation.code, allocation.reason);
    if (allocation.burned.length > 0) {
      return refuse(
        'ALLOCATION_BURNS_BALANCE',
        'This transaction allocates rune balances to an OP_RETURN output or leaves them with no output to receive them. Confirming it would destroy them.',
        { burned: allocation.burned }
      );
    }
    return { ...base, safe: true };
  }

  if (defaultBurns && edicts.length === 0) {
    return refuse(
      'ALLOCATION_BURNS_BALANCE',
      'Every rune balance this transaction spends falls to an OP_RETURN output or to no output at all. Confirming it would destroy them.'
    );
  }
  return refuse(
    'RUNE_BALANCES_REQUIRED',
    'Whether this transaction burns runes depends on the exact balances each input carries, and the index reported only counts.'
  );
}

/**
 * Full rune asset safety for a final transaction: every input examined with
 * exact balances, nothing burned, and the resulting allocation equal to the
 * expected one, [{ output, runeId, amount }], as a complete multiset.
 *
 * This is the check a builder or preflight runs before a signature is asked
 * for. A readable runestone is necessary for it, never sufficient.
 */
// OX-P04: format validity is not asset safety. Signing needs the exact ord 0.29.0
// allocation of complete index observations to equal the planned destinations.
export function verifyRuneAllocation(
  outputScriptsHex: readonly string[],
  inputs: readonly RuneInputObservation[],
  expected: readonly RuneAllocation[],
  options: { mint?: RuneMintResult } = {}
): RuneAllocationVerdict {
  const allocation = allocateRunes(outputScriptsHex, inputs, options);
  if (!allocation.ok) return allocation;
  const refuse = (code: RuneAllocationRefusalCode, reason: string): RuneAllocationVerdict => ({
    ok: false,
    code,
    reason,
    safe: allocation.burned.length === 0 && !allocation.mintUnresolved,
    runestone: allocation.runestone,
    allocations: allocation.allocations,
    burned: allocation.burned,
  });

  if (allocation.burned.length > 0) {
    return refuse(
      allocation.runestone === 'CENOTAPH' ? 'CENOTAPH_BURNS_BALANCE' : 'ALLOCATION_BURNS_BALANCE',
      'Confirming this transaction would destroy rune balances its inputs carry.'
    );
  }
  if (allocation.mintUnresolved) {
    return refuse(
      'RUNE_MINT_UNRESOLVED',
      'This runestone mints a rune whose minted amount was not supplied, so the allocation is not exact.'
    );
  }

  if (!Array.isArray(expected)) {
    return refuse('MALFORMED_RUNE_EXPECTATION', 'The expected allocation must be an array.');
  }
  const wanted = new Map<string, bigint>();
  for (const entry of expected) {
    const id = parseRuneId(entry?.runeId);
    const amount = parseU128(entry?.amount);
    if (!id || amount === null || !Number.isSafeInteger(entry?.output) || entry.output < 0) {
      return refuse('MALFORMED_RUNE_EXPECTATION', 'An expected allocation entry is malformed.');
    }
    const slot = `${entry.output}|${runeKey(id)}`;
    wanted.set(slot, (wanted.get(slot) ?? 0n) + amount);
  }
  for (const [slot, amount] of wanted) if (amount === 0n) wanted.delete(slot);

  const actual = new Map<string, bigint>(
    allocation.allocations.map((a) => [`${a.output}|${a.runeId}`, BigInt(a.amount)])
  );
  const mismatch = [...new Set([...wanted.keys(), ...actual.keys()])].find(
    (slot) => (wanted.get(slot) ?? 0n) !== (actual.get(slot) ?? 0n)
  );
  if (mismatch) {
    const [output, runeId] = mismatch.split('|');
    return refuse(
      'RUNE_ALLOCATION_MISMATCH',
      `Output ${output} would receive ${(actual.get(mismatch) ?? 0n).toString()} of rune ${runeId}, not the ${(wanted.get(mismatch) ?? 0n).toString()} planned.`
    );
  }

  return { ok: true, safe: true, runestone: allocation.runestone, allocations: allocation.allocations, burned: [] };
}
