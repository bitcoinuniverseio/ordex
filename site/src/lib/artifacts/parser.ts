/**
 * Ordex Strict Read-Only PSBT and Transaction Parser
 *
 * OX-S01: bounded decoder for PSBT version 0 (BIP174 v1.4.4, blob ecaa5d12) and version 2
 * (BIP370, blob 93b56e88), and for raw legacy or SegWit transactions. The exact number of
 * input and output maps comes from the v0 unsigned transaction or the v2 counts; every map
 * needs its separator and the PSBT must end exactly after the last map. Keys must be unique
 * and minimally encoded; unknown keys are kept byte for byte. Malformed input is reported as
 * malformed, never as a decoded artifact. No keys, signing or network access.
 */

import { sha256Bytes } from '../browser/node-crypto.mjs';

export interface ByteRange {
  startOffset: number;
  endOffset: number;
  label: string;
  fieldKey?: string;
  isStandardEncoding: boolean;
}

export interface KeyValueEntry {
  keyType: number;
  keyData: Uint8Array;
  valueData: Uint8Array;
  keyHex: string;
  keyOffset: number;
  valueOffset: number;
  totalLength: number;
  isProprietary: boolean;
  isUnknown: boolean;
  label: string;
}

export interface ParsedPsbtMap {
  mapType: 'global' | 'input' | 'output';
  index?: number;
  entries: KeyValueEntry[];
  unknownEntries: KeyValueEntry[];
  duplicateKeysDetected: boolean;
}

export interface TxInputView {
  index: number;
  txid: string;
  vout: number;
  sequence: number;
  scriptSigHex: string;
  witness: string[];
}

export interface TxOutputView {
  index: number;
  valueSats: string;
  scriptHex: string;
}

export interface DecodedTransaction {
  version: number;
  locktime: number;
  segwit: boolean;
  inputs: TxInputView[];
  outputs: TxOutputView[];
  txid: string;
  wtxid: string;
  byteLength: number;
  hex: string;
}

export interface PsbtInputView {
  index: number;
  txid: string | null;
  vout: number | null;
  sequence: number | null;
  sighashType: number | null;
  prevoutValueSats: string | null;
  prevoutScriptHex: string | null;
  prevoutSource: 'witness_utxo' | 'non_witness_utxo' | null;
  partialSignaturePubkeys: string[];
  hasTaprootKeySignature: boolean;
  hasFinalScriptSig: boolean;
  hasFinalScriptWitness: boolean;
  requiredTimeLocktime: number | null;
  requiredHeightLocktime: number | null;
}

export interface PsbtOutputView {
  index: number;
  valueSats: string | null;
  scriptHex: string | null;
}

export type ArtifactStatus = 'decoded' | 'malformed' | 'unsupported';

export interface ParsedArtifactResult {
  status: ArtifactStatus;
  format: 'PSBT_V0' | 'PSBT_V2' | 'RAW_BITCOIN_TX' | 'UNKNOWN';
  psbtVersion: 0 | 2 | null;
  magicValid: boolean;
  totalByteLength: number;
  /** SHA-256 over the exact original bytes. */
  sha256: string;
  rawHex: string;
  globalMap: ParsedPsbtMap;
  inputMaps: ParsedPsbtMap[];
  outputMaps: ParsedPsbtMap[];
  inputsCount: number;
  outputsCount: number;
  /** The raw transaction, or the PSBTv0 global unsigned transaction. */
  transaction: DecodedTransaction | null;
  version?: number;
  /** nLockTime: from the transaction, or the BIP370 determination for v2 (null when it cannot be determined). */
  locktime?: number | null;
  txModifiable: number | null;
  inputs: PsbtInputView[];
  outputs: PsbtOutputView[];
  byteRanges: ByteRange[];
  hasTaprootFields: boolean;
  hasUnknownFields: boolean;
  warnings: string[];
  errors: string[];
}

export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_MAP_ENTRIES = 10000;
const MAX_INPUT_OUTPUT_COUNT = 5000;
const MAX_MONEY = 2_100_000_000_000_000n;
const LOCKTIME_THRESHOLD = 500_000_000;

const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff];

class ParseError extends Error {
  constructor(message: string, public offset?: number) {
    super(offset === undefined ? message : `${message} (offset ${offset})`);
  }
}

class UnsupportedError extends Error {}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

const reversedHex = (bytes: Uint8Array) => bytesToHex(Uint8Array.from(bytes).reverse());
const sha256Hex = (bytes: Uint8Array) => bytesToHex(sha256Bytes(bytes));
const hash256 = (bytes: Uint8Array) => sha256Bytes(sha256Bytes(bytes));

/**
 * CompactSize decoder. isStandardEncoding is false for a non-minimal encoding, which the
 * PSBT and transaction decoders below reject.
 */
