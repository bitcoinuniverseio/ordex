// OX-S09: finds a minimal reproducer for every refusal code the verifiers can return and
// writes site/src/lib/diagnostics/reproducers.json. A reproducer is a checked-in conformance
// case plus a JSON Patch. Codes a vector already produces use that vector unchanged; for the
// rest this tool tries single, deterministic mutations of every case and keeps the smallest
// one that makes the verifier return exactly that code. Entries marked "authored" are kept
// as written. Codes still without a reproducer are listed so they stay explicitly unavailable.
//
//   node scripts/docs/discover-reproducers.mjs          rewrite the file
//   node scripts/docs/discover-reproducers.mjs --check  fail if the file is out of date

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY_REGISTRY, FAMILIES, variantOf } from '../../site/src/lib/conformance-registry.mjs';
import { invokeVerifier, normalizeVerdict } from '../../site/src/lib/conformance-engine.mjs';
import { applyPatch, pointerEscape } from '../../site/src/lib/diagnostics/patch.mjs';
import { loadVectorFile } from './vector-loader.mjs';
import { scanRefusalSources } from './refusal-sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REPRODUCERS_PATH = path.join(ROOT, 'site', 'src', 'lib', 'diagnostics', 'reproducers.json');

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Every checked-in case with its stable id (family/slug, as in allVectors.json). */
export function allCases() {
  const out = [];
  for (const family of FAMILIES) {
    const used = new Set();
    loadVectorFile(family).cases.forEach((c, index) => {
      // Same id rule as scripts/docs/generate-all-data.mjs, so ids match allVectors.json.
      let id = `${family}/${slug(c.name || `case-${index + 1}`)}`;
      if (used.has(id)) id = `${id}-${index + 1}`;
      used.add(id);
      out.push({ id, family, variant: variantOf(family, c), case: c });
    });
  }
  return out;
}

export function runCase(family, variant, source) {
  try {
    return normalizeVerdict(family, invokeVerifier(family, source, variant));
  } catch (err) {
    return { state: 'unknown', code: null, reason: String(err?.message || err) };
  }
}

function* leaves(value, pointer = '', depth = 0) {
  yield { pointer, value };
  if (depth > 9 || value === null || typeof value !== 'object') return;
  const keys = Array.isArray(value) ? [...new Set([0, 1, value.length - 1])].filter((i) => i >= 0 && i < value.length) : Object.keys(value);
  for (const k of keys) yield* leaves(value[k], `${pointer}/${pointerEscape(k)}`, depth + 1);
}

function mutations(pointer, value) {
  const ops = [];
  const replace = (v) => ops.push([{ op: 'replace', path: pointer, value: v }]);
  if (pointer !== '') ops.push([{ op: 'remove', path: pointer }]);
  replace(null);
  if (typeof value === 'string') {
    replace('');
    replace(0);
    if (/^-?\d+$/.test(value)) {
      const n = BigInt(value);
      for (const v of [n + 1n, n - 1n, 0n, -1n, n * 2n, n + 1000n, n - 1000n, 2n ** 64n]) replace(v.toString());
      replace('1.5');
      replace(` ${value}`);
    }
    if (/^[0-9a-f]+$/i.test(value) && value.length >= 2) {
      const last = value.at(-1);
      replace(`${value.slice(0, -1)}${last === '0' ? '1' : '0'}`);
      replace(`${value.slice(0, 1) === '0' ? '1' : '0'}${value.slice(1)}`);
      replace(value.slice(0, -2));
      replace(`${value}00`);
      replace(value.toUpperCase());
    }
    replace(`${value}x`);
    if (/^[a-z][a-z0-9-]*$/.test(value)) replace('unknown');
  } else if (typeof value === 'number') {
    for (const v of [value + 1, value - 1, 0, -1, 1.5, 2 ** 53, String(value)]) replace(v);
  } else if (typeof value === 'boolean') {
    replace(!value);
    replace(String(value));
  } else if (Array.isArray(value)) {
    replace([]);
    replace({});
    if (value.length) ops.push([{ op: 'add', path: `${pointer}/-`, value: structuredClone(value[0]) }]);
    if (value.length > 1) replace([...value].reverse());
    if (value.length > 1) replace(value.slice(1));
    if (value.length > 1) replace(value.slice(0, -1));
  } else if (value && typeof value === 'object') {
    replace([]);
    replace('x');
    ops.push([{ op: 'add', path: `${pointer}/unexpectedField`, value: 1 }]);
  }
  return ops;
}

const cost = (patch) => JSON.stringify(patch).length;

const key = (code, family) => `${code}|${family}`;

// A reproducer must run as a Lab or Worker candidate, so every required argument stays present.
const runnable = (family, variant, c) => FAMILY_REGISTRY[family].variants[variant].args.every((a) => c[a] !== undefined && c[a] !== null);

