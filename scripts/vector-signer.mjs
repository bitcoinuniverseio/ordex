// Deterministic signer for conformance fixtures. Test keys only: every key is
// derived from a public label, so nothing signed here is spendable value.
// The verifiers never sign; they check what this produces the same way they
// check a wallet's signature.

import { createHash } from 'node:crypto';

import { bytesToHex, hash160, hexToBytes, segwitV0Sighash, taprootSighash } from '../verifier/bitcoin-tx.js';
import { publicKeyXFromScalar, taggedHash, taprootTweak } from '../verifier/secp256k1.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const toBig = (bytes) => BigInt(`0x${bytesToHex(bytes) || '0'}`);
const to32 = (value) => hexToBytes(value.toString(16).padStart(64, '0'));
const mod = (a, m = N) => ((a % m) + m) % m;

function invert(a, m = N) {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return mod(oldS, m);
}

/** A private scalar derived from a label. */
export function testKey(label) {
  return mod(toBig(createHash('sha256').update(`ordex-test-key:${label}`).digest())) || 1n;
}

export function compressedPublicKey(scalar) {
  const { x, yOdd } = publicKeyXFromScalar(scalar);
  return `${yOdd ? '03' : '02'}${bytesToHex(x)}`;
}

export const p2wpkhScript = (scalar) => `0014${bytesToHex(hash160(hexToBytes(compressedPublicKey(scalar))))}`;

/** The BIP86 key-path output key for a scalar, and its script. */
export function p2trKeyPath(scalar) {
  const internal = publicKeyXFromScalar(scalar).x;
  const { outputKey } = taprootTweak(internal, null);
  return { internalKey: bytesToHex(internal), outputKey: bytesToHex(outputKey), scriptHex: `5120${bytesToHex(outputKey)}` };
}

/** BIP340 signing with zero auxiliary randomness. */
export function schnorrSign(message, scalar) {
  const P = publicKeyXFromScalar(scalar);
  const d = P.yOdd ? N - scalar : scalar;
  const t = d ^ toBig(taggedHash('BIP0340/aux', new Uint8Array(32)));
  const k0 = mod(toBig(taggedHash('BIP0340/nonce', to32(t), P.x, message)));
  const R = publicKeyXFromScalar(k0);
  const k = R.yOdd ? N - k0 : k0;
  const e = mod(toBig(taggedHash('BIP0340/challenge', R.x, P.x, message)));
  return new Uint8Array([...R.x, ...to32(mod(k + e * d))]);
}

/** The key-path witness item for input `index` (64 bytes for DEFAULT). */
export function signTaprootKeyPath(tx, index, prevouts, scalar, hashType = 0x00) {
  const P = publicKeyXFromScalar(scalar);
  const d = P.yOdd ? N - scalar : scalar;
  const tweak = toBig(taggedHash('TapTweak', P.x));
  const tweaked = mod(d + tweak);
  const digest = taprootSighash(tx, index, prevouts, hashType);
  const signature = schnorrSign(digest, tweaked);
  return bytesToHex(signature) + (hashType === 0x00 ? '' : hashType.toString(16).padStart(2, '0'));
}

/** Script path signature for a leaf; 64 bytes for DEFAULT. */
export function signTaprootScriptPath(tx, index, prevouts, scalar, leafHash, hashType = 0x00) {
  const digest = taprootSighash(tx, index, prevouts, hashType, { leafHash });
  return bytesToHex(schnorrSign(digest, scalar)) + (hashType === 0x00 ? '' : hashType.toString(16).padStart(2, '0'));
}

function derInteger(value) {
  let bytes = hexToBytes(value.toString(16).padStart(64, '0'));
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && !(bytes[start + 1] & 0x80)) start += 1;
  bytes = bytes.subarray(start);
  if (bytes[0] & 0x80) bytes = new Uint8Array([0, ...bytes]);
  return [0x02, bytes.length, ...bytes];
}

/** Deterministic low-S ECDSA over a 32-byte digest, DER encoded. */
export function ecdsaSign(digest, scalar) {
  const z = toBig(digest);
  let k = mod(toBig(createHash('sha256').update(to32(scalar)).update(digest).digest()));
  for (;;) {
    const r = mod(toBig(publicKeyXFromScalar(k).x));
    let s = mod(invert(k) * (z + r * scalar));
    if (r !== 0n && s !== 0n) {
      if (s > N / 2n) s = N - s;
      const body = [...derInteger(r), ...derInteger(s)];
      return bytesToHex(new Uint8Array([0x30, body.length, ...body]));
    }
    k = mod(k + 1n);
  }
}

