import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const srcDir = resolve(root, 'site', 'src');

async function getFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getFiles(full)));
    } else {
      const ext = extname(entry.name);
      if (['.ts', '.tsx', '.js', '.jsx', '.astro', '.css'].includes(ext)) {
        files.push(full);
      }
    }
  }
  return files;
}

test('style rules: zero em dashes in site/src/ source files', async () => {
  const files = await getFiles(srcDir);
  const violations = [];

  for (const f of files) {
    // Exclude pre-existing data files if any
    if (f.includes('data')) continue;
    const content = await readFile(f, 'utf8');
    if (content.includes('\u2014')) {
      violations.push(f);
    }
  }

  assert.equal(violations.length, 0, `Files containing em dashes: ${violations.join(', ')}`);
});

test('style rules: zero occurrences of prohibited word in new experience code', async () => {
  const files = await getFiles(resolve(srcDir, 'components', 'experience'));
  files.push(...(await getFiles(resolve(srcDir, 'components', 'launchpad'))));
  files.push(...(await getFiles(resolve(srcDir, 'components', 'sandbox'))));
  files.push(...(await getFiles(resolve(srcDir, 'components', 'artifact-lens'))));
  files.push(...(await getFiles(resolve(srcDir, 'components', 'failure-navigator'))));
  files.push(...(await getFiles(resolve(srcDir, 'components', 'agents'))));
  files.push(...(await getFiles(resolve(srcDir, 'lib', 'experience'))));
  files.push(...(await getFiles(resolve(srcDir, 'lib', 'scenarios'))));
  files.push(...(await getFiles(resolve(srcDir, 'lib', 'artifacts'))));
  files.push(...(await getFiles(resolve(srcDir, 'lib', 'diagnostics'))));
  files.push(...(await getFiles(resolve(srcDir, 'lib', 'mcp'))));

  const forbidden = new RegExp('\\bcanonical\\b', 'i');
  const violations = [];

  for (const f of files) {
    const content = await readFile(f, 'utf8');
    if (forbidden.test(content)) {
      violations.push(f);
    }
  }

  assert.equal(violations.length, 0, `Files containing prohibited word: ${violations.join(', ')}`);
});
