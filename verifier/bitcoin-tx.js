// Bitcoin transaction bytes for the Ordex reference verifiers.
//
// Parses raw transactions (BIP144 witness serialization included) and PSBTs
// (BIP174 v0 and BIP370 v2, with the BIP371 Taproot fields), computes the
// legacy, BIP143 and BIP341 signature hashes, and verifies the signatures a
// transaction or PSBT actually carries against the prevouts it spends. The
// verifiers compare what these functions read from bytes, never a caller's
// description of those bytes.
//
// Values are BigInt satoshis rendered as decimal strings; nothing here uses
// floating point. Verification only: nothing here signs.

import { createHash } from 'node:crypto';

import { decodePublicKey, taggedHash, taprootTweak, verifyEcdsa, verifySchnorr } from './secp256k1.js';

const HEX = /^(?:[0-9a-f]{2})*$/;
const MAX_MONEY = 2_100_000_000_000_000n;

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || !HEX.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function bytesToHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export function sha256(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

export const hash256 = (...parts) => sha256(sha256(...parts));
export const hash160 = (data) => new Uint8Array(createHash('ripemd160').update(sha256(data)).digest());

const u32le = (n) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
};
const u64le = (n) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
};

function compactSize(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  if (n <= 0xffffffff) return concat(Uint8Array.of(0xfe), u32le(n));
  return concat(Uint8Array.of(0xff), u64le(n));
}

const varBytes = (bytes) => concat(compactSize(bytes.length), bytes);
const reversed = (bytes) => Uint8Array.from(bytes).reverse();

/** A cursor that refuses to read past the end or accept non-minimal sizes. */
class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.at = 0;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining() {
    return this.bytes.length - this.at;
  }
  take(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.remaining) throw new Error('read past end');
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u8() {
    return this.take(1)[0];
  }
  u32() {
    const value = this.view.getUint32(this.at, true);
    this.take(4);
    return value;
  }
  u64() {
    if (this.remaining < 8) throw new Error('read past end');
    const value = this.view.getBigUint64(this.at, true);
    this.take(8);
    return value;
  }
  compact() {
    const first = this.u8();
    let value;
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      value = this.take(2);
      value = value[0] | (value[1] << 8);
      if (value < 0xfd) throw new Error('non-minimal compact size');
    } else if (first === 0xfe) {
      value = this.u32();
      if (value <= 0xffff) throw new Error('non-minimal compact size');
    } else {
      const big = this.u64();
      if (big <= 0xffffffffn) throw new Error('non-minimal compact size');
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('size out of range');
      value = Number(big);
    }
    return value;
  }
  varBytes() {
    return this.take(this.compact());
  }
}

function readTransaction(reader, { allowWitness = true, requireInputs = true } = {}) {
  const version = reader.u32();
  let segwit = false;
  if (allowWitness && reader.remaining >= 2 && reader.bytes[reader.at] === 0x00) {
    if (reader.bytes[reader.at + 1] !== 0x01) throw new Error('unknown witness flag');
    reader.take(2);
    segwit = true;
  }
  const inputCount = reader.compact();
  if (inputCount === 0 && requireInputs) throw new Error('a transaction spends at least one input');
  const inputs = [];
  for (let i = 0; i < inputCount; i += 1) {
    const txid = bytesToHex(reversed(reader.take(32)));
    const vout = reader.u32();
    const scriptSig = reader.varBytes();
    const sequence = reader.u32();
    inputs.push({ txid, vout, scriptSigHex: bytesToHex(scriptSig), sequence, witness: [] });
  }
  const outputCount = reader.compact();
  const outputs = [];
  for (let i = 0; i < outputCount; i += 1) {
    const value = reader.u64();
    if (value > MAX_MONEY) throw new Error('output value above the money supply');
    outputs.push({ valueSats: value.toString(), scriptHex: bytesToHex(reader.varBytes()) });
  }
  if (segwit) {
    let anyWitness = false;
    for (const input of inputs) {
      const items = reader.compact();
      for (let j = 0; j < items; j += 1) input.witness.push(bytesToHex(reader.varBytes()));
      if (items > 0) anyWitness = true;
    }
    if (!anyWitness) throw new Error('superfluous witness record');
  }
  const lockTime = reader.u32();
  return { version, lockTime, inputs, outputs };
}

/**
 * Parse a raw transaction from lowercase hex. Returns
 * { ok: true, tx, txid, wtxid, hasWitness } or { ok: false, code, reason }.
 * tx: { version, lockTime, inputs [{ txid, vout, scriptSigHex, sequence,
 * witness [hex] }], outputs [{ valueSats, scriptHex }] }.
 */
export function parseTransaction(hex) {
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length === 0) return { ok: false, code: 'TX_MALFORMED', reason: 'Expected lowercase transaction hex.' };
  try {
    const reader = new Reader(bytes);
    const tx = readTransaction(reader);
    if (reader.remaining !== 0) throw new Error('trailing bytes');
    return { ok: true, tx, txid: transactionId(tx), wtxid: witnessTransactionId(tx), hasWitness: hasWitness(tx) };
  } catch (error) {
    return { ok: false, code: 'TX_MALFORMED', reason: `The transaction bytes do not parse: ${error.message}.` };
  }
}

const hasWitness = (tx) => tx.inputs.some((input) => input.witness.length > 0);

