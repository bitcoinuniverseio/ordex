// OX-S07: browser implementation of the exact node:crypto surface the reference verifiers
// use (createHash('sha256'), createHash('ripemd160'), createHmac('sha256', key), timingSafeEqual). Browser and
// Worker bundles resolve `node:crypto` here (see site/astro.config.mjs); Node keeps its
// own module. SHA-256 follows FIPS 180-4, RIPEMD-160 its 1996 specification, and HMAC RFC 2104. Anything outside this
// surface throws, so a verifier can never silently fall back to a weaker primitive.
// tests/unit/browser-crypto.test.js checks every function byte for byte against Node.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

function compress(state, block, offset, w) {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    w[i] = (block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = 0; i < 64; i++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0;
  state[5] = (state[5] + f) | 0;
  state[6] = (state[6] + g) | 0;
  state[7] = (state[7] + h) | 0;
}

/** SHA-256 of a byte array, returned as 32 bytes. */
export function sha256Bytes(bytes) {
  const state = Int32Array.from(H0);
  const w = new Int32Array(64);
  const full = bytes.length - (bytes.length % 64);
  for (let off = 0; off < full; off += 64) compress(state, bytes, off, w);
  const tailLen = bytes.length - full;
  const tail = new Uint8Array(tailLen < 56 ? 64 : 128);
  tail.set(bytes.subarray(full));
  tail[tailLen] = 0x80;
  const bitLen = bytes.length * 8;
  const view = new DataView(tail.buffer);
  view.setUint32(tail.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(tail.length - 4, bitLen >>> 0);
  for (let off = 0; off < tail.length; off += 64) compress(state, tail, off, w);
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, state[i]);
  return out;
}

// RIPEMD-160 (Dobbertin, Bosselaers, Preneel), used by the Bitcoin HASH160 of bitcoin-tx.js.
const RL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13];
const RR = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11];
const SL = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6];
const SR = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11];
const KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
const KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];
const rotl = (x, n) => (x << n) | (x >>> (32 - n));
const rf = (j, x, y, z) =>
  j < 16 ? x ^ y ^ z : j < 32 ? (x & y) | (~x & z) : j < 48 ? (x | ~y) ^ z : j < 64 ? (x & z) | (y & ~z) : x ^ (y | ~z);

/** RIPEMD-160 of a byte array, returned as 20 bytes. */
export function ripemd160Bytes(bytes) {
  const padLen = bytes.length % 64 < 56 ? 64 : 128;
  const msg = new Uint8Array(bytes.length - (bytes.length % 64) + padLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  const bitLen = bytes.length * 8;
  view.setUint32(msg.length - 8, bitLen >>> 0, true);
  view.setUint32(msg.length - 4, Math.floor(bitLen / 0x100000000), true);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const x = new Int32Array(16);
  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) x[i] = view.getInt32(off + i * 4, true);
    let [al, bl, cl, dl, el] = h;
    let [ar, br, cr, dr, er] = h;
    for (let j = 0; j < 80; j++) {
      const r = j >> 4;
      let t = (rotl((al + rf(j, bl, cl, dl) + x[RL[j]] + KL[r]) | 0, SL[j]) + el) | 0;
      al = el;
      el = dl;
      dl = rotl(cl, 10);
      cl = bl;
      bl = t;
      t = (rotl((ar + rf(79 - j, br, cr, dr) + x[RR[j]] + KR[r]) | 0, SR[j]) + er) | 0;
      ar = er;
      er = dr;
      dr = rotl(cr, 10);
      cr = br;
      br = t;
    }
    const t = (h[1] + cl + dr) | 0;
    h[1] = (h[2] + dl + er) | 0;
    h[2] = (h[3] + el + ar) | 0;
    h[3] = (h[4] + al + br) | 0;
    h[4] = (h[0] + bl + cr) | 0;
    h[0] = t;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) outView.setInt32(i * 4, h[i], true);
  return out;
}

const encoder = new TextEncoder();

function toBytes(data, encoding) {
  if (typeof data === 'string') {
    if (encoding === undefined || encoding === 'utf8' || encoding === 'utf-8') return encoder.encode(data);
    if (encoding === 'hex') {
      if (data.length % 2 !== 0 || /[^0-9a-fA-F]/.test(data)) throw new TypeError('Invalid hex input');
      const out = new Uint8Array(data.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    throw new TypeError(`Unsupported input encoding in browser crypto: ${encoding}`);
  }
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('Data must be a string or a byte array');
}

function concat(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function encodeDigest(bytes, encoding) {
  if (encoding === undefined) return bytes;
  if (encoding === 'hex') {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
  }
  if (encoding === 'base64') {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  throw new TypeError(`Unsupported digest encoding in browser crypto: ${encoding}`);
}

function requireSha256(algorithm) {
  if (String(algorithm).toLowerCase() !== 'sha256') {
    throw new Error(`Browser verifier crypto supports sha256 only, not ${algorithm}`);
  }
}

class Sha256Hash {
  constructor(fn = sha256Bytes) {
    this.fn = fn;
    this.chunks = [];
    this.done = false;
  }
  update(data, encoding) {
    if (this.done) throw new Error('Digest already called');
    this.chunks.push(toBytes(data, encoding));
    return this;
  }
  digest(encoding) {
    if (this.done) throw new Error('Digest already called');
    this.done = true;
    return encodeDigest(this.fn(concat(this.chunks)), encoding);
  }
}

class HmacSha256 {
  constructor(key) {
    let k = toBytes(key, 'utf8');
    if (k.length > 64) k = sha256Bytes(k);
    const block = new Uint8Array(64);
    block.set(k);
    this.inner = new Uint8Array(64);
    this.outer = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      this.inner[i] = block[i] ^ 0x36;
      this.outer[i] = block[i] ^ 0x5c;
    }
    this.chunks = [];
    this.done = false;
  }
  update(data, encoding) {
    if (this.done) throw new Error('Digest already called');
    this.chunks.push(toBytes(data, encoding));
    return this;
  }
  digest(encoding) {
    if (this.done) throw new Error('Digest already called');
    this.done = true;
    const innerHash = sha256Bytes(concat([this.inner, ...this.chunks]));
    return encodeDigest(sha256Bytes(concat([this.outer, innerHash])), encoding);
  }
}

export function createHash(algorithm) {
  if (String(algorithm).toLowerCase() === 'ripemd160') return new Sha256Hash(ripemd160Bytes);
  requireSha256(algorithm);
  return new Sha256Hash();
}

export function createHmac(algorithm, key) {
  requireSha256(algorithm);
  return new HmacSha256(key);
}

/** Constant-time comparison with Node's contract: equal lengths are required. */
export function timingSafeEqual(a, b) {
  const left = toBytes(a);
  const right = toBytes(b);
  if (left.length !== right.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export default { createHash, createHmac, timingSafeEqual };
