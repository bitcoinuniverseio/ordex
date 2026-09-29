import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { signWebhookDelivery, verifyWebhookSignature } from '../../verifier/events.js';

// OX-P11: the webhook delivery key lifecycle spec/events.md requires, run end
// to end with the reference signer and verifier. The key store below is a
// model of the normative storage properties (random key returned once, sealed
// recoverably under a key encryption key only the delivery worker holds,
// bound to subscription and version, a hint on ordinary reads, bounded
// rotation overlap). The gateway's own store and worker (Core OX-X14) are
// proved by their own tests; real HTTPS delivery is an integration gate.

const OVERLAP_SECONDS = 600;
const aad = (subscriptionId, version) => Buffer.from(`ordex.webhook-secret/v2|${subscriptionId}|${version}`, 'utf8');

function seal(kek, secret, subscriptionId, version) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  cipher.setAAD(aad(subscriptionId, version));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('hex');
}

function open(kek, sealedHex, subscriptionId, version) {
  const bytes = Buffer.from(sealedHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', kek, bytes.subarray(0, 12));
  decipher.setAAD(aad(subscriptionId, version));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}

/** The persisted rows: what a database dump would contain. */
class KeyStore {
  constructor(rows = []) {
    this.rows = rows;
  }

  create(kek, subscriptionId) {
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    this.rows.push({ subscriptionId, version: 1, sealed: seal(kek, secret, subscriptionId, 1), hint: secret.slice(-4), retiredAt: null, verifyUntil: null });
    return secret;
  }

  rotate(kek, subscriptionId, nowSeconds) {
    const current = this.rows.find((r) => r.subscriptionId === subscriptionId && r.retiredAt === null);
    current.retiredAt = nowSeconds;
    current.verifyUntil = nowSeconds + OVERLAP_SECONDS;
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const version = current.version + 1;
    this.rows.push({ subscriptionId, version, sealed: seal(kek, secret, subscriptionId, version), hint: secret.slice(-4), retiredAt: null, verifyUntil: null });
    return secret;
  }

  /** What an ordinary read returns: never the key, never its ciphertext. */
  read(subscriptionId) {
    const current = this.rows.find((r) => r.subscriptionId === subscriptionId && r.retiredAt === null);
    return { subscriptionId, secretVersion: current.version, secretHint: current.hint };
  }

  /** The delivery worker: the current key and every key inside its overlap, newest first. */
  signingSecrets(kek, subscriptionId, nowSeconds) {
    return this.rows
      .filter((r) => r.subscriptionId === subscriptionId && (r.retiredAt === null || r.verifyUntil > nowSeconds))
      .sort((a, b) => b.version - a.version)
      .map((r) => open(kek, r.sealed, r.subscriptionId, r.version));
  }

  dump() {
    return JSON.stringify(this.rows);
  }

  static restore(dump) {
    return new KeyStore(JSON.parse(dump));
  }
}

const body = JSON.stringify({ id: '8f14e45f-ceea-467a-9575-52f8c1b6e1a0', type: 'ordex.orders.published', amountSats: '90000' });

test('a restarted worker decrypts the key and signs the exact body the receiver verifies', () => {
  const kek = randomBytes(32);
  const store = new KeyStore();
  const receiverSecret = store.create(kek, 'whsub_1');
  const restarted = KeyStore.restore(store.dump());
  const secrets = restarted.signingSecrets(kek, 'whsub_1', 1_787_400_000);
  assert.deepEqual(secrets, [receiverSecret]);
  const header = signWebhookDelivery({ secrets, timestamp: 1_787_400_000, deliveryId: 'whdel_1', body });
  assert.deepEqual(verifyWebhookSignature({ header, secret: receiverSecret, body, nowSeconds: 1_787_400_010 }), { ok: true });
  assert.equal(verifyWebhookSignature({ header, secret: receiverSecret, body: `${body} `, nowSeconds: 1_787_400_010 }).code, 'SIGNATURE_INVALID');
});

test('ordinary reads and the stored rows never reveal the key', () => {
  const kek = randomBytes(32);
  const store = new KeyStore();
  const secret = store.create(kek, 'whsub_2');
  const view = JSON.stringify(store.read('whsub_2'));
  assert.ok(!view.includes(secret) && !view.includes(secret.slice(6)));
  assert.ok(!view.includes(store.rows[0].sealed));
  assert.deepEqual(JSON.parse(view), { subscriptionId: 'whsub_2', secretVersion: 1, secretHint: secret.slice(-4) });
  assert.ok(!store.dump().includes(secret.slice(6)), 'a database dump carries ciphertext only');
});

test('a worker without the key encryption key cannot decrypt, and a sealed key cannot move', () => {
  const kek = randomBytes(32);
  const store = new KeyStore();
  store.create(kek, 'whsub_3');
  store.create(kek, 'whsub_4');
  assert.throws(() => store.signingSecrets(randomBytes(32), 'whsub_3', 1_787_400_000));
  const moved = KeyStore.restore(store.dump());
  moved.rows[1].sealed = moved.rows[0].sealed;
  assert.throws(() => moved.signingSecrets(kek, 'whsub_4', 1_787_400_000), 'a key sealed for one subscription opens for no other');
});

test('a hash of the key, as a hash-only store would keep, signs nothing a receiver accepts', () => {
  const kek = randomBytes(32);
  const store = new KeyStore();
  const secret = store.create(kek, 'whsub_5');
  const hashOnly = createHash('sha256').update(secret, 'utf8').digest('hex');
  const header = signWebhookDelivery({ secret: hashOnly, timestamp: 1_787_400_000, deliveryId: 'whdel_5', body });
  assert.equal(verifyWebhookSignature({ header, secret, body, nowSeconds: 1_787_400_000 }).code, 'SIGNATURE_INVALID');
});

test('rotation: both keys verify inside the overlap, only the new one after it', () => {
  const kek = randomBytes(32);
  const store = new KeyStore();
  const oldSecret = store.create(kek, 'whsub_6');
  const rotatedAt = 1_787_400_000;
  const newSecret = store.rotate(kek, 'whsub_6', rotatedAt);
  assert.notEqual(newSecret, oldSecret);
  assert.equal(store.read('whsub_6').secretVersion, 2);

  const inside = store.signingSecrets(kek, 'whsub_6', rotatedAt + 60);
  assert.deepEqual(inside, [newSecret, oldSecret]);
  const during = signWebhookDelivery({ secrets: inside, timestamp: rotatedAt + 60, deliveryId: 'whdel_6', body });
  assert.equal(during.split(',').filter((p) => p.startsWith('v1=')).length, 2);
  for (const secret of [oldSecret, newSecret]) {
    assert.deepEqual(verifyWebhookSignature({ header: during, secret, body, nowSeconds: rotatedAt + 61 }), { ok: true });
  }

  const after = store.signingSecrets(kek, 'whsub_6', rotatedAt + OVERLAP_SECONDS + 1);
  assert.deepEqual(after, [newSecret]);
  const late = signWebhookDelivery({ secrets: after, timestamp: rotatedAt + OVERLAP_SECONDS + 1, deliveryId: 'whdel_7', body });
  assert.equal(verifyWebhookSignature({ header: late, secret: oldSecret, body, nowSeconds: rotatedAt + OVERLAP_SECONDS + 2 }).code, 'SIGNATURE_INVALID');
  assert.deepEqual(verifyWebhookSignature({ header: late, secrets: [oldSecret, newSecret], body, nowSeconds: rotatedAt + OVERLAP_SECONDS + 2 }), { ok: true });
});

test('retries and replays keep the delivery id and exact body, so receivers apply each delivery once', () => {
  const kek = randomBytes(32);
  const store = new KeyStore();
  const secret = store.create(kek, 'whsub_8');
  const delivery = { id: 'whdel_8', body, bodyDigest: createHash('sha256').update(body, 'utf8').digest('hex') };
  const attempts = [1_787_400_000, 1_787_400_030, 1_787_400_600].map((timestamp) => ({
    timestamp,
    header: signWebhookDelivery({ secrets: store.signingSecrets(kek, 'whsub_8', timestamp), timestamp, deliveryId: delivery.id, body: delivery.body }),
  }));
  assert.equal(new Set(attempts.map((a) => a.header)).size, 3, 'each attempt is signed again with its own timestamp');
  const applied = new Set();
  for (const attempt of attempts) {
    const verdict = verifyWebhookSignature({ header: attempt.header, secret, body: delivery.body, nowSeconds: attempt.timestamp + 5 });
    assert.deepEqual(verdict, { ok: true });
    applied.add(/(?:^|,)d=([^,]+)/.exec(attempt.header)[1]);
  }
  assert.deepEqual([...applied], [delivery.id]);
  assert.equal(createHash('sha256').update(delivery.body, 'utf8').digest('hex'), delivery.bodyDigest, 'the signed payload never changes');
  assert.equal(
    verifyWebhookSignature({ header: attempts[0].header, secret, body: delivery.body, nowSeconds: attempts[2].timestamp }).code,
    'TIMESTAMP_OUT_OF_TOLERANCE',
    'an old attempt replayed later is refused by the tolerance',
  );
});
