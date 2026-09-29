// OX-S06: build, test and start generated starter kits exactly as a user would.
//   npx tsx scripts/docs/verify-kits.mjs --install   every runtime and mode, with a real npm ci
//                                                     from the kit's own package-lock.json (CI)
//   imported by tests/unit/kit-generator.test.js     same steps, with the kit's pinned tools
//                                                     linked from this repository's node_modules
// A kit passes when it builds, its own tests pass and its start command does what its README
// says, including refusing a gateway on the wrong network.

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { generateKit } from '../../site/src/lib/kits/generator.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = promisify(execFile);
// A kit's own test run must not report into a surrounding node:test run.
const childEnv = () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
};
export const ALL_CAPABILITIES = ['asks', 'offers', 'safeops', 'swaps', 'events', 'provenance'];

export function loadKitAssets() {
  return JSON.parse(readFileSync(join(ROOT, 'site', 'src', 'data', 'kitAssets.json'), 'utf8'));
}

export function writeKit(dir, files) {
  for (const f of files) {
    const path = join(dir, ...f.path.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.content);
  }
}

/** node_modules as npm would lay it out, from this repository's copies of the pinned tools. */
export function linkLocalTools(dir, runtime) {
  const nm = join(dir, 'node_modules');
  const link = (target, name) => {
    const path = join(nm, ...name.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, 'junction');
  };
  for (const name of ['typescript', '@types/node', 'undici-types']) link(join(ROOT, 'node_modules', ...name.split('/')), name);
  if (runtime !== 'node') {
    link(join(ROOT, 'node_modules', 'esbuild'), 'esbuild');
    for (const p of readdirSync(join(ROOT, 'node_modules', '@esbuild'))) link(join(ROOT, 'node_modules', '@esbuild', p), `@esbuild/${p}`);
  }
  link(join(dir, 'vendor', 'ordex-sdk'), '@bitcoinuniverse/ordex-sdk');
}

async function npm(dir, args) {
  const isWin = process.platform === 'win32';
  return run(isWin ? 'npm.cmd' : 'npm', args, { cwd: dir, shell: isWin, env: childEnv(), maxBuffer: 64 * 1024 * 1024 });
}

/** Build and test the kit in `dir`; returns the test runner output. */
export async function buildAndTest(dir, runtime, { install = false } = {}) {
  if (install) {
    await npm(dir, ['ci', '--no-audit', '--no-fund']);
    const { stdout } = await npm(dir, ['test']);
    return stdout;
  }
  await run(process.execPath, [join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], { cwd: dir });
  if (runtime !== 'node') await run(process.execPath, ['scripts/bundle.mjs'], { cwd: dir });
  const { stdout } = await run(process.execPath, ['--test', '--test-reporter=spec', 'dist/test/*.test.js'], { cwd: dir, env: childEnv(), maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Start a long-running kit (browser or worker) and resolve with its URL and a stop function. */
export function startKit(dir, env = {}) {
  const child = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: dir, env: { ...process.env, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolveStart, reject) => {
    const timer = setTimeout(() => reject(new Error(`kit did not start: ${out}`)), 20000);
    const onData = (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolveStart({ url: `http://127.0.0.1:${m[1]}`, stop: () => new Promise((r) => (child.exitCode !== null ? r() : (child.once('exit', r), child.kill()))) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`kit exited ${code}: ${out}`)));
  });
}

/** Run the Node kit's start command; resolves with { code, stdout }. */
export function runNodeKit(dir, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, ['dist/src/index.js'], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stdout += d));
    child.once('exit', (code) => resolveRun({ code, stdout }));
  });
}

/** A loopback gateway that answers the read routes the kits use, for one network. */
export async function startFakeGateway(network) {
  const bodies = {
    '/api/ordex/health': { ok: true, status: 'active', network },
    '/api/ordex/protocol': { network, protocolVersion: '1.2' },
    '/api/ordex/orders': { orders: [], total: 0, limit: 5, nextCursor: '', hasMore: false },
    '/api/ordex/activity': { entries: [], limit: 5, nextCursor: '', hasMore: false }
  };
  const server = createServer((req, res) => {
    const body = bodies[new URL(req.url, 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(body ?? { error: 'not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Generate, build, test and start one kit. Throws on the first failure. */
// Kits are written under dist/ (ignored by git): esbuild walks parent directories, and some
// system temp directories have parents it may not read.
export const KIT_WORK_DIR = join(ROOT, 'dist', 'kit-tests');

export async function verifyKit(options, { install = false, keep = false } = {}) {
  const assets = loadKitAssets();
  const { name, files } = generateKit(options, assets);
  mkdirSync(KIT_WORK_DIR, { recursive: true });
  const dir = join(mkdtempSync(join(KIT_WORK_DIR, 'kit-')), name);
  mkdirSync(dir);
  writeKit(dir, files);
  try {
    if (!install) linkLocalTools(dir, options.runtime);
    const testOutput = await buildAndTest(dir, options.runtime, { install });
    let startOutput = '';
    if (options.runtime === 'node') {
      const r = await runNodeKit(dir);
      if (r.code !== 0) throw new Error(`npm start failed:\n${r.stdout}`);
      startOutput = r.stdout;
    } else {
      const kit = await startKit(dir);
      try {
        const path = options.runtime === 'worker' ? '/checks' : '/';
        const res = await fetch(`${kit.url}${path}`);
        startOutput = `${res.status} ${await res.text()}`;
        if (res.status !== 200) throw new Error(`GET ${path} answered ${startOutput.slice(0, 400)}`);
        if (options.runtime === 'worker' && options.mode === 'gateway') {
          const g = await fetch(`${kit.url}/gateway`);
          const body = await g.text();
          if (g.status !== 200) throw new Error(`GET /gateway answered ${g.status} ${body.slice(0, 400)}`);
        }
        if (options.runtime === 'browser') {
          const app = await fetch(`${kit.url}/app.js`);
          if (app.status !== 200) throw new Error('public/app.js is not served');
        }
      } finally {
        await kit.stop();
      }
    }
    return { dir, testOutput, startOutput };
  } finally {
    if (!keep) rmSync(dirname(dir), { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const install = process.argv.includes('--install');
  const revision = process.env.GITHUB_SHA || 'unknown';
  const gateway = await startFakeGateway('signet');
  let failed = 0;
  try {
    for (const runtime of ['node', 'browser', 'worker']) {
      for (const mode of ['offline', 'gateway']) {
        const options = { runtime, capabilities: ALL_CAPABILITIES, mode, network: 'signet', gatewayOrigin: mode === 'gateway' ? gateway.origin : '', revision };
        try {
          await verifyKit(options, { install });
          console.log(`PASS ${runtime} ${mode}`);
        } catch (err) {
          failed++;
          console.error(`FAIL ${runtime} ${mode}: ${err.stderr || err.stdout || err.message}`);
        }
      }
    }
  } finally {
    await gateway.close();
  }
  process.exitCode = failed ? 1 : 0;
}
