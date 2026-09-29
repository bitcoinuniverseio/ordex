// Records Bitcoin Core 26.0 libbitcoinconsensus script verdicts for the offer
// transactions. Run from the repository root with Rust and a C++ compiler:
//   node conformance/script-differential/run.mjs
// It writes libbitcoinconsensus-26.0-results.json next to this file, which
// verifier/offers.delivery-recovery.test.js replays without Rust.
//
// On Windows with MSVC, bitcoinconsensus 0.106.0+26.0 compiles secp256k1
// without SECP256K1_STATIC and without the ellswift module, which fails to
// link; the two defines below are passed to that build only.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { scriptCorpus } from './corpus.mjs';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const cases = scriptCorpus();
const env = { ...process.env };
if (process.platform === 'win32') {
  env.CFLAGS = `${env.CFLAGS ?? ''} -DSECP256K1_STATIC -DENABLE_MODULE_ELLSWIFT=1`.trim();
  env.CXXFLAGS = `${env.CXXFLAGS ?? ''} -DSECP256K1_STATIC`.trim();
}
const stdout = execFileSync('cargo', ['run', '--release', '--quiet', '--manifest-path', here('./Cargo.toml')], {
  input: JSON.stringify(cases),
  maxBuffer: 64 * 1024 * 1024,
  env,
});
const answers = JSON.parse(stdout.toString('utf8'));
const lines = cases.map((c, i) => `    ${JSON.stringify(c.name)}: ${JSON.stringify({ txHex: c.txHex, inputs: answers[i] })}`);
writeFileSync(
  here('./libbitcoinconsensus-26.0-results.json'),
  `{\n  "reference": "Bitcoin Core 26.0 libbitcoinconsensus (bitcoinconsensus 0.106.0+26.0), VERIFY_ALL_PRE_TAPROOT | VERIFY_TAPROOT",\n  "cases": {\n${lines.join(',\n')}\n  }\n}\n`
);
console.log(`recorded consensus script verdicts for ${cases.length} transactions`);
