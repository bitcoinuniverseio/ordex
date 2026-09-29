/**
 * Bitcoin transaction bytes, typed.
 *
 * The same code as verifier/bitcoin-tx.js at the repository root: raw
 * transactions (BIP144 witness serialization), PSBTs (BIP174 v0, BIP370 v2,
 * BIP371 Taproot fields), the legacy, BIP143 and BIP341 signature hashes, and
 * verification of the signatures a transaction or PSBT carries. Values are
 * BigInt satoshis rendered as decimal strings. Verification only.
 */

import { createHash } from 'node:crypto';

import { decodePublicKey, taggedHash, taprootTweak, verifyEcdsa, verifySchnorr } from './secp256k1.js';

const HEX = /^(?:[0-9a-f]{2})*$/;
const MAX_MONEY = 2_100_000_000_000_000n;

export interface TxInput {
  txid: string;
  vout: number;
  scriptSigHex: string;
  sequence: number;
  witness: string[];
}

export interface TxOutput {
  valueSats: string;
  scriptHex: string;
}

export interface Transaction {
  version: number;
  lockTime: number;
  inputs: TxInput[];
  outputs: TxOutput[];
}

export interface Prevout {
  valueSats: string;
  scriptHex: string;
}

export type ParsedTransaction =
  | { ok: true; tx: Transaction; txid: string; wtxid: string; hasWitness: boolean }
  | { ok: false; code: 'TX_MALFORMED'; reason: string };

export function hexToBytes(hex: unknown): Uint8Array | null {
  if (typeof hex !== 'string' || !HEX.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** hexToBytes for values already validated as hex. */
const bytesOf = (hex: string): Uint8Array => hexToBytes(hex) ?? new Uint8Array(0);

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

export const hash256 = (...parts: Uint8Array[]): Uint8Array => sha256(sha256(...parts));
export const hash160 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('ripemd160').update(sha256(data)).digest());

const u32le = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
};
const u64le = (n: bigint | number): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
};

function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  if (n <= 0xffffffff) return concat(Uint8Array.of(0xfe), u32le(n));
  return concat(Uint8Array.of(0xff), u64le(n));
}

const varBytes = (bytes: Uint8Array): Uint8Array => concat(compactSize(bytes.length), bytes);
const reversed = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes).reverse();

/** A cursor that refuses to read past the end or accept non-minimal sizes. */
class Reader {
  bytes: Uint8Array;
  at: number;
  view: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.at = 0;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining(): number {
    return this.bytes.length - this.at;
  }
  take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.remaining) throw new Error('read past end');
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0] ?? 0;
  }
  u32(): number {
    if (this.remaining < 4) throw new Error('read past end');
    const value = this.view.getUint32(this.at, true);
    this.take(4);
    return value;
  }
  u64(): bigint {
    if (this.remaining < 8) throw new Error('read past end');
    const value = this.view.getBigUint64(this.at, true);
    this.take(8);
    return value;
  }
  compact(): number {
    const first = this.u8();
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const two = this.take(2);
      const value = (two[0] ?? 0) | ((two[1] ?? 0) << 8);
      if (value < 0xfd) throw new Error('non-minimal compact size');
      return value;
    }
    if (first === 0xfe) {
      const value = this.u32();
      if (value <= 0xffff) throw new Error('non-minimal compact size');
      return value;
    }
    const big = this.u64();
    if (big <= 0xffffffffn) throw new Error('non-minimal compact size');
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('size out of range');
    return Number(big);
  }
  varBytes(): Uint8Array {
    return this.take(this.compact());
  }
}

function readTransaction(
  reader: Reader,
  { allowWitness = true, requireInputs = true }: { allowWitness?: boolean; requireInputs?: boolean } = {}
): Transaction {
  const version = reader.u32();
  let segwit = false;
  if (allowWitness && reader.remaining >= 2 && reader.bytes[reader.at] === 0x00) {
    if (reader.bytes[reader.at + 1] !== 0x01) throw new Error('unknown witness flag');
    reader.take(2);
    segwit = true;
  }
  const inputCount = reader.compact();
  if (inputCount === 0 && requireInputs) throw new Error('a transaction spends at least one input');
  const inputs: TxInput[] = [];
  for (let i = 0; i < inputCount; i += 1) {
    const txid = bytesToHex(reversed(reader.take(32)));
    const vout = reader.u32();
    const scriptSig = reader.varBytes();
    const sequence = reader.u32();
    inputs.push({ txid, vout, scriptSigHex: bytesToHex(scriptSig), sequence, witness: [] });
  }
  const outputCount = reader.compact();
  const outputs: TxOutput[] = [];
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

const hasWitness = (tx: Transaction): boolean => tx.inputs.some((input) => input.witness.length > 0);

/** Parse a raw transaction from lowercase hex. */
export function parseTransaction(hex: unknown): ParsedTransaction {
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length === 0) return { ok: false, code: 'TX_MALFORMED', reason: 'Expected lowercase transaction hex.' };
  try {
    const reader = new Reader(bytes);
    const tx = readTransaction(reader);
    if (reader.remaining !== 0) throw new Error('trailing bytes');
    return { ok: true, tx, txid: transactionId(tx), wtxid: witnessTransactionId(tx), hasWitness: hasWitness(tx) };
  } catch (error) {
    return { ok: false, code: 'TX_MALFORMED', reason: `The transaction bytes do not parse: ${(error as Error).message}.` };
  }
}