/** Serialize a transaction; with witness: false, the legacy txid form. */
export function serializeTransaction(tx, { witness = true } = {}) {
  const segwit = witness && hasWitness(tx);
  const parts = [u32le(tx.version)];
  if (segwit) parts.push(Uint8Array.of(0x00, 0x01));
  parts.push(compactSize(tx.inputs.length));
  for (const input of tx.inputs) {
    parts.push(reversed(hexToBytes(input.txid)), u32le(input.vout), varBytes(hexToBytes(input.scriptSigHex ?? '')), u32le(input.sequence));
  }
  parts.push(compactSize(tx.outputs.length));
  for (const output of tx.outputs) parts.push(u64le(BigInt(output.valueSats)), varBytes(hexToBytes(output.scriptHex)));
  if (segwit) {
    for (const input of tx.inputs) {
      parts.push(compactSize(input.witness.length));
      for (const item of input.witness) parts.push(varBytes(hexToBytes(item)));
    }
  }
  parts.push(u32le(tx.lockTime));
  return concat(...parts);
}

export const transactionId = (tx) => bytesToHex(reversed(hash256(serializeTransaction(tx, { witness: false }))));
export const witnessTransactionId = (tx) => bytesToHex(reversed(hash256(serializeTransaction(tx))));

/** The same transaction with every scriptSig and witness removed. */
export function unsignedCopy(tx) {
  return {
    version: tx.version,
    lockTime: tx.lockTime,
    inputs: tx.inputs.map((input) => ({ txid: input.txid, vout: input.vout, scriptSigHex: '', sequence: input.sequence, witness: [] })),
    outputs: tx.outputs.map((output) => ({ valueSats: output.valueSats, scriptHex: output.scriptHex })),
  };
}

// Sighash flags.
export const SIGHASH_DEFAULT = 0x00;
export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_ANYONECANPAY = 0x80;

const SIGHASH_NAMES = {
  0x00: 'DEFAULT',
  0x01: 'ALL',
  0x02: 'NONE',
  0x03: 'SINGLE',
  0x81: 'ALL|ANYONECANPAY',
  0x82: 'NONE|ANYONECANPAY',
  0x83: 'SINGLE|ANYONECANPAY',
};

/** The protocol name of a sighash byte, or null for one Taproot does not define. */
export const sighashName = (type) => SIGHASH_NAMES[type] ?? null;

function removeCodeSeparators(script) {
  // Legacy scriptCode: every OP_CODESEPARATOR opcode removed; push data is
  // copied as is, and a truncated final push is copied as far as it goes.
  const out = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i];
    let end = i + 1;
    if (op >= 0x01 && op <= 0x4b) end += op;
    else if (op === 0x4c) end += 1 + (script[i + 1] ?? 0);
    else if (op === 0x4d) end += 2 + ((script[i + 1] ?? 0) | ((script[i + 2] ?? 0) << 8));
    else if (op === 0x4e) {
      end += 4 + (script[i + 1] ?? 0) + (script[i + 2] ?? 0) * 0x100 + (script[i + 3] ?? 0) * 0x10000 + (script[i + 4] ?? 0) * 0x1000000;
    }
    if (op !== 0xab) for (let j = i; j < Math.min(end, script.length); j += 1) out.push(script[j]);
    i = end;
  }
  return Uint8Array.from(out);
}

/** The original (pre-segwit) signature hash of input `index`. */
export function legacySighash(tx, index, scriptCode, hashType) {
  const base = hashType & 0x1f;
  if (base === SIGHASH_SINGLE && index >= tx.outputs.length) {
    const one = new Uint8Array(32);
    one[0] = 1;
    return one;
  }
  const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  const code = removeCodeSeparators(scriptCode);
  const inputs = (anyoneCanPay ? [tx.inputs[index]] : tx.inputs).map((input) => {
    const own = input === tx.inputs[index];
    const sequence = !own && (base === SIGHASH_NONE || base === SIGHASH_SINGLE) ? 0 : input.sequence;
    return concat(reversed(hexToBytes(input.txid)), u32le(input.vout), varBytes(own ? code : new Uint8Array(0)), u32le(sequence));
  });
  let outputs;
  if (base === SIGHASH_NONE) outputs = [];
  else if (base === SIGHASH_SINGLE) {
    outputs = tx.outputs.slice(0, index + 1).map((output, i) =>
      i === index
        ? concat(u64le(BigInt(output.valueSats)), varBytes(hexToBytes(output.scriptHex)))
        : concat(u64le(0xffffffffffffffffn), compactSize(0))
    );
  } else {
    outputs = tx.outputs.map((output) => concat(u64le(BigInt(output.valueSats)), varBytes(hexToBytes(output.scriptHex))));
  }
  return hash256(
    u32le(tx.version),
    compactSize(inputs.length),
    ...inputs,
    compactSize(outputs.length),
    ...outputs,
    u32le(tx.lockTime),
    u32le(hashType)
  );
}

/** The BIP143 signature hash of segwit v0 input `index`. */
export function segwitV0Sighash(tx, index, scriptCode, valueSats, hashType) {
  const base = hashType & 0x1f;
  const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  const zero = new Uint8Array(32);
  const hashPrevouts = anyoneCanPay
    ? zero
    : hash256(...tx.inputs.map((input) => concat(reversed(hexToBytes(input.txid)), u32le(input.vout))));
  const hashSequence =
    anyoneCanPay || base === SIGHASH_SINGLE || base === SIGHASH_NONE
      ? zero
      : hash256(...tx.inputs.map((input) => u32le(input.sequence)));
  const serializeOutput = (output) => concat(u64le(BigInt(output.valueSats)), varBytes(hexToBytes(output.scriptHex)));
  let hashOutputs = zero;
  if (base !== SIGHASH_SINGLE && base !== SIGHASH_NONE) hashOutputs = hash256(...tx.outputs.map(serializeOutput));
  else if (base === SIGHASH_SINGLE && index < tx.outputs.length) hashOutputs = hash256(serializeOutput(tx.outputs[index]));
  const input = tx.inputs[index];
  return hash256(
    u32le(tx.version),
    hashPrevouts,
    hashSequence,
    reversed(hexToBytes(input.txid)),
    u32le(input.vout),
    varBytes(scriptCode),
    u64le(BigInt(valueSats)),
    u32le(input.sequence),
    hashOutputs,
    u32le(tx.lockTime),
    u32le(hashType)
  );
}

