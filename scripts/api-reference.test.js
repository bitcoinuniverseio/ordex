import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderApiReference } from './api-reference.mjs';

const contractPath = fileURLToPath(new URL('../spec/openapi.json', import.meta.url));
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const page = renderApiReference(contract);

test('the page names every operation in the contract', () => {
  for (const item of Object.values(contract.paths)) {
    for (const method of ['get', 'post']) {
      if (item[method]) {
        assert.ok(page.includes(`id="${item[method].operationId}"`), item[method].operationId);
      }
    }
  }
});

test('the page names every schema in the contract', () => {
  for (const name of Object.keys(contract.components.schemas)) {
    assert.ok(page.includes(`id="schema-${name}"`), name);
  }
});

test('the page states the contract version it was generated from', () => {
  assert.ok(page.includes(`version ${contract.info.version}`));
});

test('markup characters in contract prose are escaped', () => {
  assert.ok(!page.includes('SIGHASH_SINGLE | <'));
  assert.ok(page.includes('&quot;') || !page.includes('description="'));
});
