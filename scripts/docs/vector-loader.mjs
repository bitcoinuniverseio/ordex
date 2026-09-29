// OX-S07: Node-only loader for the checked-in conformance vectors. File system access
// lives here so the shared executor (site/src/lib/conformance-engine.mjs) stays free of
// Node built-ins and can run unchanged in a browser Worker.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FAMILY_REGISTRY, FAMILIES, familyForFile, isKnownFamily } from '../../site/src/lib/conformance-registry.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CONFORMANCE_DIR = path.join(ROOT, 'conformance');

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Digest of a checked-in text file as git stores it (LF line endings), so the same
 * source hashes identically on a Windows checkout and on a Linux CI runner.
 */
export function sourceTextDigest(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  return sha256Hex(Buffer.from(text, 'utf8'));
}

/** Read one family's vector file exactly as checked in, with its source digest. */
export function loadVectorFile(family, dir = CONFORMANCE_DIR) {
  if (!isKnownFamily(family)) throw new Error(`Unknown vector family: ${family}`);
  const file = FAMILY_REGISTRY[family].file;
  const filePath = path.join(dir, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const cases = data.cases || data.vectors;
  if (!Array.isArray(cases)) throw new Error(`${file} has no cases array`);
  return { family, file, sha256: sourceTextDigest(filePath), data, cases };
}

/** Source cases for one family, each tagged with its family and a display title. */
export function loadVectorFamily(family, dir = CONFORMANCE_DIR) {
  return loadVectorFile(family, dir).cases.map((c) => ({ ...c, family, title: c.name || c.title || c.description }));
}

/** Every family's source data keyed by executor family name, ready for runConformanceSuite. */
export function loadAllFamilies(dir = CONFORMANCE_DIR) {
  const out = {};
  for (const family of FAMILIES) out[family] = loadVectorFile(family, dir).data;
  return out;
}

/** Every JSON file in conformance/ must belong to a registered family. */
export function assertNoUnregisteredVectorFiles(dir = CONFORMANCE_DIR) {
  const stray = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !familyForFile(f));
  if (stray.length) throw new Error(`Vector files with no registered family: ${stray.join(', ')}`);
}

/** Digest over every family file digest, in registry order. */
export function vectorSetDigest(dir = CONFORMANCE_DIR) {
  const lines = FAMILIES.map((f) => `${f}:${loadVectorFile(f, dir).sha256}`).join('\n');
  return sha256Hex(Buffer.from(lines, 'utf8'));
}

function digestOfFiles(paths) {
  const lines = paths.map((p) => `${path.relative(ROOT, p).replace(/\\/g, '/')}:${sourceTextDigest(p)}`).join('\n');
  return sha256Hex(Buffer.from(lines, 'utf8'));
}

/**
 * The provenance the generated vector data is pinned to: the vector files, the API
 * contracts and the verifier sources. tests/unit/generated-contracts.test.js recomputes
 * it and fails when tracked generated data no longer matches its sources.
 */
export function buildVectorManifest(dir = CONFORMANCE_DIR) {
  const families = {};
  let total = 0;
  for (const family of FAMILIES) {
    const { file, sha256, cases } = loadVectorFile(family, dir);
    families[family] = { file, sha256, count: cases.length };
    total += cases.length;
  }
  const verifierDir = path.join(ROOT, 'verifier');
  const verifierFiles = fs
    .readdirSync(verifierDir)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join(verifierDir, f));
  return {
    schema: 'ordex.vector-manifest/v1',
    total,
    familyCount: FAMILIES.length,
    vectorDigest: vectorSetDigest(dir),
    specDigest: digestOfFiles([path.join(ROOT, 'spec', 'openapi.json'), path.join(ROOT, 'spec', 'asyncapi.json')]),
    verifierDigest: digestOfFiles(verifierFiles),
    families
  };
}
