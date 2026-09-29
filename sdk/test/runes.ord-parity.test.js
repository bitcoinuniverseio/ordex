import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { differentialCorpus } from '../../conformance/ord-differential/corpus.mjs';
import { allocateRunes, decipherRunestone, verifyRuneAllocation, verifyRuneBurnSafety } from '../dist/index.js';

// OX-P04 differential for the SDK port: every rune vector and 1500 seeded random transactions
// are compared, field by field, with the answers the pinned ord 0.29.0 gave
// (conformance/ord-differential/run.mjs recorded them from the real crate).

const load = async (path) => JSON.parse(await readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8'));
const vectors = (await load('../../conformance/rune-burn-vectors.json')).cases;
const oracle = (await load('../../conformance/ord-differential/ord-0.29.0-results.json')).cases;
const corpus = differentialCorpus();

const FLAWS = {
  EdictOutput: 'EDICT_OUTPUT',
  EdictRuneId: 'EDICT_RUNE_ID',
  InvalidScript: 'INVALID_SCRIPT',
  Opcode: 'OPCODE',
  SupplyOverflow: 'SUPPLY_OVERFLOW',
  TrailingIntegers: 'TRAILING_INTEGERS',
  TruncatedField: 'TRUNCATED_FIELD',
  UnrecognizedEvenTag: 'UNRECOGNIZED_EVEN_TAG',
  UnrecognizedFlag: 'UNRECOGNIZED_FLAG',
  Varint: 'VARINT',
};

const id = (value) => (value ? `${value.block}:${value.tx}` : null);
const text = (value) => (value === undefined ? null : String(value));

/** The verifier's decipher result in the oracle's shape. */
function asOracle(runestone) {
  if (runestone.kind === 'NONE') return { kind: 'NONE' };
  if (runestone.kind === 'CENOTAPH') {
    return { kind: 'CENOTAPH', flaw: runestone.flaws[0], mint: id(runestone.mint), etching: text(runestone.etching) };
  }
  const e = runestone.etching;
  return {
    kind: 'RUNESTONE',
    edicts: runestone.edicts.map((x) => ({ id: id(x.id), amount: String(x.amount), output: x.output })),
    pointer: runestone.pointer ?? null,
    mint: id(runestone.mint),
    etching: e
      ? {
          divisibility: e.divisibility ?? null,
          premine: text(e.premine),
          rune: text(e.rune),
          spacers: e.spacers ?? null,
          symbol: e.symbol ?? null,
          terms: e.terms
            ? {
                cap: text(e.terms.cap),
                heightStart: text(e.terms.heightStart),
                heightEnd: text(e.terms.heightEnd),
                amount: text(e.terms.amount),
                offsetStart: text(e.terms.offsetStart),
                offsetEnd: text(e.terms.offsetEnd),
              }
            : null,
          turbo: e.turbo,
        }
      : null,
  };
}

function oracleArtifact(answer) {
  const a = answer.artifact;
  return a.kind === 'CENOTAPH' ? { ...a, flaw: FLAWS[a.flaw] } : a;
}

/** Burned amounts summed per rune, the granularity ord reports. */
function burnedPerRune(burned) {
  const totals = new Map();
  for (const b of burned) totals.set(b.runeId, (totals.get(b.runeId) ?? 0n) + BigInt(b.amount));
  return [...totals].map(([runeId, amount]) => ({ runeId, amount: String(amount) }));
}

function exactInputs(inputs) {
  if (!inputs.every((i) => i && i.indexed === true && (Array.isArray(i.balances) || !(i.runes > 0)))) return null;
  return inputs.map((i) => ({ indexed: true, balances: Array.isArray(i.balances) ? i.balances : [] }));
}

// A vector that checks a plan against a transaction another vector already put to ord (the
// same output scripts and inputs) is compared with that recorded answer.
const sameTransaction = (a, b) => JSON.stringify([a.outputScriptsHex, a.inputs, a.mint ?? null]) === JSON.stringify([b.outputScriptsHex, b.inputs, b.mint ?? null]);
const answerFor = (c) => oracle[c.name] ?? oracle[vectors.find((v) => oracle[v.name] && sameTransaction(v, c))?.name];

function checkAgainstOracle(c) {
  const answer = answerFor(c);
  assert.ok(answer, `ord recorded no answer for ${c.name}`);
  const runestone = decipherRunestone(c.outputScriptsHex);
  assert.deepEqual(asOracle(runestone), oracleArtifact(answer), `decipher differs from ord for ${c.name}`);

  const inputs = exactInputs(c.inputs);
  if (answer.allocations && inputs) {
    const mint = runestone.mint ? { runeId: id(runestone.mint), amount: c.mint?.amount ?? '0' } : undefined;
    const allocation = allocateRunes(c.outputScriptsHex, inputs, mint ? { mint } : {});
    assert.equal(allocation.ok, true, `${c.name}: ${allocation.reason}`);
    assert.deepEqual(allocation.allocations, answer.allocations, `allocation differs from ord for ${c.name}`);
    assert.deepEqual(burnedPerRune(allocation.burned), answer.burned, `burns differ from ord for ${c.name}`);
  }
}

test('the oracle holds an answer for every vector and every corpus case', () => {
  for (const c of [...vectors, ...corpus]) assert.ok(answerFor(c), c.name);
});

test('every rune vector deciphers and allocates exactly as ord 0.29.0 does', () => {
  for (const c of vectors) checkAgainstOracle(c);
});

test('1500 seeded random transactions decipher and allocate exactly as ord 0.29.0 does', () => {
  const kinds = new Set();
  const flaws = new Set();
  let burning = 0;
  for (const c of corpus) {
    checkAgainstOracle(c);
    const answer = oracle[c.name];
    kinds.add(answer.artifact.kind);
    if (answer.artifact.flaw) flaws.add(answer.artifact.flaw);
    if (answer.burned?.length) burning += 1;
  }
  // The corpus must reach every verdict and most flaws, or it proves little.
  assert.deepEqual([...kinds].sort(), ['CENOTAPH', 'NONE', 'RUNESTONE']);
  assert.ok(flaws.size >= 8, `only ${flaws.size} flaws reached`);
  assert.ok(burning > 100, `only ${burning} burning cases reached`);
});

test('P-R05, P-R06 and P-R07 are cenotaphs', () => {
  for (const script of ['6a5d0416011601', '6a5d020601', '6a5d021401']) {
    const runestone = decipherRunestone([script, '51']);
    assert.equal(runestone.kind, 'CENOTAPH', script);
    assert.deepEqual(runestone.flaws, ['UNRECOGNIZED_EVEN_TAG'], script);
  }
});

test('P-R08: an explicit OP_RETURN pointer with a rune-bearing input refuses', () => {
  const counted = verifyRuneBurnSafety(['6a5d021600', '51'], [{ indexed: true, runes: 1 }]);
  assert.equal(counted.safe, false);
  assert.equal(counted.code, 'ALLOCATION_BURNS_BALANCE');
  const exact = verifyRuneBurnSafety(
    ['6a5d021600', '51'],
    [{ indexed: true, balances: [{ runeId: '840000:1', amount: '7' }] }]
  );
  assert.equal(exact.code, 'ALLOCATION_BURNS_BALANCE');
  assert.deepEqual(exact.burned, [{ runeId: '840000:1', cause: 'OP_RETURN_OUTPUT', amount: '7' }]);
});

test('a readable runestone is not asset safety: the allocation must equal the plan', () => {
  const scripts = ['6a5d0800c0a23301f40301', '0014' + '11'.repeat(20), '0014' + '22'.repeat(20)];
  const inputs = [{ indexed: true, balances: [{ runeId: '840000:1', amount: '1000' }] }];
  const planned = [{ output: 1, runeId: '840000:1', amount: '1000' }];
  assert.deepEqual(verifyRuneAllocation(scripts, inputs, planned).ok, true);

  const wrong = verifyRuneAllocation(scripts, inputs, [
    { output: 1, runeId: '840000:1', amount: '500' },
    { output: 2, runeId: '840000:1', amount: '500' },
  ]);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'RUNE_ALLOCATION_MISMATCH');

  const unproven = verifyRuneAllocation(scripts, [{ indexed: false }], planned);
  assert.equal(unproven.code, 'RUNE_INPUT_UNPROVEN');

  const counted = verifyRuneAllocation(scripts, [{ indexed: true, runes: 1 }], planned);
  assert.equal(counted.code, 'MALFORMED_RUNE_BALANCE');
});