/** Serialize a transaction; with witness: false, the legacy txid form. */
export function serializeTransaction(tx: Transaction, { witness = true }: { witness?: boolean } = {}): Uint8Array {
  const segwit = witness && hasWitness(tx);
  const parts: Uint8Array[] = [u32le(tx.version)];
  if (segwit) parts.push(Uint8Array.of(0x00, 0x01));
  parts.push(compactSize(tx.inputs.length));
  for (const input of tx.inputs) {
    parts.push(reversed(bytesOf(input.txid)), u32le(input.vout), varBytes(bytesOf(input.scriptSigHex ?? '')), u32le(input.sequence));
  }
  parts.push(compactSize(tx.outputs.length));
  for (const output of tx.outputs) parts.push(u64le(BigInt(output.valueSats)), varBytes(bytesOf(output.scriptHex)));
  if (segwit) {
    for (const input of tx.inputs) {
      parts.push(compactSize(input.witness.length));
      for (const item of input.witness) parts.push(varBytes(bytesOf(item)));
    }
  }
  parts.push(u32le(tx.lockTime));
  return concat(...parts);
}

export const transactionId = (tx: Transaction): string =>
  bytesToHex(reversed(hash256(serializeTransaction(tx, { witness: false }))));
export const witnessTransactionId = (tx: Transaction): string => bytesToHex(reversed(hash256(serializeTransaction(tx))));

/** The same transaction with every scriptSig and witness removed. */
export function unsignedCopy(tx: Transaction): Transaction {
  return {
    version: tx.version,
    lockTime: tx.lockTime,
    inputs: tx.inputs.map((input) => ({ txid: input.txid, vout: input.vout, scriptSigHex: '', sequence: input.sequence, witness: [] })),
    outputs: tx.outputs.map((output) => ({ valueSats: output.valueSats, scriptHex: output.scriptHex })),
  };
}

export const SIGHASH_DEFAULT = 0x00;
export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_ANYONECANPAY = 0x80;

const SIGHASH_NAMES: Record<number, string> = {
  0x00: 'DEFAULT',
  0x01: 'ALL',
  0x02: 'NONE',
  0x03: 'SINGLE',
  0x81: 'ALL|ANYONECANPAY',
  0x82: 'NONE|ANYONECANPAY',
  0x83: 'SINGLE|ANYONECANPAY',
};

/** The protocol name of a sighash byte, or null for one Taproot does not define. */
export const sighashName = (type: number): string | null => SIGHASH_NAMES[type] ?? null;

function removeCodeSeparators(script: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  const at = (j: number): number => script[j] ?? 0;
  while (i < script.length) {
    const op = at(i);
    let end = i + 1;
    if (op >= 0x01 && op <= 0x4b) end += op;
    else if (op === 0x4c) end += 1 + at(i + 1);
    else if (op === 0x4d) end += 2 + (at(i + 1) | (at(i + 2) << 8));
    else if (op === 0x4e) end += 4 + at(i + 1) + at(i + 2) * 0x100 + at(i + 3) * 0x10000 + at(i + 4) * 0x1000000;
    if (op !== 0xab) for (let j = i; j < Math.min(end, script.length); j += 1) out.push(at(j));
    i = end;
  }
  return Uint8Array.from(out);
}

const serializeOutput = (output: TxOutput): Uint8Array =>
  concat(u64le(BigInt(output.valueSats)), varBytes(bytesOf(output.scriptHex)));
const serializeOutpoint = (input: TxInput): Uint8Array => concat(reversed(bytesOf(input.txid)), u32le(input.vout));

