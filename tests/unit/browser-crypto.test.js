import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as nodeCrypto from 'node:crypto';
import * as browserCrypto from '../../site/src/lib/browser/node-crypto.mjs';

// OX-S07: the verifiers run in the browser on this implementation, so it must give Node's
// exact bytes for every length class around the SHA-256 block and padding boundaries.

const texts = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), 'a'.repeat(119), 'a'.repeat(1000), 'héllo wörld ₿ 🙂', '{"ok":true}'];

test('SHA-256 matches FIPS 180-4 test vectors', () => {
  const h = (t) => browserCrypto.createHash('sha256').update(t, 'utf8').digest('hex');
  assert.equal(h('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(h(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(h('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('SHA-256 matches node:crypto on boundary lengths, multibyte text and random bytes', () => {
  for (const t of texts) {
    assert.equal(
      browserCrypto.createHash('sha256').update(t, 'utf8').digest('hex'),
      nodeCrypto.createHash('sha256').update(t, 'utf8').digest('hex'),
      `length ${t.length}`
    );
  }
  for (let n = 0; n < 300; n += 7) {
    const bytes = nodeCrypto.randomBytes(n);
    assert.equal(
      browserCrypto.createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),
      nodeCrypto.createHash('sha256').update(bytes).digest('hex')
    );
  }
  const chunked = browserCrypto.createHash('sha256').update('ab').update('c').digest('hex');
  assert.equal(chunked, nodeCrypto.createHash('sha256').update('abc').digest('hex'));
});

test('RIPEMD-160 (HASH160 in bitcoin-tx.js) matches node:crypto across block boundaries', () => {
  for (const t of texts) {
    assert.equal(browserCrypto.createHash('ripemd160').update(t, 'utf8').digest('hex'), nodeCrypto.createHash('ripemd160').update(t, 'utf8').digest('hex'));
  }
  for (let n = 0; n < 300; n += 1) {
    const bytes = nodeCrypto.randomBytes(n);
    assert.equal(browserCrypto.createHash('ripemd160').update(new Uint8Array(bytes)).digest('hex'), nodeCrypto.createHash('ripemd160').update(bytes).digest('hex'));
  }
  assert.equal(browserCrypto.createHash('ripemd160').update('abc').digest('hex'), '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc');
});

test('HMAC-SHA256 matches node:crypto, including keys longer than one block', () => {
  for (const key of ['whsec_test_secret_0123456789abcdef', 'k', 'x'.repeat(64), 'y'.repeat(200)]) {
    for (const t of texts) {
      assert.equal(
        browserCrypto.createHmac('sha256', key).update(t, 'utf8').digest('hex'),
        nodeCrypto.createHmac('sha256', key).update(t, 'utf8').digest('hex')
      );
    }
  }
  // RFC 4231 test case 2
  assert.equal(
    browserCrypto.createHmac('sha256', 'Jefe').update('what do ya want for nothing?').digest('hex'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
  );
});

test('timingSafeEqual follows the node contract', () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(browserCrypto.timingSafeEqual(enc('abc'), enc('abc')), true);
  assert.equal(browserCrypto.timingSafeEqual(enc('abc'), enc('abd')), false);
  assert.throws(() => browserCrypto.timingSafeEqual(enc('ab'), enc('abc')), RangeError);
});

test('unsupported algorithms and encodings throw instead of weakening', () => {
  assert.throws(() => browserCrypto.createHash('md5'), /sha256 only/);
  assert.throws(() => browserCrypto.createHmac('sha1', 'k'), /sha256 only/);
  assert.throws(() => browserCrypto.createHash('sha256').update('x', 'latin1'), /Unsupported input encoding/);
  const h = browserCrypto.createHash('sha256').update('x');
  h.digest('hex');
  assert.throws(() => h.digest('hex'), /Digest already called/);
});
