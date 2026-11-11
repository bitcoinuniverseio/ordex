import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, validateArtifact } from './metadata.mjs';

const sha = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root, encoding: 'utf8' }).trim();
const { version } = JSON.parse(await readFile(resolve(root, 'sdk/package.json'), 'utf8'));
const channel = process.env.APP_BUILD_CHANNEL;
if (!['development', 'production'].includes(channel)) throw new Error('APP_BUILD_CHANNEL must be explicit');
await validateArtifact(root, { version, sha, channel });
