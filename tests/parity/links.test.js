import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('critical internal navigation links point to existing static routes', async () => {
  const indexHtml = await readFile(resolve(root, 'dist', 'client', 'index.html'), 'utf8');

  // Regex extract hrefs starting with /
  const hrefs = new Set();
  const matches = indexHtml.matchAll(/href="(\/[^"#?]*)/g);
  for (const match of matches) {
    hrefs.add(match[1]);
  }

  for (const href of hrefs) {
    if (href === '/' || href === '/ordex' || href === '/ordex/') continue;
    const cleanPath = href.replace(/^\/ordex\/?/, '').replace(/^\//, '').replace(/\/$/, '');
    if (!cleanPath) continue;
    const candidate1 = resolve(root, 'dist', 'client', cleanPath, 'index.html');
    const candidate2 = resolve(root, 'dist', 'client', `${cleanPath}.html`);
    const candidate3 = resolve(root, 'dist', 'client', cleanPath);

    const ok1 = await access(candidate1).then(() => true).catch(() => false);
    const ok2 = await access(candidate2).then(() => true).catch(() => false);
    const ok3 = await access(candidate3).then(() => true).catch(() => false);

    assert.ok(ok1 || ok2 || ok3, `Internal link target ${href} does not exist in dist/client/`);
  }
});