/**
 * The BIP341 signature hash of input `index`. prevouts lists { valueSats,
 * scriptHex } for every input. For a script path spend pass
 * { leafHash, codeSeparatorPosition }. annexHex is the annex without change.
 * Returns null for a hash type Taproot does not define or SINGLE without its
 * output.
 */
export function taprootSighash(tx, index, prevouts, hashType, { leafHash = null, annexHex = null, codeSeparatorPosition = 0xffffffff } = {}) {
  if (sighashName(hashType) === null) return null;
  const base = hashType & 0x03;
  const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  if (base === SIGHASH_SINGLE && index >= tx.outputs.length) return null;
  const parts = [Uint8Array.of(0x00), Uint8Array.of(hashType), u32le(tx.version), u32le(tx.lockTime)];
  if (!anyoneCanPay) {
    parts.push(
      sha256(...tx.inputs.map((input) => concat(reversed(hexToBytes(input.txid)), u32le(input.vout)))),
      sha256(...prevouts.map((p) => u64le(BigInt(p.valueSats)))),
      sha256(...prevouts.map((p) => varBytes(hexToBytes(p.scriptHex)))),
      sha256(...tx.inputs.map((input) => u32le(input.sequence)))
    );
  }
  const serializeOutput = (output) => concat(u64le(BigInt(output.valueSats)), varBytes(hexToBytes(output.scriptHex)));
  if (base !== SIGHASH_NONE && base !== SIGHASH_SINGLE) parts.push(sha256(...tx.outputs.map(serializeOutput)));
  const annex = annexHex === null ? null : hexToBytes(annexHex);
  parts.push(Uint8Array.of((leafHash ? 2 : 0) + (annex ? 1 : 0)));
  const input = tx.inputs[index];
  if (anyoneCanPay) {
    parts.push(
      reversed(hexToBytes(input.txid)),
      u32le(input.vout),
      u64le(BigInt(prevouts[index].valueSats)),
      varBytes(hexToBytes(prevouts[index].scriptHex)),
      u32le(input.sequence)
    );
  } else {
    parts.push(u32le(index));
  }
  if (annex) parts.push(sha256(varBytes(annex)));
  if (base === SIGHASH_SINGLE) parts.push(sha256(serializeOutput(tx.outputs[index])));
  if (leafHash) parts.push(leafHash, Uint8Array.of(0x00), u32le(codeSeparatorPosition));
  return taggedHash('TapSighash', ...parts);
}

/** BIP341 tapleaf hash of a leaf script. */
export function tapLeafHash(scriptHex, leafVersion = 0xc0) {
  return taggedHash('TapLeaf', Uint8Array.of(leafVersion), varBytes(hexToBytes(scriptHex)));
}

/** BIP341 branch hash of two child hashes, sorted. */
export function tapBranchHash(a, b) {
  const [left, right] = Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? [a, b] : [b, a];
  return taggedHash('TapBranch', left, right);
}

/**
 * Check that a control block commits a leaf script to a Taproot output key.
 * Returns { ok: true, internalKey, leafHash, merkleRoot } or { ok: false }.
 */
export function verifyTaprootCommitment(outputKeyHex, leafScriptHex, controlBlockHex) {
  const control = hexToBytes(controlBlockHex);
  const outputKey = hexToBytes(outputKeyHex);
  if (!control || !outputKey || outputKey.length !== 32) return { ok: false };
  if (control.length < 33 || control.length > 33 + 32 * 128 || (control.length - 33) % 32 !== 0) return { ok: false };
  const leafVersion = control[0] & 0xfe;
  const internalKey = control.subarray(1, 33);
  const leafHash = tapLeafHash(leafScriptHex, leafVersion);
  let node = leafHash;
  for (let at = 33; at < control.length; at += 32) node = tapBranchHash(node, control.subarray(at, at + 32));
  const tweaked = taprootTweak(internalKey, node);
  if (!tweaked || bytesToHex(tweaked.outputKey) !== outputKeyHex || tweaked.parity !== (control[0] & 1)) return { ok: false };
  return { ok: true, internalKey: bytesToHex(internalKey), leafHash, leafVersion, merkleRoot: node };
}

/** Parse script bytes into { op } and { push } instructions, or null. */
export function scriptInstructions(scriptHex) {
  const bytes = typeof scriptHex === 'string' ? hexToBytes(scriptHex) : scriptHex;
  if (!bytes) return null;
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
      length = new DataView(bytes.buffer, bytes.byteOffset + cursor, 4).getUint32(0, true);
      cursor += 4;
    } else {
      out.push({ op: opcode });
      continue;
    }
    if (cursor + length > bytes.length) return null;
    out.push({ op: opcode, push: bytes.slice(cursor, cursor + length) });
    cursor += length;
  }
  return out;
}

/** The script template of an output script. */
export function scriptType(scriptHex) {
  if (/^0014[0-9a-f]{40}$/.test(scriptHex)) return 'p2wpkh';
  if (/^0020[0-9a-f]{64}$/.test(scriptHex)) return 'p2wsh';
  if (/^5120[0-9a-f]{64}$/.test(scriptHex)) return 'p2tr';
  if (/^76a914[0-9a-f]{40}88ac$/.test(scriptHex)) return 'p2pkh';
  if (/^a914[0-9a-f]{40}87$/.test(scriptHex)) return 'p2sh';
  if (scriptHex.startsWith('6a')) return 'op_return';
  return 'other';
}