/**
 * Search for a reproducer for every (code, family) pair in `wanted` (a Set of "CODE|family").
 * Deterministic: vectors first, then authored entries, then the smallest single mutation.
 */
export function discover(wanted, existing = []) {
  const cases = allCases();
  const found = {};
  // 1. A checked-in vector that expects the code is the best reproducer: no patch at all.
  for (const c of cases) {
    const code = c.case.expected?.code;
    const k = key(code, c.family);
    if (!code || !wanted.has(k) || found[k] || !runnable(c.family, c.variant, c.case)) continue;
    const verdict = runCase(c.family, c.variant, c.case);
    if (verdict.state === 'refused' && verdict.code === code) found[k] = { family: c.family, variant: c.variant, base: c.id, patch: [], derivation: 'vector' };
  }
  // 2. Authored reproducers are kept when they still produce their code.
  for (const r of existing) {
    const k = key(r.code, r.family);
    if (found[k] || r.derivation !== 'authored' || !wanted.has(k)) continue;
    const base = cases.find((c) => c.id === r.base);
    if (!base) continue;
    const patched = applyPatch(base.case, r.patch);
    if (!runnable(r.family, r.variant, patched)) continue;
    const verdict = runCase(r.family, r.variant, patched);
    if (verdict.state === 'refused' && verdict.code === r.code) {
      const { code, ...rest } = r;
      found[k] = rest;
    }
  }
  // 3. Single mutations of every case, smallest patch wins.
  const best = {};
  for (const c of cases) {
    const spec = FAMILY_REGISTRY[c.family].variants[c.variant];
    for (const arg of [...spec.args, ...(spec.optional || [])]) {
      if (c.case[arg] === undefined) continue;
      for (const { pointer, value } of leaves(c.case[arg], `/${pointerEscape(arg)}`)) {
        for (const patch of mutations(pointer, value)) {
          let mutated;
          try {
            mutated = applyPatch(c.case, patch);
          } catch {
            continue;
          }
          if (!runnable(c.family, c.variant, mutated)) continue;
          const verdict = runCase(c.family, c.variant, mutated);
          const k = key(verdict.code, c.family);
          if (verdict.state !== 'refused' || !verdict.code || !wanted.has(k) || found[k]) continue;
          if (!best[k] || cost(patch) < cost(best[k].patch)) best[k] = { family: c.family, variant: c.variant, base: c.id, patch, derivation: 'mutation' };
        }
      }
    }
  }
  return { ...found, ...best };
}

/** The file: code -> reproducers (one per family that returns the code), plus what is missing. */
export function buildReproducerFile(existingFile = { reproducers: {} }) {
  const sources = scanRefusalSources();
  const wanted = new Set();
  for (const [code, entry] of sources) for (const s of entry.sites) wanted.add(key(code, s.family));
  const existing = Object.entries(existingFile.reproducers || {}).flatMap(([code, list]) => (Array.isArray(list) ? list : [list]).map((r) => ({ code, ...r })));
  const found = discover(wanted, existing);
  const reproducers = {};
  for (const k of [...wanted].sort()) {
    if (!found[k]) continue;
    const [code] = k.split('|');
    (reproducers[code] ||= []).push(found[k]);
  }
  // A branch proven unreachable is recorded by hand with its reason and kept while it stays
  // wanted and no reproducer is found for it.
  const unreachable = Object.fromEntries(Object.entries(existingFile.unreachable || {}).filter(([k]) => wanted.has(k) && !found[k]).sort(([a], [b]) => a.localeCompare(b)));
  return {
    schema: 'ordex.refusal-reproducers/v2',
    note: 'Generated by scripts/docs/discover-reproducers.mjs: one reproducer per refusal code and verifier family. Entries with derivation "authored", and the unreachable list, are written by hand and kept.',
    reproducers,
    unreachable,
    unavailable: [...wanted].filter((k) => !found[k] && !unreachable[k]).sort()
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const current = fs.existsSync(REPRODUCERS_PATH) ? JSON.parse(fs.readFileSync(REPRODUCERS_PATH, 'utf8')) : { reproducers: {} };
  const next = buildReproducerFile(current);
  if (process.argv.includes('--check')) {
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      console.error('site/src/lib/diagnostics/reproducers.json is out of date. Run node scripts/docs/discover-reproducers.mjs');
      process.exit(1);
    }
  } else {
    fs.writeFileSync(REPRODUCERS_PATH, `${JSON.stringify(next, null, 2)}\n`);
  }
  const all = Object.values(next.reproducers).flat();
  const counts = all.reduce((a, r) => ({ ...a, [r.derivation]: (a[r.derivation] || 0) + 1 }), {});
  console.log(`Reproducers: ${all.length} for ${Object.keys(next.reproducers).length} codes (${JSON.stringify(counts)}); unavailable: ${next.unavailable.length}`);
  if (next.unavailable.length) console.log(next.unavailable.join(' '));
}
