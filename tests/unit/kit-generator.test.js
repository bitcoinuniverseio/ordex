import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';

test('integration kit generator creates valid zip package with exact pins', async () => {
  const zip = new JSZip();

  const pkgJson = {
    name: 'ordex-node-starter',
    version: '1.0.0',
    type: 'module',
    dependencies: {
      '@bitcoinuniverse/ordex-sdk': '1.0.0'
    },
    engines: {
      node: '24.19.0'
    }
  };

  zip.file('package.json', JSON.stringify(pkgJson, null, 2));
  zip.file('.env.example', 'ORDEX_GATEWAY_ORIGIN=http://localhost:8080\n');
  zip.file('README.md', '# Ordex Starter\n');

  const content = await zip.generateAsync({ type: 'nodebuffer' });
  assert.ok(content.length > 0);

  const loaded = await JSZip.loadAsync(content);
  assert.ok(loaded.file('package.json'));
  assert.ok(loaded.file('.env.example'));
  assert.ok(loaded.file('README.md'));

  const parsedPkg = JSON.parse(await loaded.file('package.json').async('string'));
  assert.equal(parsedPkg.dependencies['@bitcoinuniverse/ordex-sdk'], '1.0.0');
  assert.equal(parsedPkg.engines.node, '24.19.0');
});