test('allocation verification refuses burns and an unresolved mint', () => {
  const inputs = [{ indexed: true, balances: [{ runeId: '840000:1', amount: '1000' }] }];
  const burn = verifyRuneAllocation(['6a5d021600', '51'], inputs, []);
  assert.equal(burn.code, 'ALLOCATION_BURNS_BALANCE');

  const cenotaph = verifyRuneAllocation(['6a5d027e01', '51'], inputs, []);
  assert.equal(cenotaph.code, 'CENOTAPH_BURNS_BALANCE');

  // Mint 840000:9, a rune the inputs do not hold: the input allocation is exact
  // but the minted balance is not, so full verification needs the mint result.
  const mintScript = '6a5d' + '0614c0a2331409';
  const unresolved = verifyRuneAllocation([mintScript, '51'], inputs, [{ output: 1, runeId: '840000:1', amount: '1000' }]);
  assert.equal(unresolved.code, 'RUNE_MINT_UNRESOLVED');
  const resolved = verifyRuneAllocation(
    [mintScript, '51'],
    inputs,
    [
      { output: 1, runeId: '840000:1', amount: '1000' },
      { output: 1, runeId: '840000:9', amount: '21' },
    ],
    { mint: { runeId: '840000:9', amount: '21' } }
  );
  assert.equal(resolved.ok, true, resolved.reason);
});