const p2pkhScriptCode = (program) => hexToBytes(`76a914${program}88ac`);

function ecdsaCheck(sigHex, pubkeyHex, digestFor) {
  const sig = hexToBytes(sigHex);
  const pubkey = hexToBytes(pubkeyHex);
  if (!sig || sig.length < 9 || !pubkey) return { valid: false };
  const hashType = sig[sig.length - 1];
  if (sighashName(hashType) === null || hashType === SIGHASH_DEFAULT) return { valid: false, hashType };
  const digest = digestFor(hashType);
  return { valid: verifyEcdsa(digest, sig.subarray(0, sig.length - 1), pubkey), hashType };
}

function schnorrCheck(sigBytes, keyX, digestFor) {
  if (sigBytes.length !== 64 && sigBytes.length !== 65) return { valid: false };
  const hashType = sigBytes.length === 65 ? sigBytes[64] : SIGHASH_DEFAULT;
  if (sigBytes.length === 65 && hashType === SIGHASH_DEFAULT) return { valid: false, hashType };
  const digest = digestFor(hashType);
  if (!digest) return { valid: false, hashType };
  return { valid: verifySchnorr(digest, sigBytes.subarray(0, 64), keyX), hashType };
}

/**
 * Verify the signature one input of a signed transaction carries against the
 * prevouts [{ valueSats, scriptHex }] of every input.
 *
 * Returns { index, type, status, sighashType?, publicKey?, reason? } where
 * status is UNSIGNED (no scriptSig and no witness), VALID, INVALID, or
 * UNSUPPORTED (a script template this verifier cannot execute; never a pass).
 * Taproot script path spends are VALID only for a committed leaf of the form
 * <x-only key> OP_CHECKSIG with a valid signature for that key.
 */
export function verifyInputSignature(tx, index, prevouts) {
  const input = tx.inputs[index];
  const prevout = prevouts[index];
  const type = scriptType(prevout.scriptHex);
  const result = (status, extra = {}) => ({ index, type, status, ...extra });
  if (input.scriptSigHex === '' && input.witness.length === 0) return result('UNSIGNED');

  if (type === 'p2wpkh' || type === 'p2sh') {
    let program;
    if (type === 'p2wpkh') {
      if (input.scriptSigHex !== '') return result('INVALID', { reason: 'A native segwit input carries a scriptSig.' });
      program = prevout.scriptHex.slice(4);
    } else {
      // Only P2SH-wrapped P2WPKH is verified here.
      const redeem = scriptInstructions(input.scriptSigHex);
      if (!redeem || redeem.length !== 1 || !redeem[0].push || !/^0014[0-9a-f]{40}$/.test(bytesToHex(redeem[0].push))) {
        return result('UNSUPPORTED', { reason: 'Only P2SH-wrapped P2WPKH is verified.' });
      }
      if (bytesToHex(hash160(redeem[0].push)) !== prevout.scriptHex.slice(4, 44)) {
        return result('INVALID', { reason: 'The redeem script does not hash to the P2SH output.' });
      }
      program = bytesToHex(redeem[0].push).slice(4);
    }
    if (input.witness.length !== 2) return result('INVALID', { reason: 'A P2WPKH witness is a signature and a key.' });
    const [sigHex, pubkeyHex] = input.witness;
    const pubkey = hexToBytes(pubkeyHex);
    if (!pubkey || pubkey.length !== 33 || !decodePublicKey(pubkey)) {
      return result('INVALID', { reason: 'A segwit key must be a valid compressed public key.' });
    }
    if (bytesToHex(hash160(pubkey)) !== program) return result('INVALID', { reason: 'The key does not hash to the witness program.' });
    const check = ecdsaCheck(sigHex, pubkeyHex, (hashType) =>
      segwitV0Sighash(tx, index, p2pkhScriptCode(program), prevout.valueSats, hashType)
    );
    return result(check.valid ? 'VALID' : 'INVALID', { sighashType: check.hashType, publicKey: pubkeyHex });
  }

  if (type === 'p2pkh') {
    if (input.witness.length !== 0) return result('INVALID', { reason: 'A legacy input carries a witness.' });
    const parts = scriptInstructions(input.scriptSigHex);
    if (!parts || parts.length !== 2 || !parts[0].push || !parts[1].push) {
      return result('INVALID', { reason: 'A P2PKH scriptSig is a signature push and a key push.' });
    }
    const pubkeyHex = bytesToHex(parts[1].push);
    if (!decodePublicKey(parts[1].push)) return result('INVALID', { reason: 'The public key is not a valid point.' });
    if (bytesToHex(hash160(parts[1].push)) !== prevout.scriptHex.slice(6, 46)) {
      return result('INVALID', { reason: 'The key does not hash to the output.' });
    }
    const check = ecdsaCheck(bytesToHex(parts[0].push), pubkeyHex, (hashType) =>
      legacySighash(tx, index, hexToBytes(prevout.scriptHex), hashType)
    );
    return result(check.valid ? 'VALID' : 'INVALID', { sighashType: check.hashType, publicKey: pubkeyHex });
  }

  if (type === 'p2tr') {
    if (input.scriptSigHex !== '') return result('INVALID', { reason: 'A Taproot input carries a scriptSig.' });
    let stack = input.witness.slice();
    let annexHex = null;
    if (stack.length >= 2 && stack[stack.length - 1].startsWith('50')) {
      annexHex = stack[stack.length - 1];
      stack = stack.slice(0, -1);
    }
    const outputKeyHex = prevout.scriptHex.slice(4);
    if (stack.length === 1) {
      const check = schnorrCheck(hexToBytes(stack[0]), hexToBytes(outputKeyHex), (hashType) =>
        taprootSighash(tx, index, prevouts, hashType, { annexHex })
      );
      return result(check.valid ? 'VALID' : 'INVALID', { sighashType: check.hashType, publicKey: outputKeyHex, path: 'key' });
    }
    if (stack.length < 2) return result('INVALID', { reason: 'An empty Taproot witness.' });
    const controlHex = stack[stack.length - 1];
    const leafHex = stack[stack.length - 2];
    const commitment = verifyTaprootCommitment(outputKeyHex, leafHex, controlHex);
    if (!commitment.ok) return result('INVALID', { reason: 'The control block does not commit the leaf to this output.', path: 'script' });
    const leaf = scriptInstructions(leafHex);
    const singleKey =
      commitment.leafVersion === 0xc0 && leaf && leaf.length === 2 && leaf[0].push?.length === 32 && leaf[1].op === 0xac;
    if (!singleKey || stack.length !== 3) {
      return result('UNSUPPORTED', { reason: 'Only a single-key leaf is executed here.', path: 'script', leafHash: bytesToHex(commitment.leafHash) });
    }
    const check = schnorrCheck(hexToBytes(stack[0]), leaf[0].push, (hashType) =>
      taprootSighash(tx, index, prevouts, hashType, { annexHex, leafHash: commitment.leafHash })
    );
    return result(check.valid ? 'VALID' : 'INVALID', {
      sighashType: check.hashType,
      publicKey: bytesToHex(leaf[0].push),
      path: 'script',
      leafHash: bytesToHex(commitment.leafHash),
    });
  }

  return result('UNSUPPORTED', { reason: `A ${type} input is not verified here.` });
}

