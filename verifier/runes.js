// Reference verifier for the rune burn rule, stated in spec/runes.md.
//
// A rune balance is assigned by the runestone: the first output whose script
// begins OP_RETURN OP_13. When that runestone cannot be read, the transaction
// is a cenotaph. A cenotaph is not a transaction that fails. It is perfectly
// valid to Bitcoin, it confirms normally, and it destroys every rune balance
// its inputs carried.
//
// No fee check, no mempool acceptance test, and no unspent-output check finds
// one, because nothing about the transaction is invalid. Only reading the
// runestone the way the protocol reads it does.
//
// This file restates that reading as executable checks. Parsing raw bytes and
// asking a rune index what an input carries are the caller's responsibility;
// the gateway does both before it runs these same checks.
//
// Every amount is a u128 handled as BigInt. Floating point never appears here.

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

/**
 * Tags the protocol recognizes. An unrecognized even tag is a cenotaph; an
 * unrecognized odd tag is ignorable, which is how the format stays extensible
 * without turning every future field into a burn for older readers.
 */
const RECOGNIZED_EVEN_TAGS = new Set([0n, 2n, 4n, 6n, 8n, 10n, 12n, 14n, 16n, 18n, 20n, 22n]);

/**
 * The only flag combinations the protocol consumes. Bit 0 is Etching, bit 1 is
 * Terms and bit 2 is Turbo, and the latter two are read only when Etching is
 * set, so every other value leaves a bit standing.
 */
const RECOGNIZED_FLAGS = new Set([0n, 1n, 3n, 5n, 7n]);

const U32_MAX = 0xffff_ffffn;
const U64_MAX = 0xffff_ffff_ffff_ffffn;

const HEX = /^(?:[0-9a-f]{2})*$/;

/** Parse a lowercase hex string into bytes. Returns null for anything else. */
export function parseScriptHex(value) {
  if (typeof value !== 'string' || !HEX.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Decode one base-128 varint as the protocol does, rejecting both overlong
 * encodings and values that do not fit a u128. A decoder that is merely
 * lenient here reads a payload the network reads as a cenotaph.
 */
function decodeVarint(bytes, start) {
  let result = 0n;
  for (let index = 0; start + index < bytes.length; index += 1) {
    if (index > 18) return null; // overlong
    const byte = bytes[start + index];
    // The nineteenth group carries only the two bits left inside a u128.
    if (index === 18 && (byte & 0b0111_1100) !== 0) return null; // overflow
    result |= BigInt(byte & 0b0111_1111) << BigInt(7 * index);
    if ((byte & 0b1000_0000) === 0) return { value: result, length: index + 1 };
  }
  return null; // unterminated
}

/**
 * The concatenated data pushes of the runestone output, or the flaw that makes
 * the transaction a cenotaph before any integer is read. Returns undefined when
 * no output carries the runestone prefix.
 *
 * The script is walked directly rather than through a general decompiler. A
 * decompiler is free to rewrite a push into its minimal opcode form, and that
 * rewrite is lossy exactly here: a one byte payload comes back as an opcode and
 * is read as a cenotaph it is not.
 */
function runestonePayload(scripts) {
  for (const script of scripts) {
    if (!script || script.length < 2) continue;
    if (script[0] !== OP_RETURN || script[1] !== RUNESTONE_MAGIC) continue;

    const parts = [];
    let cursor = 2;
    while (cursor < script.length) {
      const opcode = script[cursor];
      cursor += 1;
      let length;
      if (opcode <= OP_PUSHBYTES_MAX) {
        // Includes OP_0, which the protocol reads as an empty push.
        length = opcode;
      } else if (opcode === OP_PUSHDATA1) {
        if (cursor + 1 > script.length) return 'INVALID_SCRIPT';
        length = script[cursor];
        cursor += 1;
      } else if (opcode === OP_PUSHDATA2) {
        if (cursor + 2 > script.length) return 'INVALID_SCRIPT';
        length = script[cursor] | (script[cursor + 1] << 8);
        cursor += 2;
      } else if (opcode === OP_PUSHDATA4) {
        if (cursor + 4 > script.length) return 'INVALID_SCRIPT';
        length =
          script[cursor] +
          script[cursor + 1] * 0x100 +
          script[cursor + 2] * 0x10000 +
          script[cursor + 3] * 0x1000000;
        cursor += 4;
      } else {
        // Any true opcode after the magic number is a cenotaph.
        return 'OPCODE';
      }
      if (cursor + length > script.length) return 'INVALID_SCRIPT';
      for (let at = cursor; at < cursor + length; at += 1) parts.push(script[at]);
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
function nextRuneId(current, blockDelta, txDelta) {
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
 * outputCount is the transaction's real output count, including the runestone
 * itself, because an edict may address it to mean "split across every
 * non-OP_RETURN output". It defaults to the number of scripts given.
 *
 * Returns one of:
 *   { kind: 'NONE' }                       no output carries the prefix
 *   { kind: 'RUNESTONE', edicts, pointer } readable, inputs are allocated
 *   { kind: 'CENOTAPH', flaws }            malformed, inputs are destroyed
 */
export function decipherRunestone(outputScriptsHex, outputCount = outputScriptsHex.length) {
  const scripts = [];
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

  const integers = [];
  let cursor = 0;
  while (cursor < payload.length) {
    const decoded = decodeVarint(payload, cursor);
    // A payload that cannot be read as integers is a cenotaph outright.
    if (!decoded) return { kind: 'CENOTAPH', flaws: ['VARINT'] };
    integers.push(decoded.value);
    cursor += decoded.length;
  }

  const flaws = [];
  const fields = new Map();
  const edicts = [];
  for (let index = 0; index < integers.length; index += 2) {
    const tag = integers[index];
    if (tag === TAG_BODY) {
      let id = { block: 0n, tx: 0n };
      for (let at = index + 1; at < integers.length; at += 4) {
        if (at + 3 >= integers.length) {
          flaws.push('TRAILING_INTEGERS');
          break;
        }
        const next = nextRuneId(id, integers[at], integers[at + 1]);
        if (!next) {
          flaws.push('EDICT_RUNE_ID');
          break;
        }
        const output = integers[at + 3];
        if (output > BigInt(outputCount)) {
          flaws.push('EDICT_OUTPUT');
          break;
        }
        id = next;
        edicts.push({ id, amount: integers[at + 2], output: Number(output) });
      }
      break;
    }
    if (index + 1 >= integers.length) {
      flaws.push('TRUNCATED_FIELD');
      break;
    }
    const bucket = fields.get(tag);
    if (bucket) bucket.push(integers[index + 1]);
    else fields.set(tag, [integers[index + 1]]);
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
 * Two conditions block a purchase. A cenotaph burns every rune carried by every
 * input, so it is refused whenever any input carries one. An input the rune
 * index has not examined is refused alongside it, because "not looked at" is
 * not the same fact as "carries nothing", and treating it as such is how a
 * balance gets spent as change.
 *
 * A transaction with no runestone at all does not burn anything: unallocated
 * runes go to the first non-OP_RETURN output. It is safe here.
 *
 * inputs: [{ indexed, runes }] in transaction order, as the rune index reports
 * each output being spent. indexed is false when the index has not examined it.
 */
export function verifyRuneBurnSafety(outputScriptsHex, inputs, outputCount) {
  const runestone = decipherRunestone(outputScriptsHex, outputCount);
  const observations = Array.isArray(inputs) ? inputs : [];
  const runeBearingInputs = observations.filter((i) => i && i.indexed === true && i.runes > 0).length;
  const unindexedInputs = observations.filter((i) => !i || i.indexed !== true).length;

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
