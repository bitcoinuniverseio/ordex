import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  containsSecret,
  maskSensitiveData,
  safeJsonParse,
  sanitizeSessionExport,
  isAllowedVerifierFamily,
  sanitizePath
} from '../../site/src/lib/security/sanitizer.js';

test('security sanitizer: detects private keys, WIF, xprv, and bearer tokens', () => {
  assert.ok(containsSecret('-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----'));
  assert.ok(containsSecret('5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ')); // WIF
  assert.ok(containsSecret('xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBNrMpHL'));
  assert.ok(containsSecret('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M'));
  assert.ok(containsSecret('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')); // 12-word seed
  assert.ok(!containsSecret('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'));
});

test('security sanitizer: masks Bitcoin addresses, xpubs, and derivation paths', () => {
  const maskedAddr = maskSensitiveData('Payment to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq for order');
  assert.ok(!maskedAddr.includes('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'));
  assert.ok(maskedAddr.includes('bc1q...5mdq'));

  const maskedPath = maskSensitiveData("Derivation path m/86'/0'/0'/0/0 used");
  assert.ok(maskedPath.includes('[DERIVATION_PATH_MASKED]'));
});

test('security sanitizer: safeJsonParse prevents prototype pollution', () => {
  const malicious = '{"__proto__": {"polluted": true}, "normal": "val"}';
  const parsed = safeJsonParse(malicious);
  assert.equal(parsed.normal, 'val');
  assert.equal(Object.prototype.polluted, undefined);
});

test('security sanitizer: verifier family allowlist accepts authoritative families only', () => {
  assert.ok(isAllowedVerifierFamily('purchase'));
  assert.ok(isAllowedVerifierFamily('offers'));
  assert.ok(isAllowedVerifierFamily('safeops'));
  assert.ok(isAllowedVerifierFamily('swaps'));
  assert.ok(isAllowedVerifierFamily('runes'));
  assert.ok(!isAllowedVerifierFamily('arbitrary_exec'));
  assert.ok(!isAllowedVerifierFamily('../../malicious'));
});

test('security sanitizer: sanitizePath blocks directory traversal', () => {
  assert.throws(() => sanitizePath('../../etc/passwd'));
  assert.throws(() => sanitizePath('/etc/shadow'));
  assert.equal(sanitizePath('spec/purchase.md'), 'spec/purchase.md');
});
