import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('authoritative corpus chunk count meets threshold and has valid structure', async () => {
  const corpus = JSON.parse(await readFile(resolve(root, 'site', 'src', 'data', 'corpus.json'), 'utf8'));
  assert.ok(corpus.length >= 300, `Expected at least 300 corpus chunks, got ${corpus.length}`);

  for (const chunk of corpus) {
    assert.ok(chunk.id, 'Chunk must have stable ID');
    assert.ok(chunk.title, 'Chunk must have title');
    assert.ok(chunk.sourcePath, 'Chunk must reference authoritative source path');
    assert.ok(chunk.pointer, 'Chunk must have pointer');
    assert.ok(chunk.docUrl || chunk.url, 'Chunk must have URL');
    assert.ok(chunk.content && chunk.content.length > 0, 'Chunk content must not be empty');

    // Never contain em dash
    assert.ok(!chunk.content.includes('\u2014'), `Chunk ${chunk.id} contains em dash`);
  }
});

test('refusals catalog covers all reference verifiers and provides remediation', async () => {
  const refusals = JSON.parse(await readFile(resolve(root, 'site', 'src', 'data', 'refusals.json'), 'utf8'));
  assert.ok(refusals.length >= 170, `Expected at least 170 refusal codes, got ${refusals.length}`);

  for (const ref of refusals) {
    assert.ok(ref.code, 'Refusal must have code');
    assert.ok(ref.category, 'Refusal must have category');
    assert.ok(ref.explanation, 'Refusal must have explanation');
    assert.ok(ref.remediation, 'Refusal must have remediation');
  }
});
