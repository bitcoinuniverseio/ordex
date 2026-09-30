import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanRefusalSources } from '../../scripts/docs/refusal-sources.mjs';
import { buildReproducerFile } from '../../scripts/docs/discover-reproducers.mjs';
import { evaluateCandidate } from '../../site/src/lib/conformance-engine.mjs';
import { reproducerArgs, reproducerScript } from '../../site/src/lib/diagnostics/reproducer.mjs';
import { FAMILY_INTRODUCED_IN } from '../../site/src/lib/diagnostics/rule-context.mjs';

// OX-S09 (PROPOSED NEW): every advertised refusal code has a rule bound to its verifier
// source, and every rule's reproducer is executed: through the shared engine and as the
// exported standalone script, each asserting the exact code.

const root = new URL('../../', import.meta.url);
const diagnostics = JSON.parse(readFileSync(new URL('site/src/data/diagnostics.json', root), 'utf8'));
const refusals = JSON.parse(readFileSync(new URL('site/src/data/refusals.json', root), 'utf8'));
const vectors = new Map(JSON.parse(readFileSync(new URL('site/src/data/allVectors.json', root), 'utf8')).map((v) => [v.id, v]));
const reproducerFile = JSON.parse(readFileSync(new URL('site/src/lib/diagnostics/reproducers.json', root), 'utf8'));
const sources = scanRefusalSources();
// Codes every site of which is recorded unreachable are never returned, so they have no rule.
const neverReturned = [...sources].filter(([code, e]) => e.sites.every((s) => reproducerFile.unreachable[`${code}|${s.family}`])).map(([code]) => code).sort();
const returned = [...sources.keys()].filter((code) => !neverReturned.includes(code)).sort();

test('every code a verifier can return has exactly one rule, and nothing else does', () => {
  assert.deepEqual(diagnostics.map((d) => d.exactCodes[0]).sort(), returned);
  assert.deepEqual(refusals.map((r) => r.code).sort(), returned);
  // Parse failures in bitcoin-tx.js are wrapped by every caller into its own code.
  assert.deepEqual(neverReturned, ['PSBT_MALFORMED', 'TX_MALFORMED']);
  // refuse(named ? 'TRANSITION_MISMATCH' : 'TRACKED_ASSET_UNASSIGNED', ...) yields both codes.
  assert.ok(sources.get('TRACKED_ASSET_UNASSIGNED')?.sites.some((s) => s.file === 'verifier/asset-flow.js') && sources.get('TRANSITION_MISMATCH')?.sites.some((s) => s.file === 'verifier/asset-flow.js'), 'both codes of a ternary refusal are found');
});

test('every (code, family) branch has a reproducer or a written reason it is unreachable', () => {
  assert.deepEqual(reproducerFile.unavailable, []);
  for (const d of diagnostics) {
    for (const f of d.families) {
      // A helper module's branch (asset-flow, bitcoin-tx) is covered by a reproducer run
      // through a family whose verifier reaches it.
      const covered = d.reproducers.some((r) => (r.covers || r.family) === f) || d.unreachable.some((u) => u.family === f);
      assert.ok(covered, `${d.exactCodes[0]} in ${f}`);
    }
  }
  for (const [key, reason] of Object.entries(reproducerFile.unreachable)) assert.ok(reason.length > 40, key);
});

test('the reproducer file is what discovery produces now', () => {
  assert.deepEqual(buildReproducerFile(reproducerFile), reproducerFile);
});

test('every reproducer returns its exact code through the shared verifier engine', () => {
  let n = 0;
  for (const d of diagnostics) {
    for (const r of d.reproducers) {
      const base = vectors.get(r.base);
      assert.ok(base, `${r.base} exists`);
      const result = evaluateCandidate(r.family, r.variant, reproducerArgs(r, base.case));
      assert.equal(result.verdict.state, 'refused', `${d.exactCodes[0]} in ${r.family}`);
      assert.equal(result.verdict.code, d.exactCodes[0]);
      n++;
    }
  }
  assert.ok(n >= diagnostics.length);
});

