import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bytesToHex,
  extractPsbtTransaction,
  hexToBytes,
  legacySighash,
  parsePsbt,
  parseTransaction,
  segwitV0Sighash,
  serializeTransaction,
  taprootSighash,
  unsignedCopy,
  verifyInputSignature,
  verifyPsbtPartialSignatures,
  verifyTaprootCommitment,
} from '../dist/index.js';
import { verifyEcdsa, verifySchnorr } from '../dist/index.js';

const fixture = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../verifier/fixtures/${name}`, import.meta.url)), 'utf8'));

// BIP143 examples (bitcoin/bips 3a10b5b5): unsigned and signed transactions,
// the scriptCode each input signs, and the signature hash the BIP states.
const P2WPKH_UNSIGNED =
  '0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000';
const P2WPKH_SIGNED =
  '01000000000102fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f00000000494830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac000247304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee0121025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee635711000000';
const P2WPKH_PREVOUTS = [
  { valueSats: '625000000', scriptHex: '2103c9f4836b9a4f77fc0d81f7bcb01b7f1b35916864b9476c241ce9fc198bd25432ac' },
  { valueSats: '600000000', scriptHex: '00141d0f172a0ecb48aee1be1f2687d2963ae33f71a1' },
];
const P2SH_P2WPKH_SIGNED =
  '01000000000101db6b1b20aa0fd7b23880be2ecbd4a98130974cf4748fb66092ac4d3ceb1a5477010000001716001479091972186c449eb1ded22b78e40d009bdf0089feffffff02b8b4eb0b000000001976a914a457b684d7f0d539a46a45bbc043f35b59d0d96388ac0008af2f000000001976a914fd270b1ee6abcaea97fea7ad0402e8bd8ad6d77c88ac02473044022047ac8e878352d3ebbde1c94ce3a10d057c24175747116f8288e5d794d12d482f0220217f36a485cae903c713331d877c1f64677e3622ad4010726870540656fe9dcb012103ad1d8e89212f0b92c74d23bb710c00662ad1470198ac48c43f7d6f93a2a2687392040000';
const P2WSH_UNSIGNED =
  '0100000002fe3dc9208094f3ffd12645477b3dc56f60ec4fa8e6f5d67c565d1c6b9216b36e0000000000ffffffff0815cf020f013ed6cf91d29f4202e8a58726b1ac6c79da47c23d1bee0a6925f80000000000ffffffff0100f2052a010000001976a914a30741f8145e5acadf23f751864167f32e0963f788ac00000000';
const ACP_UNSIGNED =
  '0100000002e9b542c5176808107ff1df906f46bb1f2583b16112b95ee5380665ba7fcfc0010000000000ffffffff80e68831516392fcd100d186b3c2c7b95c80b53c77e77c35ba03a66b429a2a1b0000000000ffffffff0280969800000000001976a914de4b231626ef508c9a74a8517e6783c0546d6b2888ac80969800000000001976a9146648a8cd4531e1ec47f35916de8e259237294d1e88ac00000000';

const tx = (h) => parseTransaction(h).tx;

test('BIP143: every example signature hash is reproduced', () => {
  const cases = [
    [P2WPKH_UNSIGNED, 1, '76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac', '600000000', 1, 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670'],
    [
      '0100000001db6b1b20aa0fd7b23880be2ecbd4a98130974cf4748fb66092ac4d3ceb1a54770100000000feffffff02b8b4eb0b000000001976a914a457b684d7f0d539a46a45bbc043f35b59d0d96388ac0008af2f000000001976a914fd270b1ee6abcaea97fea7ad0402e8bd8ad6d77c88ac92040000',
      0,
      '76a91479091972186c449eb1ded22b78e40d009bdf008988ac',
      '1000000000',
      1,
      '64f3b0f4dd2bb3aa1ce8566d220cc74dda9df97d8490cc81d89d735c92e59fb6',
    ],
    [P2WSH_UNSIGNED, 1, '21026dccc749adc2a9d0d89497ac511f760f45c47dc5ed9cf352a58ac706453880aeadab210255a9626aebf5e29c0e6538428ba0d1dcf6ca98ffdf086aa8ced5e0d0215ea465ac', '4900000000', 3, '82dde6e4f1e94d02c2b7ad03d2115d691f48d064e9d52f58194a6637e4194391'],
    [P2WSH_UNSIGNED, 1, '210255a9626aebf5e29c0e6538428ba0d1dcf6ca98ffdf086aa8ced5e0d0215ea465ac', '4900000000', 3, 'fef7bd749cce710c5c052bd796df1af0d935e59cea63736268bcbe2d2134fc47'],
    [ACP_UNSIGNED, 0, '0063ab68210392972e2eb617b2388771abe27235fd5ac44af8e61693261550447a4c3e39da98ac', '16777215', 0x83, 'e9071e75e25b8a1e298a72f0d2e9f4f95a0f5cdf86a533cda597eb402ed13b3a'],
    [ACP_UNSIGNED, 1, '68210392972e2eb617b2388771abe27235fd5ac44af8e61693261550447a4c3e39da98ac', '16777215', 0x83, 'cd72f1f1a433ee9df816857fad88d8ebd97e09a75cd481583eb841c330275e54'],
  ];
  for (const [unsigned, index, scriptCode, value, hashType, expected] of cases) {
    assert.equal(bytesToHex(segwitV0Sighash(tx(unsigned), index, hexToBytes(scriptCode), value, hashType)), expected);
  }
});

test('a legacy signature over the legacy sighash verifies (BIP143 P2PK input)', () => {
  const signed = tx(P2WPKH_SIGNED);
  const digest = legacySighash(signed, 0, hexToBytes(P2WPKH_PREVOUTS[0].scriptHex), 1);
  const der = hexToBytes('30450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed');
  assert.equal(verifyEcdsa(digest, der, hexToBytes('03c9f4836b9a4f77fc0d81f7bcb01b7f1b35916864b9476c241ce9fc198bd25432')), true);
});

test('signed BIP143 transactions parse, reserialize and verify from their own bytes', () => {
  const parsed = parseTransaction(P2WPKH_SIGNED);
  assert.equal(parsed.ok, true);
  assert.equal(bytesToHex(serializeTransaction(parsed.tx)), P2WPKH_SIGNED);
  assert.equal(bytesToHex(serializeTransaction(unsignedCopy(parsed.tx))), P2WPKH_UNSIGNED);
  assert.equal(verifyInputSignature(parsed.tx, 1, P2WPKH_PREVOUTS).status, 'VALID');
  assert.equal(verifyInputSignature(parsed.tx, 0, P2WPKH_PREVOUTS).status, 'UNSUPPORTED');

  const wrapped = parseTransaction(P2SH_P2WPKH_SIGNED).tx;
  const wrappedPrevouts = [{ valueSats: '1000000000', scriptHex: 'a9144733f37cf4db86fbc2efed2500b4f4e49f31202387' }];
  const verdict = verifyInputSignature(wrapped, 0, wrappedPrevouts);
  assert.equal(verdict.status, 'VALID');
  assert.equal(verdict.sighashType, 1);

  // Any change to what the signature committed to invalidates it.
  const moved = structuredClone(parsed.tx);
  moved.outputs[0].valueSats = '112340001';
  assert.equal(verifyInputSignature(moved, 1, P2WPKH_PREVOUTS).status, 'INVALID');
  const relocked = structuredClone(parsed.tx);
  relocked.lockTime = 12;
  assert.equal(verifyInputSignature(relocked, 1, P2WPKH_PREVOUTS).status, 'INVALID');
  const wrongValue = structuredClone(P2WPKH_PREVOUTS);
  wrongValue[1].valueSats = '600000001';
  assert.equal(verifyInputSignature(parsed.tx, 1, wrongValue).status, 'INVALID');
  assert.equal(verifyInputSignature(unsignedCopy(parsed.tx), 1, P2WPKH_PREVOUTS).status, 'UNSIGNED');
});

test('BIP341: key path sighashes, tweaks and signatures of every vector', () => {
  const vectors = fixture('bip341-wallet-test-vectors.json');
  for (const group of vectors.keyPathSpending) {
    const unsigned = tx(group.given.rawUnsignedTx);
    const prevouts = group.given.utxosSpent.map((u) => ({ valueSats: String(u.amountSats), scriptHex: u.scriptPubKey }));
    for (const spend of group.inputSpending) {
      const { txinIndex, hashType } = spend.given;
      const digest = taprootSighash(unsigned, txinIndex, prevouts, hashType);
      assert.equal(bytesToHex(digest), spend.intermediary.sigHash, `input ${txinIndex}`);
      const signature = hexToBytes(spend.expected.witness[0]);
      const outputKey = hexToBytes(prevouts[txinIndex].scriptHex.slice(4));
      assert.equal(verifySchnorr(digest, signature.subarray(0, 64), outputKey), true, `input ${txinIndex}`);
      const signed = structuredClone(unsigned);
      signed.inputs[txinIndex].witness = spend.expected.witness;
      const verdict = verifyInputSignature(signed, txinIndex, prevouts);
      assert.equal(verdict.status, 'VALID', `input ${txinIndex}`);
      assert.equal(verdict.sighashType, hashType, `input ${txinIndex}`);
    }
  }
});

function leaves(tree, out = []) {
  if (!tree) return out;
  if (Array.isArray(tree)) {
    for (const branch of tree) leaves(branch, out);
  } else {
    out.push(tree);
  }
  return out;
}

test('BIP341: every script path control block commits its leaf to the output key', () => {
  const vectors = fixture('bip341-wallet-test-vectors.json');
  for (const v of vectors.scriptPubKey) {
    const scripts = leaves(v.given.scriptTree).sort((a, b) => a.id - b.id);
    (v.expected.scriptPathControlBlocks ?? []).forEach((control, i) => {
      const commitment = verifyTaprootCommitment(v.intermediary.tweakedPubkey, scripts[i].script, control);
      assert.equal(commitment.ok, true, `${v.intermediary.tweakedPubkey} leaf ${i}`);
      assert.equal(bytesToHex(commitment.leafHash), v.intermediary.leafHashes[i]);
      const wrong = verifyTaprootCommitment(v.intermediary.tweakedPubkey, `${scripts[i].script}51`, control);
      assert.equal(wrong.ok, false);
    });
  }
});

test('BIP174, BIP370 and BIP371: valid PSBTs parse and invalid ones are refused', () => {
  const vectors = fixture('psbt-test-vectors.json');
  for (const bip of ['bip-0174', 'bip-0370', 'bip-0371']) {
    assert.ok(vectors[bip].valid.length > 0 && vectors[bip].invalid.length > 0, bip);
    for (const v of vectors[bip].valid) assert.equal(parsePsbt(v.hex).ok, true, `${bip} valid: ${v.case}`);
    for (const v of vectors[bip].invalid) assert.equal(parsePsbt(v.hex).ok, false, `${bip} invalid: ${v.case}`);
  }
});

test('BIP370: the locktime of every determination vector matches the BIP', () => {
  const expected = [
    ['No locktimes specified', 0],
    ['Fallback locktime of 0', 0],
    ['Input 1 has PSBT_IN_REQUIRED_HEIGHT_LOCKTIME of 10000, Input 2 has no locktime fields', 10000],
    ['Input 1 has PSBT_IN_REQUIRED_HEIGHT_LOCKTIME of 10000, Input 2 has PSBT_IN_REQUIRED_HEIGHT_LOCKTIME of 9000', 10000],
    ['Input 1 has PSBT_IN_REQUIRED_HEIGHT_LOCKTIME of 10000, Input 2 has PSBT_IN_REQUIRED_HEIGHT_LOCKTIME of 9000 and PSBT_IN_REQUIRED_TIME_LOCKTIME of 1657048460', 10000],
    ['Input 1 has PSBT_IN_REQUIRED_HEIGHT_LOCKTIME of 10000 and PSBT_IN_REQUIRED_TIME_LOCKTIME of 1657048459, Input 2 has PSBT_IN_REQUIRED_HEIGHT_LOCKTIME of 9000 and PSBT_IN_REQUIRED_TIME_LOCKTIME of 1657048460', 10000],
    ['Input 1 has PSBT_IN_REQUIRED_TIME_LOCKTIME of 1657048459, Input 2 has PSBT_IN_REQUIRED_HEIGHT_LOCKTIME of 9000 and PSBT_IN_REQUIRED_TIME_LOCKTIME of 1657048460', 1657048460],
    ['Input 1 has PSBT_IN_REQUIRED_HEIGHT_LOCKTIME of 10000 and PSBT_IN_REQUIRED_TIME_LOCKTIME of 1657048459, Input 2 has PSBT_IN_REQUIRED_TIME_LOCKTIME of 1657048460', 1657048460],
    ['Input 1 has PSBT_IN_REQUIRED_HEIGHT_LOCKTIME of 10000, Input 2 has PSBT_IN_REQUIRED_TIME_LOCKTIME of 1657048460', null],
  ];
  const valid = fixture('psbt-test-vectors.json')['bip-0370'].valid;
  for (const [name, lockTime] of expected) {
    const vector = valid.find((v) => v.case === name);
    assert.ok(vector, name);
    assert.equal(parsePsbt(vector.hex).psbt.tx.lockTime, lockTime, name);
  }
});

test('PSBT signatures are verified against the prevouts the PSBT carries', () => {
  const vectors = fixture('psbt-test-vectors.json');
  let checked = 0;
  for (const bip of ['bip-0174', 'bip-0371']) {
    for (const v of vectors[bip].valid) {
      const { psbt } = parsePsbt(v.hex);
      psbt.inputs.forEach((_, i) => {
        for (const sig of verifyPsbtPartialSignatures(psbt, i)) {
          if (sig.unsupported) continue;
          assert.equal(sig.valid, true, `${bip} ${v.case} input ${i}`);
          checked += 1;
        }
      });
    }
  }
  assert.ok(checked > 0, 'the vectors carry verifiable signatures');
});

test('a finalized PSBT extracts to a transaction whose signatures verify', () => {
  const vectors = fixture('psbt-test-vectors.json');
  let extracted = 0;
  for (const v of vectors['bip-0174'].valid) {
    const { psbt } = parsePsbt(v.hex);
    if (!psbt.inputs.every((i) => i.finalScriptSig !== undefined || i.finalWitness !== undefined)) continue;
    if (!psbt.inputs.every((i) => i.prevout)) continue;
    const signed = extractPsbtTransaction(psbt);
    const prevouts = psbt.inputs.map((i) => i.prevout);
    signed.inputs.forEach((_, i) => {
      const verdict = verifyInputSignature(signed, i, prevouts);
      assert.notEqual(verdict.status, 'INVALID', `${v.case} input ${i}`);
    });
    extracted += 1;
  }
  assert.ok(extracted > 0);
});

test('malformed transaction bytes are refused, never guessed', () => {
  const bad = [
    `${P2WPKH_UNSIGNED}00`, // trailing byte
    P2WPKH_UNSIGNED.slice(0, -2), // truncated
    '0100000000010002', // witness flag, no inputs
    P2WPKH_UNSIGNED.replace('0100000002', '010000000002'), // unknown witness flag
    '01000000fd0200' + P2WPKH_UNSIGNED.slice(10), // non-minimal input count
    'zz',
    '',
  ];
  for (const hex of bad) assert.equal(parseTransaction(hex).ok, false, hex.slice(0, 30));
  // A segwit serialization whose every witness is empty is superfluous.
  const noWitness = P2WPKH_UNSIGNED.replace(/^01000000/, '010000000001').replace(/11000000$/, '000011000000');
  assert.equal(parseTransaction(noWitness).ok, false);
});
