#!/usr/bin/env node
// OX-S01: extract the normative PSBT test vectors from the pinned BIP174 and BIP370 texts
// into tests/fixtures/psbt/bip-vectors.json. The source files must hash (git blob SHA-1) to
// the blobs pinned in the handoff research register, so the fixtures cannot drift from the
// reviewed specification text.
//
// Usage: node scripts/docs/extract-bip-psbt-vectors.mjs <bip-0174.mediawiki> <bip-0370.mediawiki>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PINNED = {
  bip174: 'ecaa5d127fdcd257dde8b119f78729841946121b',
  bip370: '93b56e883a3c1a64d7a3c1da66a542d52a37ee03'
};

function gitBlobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function load(path, key) {
  const bytes = readFileSync(path);
  const sha = gitBlobSha(bytes);
  if (sha !== PINNED[key]) throw new Error(`${path} is blob ${sha}, expected pinned ${PINNED[key]}`);
  return bytes.toString('utf8').split('\n');
}

const hexOf = (line) => line.match(/<pre>([0-9a-f]+)<\/pre>/)?.[1] || null;

function extract174(lines) {
  const start = lines.findIndex((l) => l.startsWith('==Test Vectors=='));
  const out = { invalid: [], valid: [], parsesButFailsSigner: [], roleSequence: [], extractedTransaction: null };
  let section = null;
  let name = null;
  let lastProse = null;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('==Rationale==')) break;
    if (/^[A-Z]/.test(l)) lastProse = l.trim();
    if (section === 'roles' && /^\* Bytes in Hex/.test(l) && hexOf(l) && !/transaction extractor/.test(lastProse || '')) {
      out.roleSequence.push({ step: lastProse, hex: hexOf(l) });
    }
    if (l.startsWith('The following are invalid PSBTs')) section = 'invalid';
    else if (l.startsWith('The following are valid PSBTs')) section = 'valid';
    else if (l.startsWith('Fails Signer checks')) section = 'parsesButFailsSigner';
    else if (l.startsWith('The private keys in the tests below')) section = 'roles';
    else if (l.includes('a transaction extractor must create this Bitcoin transaction')) section = 'extractor';
    const caseMatch = l.match(/^\* Case: (.*)$/);
    if (caseMatch) name = caseMatch[1].trim();
    if (/Bytes in Hex/.test(l)) {
      const hex = hexOf(l);
      if (!hex) continue;
      if (section === 'extractor') {
        out.extractedTransaction = hex;
        section = 'roles';
      } else if (section && section !== 'roles' && name) {
        out[section].push({ name, hex });
        name = null;
      }
    }
  }
  return out;
}

function extract370(lines) {
  const start = lines.findIndex((l) => l.startsWith('==Test Vectors=='));
  const out = { invalid: [], valid: [], locktime: [] };
  let section = null;
  let locktime;
  let name = null;
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('==Rationale==')) break;
    if (l.startsWith('The following are invalid PSBTs')) section = 'invalid';
    else if (l.startsWith('The following are valid PSBTs')) section = 'valid';
    else if (/should be computed to be (\d+)/.test(l)) {
      section = 'locktime';
      locktime = Number(l.match(/should be computed to be (\d+)/)[1]);
    } else if (/cannot be computed/.test(l)) {
      section = 'locktime';
      locktime = null;
    }
    const caseMatch = l.match(/^\* Case: (.*)$/);
    if (caseMatch) name = caseMatch[1].trim();
    if (/Bytes in Hex/.test(l) && section && name) {
      const hex = hexOf(l);
      if (!hex) continue;
      if (section === 'locktime') out.locktime.push({ name, hex, locktime });
      else out[section].push({ name, hex });
      name = null;
    }
  }
  return out;
}

const [p174, p370] = process.argv.slice(2);
if (!p174 || !p370) {
  console.error('Usage: node scripts/docs/extract-bip-psbt-vectors.mjs <bip-0174.mediawiki> <bip-0370.mediawiki>');
  process.exit(2);
}
const result = {
  source: {
    bip174: { path: 'bitcoin/bips:bip-0174.mediawiki', blob: PINNED.bip174, version: '1.4.4' },
    bip370: { path: 'bitcoin/bips:bip-0370.mediawiki', blob: PINNED.bip370 }
  },
  bip174: extract174(load(p174, 'bip174')),
  bip370: extract370(load(p370, 'bip370'))
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outPath = join(root, 'tests', 'fixtures', 'psbt', 'bip-vectors.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
console.log(
  `bip174: ${result.bip174.invalid.length} invalid, ${result.bip174.valid.length} valid, ${result.bip174.parsesButFailsSigner.length} signer-fail; ` +
    `bip370: ${result.bip370.invalid.length} invalid, ${result.bip370.valid.length} valid, ${result.bip370.locktime.length} locktime`
);
