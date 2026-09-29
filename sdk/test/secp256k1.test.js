import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  decodePublicKey,
  parseDerSignature,
  publicKeyXFromScalar,
  taprootTweak,
  verifyEcdsa,
  verifySchnorr,
} from '../dist/index.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`../../verifier/fixtures/${name}`, import.meta.url)), 'utf8');
const hex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

test('BIP340: every official test vector verifies exactly as the BIP states', () => {
  const rows = fixture('bip340-test-vectors.csv').trim().split(/\r?\n/).slice(1);
  assert.ok(rows.length >= 19);
  for (const row of rows) {
    const [index, secret, publicKey, , message, signature, result] = row.split(',');
    const expected = result === 'TRUE';
    assert.equal(verifySchnorr(hex(message), hex(signature), hex(publicKey)), expected, `vector ${index}`);
    if (secret) {
      const derived = publicKeyXFromScalar(BigInt(`0x${secret}`));
      assert.equal(Buffer.from(derived.x).toString('hex').toUpperCase(), publicKey, `vector ${index} key`);
    }
  }
});

function lowS(der) {
  // Re-encode an OpenSSL signature with S normalized below N/2.
  const { r, s } = parseDerSignature(der);
  const normal = s > N / 2n ? N - s : s;
  const encode = (value) => {
    let h = value.toString(16);
    if (h.length % 2) h = `0${h}`;
    let bytes = Buffer.from(h, 'hex');
    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const body = Buffer.concat([encode(r), encode(normal)]);
  return { der: new Uint8Array(Buffer.concat([Buffer.from([0x30, body.length]), body])), flipped: normal !== s, s };
}

test('ECDSA agrees with OpenSSL secp256k1 on random keys and messages', () => {
  for (let i = 0; i < 24; i += 1) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const point = new Uint8Array(spki.subarray(spki.length - 65));
    const message = randomBytes(40);
    const digest = new Uint8Array(createHash('sha256').update(message).digest());
    const signature = createSign('SHA256').update(message).sign(privateKey);
    const { der } = lowS(new Uint8Array(signature));
    assert.equal(verifyEcdsa(digest, der, point), true, `key ${i}`);
    const compressed = new Uint8Array([point[64] % 2 ? 3 : 2, ...point.subarray(1, 33)]);
    assert.equal(verifyEcdsa(digest, der, compressed), true, `compressed key ${i}`);
    const other = Uint8Array.from(digest);
    other[0] ^= 1;
    assert.equal(verifyEcdsa(other, der, point), false, `tampered digest ${i}`);
  }
});

test('ECDSA refuses high S and non-strict DER, which nodes will not relay', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const point = new Uint8Array(spki.subarray(spki.length - 65));
  const message = Buffer.from('ordex');
  const digest = new Uint8Array(createHash('sha256').update(message).digest());
  const { der } = lowS(new Uint8Array(createSign('SHA256').update(message).sign(privateKey)));
  const { r, s } = parseDerSignature(der);
  const encode = (value, pad = false) => {
    let h = value.toString(16);
    if (h.length % 2) h = `0${h}`;
    let bytes = Buffer.from(h, 'hex');
    if (bytes[0] & 0x80 || pad) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const wrap = (a, b) => {
    const body = Buffer.concat([a, b]);
    return new Uint8Array(Buffer.concat([Buffer.from([0x30, body.length]), body]));
  };
  assert.equal(verifyEcdsa(digest, wrap(encode(r), encode(s)), point), true);
  assert.equal(verifyEcdsa(digest, wrap(encode(r), encode(N - s)), point), false, 'high S');
  if (!(Number(r >> 248n) & 0x80)) {
    assert.equal(verifyEcdsa(digest, wrap(encode(r, true), encode(s)), point), false, 'padded R');
  }
  assert.equal(verifyEcdsa(digest, der.subarray(0, der.length - 1), point), false, 'truncated');
});

test('public keys off the curve or badly encoded are refused', () => {
  assert.equal(decodePublicKey(hex('02' + '00'.repeat(32))), null);
  assert.equal(decodePublicKey(hex('05' + '11'.repeat(32))), null);
  assert.equal(decodePublicKey(hex('04' + '11'.repeat(64))), null);
  assert.notEqual(decodePublicKey(hex('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')), null);
});

test('BIP341: the output key of every scriptPubKey vector is reproduced', () => {
  const vectors = JSON.parse(fixture('bip341-wallet-test-vectors.json'));
  for (const v of vectors.scriptPubKey) {
    const root = v.intermediary.merkleRoot ? hex(v.intermediary.merkleRoot) : null;
    const tweaked = taprootTweak(hex(v.given.internalPubkey), root);
    assert.equal(Buffer.from(tweaked.outputKey).toString('hex'), v.intermediary.tweakedPubkey);
  }
});