test('every exported reproducer script runs against the reference verifier and asserts its code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ordex-repro-'));
  const verifierUrl = new URL('verifier/', root).href;
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    for (const d of diagnostics) {
      for (const [i, r] of d.reproducers.entries()) {
        const code = d.exactCodes[0];
        const script = reproducerScript({ code, reproducer: r, args: reproducerArgs(r, vectors.get(r.base).case), revision: 'abcdef1' });
        assert.match(script, /from '\.\/verifier\//);
        assert.match(script, /git checkout abcdef1/);
        const file = join(dir, `reproduce-${code}-${i}.mjs`);
        writeFileSync(file, script.replace("from './verifier/", `from '${verifierUrl}`));
        await import(pathToFileURL(file).href);
        assert.ok(logs.at(-1).startsWith(`${code} reproduced:`), code);
      }
    }
  } finally {
    console.log = log;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rules are bound to their source, spec, lifecycle, versions and a fitting recovery', () => {
  for (const d of diagnostics) {
    const code = d.exactCodes[0];
    for (const c of d.causes) {
      const lines = readFileSync(new URL(c.source.path, root), 'utf8').split(/\r?\n/);
      const window = lines.slice(Math.max(0, c.source.line - 1), c.source.line + 2).join('\n');
      assert.ok(window.includes(code) || window.includes('_UNASSIGNED'), `${code} at ${c.source.path}:${c.source.line}`);
      assert.ok(c.predicate.length > 10, code);
    }
    assert.ok(d.lifecyclePhases.length > 0 && d.evidenceRequirements.length > 0, code);
    const reaching = sources.get(code).sites.flatMap((s) => (FAMILY_INTRODUCED_IN[s.family] ? [s.family] : s.via));
    assert.ok(reaching.length && reaching.every((f) => FAMILY_INTRODUCED_IN[f]), code);
    const introduced = reaching.map((f) => FAMILY_INTRODUCED_IN[f]).sort()[0];
    assert.equal(d.supportedProtocolVersions[0], introduced, code);
    if (d.invariant) assert.ok(readFileSync(new URL(d.sourceRefs.find((s) => s.type === 'spec').path, root), 'utf8').includes(code), code);
    // The requirement is a sentence, not a fragment listing codes.
    if (d.invariant) assert.ok(d.invariant.includes(code) && d.invariant.replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, ' ').split(/[^A-Za-z]+/).filter((w) => w.length > 1).length >= 4, `${code}: ${d.invariant}`);
    const steps = d.resolutionSteps.map((s) => s.action).join(' ');
    assert.doesNotMatch(steps, /Verify outpoints, scriptPubKeys/, code);
    if (['events', 'collection-manifest'].includes(d.family)) assert.doesNotMatch(steps, /outpoint|UTXO|scriptPubKey/i, `${code} is not a transaction failure`);
  }
  const account = diagnostics.find((d) => d.exactCodes[0] === 'ACCOUNT_INVALID');
  assert.match(account.resolutionSteps[0].action, /manifest/);
  assert.deepEqual(diagnostics.find((d) => d.exactCodes[0] === 'SWAP_PROTOCOL_UNSUPPORTED')?.supportedProtocolVersions ?? ['1.2'], ['1.2']);
});

test('shared codes keep every family: causes and reproducers per family', () => {
  const shared = diagnostics.filter((d) => d.families.length > 1);
  assert.ok(shared.length >= 20);
  const svm = diagnostics.find((d) => d.exactCodes[0] === 'SELLER_VALUE_MISMATCH');
  assert.deepEqual(svm.families, ['offers', 'purchase']);
  assert.deepEqual(svm.reproducers.map((r) => r.family), ['offers', 'purchase']);
  // SafeOps v2 (OX-P01) no longer returns FEE_CHANGED; the swaps acceptance check still does.
  const fee = diagnostics.find((d) => d.exactCodes[0] === 'FEE_CHANGED');
  assert.deepEqual(fee.families, ['swaps']);
  assert.deepEqual(fee.reproducers.map((r) => r.family), ['swaps']);
  // A helper module branch is reproduced through a family that reaches it, and says so.
  const toFee = diagnostics.find((d) => d.exactCodes[0] === 'ASSET_TO_FEE');
  assert.deepEqual(toFee.families, ['asset-flow']);
  assert.ok(toFee.reproducers.every((r) => r.covers === 'asset-flow' && sources.get('ASSET_TO_FEE').sites[0].via.includes(r.family)));
});