/** The original (pre-segwit) signature hash of input `index`. */
export function legacySighash(tx: Transaction, index: number, scriptCode: Uint8Array, hashType: number): Uint8Array {
  const base = hashType & 0x1f;
  if (base === SIGHASH_SINGLE && index >= tx.outputs.length) {
    const one = new Uint8Array(32);
    one[0] = 1;
    return one;
  }
  const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  const code = removeCodeSeparators(scriptCode);
  const own = tx.inputs[index];
  const inputs = (anyoneCanPay && own ? [own] : tx.inputs).map((input) => {
    const isOwn = input === own;
    const sequence = !isOwn && (base === SIGHASH_NONE || base === SIGHASH_SINGLE) ? 0 : input.sequence;
    return concat(serializeOutpoint(input), varBytes(isOwn ? code : new Uint8Array(0)), u32le(sequence));
  });
  let outputs: Uint8Array[];
  if (base === SIGHASH_NONE) outputs = [];
  else if (base === SIGHASH_SINGLE) {
    outputs = tx.outputs
      .slice(0, index + 1)
      .map((output, i) => (i === index ? serializeOutput(output) : concat(u64le(0xffffffffffffffffn), compactSize(0))));
  } else {
    outputs = tx.outputs.map(serializeOutput);
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
export function segwitV0Sighash(
  tx: Transaction,
  index: number,
  scriptCode: Uint8Array,
  valueSats: string,
  hashType: number
): Uint8Array {
  const base = hashType & 0x1f;
  const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  const zero: Uint8Array = new Uint8Array(32);
  const hashPrevouts = anyoneCanPay ? zero : hash256(...tx.inputs.map(serializeOutpoint));
  const hashSequence =
    anyoneCanPay || base === SIGHASH_SINGLE || base === SIGHASH_NONE
      ? zero
      : hash256(...tx.inputs.map((input) => u32le(input.sequence)));
  let hashOutputs: Uint8Array = zero;
  const single = tx.outputs[index];
  if (base !== SIGHASH_SINGLE && base !== SIGHASH_NONE) hashOutputs = hash256(...tx.outputs.map(serializeOutput));
  else if (base === SIGHASH_SINGLE && single) hashOutputs = hash256(serializeOutput(single));
  const input = tx.inputs[index] as TxInput;
  return hash256(
    u32le(tx.version),
    hashPrevouts,
    hashSequence,
    serializeOutpoint(input),
    varBytes(scriptCode),
    u64le(BigInt(valueSats)),
    u32le(input.sequence),
    hashOutputs,
    u32le(tx.lockTime),
    u32le(hashType)
  );
}

/**
 * The BIP341 signature hash of input `index`, or null for a hash type Taproot
 * does not define or SINGLE without its output.
 */
export function taprootSighash(
  tx: Transaction,
  index: number,
  prevouts: readonly Prevout[],
  hashType: number,
  {
    leafHash = null,
    annexHex = null,
    codeSeparatorPosition = 0xffffffff,
  }: { leafHash?: Uint8Array | null; annexHex?: string | null; codeSeparatorPosition?: number } = {}
): Uint8Array | null {
  if (sighashName(hashType) === null) return null;
  const base = hashType & 0x03;
  const anyoneCanPay = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  if (base === SIGHASH_SINGLE && index >= tx.outputs.length) return null;
  const input = tx.inputs[index];
  const prevout = prevouts[index];
  if (!input || !prevout) return null;
  const parts: Uint8Array[] = [Uint8Array.of(0x00), Uint8Array.of(hashType), u32le(tx.version), u32le(tx.lockTime)];
  if (!anyoneCanPay) {
    parts.push(
      sha256(...tx.inputs.map(serializeOutpoint)),
      sha256(...prevouts.map((p) => u64le(BigInt(p.valueSats)))),
      sha256(...prevouts.map((p) => varBytes(bytesOf(p.scriptHex)))),
      sha256(...tx.inputs.map((i) => u32le(i.sequence)))
    );
  }
  if (base !== SIGHASH_NONE && base !== SIGHASH_SINGLE) parts.push(sha256(...tx.outputs.map(serializeOutput)));
  const annex = annexHex === null ? null : bytesOf(annexHex);
  parts.push(Uint8Array.of((leafHash ? 2 : 0) + (annex ? 1 : 0)));
  if (anyoneCanPay) {
    parts.push(serializeOutpoint(input), u64le(BigInt(prevout.valueSats)), varBytes(bytesOf(prevout.scriptHex)), u32le(input.sequence));
  } else {
    parts.push(u32le(index));
  }
  if (annex) parts.push(sha256(varBytes(annex)));
  const single = tx.outputs[index];
  if (base === SIGHASH_SINGLE && single) parts.push(sha256(serializeOutput(single)));
  if (leafHash) parts.push(leafHash, Uint8Array.of(0x00), u32le(codeSeparatorPosition));
  return taggedHash('TapSighash', ...parts);
}

/** BIP341 tapleaf hash of a leaf script. */
export function tapLeafHash(scriptHex: string, leafVersion = 0xc0): Uint8Array {
  return taggedHash('TapLeaf', Uint8Array.of(leafVersion), varBytes(bytesOf(scriptHex)));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

/** BIP341 branch hash of two child hashes, sorted. */
export function tapBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [left, right] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  return taggedHash('TapBranch', left, right);
}

export type TaprootCommitment =
  | { ok: true; internalKey: string; leafHash: Uint8Array; leafVersion: number; merkleRoot: Uint8Array }
  | { ok: false };

/** Check that a control block commits a leaf script to a Taproot output key. */
export function verifyTaprootCommitment(outputKeyHex: string, leafScriptHex: string, controlBlockHex: string): TaprootCommitment {
  const control = hexToBytes(controlBlockHex);
  const outputKey = hexToBytes(outputKeyHex);
  if (!control || !outputKey || outputKey.length !== 32 || !hexToBytes(leafScriptHex)) return { ok: false };
  if (control.length < 33 || control.length > 33 + 32 * 128 || (control.length - 33) % 32 !== 0) return { ok: false };
  const first = control[0] ?? 0;
  const leafVersion = first & 0xfe;
  const internalKey = control.subarray(1, 33);
  const leafHash = tapLeafHash(leafScriptHex, leafVersion);
  let node = leafHash;
  for (let at = 33; at < control.length; at += 32) node = tapBranchHash(node, control.subarray(at, at + 32));
  const tweaked = taprootTweak(internalKey, node);
  if (!tweaked || bytesToHex(tweaked.outputKey) !== outputKeyHex || tweaked.parity !== (first & 1)) return { ok: false };
  return { ok: true, internalKey: bytesToHex(internalKey), leafHash, leafVersion, merkleRoot: node };
}

export type ScriptInstruction = { op: number; push?: Uint8Array };

/** Parse script bytes into { op } and { op, push } instructions, or null. */
export function scriptInstructions(script: string | Uint8Array): ScriptInstruction[] | null {
  const bytes = typeof script === 'string' ? hexToBytes(script) : script;
  if (!bytes) return null;
  const out: ScriptInstruction[] = [];
  let cursor = 0;
  const at = (j: number): number => bytes[j] ?? 0;
  while (cursor < bytes.length) {
    const opcode = at(cursor);
    cursor += 1;
    let length: number;
    if (opcode <= 0x4b) length = opcode;
    else if (opcode === 0x4c) {
      if (cursor + 1 > bytes.length) return null;
      length = at(cursor);
      cursor += 1;
    } else if (opcode === 0x4d) {
      if (cursor + 2 > bytes.length) return null;
      length = at(cursor) | (at(cursor + 1) << 8);
      cursor += 2;
    } else if (opcode === 0x4e) {
      if (cursor + 4 > bytes.length) return null;
      length = at(cursor) + at(cursor + 1) * 0x100 + at(cursor + 2) * 0x10000 + at(cursor + 3) * 0x1000000;
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

export type ScriptType = 'p2wpkh' | 'p2wsh' | 'p2tr' | 'p2pkh' | 'p2sh' | 'op_return' | 'other';

/** The script template of an output script. */
export function scriptType(scriptHex: string): ScriptType {
  if (/^0014[0-9a-f]{40}$/.test(scriptHex)) return 'p2wpkh';
  if (/^0020[0-9a-f]{64}$/.test(scriptHex)) return 'p2wsh';
  if (/^5120[0-9a-f]{64}$/.test(scriptHex)) return 'p2tr';
  if (/^76a914[0-9a-f]{40}88ac$/.test(scriptHex)) return 'p2pkh';
  if (/^a914[0-9a-f]{40}87$/.test(scriptHex)) return 'p2sh';
  if (scriptHex.startsWith('6a')) return 'op_return';
  return 'other';
}

const p2pkhScriptCode = (program: string): Uint8Array => bytesOf(`76a914${program}88ac`);

function ecdsaCheck(
  sigHex: string,
  pubkeyHex: string,
  digestFor: (hashType: number) => Uint8Array
): { valid: boolean; hashType?: number } {
  const sig = hexToBytes(sigHex);
  const pubkey = hexToBytes(pubkeyHex);
  if (!sig || sig.length < 9 || !pubkey) return { valid: false };
  const hashType = sig[sig.length - 1] ?? 0;
  if (sighashName(hashType) === null || hashType === SIGHASH_DEFAULT) return { valid: false, hashType };
  return { valid: verifyEcdsa(digestFor(hashType), sig.subarray(0, sig.length - 1), pubkey), hashType };
}

function schnorrCheck(
  sigBytes: Uint8Array | null,
  keyX: Uint8Array | null,
  digestFor: (hashType: number) => Uint8Array | null
): { valid: boolean; hashType?: number } {
  if (!sigBytes || !keyX || (sigBytes.length !== 64 && sigBytes.length !== 65)) return { valid: false };
  const hashType = sigBytes.length === 65 ? (sigBytes[64] ?? 0) : SIGHASH_DEFAULT;
  if (sigBytes.length === 65 && hashType === SIGHASH_DEFAULT) return { valid: false, hashType };
  const digest = digestFor(hashType);
  if (!digest) return { valid: false, hashType };
  return { valid: verifySchnorr(digest, sigBytes.subarray(0, 64), keyX), hashType };
}

export type SignatureStatus = 'UNSIGNED' | 'VALID' | 'INVALID' | 'UNSUPPORTED';

export interface InputSignatureVerdict {
  index: number;
  type: ScriptType;
  status: SignatureStatus;
  sighashType?: number;
  publicKey?: string;
  path?: 'key' | 'script';
  leafHash?: string;
  reason?: string;
}

/**
 * Verify the signature one input of a signed transaction carries against the
 * prevouts of every input. UNSUPPORTED is never a pass.
 */
export function verifyInputSignature(tx: Transaction, index: number, prevouts: readonly Prevout[]): InputSignatureVerdict {
  const input = tx.inputs[index] as TxInput;
  const prevout = prevouts[index] as Prevout;
  const type = scriptType(prevout.scriptHex);
  const result = (status: SignatureStatus, extra: Omit<InputSignatureVerdict, 'index' | 'type' | 'status'> = {}): InputSignatureVerdict => ({
    index,
    type,
    status,
    ...extra,
  });
  const withHash = (hashType: number | undefined): { sighashType?: number } =>
    hashType === undefined ? {} : { sighashType: hashType };
  if (input.scriptSigHex === '' && input.witness.length === 0) return result('UNSIGNED');

  if (type === 'p2wpkh' || type === 'p2sh') {
    let program: string;
    if (type === 'p2wpkh') {
      if (input.scriptSigHex !== '') return result('INVALID', { reason: 'A native segwit input carries a scriptSig.' });
      program = prevout.scriptHex.slice(4);
    } else {
      const redeem = scriptInstructions(input.scriptSigHex);
      const push = redeem && redeem.length === 1 ? redeem[0]?.push : undefined;
      if (!push || !/^0014[0-9a-f]{40}$/.test(bytesToHex(push))) {
        return result('UNSUPPORTED', { reason: 'Only P2SH-wrapped P2WPKH is verified.' });
      }
      if (bytesToHex(hash160(push)) !== prevout.scriptHex.slice(4, 44)) {
        return result('INVALID', { reason: 'The redeem script does not hash to the P2SH output.' });
      }
      program = bytesToHex(push).slice(4);
    }
    const [sigHex, pubkeyHex] = input.witness;
    if (input.witness.length !== 2 || sigHex === undefined || pubkeyHex === undefined) {
      return result('INVALID', { reason: 'A P2WPKH witness is a signature and a key.' });
    }
    const pubkey = hexToBytes(pubkeyHex);
    if (!pubkey || pubkey.length !== 33 || !decodePublicKey(pubkey)) {
      return result('INVALID', { reason: 'A segwit key must be a valid compressed public key.' });
    }
    if (bytesToHex(hash160(pubkey)) !== program) return result('INVALID', { reason: 'The key does not hash to the witness program.' });
    const check = ecdsaCheck(sigHex, pubkeyHex, (hashType) =>
      segwitV0Sighash(tx, index, p2pkhScriptCode(program), prevout.valueSats, hashType)
    );
    return result(check.valid ? 'VALID' : 'INVALID', { ...withHash(check.hashType), publicKey: pubkeyHex });
  }

  if (type === 'p2pkh') {
    if (input.witness.length !== 0) return result('INVALID', { reason: 'A legacy input carries a witness.' });
    const parts = scriptInstructions(input.scriptSigHex);
    const sigPush = parts?.[0]?.push;
    const keyPush = parts?.[1]?.push;
    if (!parts || parts.length !== 2 || !sigPush || !keyPush) {
      return result('INVALID', { reason: 'A P2PKH scriptSig is a signature push and a key push.' });
    }
    const pubkeyHex = bytesToHex(keyPush);
    if (!decodePublicKey(keyPush)) return result('INVALID', { reason: 'The public key is not a valid point.' });
    if (bytesToHex(hash160(keyPush)) !== prevout.scriptHex.slice(6, 46)) {
      return result('INVALID', { reason: 'The key does not hash to the output.' });
    }
    const check = ecdsaCheck(bytesToHex(sigPush), pubkeyHex, (hashType) =>
      legacySighash(tx, index, bytesOf(prevout.scriptHex), hashType)
    );
    return result(check.valid ? 'VALID' : 'INVALID', { ...withHash(check.hashType), publicKey: pubkeyHex });
  }

  if (type === 'p2tr') {
    if (input.scriptSigHex !== '') return result('INVALID', { reason: 'A Taproot input carries a scriptSig.' });
    let stack = input.witness.slice();
    let annexHex: string | null = null;
    const last = stack[stack.length - 1];
    if (stack.length >= 2 && last !== undefined && last.startsWith('50')) {
      annexHex = last;
      stack = stack.slice(0, -1);
    }
    const outputKeyHex = prevout.scriptHex.slice(4);
    if (stack.length === 1) {
      const check = schnorrCheck(hexToBytes(stack[0]), hexToBytes(outputKeyHex), (hashType) =>
        taprootSighash(tx, index, prevouts, hashType, { annexHex })
      );
      return result(check.valid ? 'VALID' : 'INVALID', { ...withHash(check.hashType), publicKey: outputKeyHex, path: 'key' });
    }
    if (stack.length < 2) return result('INVALID', { reason: 'An empty Taproot witness.' });
    const controlHex = stack[stack.length - 1] as string;
    const leafHex = stack[stack.length - 2] as string;
    const commitment = verifyTaprootCommitment(outputKeyHex, leafHex, controlHex);
    if (!commitment.ok) {
      return result('INVALID', { reason: 'The control block does not commit the leaf to this output.', path: 'script' });
    }
    const leaf = scriptInstructions(leafHex);
    const key = leaf?.[0]?.push;
    const singleKey = commitment.leafVersion === 0xc0 && leaf && leaf.length === 2 && key?.length === 32 && leaf[1]?.op === 0xac;
    if (!singleKey || !key || stack.length !== 3) {
      return result('UNSUPPORTED', {
        reason: 'Only a single-key leaf is executed here.',
        path: 'script',
        leafHash: bytesToHex(commitment.leafHash),
      });
    }
    const check = schnorrCheck(hexToBytes(stack[0]), key, (hashType) =>
      taprootSighash(tx, index, prevouts, hashType, { annexHex, leafHash: commitment.leafHash })
    );
    return result(check.valid ? 'VALID' : 'INVALID', {
      ...withHash(check.hashType),
      publicKey: bytesToHex(key),
      path: 'script',
      leafHash: bytesToHex(commitment.leafHash),
    });
  }

  return result('UNSUPPORTED', { reason: `A ${type} input is not verified here.` });
}

// ---------------------------------------------------------------------------
// PSBT (BIP174 v0, BIP370 v2, BIP371 Taproot fields)

const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff];

interface KeySpec {
  name: string;
  keyData: number | null;
  versions: number[];
}

const GLOBAL_KEYS: Record<number, KeySpec> = {
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
const INPUT_KEYS: Record<number, KeySpec> = {
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
const OUTPUT_KEYS: Record<number, KeySpec> = {
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

export interface PsbtKeyValue {
  keyData: string;
  value: string;
}

/** One decoded PSBT map: single-key fields as hex, keyed fields as lists. */
export interface PsbtMap {
  unknown: Array<{ keyHex: string; valueHex: string }>;
  [field: string]: unknown;
}

export interface PsbtInput extends PsbtMap {
  nonWitnessUtxo?: string;
  witnessUtxo?: string;
  partialSig?: PsbtKeyValue[];
  sighashType?: number;
  redeemScript?: string;
  witnessScript?: string;
  finalScriptSig?: string;
  finalScriptWitness?: string;
  tapKeySig?: string;
  tapScriptSig?: PsbtKeyValue[];
  tapLeafScript?: PsbtKeyValue[];
  tapInternalKey?: string;
  tapMerkleRoot?: string;
  prevout?: Prevout;
  finalWitness?: string[];
}

export interface Psbt {
  version: number;
  /** The unsigned transaction; lockTime is null when BIP370 cannot determine it. */
  tx: Omit<Transaction, 'lockTime'> & { lockTime: number | null };
  global: PsbtMap;
  inputs: PsbtInput[];
  outputs: PsbtMap[];
}

export type ParsedPsbt = { ok: true; psbt: Psbt } | { ok: false; code: 'PSBT_MALFORMED'; reason: string };

interface RawEntry {
  type: number;
  keyData: Uint8Array;
  value: Uint8Array;
  keyHex: string;
  valueHex: string;
}

function readMap(reader: Reader): RawEntry[] {
  const entries: RawEntry[] = [];
  const seen = new Set<string>();
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

function decodeMap(entries: RawEntry[], table: Record<number, KeySpec>, version: number, where: string): PsbtMap {
  const fields: PsbtMap = { unknown: [] };
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
    if (
      spec.name === 'tapLeafScript' &&
      (entry.keyData.length < 33 || entry.keyData.length > 33 + 32 * 128 || (entry.keyData.length - 33) % 32 !== 0 || entry.value.length < 1)
    ) {
      throw new Error(`${where} Taproot leaf script has a malformed control block`);
    }
    if (spec.name === 'tapInternalKey' && entry.value.length !== 32) {
      throw new Error(`${where} Taproot internal key is not 32 bytes`);
    }
    if (spec.keyData === 0) fields[spec.name] = entry.valueHex;
    else {
      const list = (fields[spec.name] as PsbtKeyValue[] | undefined) ?? [];
      list.push({ keyData: bytesToHex(entry.keyData), value: entry.valueHex });
      fields[spec.name] = list;
    }
  }
  return fields;
}

function readU32Value(hex: unknown, name: string): number {
  const bytes = hexToBytes(hex);
  if (!bytes || bytes.length !== 4) throw new Error(`${name} must be four bytes`);
  return new DataView(bytes.buffer).getUint32(0, true);
}

function readWitnessStack(hex: string): string[] {
  const reader = new Reader(bytesOf(hex));
  const count = reader.compact();
  const items: string[] = [];
  for (let i = 0; i < count; i += 1) items.push(bytesToHex(reader.varBytes()));
  if (reader.remaining !== 0) throw new Error('trailing bytes in a final witness');
  return items;
}

function readTxOut(hex: string): Prevout {
  const reader = new Reader(bytesOf(hex));
  const value = reader.u64();
  if (value > MAX_MONEY) throw new Error('witness UTXO value above the money supply');
  const script = reader.varBytes();
  if (reader.remaining !== 0) throw new Error('trailing bytes in a witness UTXO');
  return { valueSats: value.toString(), scriptHex: bytesToHex(script) };
}

/** Parse a PSBT given as base64 or lowercase hex. */
export function parsePsbt(encoded: unknown): ParsedPsbt {
  let bytes: Uint8Array | null = null;
  if (typeof encoded === 'string' && encoded.startsWith('70736274ff')) bytes = hexToBytes(encoded);
  else if (typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) bytes = new Uint8Array(Buffer.from(encoded, 'base64'));
  const magic = bytes;
  if (!magic || magic.length < 5 || PSBT_MAGIC.some((b, i) => magic[i] !== b)) {
    return { ok: false, code: 'PSBT_MALFORMED', reason: 'The data does not start with the PSBT magic bytes.' };
  }
  try {
    const reader = new Reader(magic);
    reader.take(5);
    const globalEntries = readMap(reader);
    const versionEntry = globalEntries.find((e) => e.type === 0xfb && e.keyData.length === 0);
    const version = versionEntry ? readU32Value(versionEntry.valueHex, 'PSBT version') : 0;
    if (version !== 0 && version !== 2) throw new Error(`PSBT version ${version} is not supported`);
    const global = decodeMap(globalEntries, GLOBAL_KEYS, version, 'global');

    let tx: Psbt['tx'];
    let inputCount: number;
    let outputCount: number;
    if (version === 0) {
      if (typeof global.unsignedTx !== 'string') throw new Error('a v0 PSBT carries the unsigned transaction');
      const txReader = new Reader(bytesOf(global.unsignedTx));
      tx = readTransaction(txReader, { allowWitness: false, requireInputs: false });
      if (txReader.remaining !== 0) throw new Error('trailing bytes in the unsigned transaction');
      if (tx.inputs.some((input) => input.scriptSigHex !== '')) throw new Error('the unsigned transaction carries a scriptSig');
      inputCount = tx.inputs.length;
      outputCount = tx.outputs.length;
    } else {
      if (global.txVersion === undefined || global.inputCount === undefined || global.outputCount === undefined) {
        throw new Error('a v2 PSBT carries the transaction version and both counts');
      }
      inputCount = new Reader(bytesOf(global.inputCount as string)).compact();
      outputCount = new Reader(bytesOf(global.outputCount as string)).compact();
      tx = { version: 0, lockTime: 0, inputs: [], outputs: [] };
    }

    const inputs: PsbtInput[] = [];
    for (let i = 0; i < inputCount; i += 1) inputs.push(decodeMap(readMap(reader), INPUT_KEYS, version, `input ${i}`) as PsbtInput);
    const outputs: PsbtMap[] = [];
    for (let i = 0; i < outputCount; i += 1) outputs.push(decodeMap(readMap(reader), OUTPUT_KEYS, version, `output ${i}`));
    if (reader.remaining !== 0) throw new Error('trailing bytes after the last output map');

    if (version === 2) {
      const txVersion = readU32Value(global.txVersion, 'transaction version');
      if (txVersion < 2) throw new Error('a v2 PSBT describes a transaction of version 2 or more');
      tx = { version: txVersion, lockTime: 0, inputs: [], outputs: [] };
      let maxTime = 0;
      let maxHeight = 0;
      let anyTime = false;
      let anyHeight = false;
      let forcesTime = false;
      let forcesHeight = false;
      for (let i = 0; i < inputs.length; i += 1) {
        const input = inputs[i] as PsbtInput;
        if (input.previousTxid === undefined || input.outputIndex === undefined) throw new Error(`input ${i} names no previous output`);
        const txidBytes = bytesOf(input.previousTxid as string);
        if (txidBytes.length !== 32) throw new Error(`input ${i} previous txid is not 32 bytes`);
        const time = input.requiredTimeLocktime !== undefined ? readU32Value(input.requiredTimeLocktime, 'time locktime') : null;
        const height = input.requiredHeightLocktime !== undefined ? readU32Value(input.requiredHeightLocktime, 'height locktime') : null;
        if (time !== null && time < 500000000) throw new Error(`input ${i} time locktime is below 500000000`);
        if (height !== null && (height < 1 || height >= 500000000)) throw new Error(`input ${i} height locktime is out of range`);
        if (time !== null) {
          anyTime = true;
          maxTime = Math.max(maxTime, time);
        }
        if (height !== null) {
          anyHeight = true;
          maxHeight = Math.max(maxHeight, height);
        }
        if (time !== null && height === null) forcesTime = true;
        if (height !== null && time === null) forcesHeight = true;
        tx.inputs.push({
          txid: bytesToHex(reversed(txidBytes)),
          vout: readU32Value(input.outputIndex, 'output index'),
          scriptSigHex: '',
          sequence: input.sequence !== undefined ? readU32Value(input.sequence, 'sequence') : 0xffffffff,
          witness: [],
        });
      }
      // BIP370: height wins when every input with a lock accepts it; an input
      // that only accepts time forces time. A PSBT whose inputs force both
      // stays valid, but its locktime cannot be computed.
      if (forcesTime && forcesHeight) tx.lockTime = null;
      else if (anyHeight && !forcesTime) tx.lockTime = maxHeight;
      else if (anyTime) tx.lockTime = maxTime;
      else tx.lockTime = global.fallbackLocktime !== undefined ? readU32Value(global.fallbackLocktime, 'fallback locktime') : 0;
      for (let i = 0; i < outputs.length; i += 1) {
        const output = outputs[i] as PsbtMap;
        if (typeof output.amount !== 'string' || typeof output.script !== 'string') throw new Error(`output ${i} lacks its amount or script`);
        const amount = bytesOf(output.amount);
        if (amount.length !== 8) throw new Error(`output ${i} amount is not eight bytes`);
        const value = new DataView(amount.buffer).getBigUint64(0, true);
        if (value > MAX_MONEY) throw new Error(`output ${i} amount above the money supply`);
        tx.outputs.push({ valueSats: value.toString(), scriptHex: output.script });
      }
    }

    // Prevout data: a non-witness UTXO must be the transaction the input spends.
    for (let i = 0; i < inputs.length; i += 1) {
      const input = inputs[i] as PsbtInput;
      const spent = tx.inputs[i] as TxInput;
      let fromNonWitness: TxOutput | null = null;
      if (input.nonWitnessUtxo !== undefined) {
        const parsed = parseTransaction(input.nonWitnessUtxo);
        if (!parsed.ok) throw new Error(`input ${i} non-witness UTXO does not parse`);
        if (parsed.txid !== spent.txid) throw new Error(`input ${i} non-witness UTXO is not the transaction it spends`);
        fromNonWitness = parsed.tx.outputs[spent.vout] ?? null;
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
      if (input.tapKeySig !== undefined && ![128, 130].includes(input.tapKeySig.length)) {
        throw new Error(`input ${i} Taproot key signature has a bad length`);
      }
    }
    return { ok: true, psbt: { version, tx, global, inputs, outputs } };
  } catch (error) {
    return { ok: false, code: 'PSBT_MALFORMED', reason: `The PSBT does not parse: ${(error as Error).message}.` };
  }
}

/**
 * The transaction a finalized PSBT extracts to. Inputs that are not final stay
 * unsigned. Null when BIP370 cannot determine the locktime.
 */
export function extractPsbtTransaction(psbt: Psbt): Transaction | null {
  if (psbt.tx.lockTime === null) return null;
  return {
    version: psbt.tx.version,
    lockTime: psbt.tx.lockTime,
    inputs: psbt.tx.inputs.map((input, i) => ({
      ...input,
      scriptSigHex: psbt.inputs[i]?.finalScriptSig ?? '',
      witness: psbt.inputs[i]?.finalWitness ?? [],
    })),
    outputs: psbt.tx.outputs.map((output) => ({ ...output })),
  };
}

export interface PsbtSignatureCheck {
  kind: 'ecdsa' | 'taproot-key' | 'taproot-script';
  publicKey: string;
  leafHash?: string;
  sighashType?: number;
  valid: boolean;
  unsupported?: true;
}

/**
 * Verify every partial signature a PSBT input carries against the sighash of
 * the unsigned transaction.
 */
export function verifyPsbtPartialSignatures(psbt: Psbt, index: number): PsbtSignatureCheck[] {
  const input = psbt.inputs[index];
  const out: PsbtSignatureCheck[] = [];
  const lockTime = psbt.tx.lockTime;
  if (!input || !input.prevout || lockTime === null) return out;
  const prevout = input.prevout;
  const tx: Transaction = { ...psbt.tx, lockTime };
  const prevouts = psbt.inputs.map((i) => i.prevout);
  const complete = prevouts.every((p): p is Prevout => p !== undefined);
  const type = scriptType(prevout.scriptHex);
  const withHash = (hashType: number | undefined): { sighashType?: number } =>
    hashType === undefined ? {} : { sighashType: hashType };
  for (const entry of input.partialSig ?? []) {
    let digestFor: ((h: number) => Uint8Array) | null = null;
    const redeem = input.redeemScript;
    if (type === 'p2wpkh') {
      digestFor = (h) => segwitV0Sighash(tx, index, p2pkhScriptCode(prevout.scriptHex.slice(4)), prevout.valueSats, h);
    } else if (type === 'p2sh' && redeem && /^0014[0-9a-f]{40}$/.test(redeem)) {
      digestFor = (h) => segwitV0Sighash(tx, index, p2pkhScriptCode(redeem.slice(4)), prevout.valueSats, h);
    } else if (type === 'p2pkh') {
      digestFor = (h) => legacySighash(tx, index, bytesOf(prevout.scriptHex), h);
    }
    if (!digestFor) {
      out.push({ kind: 'ecdsa', publicKey: entry.keyData, valid: false, unsupported: true });
      continue;
    }
    const check = ecdsaCheck(entry.value, entry.keyData, digestFor);
    out.push({ kind: 'ecdsa', publicKey: entry.keyData, ...withHash(check.hashType), valid: check.valid });
  }
  if (input.tapKeySig !== undefined && type === 'p2tr' && complete) {
    const key = prevout.scriptHex.slice(4);
    const check = schnorrCheck(hexToBytes(input.tapKeySig), hexToBytes(key), (h) => taprootSighash(tx, index, prevouts, h));
    out.push({ kind: 'taproot-key', publicKey: key, ...withHash(check.hashType), valid: check.valid });
  }
  for (const entry of input.tapScriptSig ?? []) {
    if (type !== 'p2tr' || !complete) continue;
    const key = entry.keyData.slice(0, 64);
    const leafHash = bytesOf(entry.keyData.slice(64));
    const check = schnorrCheck(hexToBytes(entry.value), hexToBytes(key), (h) =>
      taprootSighash(tx, index, prevouts, h, { leafHash })
    );
    out.push({ kind: 'taproot-script', publicKey: key, leafHash: entry.keyData.slice(64), ...withHash(check.hashType), valid: check.valid });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Relay policy (Bitcoin Core v29.0 src/policy/policy.cpp, blob ed336928)

/** Default -dustrelayfee, satoshis per 1000 virtual bytes. */
export const DUST_RELAY_FEE_SATS_PER_KVB = 3000n;
/** Default -datacarriersize: the largest OP_RETURN scriptPubKey relayed. */
export const MAX_OP_RETURN_RELAY_BYTES = 83;

function isWitnessProgram(script: Uint8Array): boolean {
  if (script.length < 4 || script.length > 42) return false;
  const first = script[0] ?? 0;
  if (first !== 0x00 && (first < 0x51 || first > 0x60)) return false;
  return (script[1] ?? 0) + 2 === script.length;
}

/**
 * Bitcoin Core's GetDustThreshold at the default dust relay fee. An
 * unspendable script (OP_RETURN, or longer than 10000 bytes) has a threshold of 0.
 */
export function dustThresholdSats(scriptHex: string): bigint | null {
  const script = hexToBytes(scriptHex);
  if (!script) return null;
  if ((script.length > 0 && script[0] === 0x6a) || script.length > 10000) return 0n;
  let size = 8 + compactSize(script.length).length + script.length;
  size += isWitnessProgram(script) ? 32 + 4 + 1 + Math.floor(107 / 4) + 4 : 32 + 4 + 1 + 107 + 4;
  return (BigInt(size) * DUST_RELAY_FEE_SATS_PER_KVB) / 1000n;
}