// ---------------------------------------------------------------------------
// PSBT (BIP174 v0, BIP370 v2, BIP371 Taproot fields)

const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff];

// Key types every map may carry, with the key-data length a valid key has
// (null for variable), and the PSBT versions it is allowed in.
const GLOBAL_KEYS = {
  0x00: { name: 'unsignedTx', keyData: 0, versions: [0] },
  0x01: { name: 'xpub', keyData: 78, versions: [0, 2] },
  0x02: { name: 'txVersion', keyData: 0, versions: [2] },
  0x03: { name: 'fallbackLocktime', keyData: 0, versions: [2] },
  0x04: { name: 'inputCount', keyData: 0, versions: [2] },
  0x05: { name: 'outputCount', keyData: 0, versions: [2] },
  0x06: { name: 'txModifiable', keyData: 0, versions: [2] },
  0xfb: { name: 'version', keyData: 0, versions: [0, 2] },
  0xfc: { name: 'proprietary', keyData: null, versions: [0, 2] },
};
const INPUT_KEYS = {
  0x00: { name: 'nonWitnessUtxo', keyData: 0, versions: [0, 2] },
  0x01: { name: 'witnessUtxo', keyData: 0, versions: [0, 2] },
  0x02: { name: 'partialSig', keyData: null, versions: [0, 2] },
  0x03: { name: 'sighashType', keyData: 0, versions: [0, 2] },
  0x04: { name: 'redeemScript', keyData: 0, versions: [0, 2] },
  0x05: { name: 'witnessScript', keyData: 0, versions: [0, 2] },
  0x06: { name: 'bip32Derivation', keyData: null, versions: [0, 2] },
  0x07: { name: 'finalScriptSig', keyData: 0, versions: [0, 2] },
  0x08: { name: 'finalScriptWitness', keyData: 0, versions: [0, 2] },
  0x09: { name: 'porCommitment', keyData: 0, versions: [0, 2] },
  0x0a: { name: 'ripemd160', keyData: 20, versions: [0, 2] },
  0x0b: { name: 'sha256', keyData: 32, versions: [0, 2] },
  0x0c: { name: 'hash160', keyData: 20, versions: [0, 2] },
  0x0d: { name: 'hash256', keyData: 32, versions: [0, 2] },
  0x0e: { name: 'previousTxid', keyData: 0, versions: [2] },
  0x0f: { name: 'outputIndex', keyData: 0, versions: [2] },
  0x10: { name: 'sequence', keyData: 0, versions: [2] },
  0x11: { name: 'requiredTimeLocktime', keyData: 0, versions: [2] },
  0x12: { name: 'requiredHeightLocktime', keyData: 0, versions: [2] },
  0x13: { name: 'tapKeySig', keyData: 0, versions: [0, 2] },
  0x14: { name: 'tapScriptSig', keyData: 64, versions: [0, 2] },
  0x15: { name: 'tapLeafScript', keyData: null, versions: [0, 2] },
  0x16: { name: 'tapBip32Derivation', keyData: 32, versions: [0, 2] },
  0x17: { name: 'tapInternalKey', keyData: 0, versions: [0, 2] },
  0x18: { name: 'tapMerkleRoot', keyData: 0, versions: [0, 2] },
  0xfc: { name: 'proprietary', keyData: null, versions: [0, 2] },
};
const OUTPUT_KEYS = {
  0x00: { name: 'redeemScript', keyData: 0, versions: [0, 2] },
  0x01: { name: 'witnessScript', keyData: 0, versions: [0, 2] },
  0x02: { name: 'bip32Derivation', keyData: null, versions: [0, 2] },
  0x03: { name: 'amount', keyData: 0, versions: [2] },
  0x04: { name: 'script', keyData: 0, versions: [2] },
  0x05: { name: 'tapInternalKey', keyData: 0, versions: [0, 2] },
  0x06: { name: 'tapTree', keyData: 0, versions: [0, 2] },
  0x07: { name: 'tapBip32Derivation', keyData: 32, versions: [0, 2] },
  0xfc: { name: 'proprietary', keyData: null, versions: [0, 2] },
};

