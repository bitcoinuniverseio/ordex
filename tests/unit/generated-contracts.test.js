import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { FAMILIES, FAMILY_REGISTRY, variantOf, resultKey } from '../../site/src/lib/conformance-registry.mjs';
import { loadVectorFile, buildVectorManifest } from '../../scripts/docs/vector-loader.mjs';

const read = async (name) => JSON.parse(await readFile(new URL(`../../site/src/data/${name}`, import.meta.url), 'utf8'));

// OX-S07: generated vector data must be a lossless, current copy of conformance/*.json.

test('the generated vector manifest matches the current sources', async () => {
  const tracked = await read('vectorManifest.json');
  assert.deepEqual(tracked, buildVectorManifest(), 'site/src/data is stale; run npm run build');
});

test('every family is generated under its executor name with the source count', async () => {
  const families = await read('vectorFamilies.json');
  assert.deepEqual(Object.keys(families).sort(), [...FAMILIES].sort());
  for (const family of FAMILIES) {
    const src = loadVectorFile(family);
    assert.equal(families[family].count, src.cases.length, family);
    assert.equal(families[family].cases.length, src.cases.length, family);
    assert.equal(families[family].fileSha256, src.sha256, family);
    assert.equal(families[family].resultField, FAMILY_REGISTRY[family].result, family);
  }
});

test('every generated case preserves its complete source case and its variant arguments', async () => {
  const families = await read('vectorFamilies.json');
  const ids = new Set();
  for (const family of FAMILIES) {
    const src = loadVectorFile(family);
    families[family].cases.forEach((entry, i) => {
      assert.equal(entry.family, family);
      assert.equal(entry.index, i);
      assert.deepEqual(entry.case, src.cases[i], `${family} case ${i} lost fields`);
      assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
      ids.add(entry.id);
      assert.equal(entry.variant, variantOf(family, src.cases[i]));
      const spec = FAMILY_REGISTRY[family].variants[entry.variant];
      for (const arg of spec.args) {
        assert.ok(entry.case[arg] !== undefined, `${family}/${entry.variant} ${entry.id} is missing ${arg}`);
      }
      assert.ok(Object.prototype.hasOwnProperty.call(entry.case.expected, resultKey(family, entry.variant)), `${entry.id} has no ${resultKey(family, entry.variant)}`);
    });
  }
});

test('the flat vector list is the family data in the same order', async () => {
  const families = await read('vectorFamilies.json');
  const all = await read('allVectors.json');
  assert.deepEqual(all, FAMILIES.flatMap((f) => families[f].cases));
});
