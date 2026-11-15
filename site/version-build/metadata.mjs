import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function generateMetadata(directory = root, channel = process.env.APP_BUILD_CHANNEL ?? 'development') {
  if (!['development', 'production'].includes(channel)) throw new Error('Invalid APP_BUILD_CHANNEL');
  const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: directory, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a full source SHA');
  const { version } = JSON.parse(await readFile(resolve(directory, 'sdk/package.json'), 'utf8'));
  if (typeof version !== 'string' || !version) throw new Error('Missing SDK version');
  const metadata = { version, sha, channel };
  const json = `${JSON.stringify(metadata, null, 2)}\n`;
  for (const path of ['site/src/generated/app-version.json', 'site/public/version.json']) {
    const target = resolve(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, json);
  }
  return metadata;
}

export async function validateArtifact(directory, expected) {
  for (const path of ['site/src/generated/app-version.json', 'site/public/version.json', 'dist/client/version.json', 'docs/version.json']) {
    const actual = JSON.parse(await readFile(resolve(directory, path), 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Invalid metadata: ${path}`);
  }
  // Validate the script referenced by the actual upload entry point, not a stale asset.
  for (const output of ['dist/client', 'docs']) {
    const html = await readFile(resolve(directory, output, 'index.html'), 'utf8');
    const script = html.match(/src="\/ordex\/(assets\/page\.[^"/]+\.js)"/);
    if (!script) throw new Error(`Missing baked metadata script: ${output}`);
    const source = await readFile(resolve(directory, output, script[1]), 'utf8');
    for (const value of ['__APP_VERSION__', expected.version, expected.sha, expected.channel]) {
      if (!source.includes(value)) throw new Error(`Invalid baked metadata: ${output}`);
    }
  }
}
