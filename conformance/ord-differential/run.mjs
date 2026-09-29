// Records what the pinned ord 0.29.0 says about every rune vector and every
// case of the seeded random corpus. Run from the repository root with a Rust
// toolchain available:
//   node conformance/ord-differential/run.mjs
// It writes ord-0.29.0-results.json next to this file. The verifier and SDK
// parity tests replay that file, so they need no Rust toolchain themselves.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { differentialCorpus } from './corpus.mjs';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

const vectors = JSON.parse(readFileSync(here('../rune-burn-vectors.json'), 'utf8')).cases;
const cases = [...vectors, ...differentialCorpus()];

function balancesOf(inputs) {
  const flat = [];
  for (const input of inputs) {
    if (!input || input.indexed !== true) return null;
    if (Array.isArray(input.balances)) {
      for (const b of input.balances) flat.push([b.runeId, b.amount]);
    } else if (input.runes > 0) {
      return null;
    }
  }
  return flat;
}

const request = cases.map((c) => {
  const balances = balancesOf(c.inputs);
  return {
    outputs: c.outputScriptsHex,
    ...(balances ? { balances } : {}),
    mint: c.mint?.amount ?? '0',
  };
});

const stdout = execFileSync(
  'cargo',
  ['run', '--release', '--quiet', '--manifest-path', here('./Cargo.toml')],
  { input: JSON.stringify(request), maxBuffer: 64 * 1024 * 1024 }
);
const answers = JSON.parse(stdout.toString('utf8'));

const results = {};
cases.forEach((c, index) => {
  results[c.name] = answers[index];
});

// One case per line keeps the file reviewable and its diffs small.
const reference =
  'ord 0.29.0, commit 7e37a3bd3391044b39f5f11f20dfdb8b3764cd0e (ordinals crate Runestone::decipher and rune_updater.rs allocation)';
const lines = Object.entries(results).map(([name, answer]) => `    ${JSON.stringify(name)}: ${JSON.stringify(answer)}`);
writeFileSync(
  here('./ord-0.29.0-results.json'),
  `{\n  "reference": ${JSON.stringify(reference)},\n  "cases": {\n${lines.join(',\n')}\n  }\n}\n`
);
console.log(`recorded ord 0.29.0 answers for ${cases.length} cases`);
