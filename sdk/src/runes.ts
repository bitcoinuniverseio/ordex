/**
 * The rune burn rule from spec/runes.md, typed.
 *
 * This is the same verifier as verifier/runes.js at the repository root,
 * ported to TypeScript for SDK consumers. Both implementations are run
 * against conformance/rune-burn-vectors.json, so they cannot drift apart
 * without a test failing.
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

const TAG_BODY = 0n;
const TAG_FLAGS = 2n;
const TAG_POINTER = 22n;

const RECOGNIZED_EVEN_TAGS: ReadonlySet<bigint> = new Set([
  0n, 2n, 4n, 6n, 8n, 10n, 12n, 14n, 16n, 18n, 20n, 22n,
]);

/**
 * Bit 0 is Etching, bit 1 is Terms and bit 2 is Turbo, and the latter two are
 * read only when Etching is set, so every other value leaves a bit standing.
 */
const RECOGNIZED_FLAGS: ReadonlySet<bigint> = new Set([0n, 1n, 3n, 5n, 7n]);

const U32_MAX = 0xffff_ffffn;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

const HEX = /^(?:[0-9a-f]{2})*$/;

export type RunestoneFlaw =
  | 'INVALID_SCRIPT'
  | 'OPCODE'
  | 'VARINT'
  | 'TRUNCATED_FIELD'
  | 'UNRECOGNIZED_EVEN_TAG'
  | 'UNRECOGNIZED_FLAG'
  | 'EDICT_RUNE_ID'
  | 'EDICT_OUTPUT'
  | 'TRAILING_INTEGERS';

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

export type Runestone =
  | { kind: 'NONE' }
  | { kind: 'RUNESTONE'; edicts: RuneEdict[]; pointer?: number }
  | { kind: 'CENOTAPH'; flaws: RunestoneFlaw[] };

/** What the rune index reports about one output being spent. */
export interface RuneInputObservation {
  /** False when the index has not examined this output at all. */
  indexed: boolean;
  /** How many distinct rune balances the index reports at this output. */
  runes: number;
}

export type RuneRefusalCode = 'CENOTAPH_BURNS_BALANCE' | 'CENOTAPH_WITH_UNPROVEN_INPUT';

export interface RuneSafetyVerdict {
  /** False whenever signing this transaction could destroy a rune balance. */
  safe: boolean;
  runestone: Runestone['kind'];
  runeBearingInputs: number;
  unindexedInputs: number;
  code?: RuneRefusalCode;
  flaws?: RunestoneFlaw[];
  reason?: string;
}

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

/**
 * Decipher the runestone of a transaction from its output scripts, given as
 * lowercase hex strings in transaction order.
 *
 * `outputCount` is the transaction's real output count, including the runestone
 * itself, because an edict may address it to mean "split across every
 * non-OP_RETURN output". It defaults to the number of scripts given.
 */
export function decipherRunestone(
  outputScriptsHex: readonly string[],
  outputCount: number = outputScriptsHex.length
): Runestone {
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

  const flaws: RunestoneFlaw[] = [];
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
          flaws.push('TRAILING_INTEGERS');
          break;
        }
        const next = nextRuneId(id, blockDelta, txDelta);
        if (!next) {
          flaws.push('EDICT_RUNE_ID');
          break;
        }
        if (output > BigInt(outputCount)) {
          flaws.push('EDICT_OUTPUT');
          break;
        }
        id = next;
        edicts.push({ id, amount, output: Number(output) });
      }
      break;
    }
    if (index + 1 >= integers.length) {
      flaws.push('TRUNCATED_FIELD');
      break;
    }
    const value = integers[index + 1];
    if (value === undefined) {
      flaws.push('TRUNCATED_FIELD');
      break;
    }
    const bucket = fields.get(tag);
    if (bucket) bucket.push(value);
    else fields.set(tag, [value]);
  }

  const flags = fields.get(TAG_FLAGS)?.[0];
  if (flags !== undefined && !RECOGNIZED_FLAGS.has(flags)) flaws.push('UNRECOGNIZED_FLAG');

  // A pointer that does not address a real output fails to be consumed as a
  // pointer, which leaves tag 22 in the field map. Tag 22 is even, so the
  // leftover is what makes the transaction a cenotaph.
  const pointer = fields.get(TAG_POINTER)?.[0];
  const pointerAddressesOutput = pointer !== undefined && pointer < BigInt(outputCount);
  if (pointer !== undefined && !pointerAddressesOutput) flaws.push('UNRECOGNIZED_EVEN_TAG');

  for (const tag of fields.keys()) {
    if (tag % 2n === 0n && !RECOGNIZED_EVEN_TAGS.has(tag)) {
      flaws.push('UNRECOGNIZED_EVEN_TAG');
      break;
    }
  }

  if (flaws.length > 0) return { kind: 'CENOTAPH', flaws };

  return {
    kind: 'RUNESTONE',
    edicts,
    ...(pointerAddressesOutput ? { pointer: Number(pointer) } : {}),
  };
}

/**
 * Whether a final transaction is safe to sign with respect to runes.
 *
 * A cenotaph burns every rune carried by every input, so it is refused whenever
 * any input carries one. An input the rune index has not examined is refused
 * alongside it, because "not looked at" is not the same fact as "carries
 * nothing", and treating it as such is how a balance gets spent as change.
 *
 * A transaction with no runestone at all does not burn anything: unallocated
 * runes go to the first non-OP_RETURN output. It is safe here.
 */
export function verifyRuneBurnSafety(
  outputScriptsHex: readonly string[],
  inputs: readonly RuneInputObservation[],
  outputCount?: number
): RuneSafetyVerdict {
  const runestone = decipherRunestone(outputScriptsHex, outputCount);
  const observations = Array.isArray(inputs) ? inputs : [];
  const runeBearingInputs = observations.filter(
    (input) => input && input.indexed === true && input.runes > 0
  ).length;
  const unindexedInputs = observations.filter((input) => !input || input.indexed !== true).length;

  const base = { runestone: runestone.kind, runeBearingInputs, unindexedInputs };

  if (runestone.kind === 'CENOTAPH') {
    if (runeBearingInputs > 0) {
      return {
        ...base,
        safe: false,
        code: 'CENOTAPH_BURNS_BALANCE',
        flaws: runestone.flaws,
        reason:
          'This transaction carries a malformed runestone. Confirming it would destroy every rune balance it spends.',
      };
    }
    if (unindexedInputs > 0) {
      return {
        ...base,
        safe: false,
        code: 'CENOTAPH_WITH_UNPROVEN_INPUT',
        flaws: runestone.flaws,
        reason:
          'This transaction carries a malformed runestone and spends an output the rune index has not examined, so it cannot be proven to hold no runes.',
      };
    }
  }

  return { ...base, safe: true };
}