/** The witness [signature, key] for a P2WPKH input. */
export function signP2wpkh(tx, index, prevouts, scalar, hashType = 0x01) {
  const program = prevouts[index].scriptHex.slice(4);
  const digest = segwitV0Sighash(tx, index, hexToBytes(`76a914${program}88ac`), prevouts[index].valueSats, hashType);
  return [ecdsaSign(digest, scalar) + hashType.toString(16).padStart(2, '0'), compressedPublicKey(scalar)];
}

// ---------------------------------------------------------------------------
// PSBT encoding for fixtures (BIP174 v0 and BIP370 v2).

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const le = (n, bytes) => {
  const out = new Uint8Array(bytes);
  let v = BigInt(n);
  for (let i = 0; i < bytes; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};
const compact = (n) => (n < 0xfd ? Uint8Array.of(n) : n <= 0xffff ? cat(Uint8Array.of(0xfd), le(n, 2)) : cat(Uint8Array.of(0xfe), le(n, 4)));
const pair = (type, keyData, value) => {
  const key = cat(compact(type), keyData);
  return cat(compact(key.length), key, compact(value.length), value);
};
const txOut = ({ valueSats, scriptHex }) => cat(le(valueSats, 8), compact(scriptHex.length / 2), hexToBytes(scriptHex));
const witnessStack = (items) => cat(compact(items.length), ...items.map((h) => cat(compact(h.length / 2), hexToBytes(h))));

/**
 * Encode a PSBT. inputs[i]: { witnessUtxo?, partialSigs? [{ pubkey, sig }],
 * tapKeySig?, finalWitness?, finalScriptSig?, sighashType? }. Returns base64.
 */
export function encodePsbt({ version = 0, tx, inputs }) {
  const parts = [Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff)];
  if (version === 0) {
    const unsigned = serializeUnsigned(tx);
    parts.push(pair(0x00, new Uint8Array(0), unsigned));
  } else {
    parts.push(
      pair(0x02, new Uint8Array(0), le(tx.version, 4)),
      pair(0x03, new Uint8Array(0), le(tx.lockTime, 4)),
      pair(0x04, new Uint8Array(0), compact(tx.inputs.length)),
      pair(0x05, new Uint8Array(0), compact(tx.outputs.length)),
      pair(0xfb, new Uint8Array(0), le(2, 4))
    );
  }
  parts.push(Uint8Array.of(0x00));
  tx.inputs.forEach((input, i) => {
    const fields = inputs[i] ?? {};
    if (version === 2) {
      parts.push(
        pair(0x0e, new Uint8Array(0), hexToBytes(input.txid).reverse()),
        pair(0x0f, new Uint8Array(0), le(input.vout, 4)),
        pair(0x10, new Uint8Array(0), le(input.sequence, 4))
      );
    }
    if (fields.witnessUtxo) parts.push(pair(0x01, new Uint8Array(0), txOut(fields.witnessUtxo)));
    for (const { pubkey, sig } of fields.partialSigs ?? []) parts.push(pair(0x02, hexToBytes(pubkey), hexToBytes(sig)));
    if (fields.sighashType !== undefined) parts.push(pair(0x03, new Uint8Array(0), le(fields.sighashType, 4)));
    if (fields.finalScriptSig !== undefined) parts.push(pair(0x07, new Uint8Array(0), hexToBytes(fields.finalScriptSig)));
    if (fields.finalWitness !== undefined) parts.push(pair(0x08, new Uint8Array(0), witnessStack(fields.finalWitness)));
    if (fields.tapKeySig !== undefined) parts.push(pair(0x13, new Uint8Array(0), hexToBytes(fields.tapKeySig)));
    parts.push(Uint8Array.of(0x00));
  });
  tx.outputs.forEach((output) => {
    if (version === 2) {
      parts.push(pair(0x03, new Uint8Array(0), le(output.valueSats, 8)), pair(0x04, new Uint8Array(0), hexToBytes(output.scriptHex)));
    }
    parts.push(Uint8Array.of(0x00));
  });
  return Buffer.from(cat(...parts)).toString('base64');
}

function serializeUnsigned(tx) {
  return cat(
    le(tx.version, 4),
    compact(tx.inputs.length),
    ...tx.inputs.map((input) => cat(hexToBytes(input.txid).reverse(), le(input.vout, 4), compact(0), le(input.sequence, 4))),
    compact(tx.outputs.length),
    ...tx.outputs.map(txOut),
    le(tx.lockTime, 4)
  );
}