export function readCompactSize(buffer: Uint8Array, offset: number): { value: bigint; bytesRead: number; isStandardEncoding: boolean } {
  if (offset >= buffer.length) throw new ParseError('Truncated compact size', offset);
  const first = buffer[offset];
  if (first < 0xfd) return { value: BigInt(first), bytesRead: 1, isStandardEncoding: true };
  if (first === 0xfd) {
    if (offset + 3 > buffer.length) throw new ParseError('Truncated 16-bit compact size', offset);
    const val = BigInt(buffer[offset + 1] | (buffer[offset + 2] << 8));
    return { value: val, bytesRead: 3, isStandardEncoding: val >= 0xfdn };
  }
  if (first === 0xfe) {
    if (offset + 5 > buffer.length) throw new ParseError('Truncated 32-bit compact size', offset);
    const val = BigInt((buffer[offset + 1] | (buffer[offset + 2] << 8) | (buffer[offset + 3] << 16) | (buffer[offset + 4] << 24)) >>> 0);
    return { value: val, bytesRead: 5, isStandardEncoding: val > 0xffffn };
  }
  if (offset + 9 > buffer.length) throw new ParseError('Truncated 64-bit compact size', offset);
  const val = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 8).getBigUint64(0, true);
  return { value: val, bytesRead: 9, isStandardEncoding: val > 0xffffffffn };
}

