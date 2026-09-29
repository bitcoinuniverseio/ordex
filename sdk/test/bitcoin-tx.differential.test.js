import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sighashCorpus } from '../../conformance/bitcoin-differential/corpus.mjs';
import { bytesToHex, hexToBytes, legacySighash, parseTransaction, segwitV0Sighash, taprootSighash } from '../dist/index.js';

// Every signature hash of every input of a seeded random corpus, under every
// flag, compared with what rust-bitcoin 0.32.5 computed
// (conformance/bitcoin-differential/run.mjs recorded it).

const oracle = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../conformance/bitcoin-differential/bitcoin-0.32.5-results.json', import.meta.url)), 'utf8')
).cases;

const ONE = `01${'00'.repeat(31)}`;

test('legacy, BIP143 and BIP341 sighashes match rust-bitcoin on the seeded corpus', () => {
  let compared = 0;
  let divergences = 0;
  for (const c of sighashCorpus()) {
    const answer = oracle[c.name];
    assert.ok(answer, c.name);
    const { tx } = parseTransaction(c.txHex);
    tx.inputs.forEach((_, index) => {
      const expected = answer.inputs[index];
      const prevout = c.prevouts[index];
      for (const [type, hash] of Object.entries(expected.legacy)) {
        const actual = bytesToHex(legacySighash(tx, index, hexToBytes(prevout.scriptHex), Number(type)));
        if ((Number(type) & 0x1f) === 3 && index >= tx.outputs.length && Number(type) !== 3) {
          // Bitcoin Core v29.0 interpreter.cpp returns ONE for any hash type whose
          // low bits are SINGLE with no matching output, ANYONECANPAY included.
          // rust-bitcoin 0.32.5 applies that only to plain SINGLE; consensus wins.
          assert.equal(actual, ONE, `${c.name} legacy ${type}`);
          assert.notEqual(hash, ONE, 'the recorded rust-bitcoin divergence is still present');
          divergences += 1;
        } else {
          assert.equal(actual, hash, `${c.name} legacy ${type}`);
        }
        compared += 1;
      }
      const scriptCode = /^0014/.test(prevout.scriptHex) ? `76a914${prevout.scriptHex.slice(4)}88ac` : prevout.scriptHex;
      for (const [type, hash] of Object.entries(expected.segwit)) {
        assert.equal(
          bytesToHex(segwitV0Sighash(tx, index, hexToBytes(scriptCode), prevout.valueSats, Number(type))),
          hash,
          `${c.name} segwit ${type}`
        );
        compared += 1;
      }
      for (const [path, table] of [['taprootKey', null], ['taprootScript', c.leafHashHex]]) {
        for (const [type, hash] of Object.entries(expected[path])) {
          const options = { annexHex: c.annexHex ?? null, ...(table ? { leafHash: hexToBytes(table) } : {}) };
          const digest = taprootSighash(tx, index, c.prevouts, Number(type), options);
          assert.equal(digest === null ? null : bytesToHex(digest), hash, `${c.name} ${path} ${type}`);
          compared += 1;
        }
      }
    });
  }
  assert.ok(compared > 5000, `only ${compared} hashes compared`);
  assert.ok(divergences > 0, 'the corpus reaches SINGLE|ANYONECANPAY without a matching output');
});
