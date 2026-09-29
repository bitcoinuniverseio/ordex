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

test('every code a verifier can return has exactly one rule, and nothing else does', () => {
  assert.deepEqual(diagnostics.map((d) => d.exactCodes[0]).sort(), [...sources.keys()].sort());
  assert.deepEqual(refusals.map((r) => r.code).sort(), [...sources.keys()].sort());
  assert.ok(sources.has('MAKER_ASSET_UNASSIGNED') && sources.has('TAKER_ASSET_UNASSIGNED'), 'template codes are expanded');
});

test('every (code, family) branch has a reproducer or a written reason it is unreachable', () => {
  assert.deepEqual(reproducerFile.unavailable, []);
  for (const d of diagnostics) {
    for (const f of d.families) {
      const covered = d.reproducers.some((r) => r.family === f) || d.unreachable.some((u) => u.family === f);
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
    const introduced = d.families.map((f) => FAMILY_INTRODUCED_IN[f]).sort()[0];
    assert.equal(d.supportedProtocolVersions[0], introduced, code);
    if (d.invariant) assert.ok(readFileSync(new URL(d.sourceRefs.find((s) => s.type === 'spec').path, root), 'utf8').includes(code), code);
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
  const fee = diagnostics.find((d) => d.exactCodes[0] === 'FEE_CHANGED');
  assert.deepEqual(fee.unreachable.map((u) => u.family), ['safeops']);
  assert.equal(fee.causes.find((c) => c.family === 'safeops').reachable, false);
});
