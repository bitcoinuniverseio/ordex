// Records rust-bitcoin 0.32.5's signature hashes for the seeded corpus. Run
// from the repository root with a Rust toolchain available:
//   node conformance/bitcoin-differential/run.mjs
// It writes bitcoin-0.32.5-results.json next to this file, which
// verifier/bitcoin-tx.differential.test.js replays without Rust.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { sighashCorpus } from './corpus.mjs';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const cases = sighashCorpus();
const stdout = execFileSync('cargo', ['run', '--release', '--quiet', '--manifest-path', here('./Cargo.toml')], {
  input: JSON.stringify(cases),
  maxBuffer: 64 * 1024 * 1024,
});
const answers = JSON.parse(stdout.toString('utf8'));
const lines = cases.map((c, i) => `    ${JSON.stringify(c.name)}: ${JSON.stringify(answers[i])}`);
writeFileSync(
  here('./bitcoin-0.32.5-results.json'),
  `{\n  "reference": "rust-bitcoin 0.32.5 SighashCache",\n  "cases": {\n${lines.join(',\n')}\n  }\n}\n`
);
console.log(`recorded rust-bitcoin sighashes for ${cases.length} cases`);