function readMap(reader) {
  const entries = [];
  const seen = new Set();
  for (;;) {
    const keyLength = reader.compact();
    if (keyLength === 0) return entries;
    const key = reader.take(keyLength);
    const value = reader.varBytes();
    const keyHex = bytesToHex(key);
    if (seen.has(keyHex)) throw new Error(`duplicate key ${keyHex}`);
    seen.add(keyHex);
    const keyReader = new Reader(key);
    const type = keyReader.compact();
    entries.push({ type, keyData: key.subarray(keyReader.at), value, keyHex, valueHex: bytesToHex(value) });
  }
}

function decodeMap(entries, table, version, where) {
  const fields = { unknown: [] };
  for (const entry of entries) {
    const spec = table[entry.type];
    if (!spec) {
      fields.unknown.push({ keyHex: entry.keyHex, valueHex: entry.valueHex });
      continue;
    }
    if (!spec.versions.includes(version)) throw new Error(`${where} field ${spec.name} is not allowed in PSBT v${version}`);
    if (spec.keyData !== null && entry.keyData.length !== spec.keyData) throw new Error(`${where} field ${spec.name} has a malformed key`);
    if ((spec.name === 'partialSig' || spec.name === 'bip32Derivation') && !decodePublicKey(entry.keyData)) {
      throw new Error(`${where} ${spec.name} key is not a valid public key`);
    }
    if (spec.name === 'bip32Derivation' && (entry.value.length < 4 || entry.value.length % 4 !== 0)) {
      throw new Error(`${where} derivation path is malformed`);
    }
    if (spec.name === 'tapScriptSig' && entry.value.length !== 64 && entry.value.length !== 65) {
      throw new Error(`${where} Taproot script signature has a bad length`);
    }
    if (spec.name === 'tapLeafScript' && (entry.keyData.length < 33 || entry.keyData.length > 33 + 32 * 128 || (entry.keyData.length - 33) % 32 !== 0 || entry.value.length < 1)) {
      throw new Error(`${where} Taproot leaf script has a malformed control block`);
    }
    if (spec.name === 'tapInternalKey' && entry.value.length !== 32) {
      throw new Error(`${where} Taproot internal key is not 32 bytes`);
    }
    const value = { keyData: bytesToHex(entry.keyData), value: entry.valueHex };
    if (spec.keyData === 0) fields[spec.name] = entry.valueHex;
    else (fields[spec.name] ??= []).push(value);
  }
  return fields;
}

function readU32Value(hex, name) {
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length !== 4) throw new Error(`${name} must be four bytes`);
  return new DataView(bytes.buffer).getUint32(0, true);
}

function readWitnessStack(hex) {
  const reader = new Reader(hexToBytes(hex));
  const count = reader.compact();
  const items = [];
  for (let i = 0; i < count; i += 1) items.push(bytesToHex(reader.varBytes()));
  if (reader.remaining !== 0) throw new Error('trailing bytes in a final witness');
  return items;
}

function readTxOut(hex) {
  const reader = new Reader(hexToBytes(hex));
  const value = reader.u64();
  if (value > MAX_MONEY) throw new Error('witness UTXO value above the money supply');
  const script = reader.varBytes();
  if (reader.remaining !== 0) throw new Error('trailing bytes in a witness UTXO');
  return { valueSats: value.toString(), scriptHex: bytesToHex(script) };
}

/**
 * Parse a PSBT given as base64 or lowercase hex. Returns { ok: true, psbt } or
 * { ok: false, code: 'PSBT_MALFORMED', reason }.
 *
 * psbt: { version, tx (the unsigned transaction it describes), global,
 *   inputs [{ ...fields, prevout?, finalWitness? }], outputs [...] }.
 * Every key must be unique within its map, version-specific fields must match
 * the PSBT version, v2 locktime follows BIP370's determination, and a
 * non-witness UTXO must hash to the txid it claims to spend.
 */