/** A bounded reader: every read checks the remaining length before touching bytes. */
class Cursor {
  offset = 0;
  constructor(public bytes: Uint8Array, public label: string) {}
  get remaining() {
    return this.bytes.length - this.offset;
  }
  take(n: number, what: string): Uint8Array {
    if (n < 0 || this.offset + n > this.bytes.length) throw new ParseError(`${this.label}: truncated ${what}`, this.offset);
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  u8(what: string) {
    return this.take(1, what)[0];
  }
  u32(what: string) {
    const b = this.take(4, what);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  i32(what: string) {
    const b = this.take(4, what);
    return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
  }
  u64(what: string) {
    const b = this.take(8, what);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }
  compact(what: string, limit = Number.MAX_SAFE_INTEGER): number {
    const at = this.offset;
    const r = readCompactSize(this.bytes, this.offset);
    if (!r.isStandardEncoding) throw new ParseError(`${this.label}: non-minimal compact size for ${what}`, at);
    this.offset += r.bytesRead;
    if (r.value > BigInt(limit)) throw new ParseError(`${this.label}: ${what} ${r.value} exceeds the bound ${limit}`, at);
    return Number(r.value);
  }
  varBytes(what: string) {
    return this.take(this.compact(`${what} length`, this.remaining), what);
  }
}

/** True when the bytes decode completely as a SegWit serialization. */
function looksLikeWitnessSerialization(bytes: Uint8Array, _offset: number): boolean {
  try {
    return decodeTransaction(bytes, 'probe', { allowWitness: true, allowEmptyWitness: true }).segwit;
  } catch {
    return false;
  }
}

/** Decode a whole transaction from `bytes`, requiring every byte to be consumed. */
function decodeTransaction(bytes: Uint8Array, label: string, opts: { allowWitness: boolean; allowEmptyWitness?: boolean }): DecodedTransaction {
  const c = new Cursor(bytes, label);
  const version = c.i32('version');
  let segwit = false;
  // Without witness serialization a leading 0x00 is simply a zero input count (BIP174 allows
  // an unsigned transaction with no inputs). With it, 0x00 is the BIP144 marker and the flag
  // must be 0x01, as Bitcoin Core requires.
  if (c.remaining >= 2 && bytes[c.offset] === 0x00) {
    if (opts.allowWitness) {
      if (bytes[c.offset + 1] !== 0x01) throw new ParseError(`${label}: unknown transaction serialization flag 0x${bytes[c.offset + 1].toString(16)}`, c.offset);
      segwit = true;
      c.take(2, 'marker and flag');
    } else if (bytes[c.offset + 1] === 0x01 && looksLikeWitnessSerialization(bytes, c.offset)) {
      throw new ParseError(`${label}: must use the serialization without witness data`, c.offset);
    }
  }
  const bodyStart = c.offset;
  const inCount = c.compact('input count', MAX_INPUT_OUTPUT_COUNT);
  const inputs: TxInputView[] = [];
  for (let i = 0; i < inCount; i++) {
    const hash = c.take(32, `input ${i} previous txid`);
    const vout = c.u32(`input ${i} previous index`);
    const scriptSig = c.varBytes(`input ${i} scriptSig`);
    const sequence = c.u32(`input ${i} sequence`);
    inputs.push({ index: i, txid: reversedHex(hash), vout, sequence, scriptSigHex: bytesToHex(scriptSig), witness: [] });
  }
  const outCount = c.compact('output count', MAX_INPUT_OUTPUT_COUNT);
  const outputs: TxOutputView[] = [];
  for (let i = 0; i < outCount; i++) {
    const value = c.u64(`output ${i} amount`);
    if (value > MAX_MONEY) throw new ParseError(`${label}: output ${i} amount exceeds 21,000,000 BTC`, c.offset - 8);
    const script = c.varBytes(`output ${i} script`);
    outputs.push({ index: i, valueSats: value.toString(), scriptHex: bytesToHex(script) });
  }
  const bodyEnd = c.offset;
  if (segwit) {
    let anyWitness = false;
    for (let i = 0; i < inCount; i++) {
      const items = c.compact(`input ${i} witness item count`, 10000);
      for (let j = 0; j < items; j++) inputs[i].witness.push(bytesToHex(c.varBytes(`input ${i} witness item ${j}`)));
      if (items > 0) anyWitness = true;
    }
    if (!anyWitness && !opts.allowEmptyWitness) throw new ParseError(`${label}: SegWit serialization with no witness data (superfluous witness record)`);
  }
  const locktime = c.u32('locktime');
  if (c.remaining !== 0) throw new ParseError(`${label}: ${c.remaining} unexpected bytes after the locktime`, c.offset);
  const stripped = new Uint8Array(4 + (bodyEnd - bodyStart) + 4);
  stripped.set(bytes.subarray(0, 4), 0);
  stripped.set(bytes.subarray(bodyStart, bodyEnd), 4);
  stripped.set(bytes.subarray(bytes.length - 4), 4 + (bodyEnd - bodyStart));
  return {
    version,
    locktime,
    segwit,
    inputs,
    outputs,
    txid: reversedHex(hash256(stripped)),
    wtxid: reversedHex(hash256(bytes)),
    byteLength: bytes.length,
    hex: bytesToHex(bytes)
  };
}

/** Serialize a decoded transaction; with its witnesses when it was SegWit. */
export function serializeTransaction(tx: DecodedTransaction): Uint8Array {
  const parts: number[] = [];
  const u32 = (v: number) => parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const compact = (n: number) => {
    if (n < 0xfd) parts.push(n);
    else if (n <= 0xffff) parts.push(0xfd, n & 0xff, n >>> 8);
    else {
      parts.push(0xfe);
      u32(n);
    }
  };
  const hexBytes = (hex: string) => {
    for (let i = 0; i < hex.length; i += 2) parts.push(parseInt(hex.slice(i, i + 2), 16));
  };
  u32(tx.version);
  if (tx.segwit) parts.push(0x00, 0x01);
  compact(tx.inputs.length);
  for (const input of tx.inputs) {
    const txidLE = input.txid.match(/../g)!.reverse().join('');
    hexBytes(txidLE);
    u32(input.vout);
    compact(input.scriptSigHex.length / 2);
    hexBytes(input.scriptSigHex);
    u32(input.sequence);
  }
  compact(tx.outputs.length);
  for (const output of tx.outputs) {
    let v = BigInt(output.valueSats);
    for (let i = 0; i < 8; i++) {
      parts.push(Number(v & 0xffn));
      v >>= 8n;
    }
    compact(output.scriptHex.length / 2);
    hexBytes(output.scriptHex);
  }
  if (tx.segwit) {
    for (const input of tx.inputs) {
      compact(input.witness.length);
      for (const item of input.witness) {
        compact(item.length / 2);
        hexBytes(item);
      }
    }
  }
  u32(tx.locktime);
  return Uint8Array.from(parts);
}

function compactBytes(n: number): number[] {
  if (n < 0xfd) return [n];
  if (n <= 0xffff) return [0xfd, n & 0xff, n >>> 8];
  return [0xfe, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/**
 * Serialize PSBT maps back to bytes (magic, global, inputs, outputs), each entry as parsed.
 * Parsing then serializing a valid PSBT reproduces its exact bytes.
 */
export function serializePsbt(maps: { globalMap: ParsedPsbtMap; inputMaps: ParsedPsbtMap[]; outputMaps: ParsedPsbtMap[] }): Uint8Array {
  const out: number[] = [...PSBT_MAGIC];
  const push = (bytes: ArrayLike<number>) => {
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
  };
  const writeMap = (m: ParsedPsbtMap) => {
    for (const e of m.entries) {
      const keyType = compactBytes(e.keyType);
      push(compactBytes(keyType.length + e.keyData.length));
      push(keyType);
      push(e.keyData);
      push(compactBytes(e.valueData.length));
      push(e.valueData);
    }
    out.push(0x00);
  };
  writeMap(maps.globalMap);
  maps.inputMaps.forEach(writeMap);
  maps.outputMaps.forEach(writeMap);
  return Uint8Array.from(out);
}

/** PROPOSED NEW (OX-S01): decode a raw legacy or SegWit transaction. */
export function parseRawTransaction(bytes: Uint8Array): ParsedArtifactResult {
  const base = emptyResult(bytes, 'RAW_BITCOIN_TX', false);
  try {
    if (bytes.length > MAX_PAYLOAD_BYTES) throw new ParseError(`Payload of ${bytes.length} bytes exceeds the ${MAX_PAYLOAD_BYTES} byte bound`);
    const tx = decodeTransaction(bytes, 'Transaction', { allowWitness: true });
    return {
      ...base,
      status: 'decoded',
      transaction: tx,
      version: tx.version,
      locktime: tx.locktime,
      inputsCount: tx.inputs.length,
      outputsCount: tx.outputs.length,
      inputs: tx.inputs.map((i) => ({ ...blankInput(i.index), txid: i.txid, vout: i.vout, sequence: i.sequence, hasFinalScriptSig: i.scriptSigHex.length > 0, hasFinalScriptWitness: i.witness.length > 0 })),
      outputs: tx.outputs.map((o) => ({ index: o.index, valueSats: o.valueSats, scriptHex: o.scriptHex })),
      byteRanges: [{ startOffset: 0, endOffset: bytes.length, label: `Raw transaction ${tx.txid}`, isStandardEncoding: true }]
    };
  } catch (err) {
    return { ...base, status: 'malformed', errors: [(err as Error).message] };
  }
}

function blankInput(index: number): PsbtInputView {
  return {
    index,
    txid: null,
    vout: null,
    sequence: null,
    sighashType: null,
    prevoutValueSats: null,
    prevoutScriptHex: null,
    prevoutSource: null,
    partialSignaturePubkeys: [],
    hasTaprootKeySignature: false,
    hasFinalScriptSig: false,
    hasFinalScriptWitness: false,
    requiredTimeLocktime: null,
    requiredHeightLocktime: null
  };
}

function emptyResult(bytes: Uint8Array, format: ParsedArtifactResult['format'], magicValid: boolean): ParsedArtifactResult {
  return {
    status: 'malformed',
    format,
    psbtVersion: null,
    magicValid,
    totalByteLength: bytes.length,
    sha256: sha256Hex(bytes),
    rawHex: bytesToHex(bytes),
    globalMap: { mapType: 'global', entries: [], unknownEntries: [], duplicateKeysDetected: false },
    inputMaps: [],
    outputMaps: [],
    inputsCount: 0,
    outputsCount: 0,
    transaction: null,
    txModifiable: null,
    inputs: [],
    outputs: [],
    byteRanges: [],
    hasTaprootFields: false,
    hasUnknownFields: false,
    warnings: [],
    errors: []
  };
}

// Key types per map (BIP174, BIP370, BIP371, BIP373).
const GLOBAL_LABELS: Record<number, string> = {
  0x00: 'Unsigned Transaction (v0)',
  0x01: 'Extended Public Key',
  0x02: 'Transaction Version (v2)',
  0x03: 'Fallback Locktime (v2)',
  0x04: 'Input Count (v2)',
  0x05: 'Output Count (v2)',
  0x06: 'Transaction Modifiable Flags (v2)',
  0xfb: 'PSBT Version',
  0xfc: 'Proprietary'
};
const INPUT_LABELS: Record<number, string> = {
  0x00: 'Non-Witness UTXO',
  0x01: 'Witness UTXO',
  0x02: 'Partial Signature',
  0x03: 'Sighash Type',
  0x04: 'Redeem Script',
  0x05: 'Witness Script',
  0x06: 'BIP32 Derivation',
  0x07: 'Final ScriptSig',
  0x08: 'Final Script Witness',
  0x09: 'Proof of Reserves Commitment',
  0x0a: 'RIPEMD160 Preimage',
  0x0b: 'SHA256 Preimage',
  0x0c: 'HASH160 Preimage',
  0x0d: 'HASH256 Preimage',
  0x0e: 'Previous TXID (v2)',
  0x0f: 'Previous Output Index (v2)',
  0x10: 'Sequence (v2)',
  0x11: 'Required Time Locktime (v2)',
  0x12: 'Required Height Locktime (v2)',
  0x13: 'Taproot Key Signature',
  0x14: 'Taproot Script Signature',
  0x15: 'Taproot Leaf Script',
  0x16: 'Taproot BIP32 Derivation',
  0x17: 'Taproot Internal Key',
  0x18: 'Taproot Merkle Root',
  0x1a: 'MuSig2 Participant Keys',
  0x1b: 'MuSig2 Public Nonce',
  0x1c: 'MuSig2 Partial Signature',
  0xfc: 'Proprietary'
};
const OUTPUT_LABELS: Record<number, string> = {
  0x00: 'Redeem Script',
  0x01: 'Witness Script',
  0x02: 'BIP32 Derivation',
  0x03: 'Amount (v2)',
  0x04: 'Script (v2)',
  0x05: 'Taproot Internal Key',
  0x06: 'Taproot Tree',
  0x07: 'Taproot BIP32 Derivation',
  0x08: 'MuSig2 Participant Keys',
  0xfc: 'Proprietary'
};
const LABELS = { global: GLOBAL_LABELS, input: INPUT_LABELS, output: OUTPUT_LABELS };

// Key types whose key must carry no key data beyond the type.
const EMPTY_KEYDATA = {
  global: new Set([0x00, 0x02, 0x03, 0x04, 0x05, 0x06, 0xfb]),
  input: new Set([0x00, 0x01, 0x03, 0x04, 0x05, 0x07, 0x08, 0x09, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x17, 0x18]),
  output: new Set([0x00, 0x01, 0x03, 0x04, 0x05, 0x06])
};
const V2_ONLY = {
  global: new Set([0x02, 0x03, 0x04, 0x05, 0x06]),
  input: new Set([0x0e, 0x0f, 0x10, 0x11, 0x12]),
  output: new Set([0x03, 0x04])
};

const u32le = (b: Uint8Array) => (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
const i32le = (b: Uint8Array) => b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);

// secp256k1 point check for public keys carried in PSBT keys.
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}
const toBig = (bytes: Uint8Array) => BigInt(`0x${bytesToHex(bytes) || '0'}`);
export function isValidPublicKey(key: Uint8Array): boolean {
  if (key.length === 33 && (key[0] === 0x02 || key[0] === 0x03)) {
    const x = toBig(key.subarray(1));
    if (x >= P) return false;
    const rhs = (modPow(x, 3n, P) + 7n) % P;
    return rhs === 0n || modPow(rhs, (P - 1n) / 2n, P) === 1n;
  }
  if (key.length === 65 && key[0] === 0x04) {
    const x = toBig(key.subarray(1, 33));
    const y = toBig(key.subarray(33));
    if (x >= P || y >= P) return false;
    return (y * y) % P === (modPow(x, 3n, P) + 7n) % P;
  }
  return false;
}

function requireLength(entry: KeyValueEntry, allowed: number[], what: string) {
  if (!allowed.includes(entry.valueData.length)) {
    throw new ParseError(`${entry.label}: ${what} must be ${allowed.join(' or ')} bytes, found ${entry.valueData.length}`, entry.valueOffset);
  }
}

/** Validate the key data and value of a known key type. Unknown types are preserved as is. */
function validateEntry(mapType: 'global' | 'input' | 'output', e: KeyValueEntry) {
  const t = e.keyType;
  if (EMPTY_KEYDATA[mapType].has(t) && e.keyData.length !== 0) {
    throw new ParseError(`${e.label}: key must not carry key data (found ${e.keyData.length} bytes)`, e.keyOffset);
  }
  if (t === 0xfc) {
    const c = new Cursor(e.keyData, 'Proprietary key');
    c.varBytes('identifier');
    c.compact('subtype');
    return;
  }
  if (mapType === 'global') {
    if (t === 0x01) {
      if (e.keyData.length !== 78) throw new ParseError('Extended Public Key: key data must be 78 bytes', e.keyOffset);
      if (e.valueData.length < 4 || e.valueData.length % 4 !== 0) throw new ParseError('Extended Public Key: value must be a fingerprint and 32-bit path elements', e.valueOffset);
    }
    if (t === 0x02 || t === 0x03 || t === 0xfb) requireLength(e, [4], 'value');
    if (t === 0x06) requireLength(e, [1], 'value');
    if (t === 0x04 || t === 0x05) {
      const c = new Cursor(e.valueData, e.label);
      c.compact('count', MAX_INPUT_OUTPUT_COUNT);
      if (c.remaining !== 0) throw new ParseError(`${e.label}: value holds extra bytes`, e.valueOffset);
    }
  } else if (mapType === 'input') {
    if (t === 0x01) {
      const c = new Cursor(e.valueData, 'Witness UTXO');
      const v = c.u64('amount');
      if (v > MAX_MONEY) throw new ParseError('Witness UTXO: amount exceeds 21,000,000 BTC', e.valueOffset);
      c.varBytes('script');
      if (c.remaining !== 0) throw new ParseError('Witness UTXO: value holds extra bytes', e.valueOffset);
    }
    if (t === 0x02 || t === 0x06) {
      if (!isValidPublicKey(e.keyData)) throw new ParseError(`${e.label}: key data is not a valid public key`, e.keyOffset);
      if (t === 0x06 && (e.valueData.length < 4 || e.valueData.length % 4 !== 0)) throw new ParseError('BIP32 Derivation: value must be a fingerprint and 32-bit path elements', e.valueOffset);
    }
    if (t === 0x03 || t === 0x0f || t === 0x10 || t === 0x11 || t === 0x12) requireLength(e, [4], 'value');
    if (t === 0x0e) requireLength(e, [32], 'value');
    if (t === 0x0a || t === 0x0c) {
      if (e.keyData.length !== 20) throw new ParseError(`${e.label}: key data must be a 20 byte hash`, e.keyOffset);
    }
    if (t === 0x0b || t === 0x0d) {
      if (e.keyData.length !== 32) throw new ParseError(`${e.label}: key data must be a 32 byte hash`, e.keyOffset);
    }
    if (t === 0x08) {
      const c = new Cursor(e.valueData, 'Final Script Witness');
      const n = c.compact('item count', 10000);
      for (let i = 0; i < n; i++) c.varBytes(`item ${i}`);
      if (c.remaining !== 0) throw new ParseError('Final Script Witness: value holds extra bytes', e.valueOffset);
    }
    if (t === 0x11 && u32le(e.valueData) < LOCKTIME_THRESHOLD) throw new ParseError('Required Time Locktime must be at least 500000000', e.valueOffset);
    if (t === 0x12) {
      const h = u32le(e.valueData);
      if (h === 0 || h >= LOCKTIME_THRESHOLD) throw new ParseError('Required Height Locktime must be between 1 and 499999999', e.valueOffset);
    }
    if (t === 0x13) requireLength(e, [64, 65], 'Taproot key signature');
    if (t === 0x14) {
      if (e.keyData.length !== 64) throw new ParseError('Taproot Script Signature: key data must be an x-only key and leaf hash', e.keyOffset);
      requireLength(e, [64, 65], 'signature');
    }
    if (t === 0x15 && (e.keyData.length < 33 || (e.keyData.length - 33) % 32 !== 0)) throw new ParseError('Taproot Leaf Script: key data must be a control block', e.keyOffset);
    if (t === 0x16 && e.keyData.length !== 32) throw new ParseError('Taproot BIP32 Derivation: key data must be an x-only key', e.keyOffset);
    if (t === 0x17 || t === 0x18) requireLength(e, [32], 'value');
  } else {
    if (t === 0x02) {
      if (!isValidPublicKey(e.keyData)) throw new ParseError(`${e.label}: key data is not a valid public key`, e.keyOffset);
      if (e.valueData.length < 4 || e.valueData.length % 4 !== 0) throw new ParseError('BIP32 Derivation: value must be a fingerprint and 32-bit path elements', e.valueOffset);
    }
    if (t === 0x03) {
      requireLength(e, [8], 'value');
      if (new DataView(e.valueData.buffer, e.valueData.byteOffset, 8).getBigInt64(0, true) < 0n) throw new ParseError('Output Amount must not be negative', e.valueOffset);
    }
    if (t === 0x05) requireLength(e, [32], 'value');
    if (t === 0x07 && e.keyData.length !== 32) throw new ParseError('Taproot BIP32 Derivation: key data must be an x-only key', e.keyOffset);
  }
}

/**
 * BIP370 nLockTime determination: fallback when no input requires a locktime; otherwise the
 * type every locking input supports (height preferred on a tie) at its maximum; null when
 * the inputs require incompatible types.
 */
export function determineLocktime(fallback: number | null, inputs: PsbtInputView[]): number | null {
  const locking = inputs.filter((i) => i.requiredTimeLocktime !== null || i.requiredHeightLocktime !== null);
  if (locking.length === 0) return fallback ?? 0;
  const allHeight = locking.every((i) => i.requiredHeightLocktime !== null);
  const allTime = locking.every((i) => i.requiredTimeLocktime !== null);
  if (allHeight) return Math.max(...locking.map((i) => i.requiredHeightLocktime as number));
  if (allTime) return Math.max(...locking.map((i) => i.requiredTimeLocktime as number));
  return null;
}

/** Strict bounded PSBT parser (BIP174 version 0 and BIP370 version 2). */
export function parsePsbtBytes(bytes: Uint8Array): ParsedArtifactResult {
  const magicValid = bytes.length >= 5 && PSBT_MAGIC.every((b, i) => bytes[i] === b);
  const result = emptyResult(bytes, 'UNKNOWN', magicValid);
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    return { ...result, errors: [`Payload of ${bytes.length} bytes exceeds the ${MAX_PAYLOAD_BYTES} byte bound`] };
  }
  if (!magicValid) return { ...result, errors: ['Missing or malformed PSBT magic header (0x70736274ff)'] };

  const byteRanges: ByteRange[] = [{ startOffset: 0, endOffset: 5, label: 'PSBT Magic Header (psbt 0xff)', isStandardEncoding: true }];
  const c = new Cursor(bytes, 'PSBT');
  c.offset = 5;
  let hasTaprootFields = false;
  let hasUnknownFields = false;

  const parseMap = (mapType: 'global' | 'input' | 'output', index?: number): ParsedPsbtMap => {
    const entries: KeyValueEntry[] = [];
    const unknownEntries: KeyValueEntry[] = [];
    const seen = new Set<string>();
    const where = mapType === 'global' ? 'global map' : `${mapType} map ${index}`;
    for (;;) {
      if (c.remaining === 0) throw new ParseError(`The ${where} is missing its 0x00 separator (unexpected end of data)`, c.offset);
      const keyStart = c.offset;
      const keyLen = c.compact(`${where} key length`, c.remaining);
      if (keyLen === 0) {
        byteRanges.push({ startOffset: keyStart, endOffset: c.offset, label: `${mapType === 'global' ? 'Global' : `${mapType === 'input' ? 'Input' : 'Output'} ${index}`} map separator (0x00)`, isStandardEncoding: true });
        break;
      }
      if (entries.length >= MAX_MAP_ENTRIES) throw new ParseError(`The ${where} exceeds ${MAX_MAP_ENTRIES} entries`, keyStart);
      const key = c.take(keyLen, `${where} key`);
      const kc = new Cursor(key, `${where} key`);
      const keyType = kc.compact('key type');
      const keyData = key.subarray(kc.offset);
      const valueLen = c.compact(`${where} value length`, c.remaining);
      const valueOffset = c.offset;
      const valueData = c.take(valueLen, `${where} value`);
      const keyHex = bytesToHex(key);
      if (seen.has(keyHex)) throw new ParseError(`Duplicate key ${keyHex} in the ${where}`, keyStart);
      seen.add(keyHex);
      const known = keyType in LABELS[mapType];
      const label = known ? LABELS[mapType][keyType] : `Unknown ${mapType} key type 0x${keyType.toString(16)}`;
      const entry: KeyValueEntry = {
        keyType,
        keyData: Uint8Array.from(keyData),
        valueData: Uint8Array.from(valueData),
        keyHex,
        keyOffset: keyStart,
        valueOffset,
        totalLength: c.offset - keyStart,
        isProprietary: keyType === 0xfc,
        isUnknown: !known || keyType === 0xfc,
        label
      };
      validateEntry(mapType, entry);
      if ((mapType === 'input' && keyType >= 0x13 && keyType <= 0x18) || (mapType === 'output' && keyType >= 0x05 && keyType <= 0x07)) hasTaprootFields = true;
      if (entry.isUnknown) {
        hasUnknownFields = true;
        unknownEntries.push(entry);
      }
      entries.push(entry);
      byteRanges.push({ startOffset: keyStart, endOffset: c.offset, label, fieldKey: keyHex, isStandardEncoding: true });
    }
    return { mapType, index, entries, unknownEntries, duplicateKeysDetected: false };
  };

  try {
    const globalMap = parseMap('global');
    const g = (t: number) => globalMap.entries.find((e) => e.keyType === t);
    const versionEntry = g(0xfb);
    const psbtVersion = versionEntry ? u32le(versionEntry.valueData) : 0;
    if (psbtVersion !== 0 && psbtVersion !== 2) throw new UnsupportedError(`PSBT version ${psbtVersion} is not supported (only 0 and 2 are defined)`);

    let inCount: number;
    let outCount: number;
    let unsignedTx: DecodedTransaction | null = null;
    if (psbtVersion === 0) {
      const tx = g(0x00);
      if (!tx) throw new ParseError('A version 0 PSBT requires the global unsigned transaction (key 0x00)');
      for (const e of globalMap.entries) {
        if (V2_ONLY.global.has(e.keyType)) throw new ParseError(`${e.label} is not allowed in a version 0 PSBT`, e.keyOffset);
      }
      unsignedTx = decodeTransaction(tx.valueData, 'Global unsigned transaction', { allowWitness: false });
      unsignedTx.inputs.forEach((input) => {
        if (input.scriptSigHex.length > 0) throw new ParseError(`The unsigned transaction input ${input.index} has a non-empty scriptSig`);
      });
      inCount = unsignedTx.inputs.length;
      outCount = unsignedTx.outputs.length;
    } else {
      if (g(0x00)) throw new ParseError('A version 2 PSBT must not include the global unsigned transaction');
      for (const [t, name] of [[0x02, 'transaction version (0x02)'], [0x04, 'input count (0x04)'], [0x05, 'output count (0x05)']] as const) {
        if (!g(t)) throw new ParseError(`A version 2 PSBT requires the global ${name}`);
      }
      if (i32le(g(0x02)!.valueData) < 2) throw new ParseError('A version 2 PSBT requires a transaction version of at least 2');
      inCount = new Cursor(g(0x04)!.valueData, 'Input count').compact('count', MAX_INPUT_OUTPUT_COUNT);
      outCount = new Cursor(g(0x05)!.valueData, 'Output count').compact('count', MAX_INPUT_OUTPUT_COUNT);
    }

    const inputMaps: ParsedPsbtMap[] = [];
    for (let i = 0; i < inCount; i++) inputMaps.push(parseMap('input', i));
    const outputMaps: ParsedPsbtMap[] = [];
    for (let i = 0; i < outCount; i++) outputMaps.push(parseMap('output', i));
    if (c.remaining !== 0) throw new ParseError(`${c.remaining} unexpected bytes after the last output map`, c.offset);

    const find = (m: ParsedPsbtMap, t: number) => m.entries.find((e) => e.keyType === t);
    const inputs: PsbtInputView[] = inputMaps.map((m, i) => {
      if (psbtVersion === 0) {
        for (const e of m.entries) if (V2_ONLY.input.has(e.keyType)) throw new ParseError(`${e.label} is not allowed in a version 0 PSBT`, e.keyOffset);
      } else {
        if (!find(m, 0x0e)) throw new ParseError(`Input ${i} of a version 2 PSBT requires the previous txid (0x0e)`);
        if (!find(m, 0x0f)) throw new ParseError(`Input ${i} of a version 2 PSBT requires the previous output index (0x0f)`);
      }
      const view = blankInput(i);
      if (unsignedTx) {
        view.txid = unsignedTx.inputs[i].txid;
        view.vout = unsignedTx.inputs[i].vout;
        view.sequence = unsignedTx.inputs[i].sequence;
      } else {
        view.txid = reversedHex(find(m, 0x0e)!.valueData);
        view.vout = u32le(find(m, 0x0f)!.valueData);
        const seq = find(m, 0x10);
        view.sequence = seq ? u32le(seq.valueData) : 0xffffffff;
        const t = find(m, 0x11);
        const hgt = find(m, 0x12);
        view.requiredTimeLocktime = t ? u32le(t.valueData) : null;
        view.requiredHeightLocktime = hgt ? u32le(hgt.valueData) : null;
      }
      const sighash = find(m, 0x03);
      view.sighashType = sighash ? u32le(sighash.valueData) : null;
      const wu = find(m, 0x01);
      const nwu = find(m, 0x00);
      if (nwu) {
        const prev = decodeTransaction(nwu.valueData, `Input ${i} non-witness UTXO`, { allowWitness: true });
        if (prev.txid !== view.txid) throw new ParseError(`Input ${i} non-witness UTXO hashes to ${prev.txid}, not the spent txid ${view.txid}`);
        const out = prev.outputs[view.vout as number];
        if (!out) throw new ParseError(`Input ${i} non-witness UTXO has no output ${view.vout}`);
        view.prevoutValueSats = out.valueSats;
        view.prevoutScriptHex = out.scriptHex;
        view.prevoutSource = 'non_witness_utxo';
      }
      if (wu) {
        const wc = new Cursor(wu.valueData, 'Witness UTXO');
        const value = wc.u64('amount').toString();
        const script = bytesToHex(wc.varBytes('script'));
        if (view.prevoutSource === 'non_witness_utxo' && (view.prevoutValueSats !== value || view.prevoutScriptHex !== script)) {
          throw new ParseError(`Input ${i} witness UTXO disagrees with its non-witness UTXO`);
        }
        view.prevoutValueSats = value;
        view.prevoutScriptHex = script;
        view.prevoutSource = view.prevoutSource || 'witness_utxo';
      }
      view.partialSignaturePubkeys = m.entries.filter((e) => e.keyType === 0x02).map((e) => bytesToHex(e.keyData));
      view.hasTaprootKeySignature = !!find(m, 0x13);
      view.hasFinalScriptSig = !!find(m, 0x07);
      view.hasFinalScriptWitness = !!find(m, 0x08);
      return view;
    });

    const outputs: PsbtOutputView[] = outputMaps.map((m, i) => {
      if (psbtVersion === 0) {
        for (const e of m.entries) if (V2_ONLY.output.has(e.keyType)) throw new ParseError(`${e.label} is not allowed in a version 0 PSBT`, e.keyOffset);
        return { index: i, valueSats: unsignedTx!.outputs[i].valueSats, scriptHex: unsignedTx!.outputs[i].scriptHex };
      }
      const amount = find(m, 0x03);
      const script = find(m, 0x04);
      if (!amount) throw new ParseError(`Output ${i} of a version 2 PSBT requires the amount (0x03)`);
      if (!script) throw new ParseError(`Output ${i} of a version 2 PSBT requires the script (0x04)`);
      return {
        index: i,
        valueSats: new DataView(amount.valueData.buffer, amount.valueData.byteOffset, 8).getBigUint64(0, true).toString(),
        scriptHex: bytesToHex(script.valueData)
      };
    });

    const fallback = g(0x03) ? u32le(g(0x03)!.valueData) : null;
    const modifiable = g(0x06) ? g(0x06)!.valueData[0] : null;
    return {
      ...result,
      status: 'decoded',
      format: psbtVersion === 2 ? 'PSBT_V2' : 'PSBT_V0',
      psbtVersion: psbtVersion as 0 | 2,
      globalMap,
      inputMaps,
      outputMaps,
      inputsCount: inCount,
      outputsCount: outCount,
      transaction: unsignedTx,
      version: unsignedTx ? unsignedTx.version : i32le(g(0x02)!.valueData),
      locktime: unsignedTx ? unsignedTx.locktime : determineLocktime(fallback, inputs),
      txModifiable: modifiable,
      inputs,
      outputs,
      byteRanges,
      hasTaprootFields,
      hasUnknownFields
    };
  } catch (err) {
    if (err instanceof UnsupportedError) return { ...result, status: 'unsupported', byteRanges, errors: [err.message] };
    if (err instanceof ParseError) return { ...result, status: 'malformed', byteRanges, errors: [err.message] };
    throw err;
  }
}

/**
 * Hex or Base64 to bytes, with the size bound checked before anything is allocated.
 */
export function payloadToBytes(input: string): Uint8Array {
  const trimmed = input.replace(/\s+/g, '');
  if (trimmed.length === 0) throw new Error('The input is empty');
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    if (trimmed.length % 2 !== 0) throw new Error('Hex input has an odd number of digits');
    if (trimmed.length / 2 > MAX_PAYLOAD_BYTES) throw new Error(`The payload exceeds the ${MAX_PAYLOAD_BYTES} byte bound`);
    const bytes = new Uint8Array(trimmed.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(trimmed.substr(i * 2, 2), 16);
    return bytes;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) throw new Error('Input is neither valid hex nor valid Base64');
  if ((trimmed.length / 4) * 3 > MAX_PAYLOAD_BYTES + 3) throw new Error(`The payload exceeds the ${MAX_PAYLOAD_BYTES} byte bound`);
  const binary = atob(trimmed);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length > MAX_PAYLOAD_BYTES) throw new Error(`The payload exceeds the ${MAX_PAYLOAD_BYTES} byte bound`);
  return bytes;
}

/** Decode any supported artifact: a PSBT when the magic is present, otherwise a raw transaction. */
export function parseArtifact(input: string): ParsedArtifactResult {
  let bytes: Uint8Array;
  try {
    bytes = payloadToBytes(input);
  } catch (err) {
    const empty = new Uint8Array(0);
    return { ...emptyResult(empty, 'UNKNOWN', false), errors: [(err as Error).message] };
  }
  if (bytes.length >= 5 && PSBT_MAGIC.every((b, i) => bytes[i] === b)) return parsePsbtBytes(bytes);
  const tx = parseRawTransaction(bytes);
  if (tx.status === 'decoded') return tx;
  return { ...tx, format: 'UNKNOWN', errors: [`Not a PSBT (no magic header) and not a valid transaction: ${tx.errors[0]}`] };
}
