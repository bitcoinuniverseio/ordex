import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decipherRunestone, parseScriptHex, verifyRuneBurnSafety } from './runes.js';

const vectorsPath = fileURLToPath(new URL('../conformance/rune-burn-vectors.json', import.meta.url));
const vectors = JSON.parse(await readFile(vectorsPath, 'utf8'));

test('the vector file names at least one accepting and one refusing case', () => {
  assert.ok(vectors.cases.some((c) => c.expected.safe === true));
  assert.ok(vectors.cases.some((c) => c.expected.safe === false));
});

test('the vector file covers every refusal code the verifier can return', () => {
  const codes = new Set(vectors.cases.map((c) => c.expected.code).filter(Boolean));
  assert.deepEqual(
    [...codes].sort(),
    ['CENOTAPH_BURNS_BALANCE', 'CENOTAPH_WITH_UNPROVEN_INPUT']
  );
});

for (const vector of vectors.cases) {
  test(`vector: ${vector.name}`, () => {
    const verdict = verifyRuneBurnSafety(
      vector.outputScriptsHex,
      vector.inputs,
      vector.outputCount
    );
    assert.equal(verdict.safe, vector.expected.safe, verdict.reason || '');
    assert.equal(verdict.runestone, vector.expected.runestone);
    if (vector.expected.safe) {
      assert.equal(verdict.code, undefined);
    } else {
      assert.equal(verdict.code, vector.expected.code, verdict.reason || '');
      assert.ok(
        verdict.flaws.includes(vector.expected.flaw),
        `expected flaw ${vector.expected.flaw}, got ${verdict.flaws.join(', ')}`
      );
    }
  });
}

test('parseScriptHex accepts only even-length lowercase hex', () => {
  assert.deepEqual([...parseScriptHex('6a5d')], [0x6a, 0x5d]);
  assert.deepEqual([...parseScriptHex('')], []);
  assert.equal(parseScriptHex('6A5D'), null);
  assert.equal(parseScriptHex('6a5'), null);
  assert.equal(parseScriptHex('zz'), null);
  assert.equal(parseScriptHex(0x6a5d), null);
  assert.equal(parseScriptHex(null), null);
});

test('an unreadable script is refused rather than read as no runestone', () => {
  // Bytes that never came off a chain must not resolve to "nothing to see".
  const verdict = verifyRuneBurnSafety(['not hex'], [{ indexed: true, runes: 1 }]);
  assert.equal(verdict.safe, false);
  assert.equal(verdict.runestone, 'CENOTAPH');
});

test('deciphering is stable under repeated reads', () => {
  for (const vector of vectors.cases) {
    const first = decipherRunestone(vector.outputScriptsHex, vector.outputCount);
    const second = decipherRunestone(vector.outputScriptsHex, vector.outputCount);
    assert.deepEqual(first, second, vector.name);
  }
});

test('no random script crashes the reader', () => {
  // The payload is attacker influenced. A throw here is a denial of service on
  // every purchase, so the reader answers rather than raises.
  let seed = 0x12345678;
  const next = (n) => {
    // A fixed generator keeps this deterministic across runs and machines.
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const kinds = new Set();
  for (let i = 0; i < 20000; i += 1) {
    const length = next(40);
    const bytes = Array.from({ length }, () => next(256));
    const script = i % 2 === 0 ? [0x6a, 0x5d, ...bytes] : bytes;
    const hex = Buffer.from(script).toString('hex');
    const verdict = verifyRuneBurnSafety([hex], [{ indexed: true, runes: 1 }]);
    assert.equal(typeof verdict.safe, 'boolean');
    kinds.add(verdict.runestone);
  }
  // The corpus must actually reach every branch, or it proves nothing.
  assert.deepEqual([...kinds].sort(), ['CENOTAPH', 'NONE', 'RUNESTONE']);
});