export function parsePsbt(encoded) {
  let bytes = null;
  if (typeof encoded === 'string' && encoded.startsWith('70736274ff')) bytes = hexToBytes(encoded);
  else if (typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  if (!bytes || bytes.length < 5 || PSBT_MAGIC.some((b, i) => bytes[i] !== b)) {
    return { ok: false, code: 'PSBT_MALFORMED', reason: 'The data does not start with the PSBT magic bytes.' };
  }
  try {
    const reader = new Reader(bytes);
    reader.take(5);
    const globalEntries = readMap(reader);
    const versionEntry = globalEntries.find((e) => e.type === 0xfb && e.keyData.length === 0);
    const version = versionEntry ? readU32Value(versionEntry.valueHex, 'PSBT version') : 0;
    if (version !== 0 && version !== 2) throw new Error(`PSBT version ${version} is not supported`);
    const global = decodeMap(globalEntries, GLOBAL_KEYS, version, 'global');

    let tx;
    let inputCount;
    let outputCount;
    if (version === 0) {
      if (!global.unsignedTx) throw new Error('a v0 PSBT carries the unsigned transaction');
      const txReader = new Reader(hexToBytes(global.unsignedTx));
      tx = readTransaction(txReader, { allowWitness: false, requireInputs: false });
      if (txReader.remaining !== 0) throw new Error('trailing bytes in the unsigned transaction');
      if (tx.inputs.some((input) => input.scriptSigHex !== '')) throw new Error('the unsigned transaction carries a scriptSig');
      inputCount = tx.inputs.length;
      outputCount = tx.outputs.length;
    } else {
      if (global.txVersion === undefined || global.inputCount === undefined || global.outputCount === undefined) {
        throw new Error('a v2 PSBT carries the transaction version and both counts');
      }
      inputCount = new Reader(hexToBytes(global.inputCount)).compact();
      outputCount = new Reader(hexToBytes(global.outputCount)).compact();
    }

    const inputs = [];
    for (let i = 0; i < inputCount; i += 1) inputs.push(decodeMap(readMap(reader), INPUT_KEYS, version, `input ${i}`));
    const outputs = [];
    for (let i = 0; i < outputCount; i += 1) outputs.push(decodeMap(readMap(reader), OUTPUT_KEYS, version, `output ${i}`));
    if (reader.remaining !== 0) throw new Error('trailing bytes after the last output map');

    if (version === 2) {
      const txVersion = readU32Value(global.txVersion, 'transaction version');
      if (txVersion < 2) throw new Error('a v2 PSBT describes a transaction of version 2 or more');
      tx = { version: txVersion, lockTime: 0, inputs: [], outputs: [] };
      let maxTime = null;
      let maxHeight = null;
      let anyTime = false;
      let anyHeight = false;
      for (let i = 0; i < inputs.length; i += 1) {
        const input = inputs[i];
        if (input.previousTxid === undefined || input.outputIndex === undefined) throw new Error(`input ${i} names no previous output`);
        const txidBytes = hexToBytes(input.previousTxid);
        if (txidBytes.length !== 32) throw new Error(`input ${i} previous txid is not 32 bytes`);
        const time = input.requiredTimeLocktime !== undefined ? readU32Value(input.requiredTimeLocktime, 'time locktime') : null;
        const height = input.requiredHeightLocktime !== undefined ? readU32Value(input.requiredHeightLocktime, 'height locktime') : null;
        if (time !== null && time < 500000000) throw new Error(`input ${i} time locktime is below 500000000`);
        if (height !== null && (height < 1 || height >= 500000000)) throw new Error(`input ${i} height locktime is out of range`);
        if (time !== null) {
          anyTime = true;
          maxTime = Math.max(maxTime ?? 0, time);
        }
        if (height !== null) {
          anyHeight = true;
          maxHeight = Math.max(maxHeight ?? 0, height);
        }
        tx.inputs.push({
          txid: bytesToHex(reversed(txidBytes)),
          vout: readU32Value(input.outputIndex, 'output index'),
          scriptSigHex: '',
          sequence: input.sequence !== undefined ? readU32Value(input.sequence, 'sequence') : 0xffffffff,
          witness: [],
        });
        input.onlyTime = time !== null && height === null;
        input.onlyHeight = height !== null && time === null;
      }
      // BIP370: height wins when every input with a lock accepts it; an input
      // that only accepts time forces time; one forcing each is invalid.
      const forcesTime = inputs.some((input) => input.onlyTime);
      const forcesHeight = inputs.some((input) => input.onlyHeight);
      // A PSBT whose inputs force both kinds stays valid, but its locktime
      // cannot be computed, so it can never be extracted or signed against.
      if (forcesTime && forcesHeight) tx.lockTime = null;
      else if (anyHeight && !forcesTime) tx.lockTime = maxHeight;
      else if (anyTime) tx.lockTime = maxTime;
      else tx.lockTime = global.fallbackLocktime !== undefined ? readU32Value(global.fallbackLocktime, 'fallback locktime') : 0;
      for (const input of inputs) {
        delete input.onlyTime;
        delete input.onlyHeight;
      }
      for (let i = 0; i < outputs.length; i += 1) {
        const output = outputs[i];
        if (output.amount === undefined || output.script === undefined) throw new Error(`output ${i} lacks its amount or script`);
        const amount = hexToBytes(output.amount);
        if (amount.length !== 8) throw new Error(`output ${i} amount is not eight bytes`);
        const value = new DataView(amount.buffer).getBigUint64(0, true);
        if (value > MAX_MONEY) throw new Error(`output ${i} amount above the money supply`);
        tx.outputs.push({ valueSats: value.toString(), scriptHex: output.script });
      }
    }

    // Prevout data: a non-witness UTXO must be the transaction the input spends.
    for (let i = 0; i < inputs.length; i += 1) {
      const input = inputs[i];
      let fromNonWitness = null;
      if (input.nonWitnessUtxo !== undefined) {
        const parsed = parseTransaction(input.nonWitnessUtxo);
        if (!parsed.ok) throw new Error(`input ${i} non-witness UTXO does not parse`);
        if (parsed.txid !== tx.inputs[i].txid) throw new Error(`input ${i} non-witness UTXO is not the transaction it spends`);
        fromNonWitness = parsed.tx.outputs[tx.inputs[i].vout];
        if (!fromNonWitness) throw new Error(`input ${i} spends an output its UTXO does not have`);
      }
      if (input.witnessUtxo !== undefined) {
        const witnessUtxo = readTxOut(input.witnessUtxo);
        if (fromNonWitness && (fromNonWitness.valueSats !== witnessUtxo.valueSats || fromNonWitness.scriptHex !== witnessUtxo.scriptHex)) {
          throw new Error(`input ${i} witness and non-witness UTXOs disagree`);
        }
        input.prevout = witnessUtxo;
      } else if (fromNonWitness) {
        input.prevout = { valueSats: fromNonWitness.valueSats, scriptHex: fromNonWitness.scriptHex };
      }
      if (input.sighashType !== undefined) input.sighashType = readU32Value(input.sighashType, 'sighash type');
      if (input.finalScriptWitness !== undefined) input.finalWitness = readWitnessStack(input.finalScriptWitness);
      if (input.tapKeySig !== undefined && ![128, 130].includes(input.tapKeySig.length)) throw new Error(`input ${i} Taproot key signature has a bad length`);
    }
    return { ok: true, psbt: { version, tx, global, inputs, outputs } };
  } catch (error) {
    return { ok: false, code: 'PSBT_MALFORMED', reason: `The PSBT does not parse: ${error.message}.` };
  }
}

/**
 * The transaction a finalized PSBT extracts to: the unsigned transaction with
 * each input's final scriptSig and final witness. Inputs that are not final
 * stay unsigned. Null when BIP370 cannot determine the locktime.
 */
export function extractPsbtTransaction(psbt) {
  if (psbt.tx.lockTime === null) return null;
  const tx = {
    version: psbt.tx.version,
    lockTime: psbt.tx.lockTime,
    inputs: psbt.tx.inputs.map((input, i) => ({
      ...input,
      scriptSigHex: psbt.inputs[i].finalScriptSig ?? '',
      witness: psbt.inputs[i].finalWitness ?? [],
    })),
    outputs: psbt.tx.outputs.map((output) => ({ ...output })),
  };
  return tx;
}

/**
 * Verify every partial signature a PSBT input carries (ECDSA partial_sig,
 * Taproot key and script signatures) against the sighash of the unsigned
 * transaction. Returns [{ kind, publicKey, sighashType, valid }].
 */
export function verifyPsbtPartialSignatures(psbt, index) {
  const input = psbt.inputs[index];
  const prevouts = psbt.inputs.map((i) => i.prevout);
  const out = [];
  // Without a prevout, or a locktime BIP370 could determine, there is no sighash.
  if (!input.prevout || psbt.tx.lockTime === null) return out;
  const tx = psbt.tx;
  const type = scriptType(input.prevout.scriptHex);
  for (const entry of input.partialSig ?? []) {
    let digestFor = null;
    let program = null;
    if (type === 'p2wpkh') {
      program = input.prevout.scriptHex.slice(4);
      digestFor = (h) => segwitV0Sighash(tx, index, p2pkhScriptCode(program), input.prevout.valueSats, h);
    } else if (
      type === 'p2sh' &&
      input.redeemScript &&
      /^0014[0-9a-f]{40}$/.test(input.redeemScript) &&
      bytesToHex(hash160(hexToBytes(input.redeemScript))) === input.prevout.scriptHex.slice(4, 44)
    ) {
      program = input.redeemScript.slice(4);
      digestFor = (h) => segwitV0Sighash(tx, index, p2pkhScriptCode(program), input.prevout.valueSats, h);
    } else if (type === 'p2pkh') {
      program = input.prevout.scriptHex.slice(6, 46);
      digestFor = (h) => legacySighash(tx, index, hexToBytes(input.prevout.scriptHex), h);
    }
    if (!digestFor) {
      out.push({ kind: 'ecdsa', publicKey: entry.keyData, valid: false, unsupported: true });
      continue;
    }
    // A signature only counts for the key the script commits to.
    if (bytesToHex(hash160(hexToBytes(entry.keyData))) !== program) {
      out.push({ kind: 'ecdsa', publicKey: entry.keyData, valid: false, reason: 'The key does not match the script.' });
      continue;
    }
    const check = ecdsaCheck(entry.value, entry.keyData, digestFor);
    out.push({ kind: 'ecdsa', publicKey: entry.keyData, sighashType: check.hashType, valid: check.valid });
  }
  if (input.tapKeySig !== undefined && type === 'p2tr' && prevouts.every(Boolean)) {
    const key = input.prevout.scriptHex.slice(4);
    const check = schnorrCheck(hexToBytes(input.tapKeySig), hexToBytes(key), (h) => taprootSighash(tx, index, prevouts, h));
    out.push({ kind: 'taproot-key', publicKey: key, sighashType: check.hashType, valid: check.valid });
  }
  for (const entry of input.tapScriptSig ?? []) {
    if (type !== 'p2tr' || !prevouts.every(Boolean)) continue;
    const key = entry.keyData.slice(0, 64);
    const leafHash = hexToBytes(entry.keyData.slice(64));
    const check = schnorrCheck(hexToBytes(entry.value), hexToBytes(key), (h) => taprootSighash(tx, index, prevouts, h, { leafHash }));
    out.push({ kind: 'taproot-script', publicKey: key, leafHash: entry.keyData.slice(64), sighashType: check.hashType, valid: check.valid });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Relay policy (Bitcoin Core v29.0 src/policy/policy.cpp, blob ed336928)

/** Default -dustrelayfee, satoshis per 1000 virtual bytes. */
export const DUST_RELAY_FEE_SATS_PER_KVB = 3000n;
/** Default -datacarriersize: the largest OP_RETURN scriptPubKey relayed. */
export const MAX_OP_RETURN_RELAY_BYTES = 83;

function isWitnessProgram(script) {
  if (script.length < 4 || script.length > 42) return false;
  if (script[0] !== 0x00 && (script[0] < 0x51 || script[0] > 0x60)) return false;
  return script[1] + 2 === script.length;
}

/**
 * Bitcoin Core's GetDustThreshold at the default dust relay fee: the smallest
 * value an output with this script may carry and still relay. An unspendable
 * script (OP_RETURN, or longer than 10000 bytes) has a threshold of 0.
 */
export function dustThresholdSats(scriptHex) {
  const script = hexToBytes(scriptHex);
  if (!script) return null;
  if ((script.length > 0 && script[0] === 0x6a) || script.length > 10000) return 0n;
  let size = 8 + compactSize(script.length).length + script.length;
  size += isWitnessProgram(script) ? 32 + 4 + 1 + Math.floor(107 / 4) + 4 : 32 + 4 + 1 + 107 + 4;
  return (BigInt(size) * DUST_RELAY_FEE_SATS_PER_KVB) / 1000n;
}
