// secp256k1 signature verification for the Ordex reference verifiers.
//
// Verification only: ECDSA over DER signatures (BIP66 strict encoding, BIP62
// low S) and BIP340 Schnorr, plus the BIP341 key tweak a Taproot output
// commits to. Nothing here signs or holds a key. Arithmetic is BigInt over the
// curve's prime field, dependency free, and checked against the BIP340 test
// vectors and OpenSSL signatures in secp256k1.test.js.

import { createHash } from 'node:crypto';

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N >> 1n;
const G = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
};

const mod = (a, m = P) => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

function pow(base, exponent, m = P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function invert(a, m = P) {
  // Extended Euclid; a is never 0 mod m where this is called.
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return mod(oldS, m);
}

// Jacobian coordinates: (X, Y, Z) is the affine point (X / Z^2, Y / Z^3).
const INFINITY = { X: 1n, Y: 1n, Z: 0n };

function toJacobian(point) {
  return { X: point.x, Y: point.y, Z: 1n };
}

function toAffine(point) {
  if (point.Z === 0n) return null;
  const zInv = invert(point.Z);
  const zInv2 = (zInv * zInv) % P;
  return { x: (point.X * zInv2) % P, y: (point.Y * zInv2 * zInv) % P };
}

function double(point) {
  if (point.Z === 0n || point.Y === 0n) return INFINITY;
  const { X, Y, Z } = point;
  const YY = (Y * Y) % P;
  const S = (4n * X * YY) % P;
  const M = (3n * X * X) % P;
  const X3 = mod(M * M - 2n * S);
  const Y3 = mod(M * (S - X3) - 8n * YY * YY);
  const Z3 = (2n * Y * Z) % P;
  return { X: X3, Y: Y3, Z: Z3 };
}

function add(a, b) {
  if (a.Z === 0n) return b;
  if (b.Z === 0n) return a;
  const Z1Z1 = (a.Z * a.Z) % P;
  const Z2Z2 = (b.Z * b.Z) % P;
  const U1 = (a.X * Z2Z2) % P;
  const U2 = (b.X * Z1Z1) % P;
  const S1 = (a.Y * b.Z * Z2Z2) % P;
  const S2 = (b.Y * a.Z * Z1Z1) % P;
  if (U1 === U2) return S1 === S2 ? double(a) : INFINITY;
  const H = mod(U2 - U1);
  const R = mod(S2 - S1);
  const HH = (H * H) % P;
  const HHH = (H * HH) % P;
  const V = (U1 * HH) % P;
  const X3 = mod(R * R - HHH - 2n * V);
  const Y3 = mod(R * (V - X3) - S1 * HHH);
  const Z3 = (a.Z * b.Z * H) % P;
  return { X: X3, Y: Y3, Z: Z3 };
}

function multiply(point, scalar) {
  let result = INFINITY;
  let addend = toJacobian(point);
  let k = scalar;
  while (k > 0n) {
    if (k & 1n) result = add(result, addend);
    addend = double(addend);
    k >>= 1n;
  }
  return result;
}

/** u1*G + u2*Q in one pass (Shamir's trick). */
function multiplyTwo(u1, q, u2) {
  const g = toJacobian(G);
  const qj = toJacobian(q);
  const gq = add(g, qj);
  let result = INFINITY;
  const bits = Math.max(u1.toString(2).length, u2.toString(2).length);
  for (let i = bits - 1; i >= 0; i -= 1) {
    result = double(result);
    const b1 = (u1 >> BigInt(i)) & 1n;
    const b2 = (u2 >> BigInt(i)) & 1n;
    if (b1 && b2) result = add(result, gq);
    else if (b1) result = add(result, g);
    else if (b2) result = add(result, qj);
  }
  return result;
}

const isOnCurve = ({ x, y }) => mod(y * y - (x * x * x + 7n)) === 0n;

function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntTo32(value) {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** BIP340 lift_x: the point with x and an even y, or null. */
export function liftX(x) {
  if (x >= P) return null;
  const c = mod(x * x * x + 7n);
  const y = pow(c, (P + 1n) / 4n);
  if ((y * y) % P !== c) return null;
  return { x, y: y % 2n === 0n ? y : P - y };
}

/** Decode a 33-byte compressed or 65-byte uncompressed public key, or null. */
export function decodePublicKey(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  if (bytes.length === 33 && (bytes[0] === 2 || bytes[0] === 3)) {
    const point = liftX(bytesToBigInt(bytes.subarray(1)));
    if (!point) return null;
    const odd = bytes[0] === 3;
    return (point.y % 2n === 1n) === odd ? point : { x: point.x, y: P - point.y };
  }
  if (bytes.length === 65 && bytes[0] === 4) {
    const point = { x: bytesToBigInt(bytes.subarray(1, 33)), y: bytesToBigInt(bytes.subarray(33)) };
    if (point.x >= P || point.y >= P || !isOnCurve(point)) return null;
    return point;
  }
  return null;
}

/**
 * Parse a DER signature under BIP66 strict rules. Returns { r, s } or null.
 * The sighash byte must already be removed.
 */
export function parseDerSignature(der) {
  if (!(der instanceof Uint8Array) || der.length < 8 || der.length > 72) return null;
  if (der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const rLength = der[3];
  if (der[2] !== 0x02 || rLength === 0 || 5 + rLength >= der.length) return null;
  const sLength = der[5 + rLength];
  if (der[4 + rLength] !== 0x02 || sLength === 0 || rLength + sLength + 6 !== der.length) return null;
  const rBytes = der.subarray(4, 4 + rLength);
  const sBytes = der.subarray(6 + rLength);
  for (const part of [rBytes, sBytes]) {
    if (part[0] & 0x80) return null; // negative
    if (part.length > 1 && part[0] === 0 && !(part[1] & 0x80)) return null; // padded
  }
  return { r: bytesToBigInt(rBytes), s: bytesToBigInt(sBytes) };
}

/**
 * ECDSA verification of a 32-byte message hash. Returns false for any malformed
 * input, a non-strict DER encoding, or a high S, which Bitcoin Core's standard
 * policy refuses to relay.
 */
export function verifyEcdsa(messageHash, derSignature, publicKey) {
  if (!(messageHash instanceof Uint8Array) || messageHash.length !== 32) return false;
  const signature = parseDerSignature(derSignature);
  const q = decodePublicKey(publicKey);
  if (!signature || !q) return false;
  const { r, s } = signature;
  if (r < 1n || r >= N || s < 1n || s >= N || s > HALF_N) return false;
  const z = bytesToBigInt(messageHash);
  const w = invert(s, N);
  const point = toAffine(multiplyTwo(mod(z * w, N), q, mod(r * w, N)));
  return point !== null && mod(point.x, N) === r;
}

function sha256(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

/** BIP340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || data...). */
export function taggedHash(tag, ...parts) {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(tagHash, tagHash, ...parts);
}

/**
 * BIP340 Schnorr verification under a 32-byte x-only key. Taproot always signs
 * a 32-byte sighash; BIP340 itself allows a message of any length.
 */
export function verifySchnorr(message, signature, publicKeyX) {
  if (!(message instanceof Uint8Array) || !(signature instanceof Uint8Array) || !(publicKeyX instanceof Uint8Array)) {
    return false;
  }
  if (signature.length !== 64 || publicKeyX.length !== 32) return false;
  const point = liftX(bytesToBigInt(publicKeyX));
  if (!point) return false;
  const r = bytesToBigInt(signature.subarray(0, 32));
  const s = bytesToBigInt(signature.subarray(32));
  if (r >= P || s >= N) return false;
  const e = mod(bytesToBigInt(taggedHash('BIP0340/challenge', signature.subarray(0, 32), publicKeyX, message)), N);
  const R = toAffine(multiplyTwo(s, point, mod(N - e, N)));
  if (!R || R.y % 2n !== 0n) return false;
  return R.x === r;
}

/**
 * The BIP341 output key for an internal x-only key and a script tree root
 * (null for a key-path-only output). Returns { outputKey, parity } with the
 * 32-byte x-only output key, or null when the tweak is invalid.
 */
export function taprootTweak(internalKeyX, merkleRoot) {
  if (!(internalKeyX instanceof Uint8Array) || internalKeyX.length !== 32) return null;
  if (merkleRoot !== null && (!(merkleRoot instanceof Uint8Array) || merkleRoot.length !== 32)) return null;
  const internal = liftX(bytesToBigInt(internalKeyX));
  if (!internal) return null;
  const t = bytesToBigInt(taggedHash('TapTweak', internalKeyX, ...(merkleRoot ? [merkleRoot] : [])));
  if (t >= N) return null;
  const q = toAffine(add(toJacobian(internal), multiply(G, t)));
  if (!q) return null;
  return { outputKey: bigIntTo32(q.x), parity: Number(q.y & 1n) };
}

/** The x-only public key of a private scalar, for tests and fixtures only. */
export function publicKeyXFromScalar(scalar) {
  if (typeof scalar !== 'bigint' || scalar <= 0n || scalar >= N) return null;
  const point = toAffine(multiply(G, scalar));
  return { x: bigIntTo32(point.x), yOdd: point.y % 2n === 1n };
}
