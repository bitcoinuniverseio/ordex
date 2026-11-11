import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { generateMetadata, validateArtifact, root } from './metadata.mjs';

test('selected checkout generates matching publication metadata and rejects stale output', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'version-artifact-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    await mkdir(resolve(dir, 'sdk'));
    await writeFile(resolve(dir, 'sdk/package.json'), '{"version":"1.2.3"}');
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'source']);
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    for (const channel of ['production', 'development']) {
      const expected = await generateMetadata(dir, channel);
      assert.deepEqual(expected, { version: '1.2.3', sha, channel });
      await mkdir(resolve(dir, 'dist/client'), { recursive: true });
      await mkdir(resolve(dir, 'docs'), { recursive: true });
      await cp(resolve(dir, 'site/public/version.json'), resolve(dir, 'dist/client/version.json'));
      await cp(resolve(dir, 'dist/client/version.json'), resolve(dir, 'docs/version.json'));
      for (const output of ['dist/client', 'docs']) {
        await mkdir(resolve(dir, output, 'assets'), { recursive: true });
        await writeFile(resolve(dir, output, 'index.html'), '<script src="/ordex/assets/page.test.js"></script>');
        await writeFile(resolve(dir, output, 'assets/page.test.js'), `window.__APP_VERSION__ = ${JSON.stringify(expected)}`);
      }
      await validateArtifact(dir, expected);
      await writeFile(resolve(dir, 'docs/assets/page.test.js'), 'window.__APP_VERSION__ = {}');
      await assert.rejects(validateArtifact(dir, expected));
      await writeFile(resolve(dir, 'docs/assets/page.test.js'), `window.__APP_VERSION__ = ${JSON.stringify(expected)}`);
      await writeFile(resolve(dir, 'docs/version.json'), JSON.stringify({ ...expected, sha: '0'.repeat(40) }));
      await assert.rejects(validateArtifact(dir, expected));
    }
    await assert.rejects(generateMetadata(dir, 'unknown'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Pages workflow builds, validates, uploads docs and deploys only by manual main guard', async () => {
  const workflow = await readFile(resolve(root, '.github/workflows/pages.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.equal((workflow.match(/github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/g) || []).length, 2);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /APP_BUILD_CHANNEL: production/);
  assert.match(workflow, /node site\/version-build\/verify-artifact\.mjs[\s\S]*actions\/upload-pages-artifact@[a-f0-9]{40}[\s\S]*path: docs[\s\S]*needs: build[\s\S]*actions\/deploy-pages@[a-f0-9]{40}/);
});
