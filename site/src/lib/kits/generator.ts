// OX-S06: deterministic starter-kit generator. Pure: the same options and assets always give
// the same files, and createKitZip gives the same bytes. Each runtime gets its own entry,
// build and start scripts; each selected capability is wired to the SDK verifier that
// answers it and ships the checked-in conformance vectors as its consumer test; gateway mode
// adds typed read-only SDK calls to a configured origin and network. No credentials, keys,
// signing or broadcasting are ever generated.

import { normalizeGatewayOrigin, NETWORKS } from '../session/journey-schema.js';

export const KIT_RUNTIMES = [
  { id: 'node', label: 'Node.js service', description: 'A Node 24 program: runs the checks, and in gateway mode reads the gateway with the typed client.' },
  { id: 'browser', label: 'Browser app', description: 'A static page bundled with esbuild. No Node modules or process.env in the page.' },
  { id: 'worker', label: 'Fetch-handler worker', description: 'A Workers-compatible module that exports fetch(request, env). Runs locally on Node for development.' }
] as const;
export type KitRuntime = (typeof KIT_RUNTIMES)[number]['id'];

export const KIT_CAPABILITIES = [
  { id: 'asks', label: 'Public asks and purchases', family: 'purchase', gatewayRead: 'orders' },
  { id: 'offers', label: 'Buyer-funded offers', family: 'offers', gatewayRead: null },
  { id: 'safeops', label: 'SafeOps plans and signed results', family: 'safeops', gatewayRead: null },
  { id: 'swaps', label: 'Swap intents and acceptances', family: 'swaps', gatewayRead: null },
  { id: 'events', label: 'Events and signed webhooks', family: 'events', gatewayRead: 'activity' },
  { id: 'provenance', label: 'Collection manifests and membership', family: 'collection-manifest', gatewayRead: null }
] as const;
export type KitCapability = (typeof KIT_CAPABILITIES)[number]['id'];

export const KIT_MODES = [
  { id: 'offline', label: 'Offline', description: 'Verifies the checked-in conformance vectors with the SDK. No network access.' },
  { id: 'gateway', label: 'Configured gateway', description: 'Also reads a gateway you name, read-only, and refuses one on the wrong network.' }
] as const;
export type KitMode = (typeof KIT_MODES)[number]['id'];

export interface KitOptions {
  runtime: KitRuntime;
  capabilities: KitCapability[];
  mode: KitMode;
  network: string;
  gatewayOrigin: string;
  revision: string;
}

export interface KitAssets {
  schema: string;
  sdk: { name: string; version: string; license: string; sourceSha256: string; files: Record<string, string> };
  fixtures: Record<string, { file: string; sha256: string; text: string }>;
  cryptoShim: { path: string; sha256: string; text: string };
  tools: Record<string, string>;
  node: string;
  lockPackages: Record<string, Record<string, unknown>>;
}

export interface KitFile {
  path: string;
  content: string;
}

const REPOSITORY = 'https://github.com/bitcoinuniverseio/ordex';
// Every file in the archive carries this timestamp so the ZIP bytes are reproducible.
export const KIT_ZIP_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

/** Problems with the options; empty when a kit can be generated. */
export function validateKitOptions(o: Partial<KitOptions>): string[] {
  const errors: string[] = [];
  if (!KIT_RUNTIMES.some((r) => r.id === o.runtime)) errors.push('Choose a runtime.');
  if (!Array.isArray(o.capabilities) || o.capabilities.length === 0) errors.push('Choose at least one capability.');
  else for (const c of o.capabilities) if (!KIT_CAPABILITIES.some((k) => k.id === c)) errors.push(`Unknown capability ${String(c)}.`);
  if (!KIT_MODES.some((m) => m.id === o.mode)) errors.push('Choose offline or configured gateway.');
  if (!NETWORKS.includes(o.network as (typeof NETWORKS)[number])) errors.push(`Network must be one of ${NETWORKS.join(', ')}.`);
  if (o.mode === 'gateway') {
    const origin = normalizeGatewayOrigin(o.gatewayOrigin ?? '');
    if (!origin.ok) errors.push(origin.error);
    else if (origin.origin === '') errors.push('Gateway mode needs a gateway origin.');
  }
  if (typeof o.revision !== 'string' || !/^([0-9a-f]{7,64}|unknown)$/.test(o.revision)) errors.push('The source revision must be a commit id or unknown.');
  return errors;
}

export function kitName(o: Pick<KitOptions, 'runtime'>): string {
  return `ordex-${o.runtime}-kit`;
}

const selected = (o: KitOptions) => KIT_CAPABILITIES.filter((c) => o.capabilities.includes(c.id));
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const lines = (...rows: (string | false | null | undefined)[]) => `${rows.filter((r) => r !== false && r !== null && r !== undefined).join('\n')}\n`;

function packageJson(o: KitOptions, assets: KitAssets) {
  const bundled = o.runtime !== 'node';
  const scripts: Record<string, string> = {
    build: bundled ? 'tsc -p tsconfig.json && node scripts/bundle.mjs' : 'tsc -p tsconfig.json',
    test: 'npm run build && node --test dist/test/*.test.js',
    start: o.runtime === 'node' ? 'npm run build && node dist/src/index.js' : 'npm run build && node scripts/serve.mjs'
  };
  const devDependencies: Record<string, string> = { '@types/node': assets.tools['@types/node'], typescript: assets.tools.typescript };
  if (bundled) devDependencies.esbuild = assets.tools.esbuild;
  return {
    name: kitName(o),
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: assets.node },
    scripts,
    dependencies: { [assets.sdk.name]: 'file:vendor/ordex-sdk' },
    devDependencies: Object.fromEntries(Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b)))
  };
}

function packageLock(o: KitOptions, assets: KitAssets) {
  const pkg = packageJson(o, assets);
  const wanted = (key: string) => {
    const name = key.replace(/^node_modules\//, '');
    if (name === 'typescript' || name === '@types/node' || name === 'undici-types') return true;
    return o.runtime !== 'node' && (name === 'esbuild' || name.startsWith('@esbuild/'));
  };
  const packages: Record<string, unknown> = {
    '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, engines: pkg.engines },
    [`node_modules/${assets.sdk.name}`]: { resolved: 'vendor/ordex-sdk', link: true }
  };
  for (const key of Object.keys(assets.lockPackages).filter(wanted).sort()) packages[key] = { ...assets.lockPackages[key], dev: true };
  packages['vendor/ordex-sdk'] = { name: assets.sdk.name, version: assets.sdk.version, license: assets.sdk.license };
  return { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages };
}

function sdkPackageJson(assets: KitAssets) {
  return {
    name: assets.sdk.name,
    version: assets.sdk.version,
    license: assets.sdk.license,
    type: 'module',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } }
  };
}

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    lib: ['ES2022', 'DOM'],
    types: ['node'],
    strict: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    rootDir: '.',
    outDir: 'dist'
  },
  include: ['src', 'test']
};

function configTs(o: KitOptions, assets: KitAssets) {
  return lines(
    '// Generated by the Ordex kit generator. Settings live here, not in code.',
    `export const MODE: 'offline' | 'gateway' = '${o.mode}';`,
    `export const NETWORK = '${o.network}';`,
    `// Read-only gateway origin, gateway mode only. No credentials are ever needed or stored.`,
    `export const GATEWAY_ORIGIN = '${o.mode === 'gateway' ? normalizedOrigin(o) : ''}';`,
    `export const CAPABILITIES = ${JSON.stringify(selected(o).map((c) => c.id))} as const;`,
    `export const SOURCE = ${JSON.stringify({ repository: REPOSITORY, revision: o.revision, sdk: `${assets.sdk.name}@${assets.sdk.version}`, sdkSourceSha256: assets.sdk.sourceSha256 })} as const;`
  );
}

function normalizedOrigin(o: KitOptions): string {
  const r = normalizeGatewayOrigin(o.gatewayOrigin);
  return r.ok ? r.origin : '';
}

// How each capability calls the SDK. The fixture shapes are those of the checked-in vectors.
const CAPABILITY_CODE: Record<KitCapability, { imports: string[]; run: string }> = {
  asks: { imports: ['verifyPublicAskCompletion'], run: '(c) => verifyPublicAskCompletion(c.transaction, c.order)' },
  offers: {
    imports: ['verifyOfferAcceptance', 'verifyOfferRecovery', 'verifyOfferTerms'],
    run: "(c) => (c.kind === 'acceptance' ? verifyOfferAcceptance(c.acceptance, c.offer) : c.kind === 'recovery' ? verifyOfferRecovery(c.recovery, c.offer) : verifyOfferTerms(c.terms))"
  },
  safeops: { imports: ['verifySafeOpsPlan', 'verifySafeOpsSignedResult'], run: '(c) => (c.signed ? verifySafeOpsSignedResult(c.signed, c.plan) : verifySafeOpsPlan(c.plan))' },
  swaps: { imports: ['verifySwapAcceptance', 'verifySwapIntent'], run: '(c) => (c.acceptance ? verifySwapAcceptance(c.acceptance, c.intent) : verifySwapIntent(c.intent))' },
  events: {
    imports: ['signWebhookDelivery', 'validateOrdexEvent', 'verifyWebhookSignature'],
    run: "(c) => {\n      if (c.kind !== 'webhook') return validateOrdexEvent(c.event);\n      const { headerOverride, ...verifying } = c.verifying;\n      return verifyWebhookSignature({ header: headerOverride || signWebhookDelivery(c.signing), ...verifying });\n    }"
  },
  provenance: {
    imports: ['verifyCollectionManifest', 'verifyManifestRevocation', 'verifyMembershipProof'],
    run: '(c) =>\n      c.membership\n        ? verifyMembershipProof({ manifest: c.manifest, memberIdentity: c.membership.memberIdentity, proof: c.membership.proof })\n        : c.revocation\n          ? verifyManifestRevocation(c.revocation, c.manifest)\n          : verifyCollectionManifest(c.manifest)'
  }
};

const ident = (id: string) => `${id}Vectors`;

function capabilitiesTs(o: KitOptions, assets: KitAssets) {
  const caps = selected(o);
  const imports = [...new Set(caps.flatMap((c) => CAPABILITY_CODE[c.id].imports))].sort();
  return lines(
    `import { ${imports.join(', ')} } from '${assets.sdk.name}';`,
    ...caps.map((c) => `import ${ident(c.id)} from '../fixtures/${assets.fixtures[c.id].file}' with { type: 'json' };`),
    '',
    '// A conformance case is JSON from the checked-in vector file. The SDK verifiers check the',
    '// shape of what they receive at run time and refuse anything malformed.',
    '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
    'export type Case = { name: string; expected: { ok: boolean; code?: string } } & Record<string, any>;',
    'export interface Verdict {',
    '  ok: boolean;',
    '  code?: string;',
    '  reason?: string;',
    '}',
    'export interface Capability {',
    '  id: string;',
    '  label: string;',
    '  family: string;',
    '  cases: Case[];',
    '  run: (c: Case) => Verdict;',
    '}',
    '',
    'export const capabilities: Capability[] = [',
    ...caps.map((c, i) =>
      [
        '  {',
        `    id: '${c.id}',`,
        `    label: '${c.label}',`,
        `    family: '${c.family}',`,
        `    cases: ${ident(c.id)}.cases as unknown as Case[],`,
        `    run: ${CAPABILITY_CODE[c.id].run}`,
        `  }${i < caps.length - 1 ? ',' : ''}`
      ].join('\n')
    ),
    '];'
  );
}

const CHECKS_TS = lines(
  "import { capabilities, type Capability } from './capabilities.js';",
  '',
  'export interface CheckResult {',
  '  capability: string;',
  '  name: string;',
  '  expectedOk: boolean;',
  '  expectedCode: string | null;',
  '  ok: boolean | null;',
  '  code: string | null;',
  '  match: boolean;',
  '  error: string | null;',
  '}',
  '',
  '/** Run every conformance case of every capability through the SDK and compare. */',
  'export function runChecks(list: Capability[] = capabilities) {',
  '  const results: CheckResult[] = [];',
  '  for (const cap of list) {',
  '    for (const c of cap.cases) {',
  '      const expectedCode = c.expected.code ?? null;',
  '      try {',
  '        const verdict = cap.run(c);',
  '        const code = verdict.ok ? null : verdict.code ?? null;',
  '        const match = verdict.ok === c.expected.ok && (c.expected.ok || expectedCode === null || code === expectedCode);',
  '        results.push({ capability: cap.id, name: c.name, expectedOk: c.expected.ok, expectedCode, ok: verdict.ok, code, match, error: null });',
  '      } catch (err) {',
  '        results.push({ capability: cap.id, name: c.name, expectedOk: c.expected.ok, expectedCode, ok: null, code: null, match: false, error: (err as Error).message });',
  '      }',
  '    }',
  '  }',
  '  const matched = results.filter((r) => r.match).length;',
  '  return { results, matched, total: results.length, passed: results.length > 0 && matched === results.length };',
  '}'
);

function gatewayTs() {
  return lines(
    "import { OrdexApiError, OrdexClient } from '@bitcoinuniverse/ordex-sdk';",
    "import { CAPABILITIES } from './config.js';",
    '',
    'export interface GatewayStep {',
    '  name: string;',
    '  ok: boolean;',
    '  detail: string;',
    '}',
    '',
    '/** Reads the selected capabilities need. Offers, SafeOps, swaps and manifests have no SDK read route. */',
    'export function gatewayReads(capabilities: readonly string[] = CAPABILITIES): string[] {',
    '  const reads: string[] = [];',
    "  if (capabilities.includes('asks')) reads.push('orders');",
    "  if (capabilities.includes('events')) reads.push('activity');",
    '  return reads;',
    '}',
    '',
    'const describe = (err: unknown) => (err instanceof OrdexApiError ? `HTTP ${err.status}: ${err.message}` : (err as Error)?.message || String(err));',
    '',
    '/**',
    ' * Read-only gateway check with the typed client: health, then the protocol contract, whose',
    ' * network must be the one this kit was generated for, then the capability reads. It stops',
    ' * at the first failure, because later reads would be meaningless.',
    ' */',
    'export async function checkGateway(origin: string, network: string, reads: string[], fetchImpl?: typeof fetch): Promise<{ ok: boolean; steps: GatewayStep[] }> {',
    '  const steps: GatewayStep[] = [];',
    '  if (!origin) {',
    "    steps.push({ name: 'origin', ok: false, detail: 'No gateway origin is configured.' });",
    '    return { ok: false, steps };',
    '  }',
    '  const client = fetchImpl ? new OrdexClient({ baseUrl: origin, timeoutMs: 10_000, fetch: fetchImpl }) : new OrdexClient({ baseUrl: origin, timeoutMs: 10_000 });',
    '  const step = async (name: string, run: () => Promise<string>) => {',
    '    try {',
    '      steps.push({ name, ok: true, detail: await run() });',
    '      return true;',
    '    } catch (err) {',
    '      steps.push({ name, ok: false, detail: describe(err) });',
    '      return false;',
    '    }',
    '  };',
    "  if (!(await step('health', async () => {",
    '    const health = await client.getHealth();',
    '    if (health.ok !== true) throw new Error(`The gateway reports status ${health.status}.`);',
    '    return `status ${health.status}`;',
    '  }))) return { ok: false, steps };',
    "  if (!(await step('network', async () => {",
    '    const protocol = await client.getProtocol();',
    '    if (protocol.network !== network) throw new Error(`The gateway serves ${protocol.network}; this kit is configured for ${network}.`);',
    '    return `${protocol.network}, protocol ${protocol.protocolVersion}`;',
    '  }))) return { ok: false, steps };',
    "  if (reads.includes('orders') && !(await step('orders', async () => {",
    "    const page = await client.listOrders({ limit: '5' });",
    '    return `${page.orders.length} of ${page.total} orders read`;',
    '  }))) return { ok: false, steps };',
    "  if (reads.includes('activity') && !(await step('activity', async () => {",
    "    const page = await client.listActivity({ limit: '5' });",
    '    return `${page.entries.length} activity entries read`;',
    '  }))) return { ok: false, steps };',
    '  return { ok: true, steps };',
    '}'
  );
}

const NODE_INDEX_TS = lines(
  "import { CAPABILITIES, GATEWAY_ORIGIN, MODE, NETWORK, SOURCE } from './config.js';",
  "import { runChecks } from './checks.js';",
  "import { checkGateway, gatewayReads } from './gateway.js';",
  '',
  'console.log(`Ordex kit, ${SOURCE.sdk}, source ${SOURCE.revision}`);',
  'const summary = runChecks();',
  'for (const r of summary.results) {',
  "  const verdict = r.ok === null ? `error: ${r.error}` : r.ok ? 'accepted' : `refused ${r.code}`;",
  "  console.log(`${r.match ? 'match   ' : 'MISMATCH'} ${r.capability.padEnd(10)} ${verdict.padEnd(40)} ${r.name}`);",
  '}',
  'console.log(`${summary.matched}/${summary.total} conformance cases give the recorded verdict (${CAPABILITIES.join(\', \')})`);',
  'let ok = summary.passed;',
  '',
  "if (MODE === 'gateway') {",
  '  const origin = process.env.ORDEX_GATEWAY_ORIGIN || GATEWAY_ORIGIN;',
  '  const network = process.env.ORDEX_NETWORK || NETWORK;',
  '  console.log(`Gateway ${origin} on ${network}, read-only`);',
  '  const gateway = await checkGateway(origin, network, gatewayReads());',
  "  for (const s of gateway.steps) console.log(`${s.ok ? 'ok    ' : 'FAILED'} ${s.name}: ${s.detail}`);",
  '  ok = ok && gateway.ok;',
  '}',
  'process.exitCode = ok ? 0 : 1;'
);

const BROWSER_MAIN_TS = lines(
  "import { CAPABILITIES, GATEWAY_ORIGIN, MODE, NETWORK, SOURCE } from './config.js';",
  "import { runChecks } from './checks.js';",
  "import { checkGateway, gatewayReads } from './gateway.js';",
  '',
  "const app = document.getElementById('app');",
  "if (!app) throw new Error('The page has no #app element.');",
  '',
  'function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, attrs: Record<string, string> = {}) {',
  '  const node = document.createElement(tag);',
  '  if (text !== undefined) node.textContent = text;',
  '  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);',
  '  return node;',
  '}',
  '',
  'const summary = runChecks();',
  "const status = el('p', `${summary.matched} of ${summary.total} conformance cases give the recorded verdict.`, { role: 'status', 'data-passed': String(summary.passed) });",
  "const table = el('table');",
  "table.append(el('caption', `Capabilities: ${CAPABILITIES.join(', ')}. Source ${SOURCE.revision}.`));",
  "const head = el('tr');",
  "for (const h of ['Capability', 'Case', 'Expected', 'SDK verdict', 'Result']) head.append(el('th', h, { scope: 'col' }));",
  "table.append(el('thead'), el('tbody'));",
  'table.tHead!.append(head);',
  'for (const r of summary.results) {',
  "  const row = el('tr');",
  "  const expected = r.expectedOk ? 'accepted' : `refused ${r.expectedCode ?? ''}`;",
  "  const got = r.ok === null ? `error: ${r.error}` : r.ok ? 'accepted' : `refused ${r.code ?? ''}`;",
  "  for (const cell of [r.capability, r.name, expected, got, r.match ? 'match' : 'MISMATCH']) row.append(el('td', cell));",
  '  table.tBodies[0]!.append(row);',
  '}',
  'app.append(status, table);',
  '',
  "if (MODE === 'gateway') {",
  "  const button = el('button', `Check gateway ${GATEWAY_ORIGIN} (${NETWORK})`, { type: 'button' });",
  "  const out = el('ul', undefined, { 'aria-live': 'polite' });",
  "  button.addEventListener('click', async () => {",
  "    button.setAttribute('disabled', '');",
  "    out.replaceChildren(el('li', 'Checking...'));",
  '    const result = await checkGateway(GATEWAY_ORIGIN, NETWORK, gatewayReads());',
  "    out.replaceChildren(...result.steps.map((s) => el('li', `${s.ok ? 'ok' : 'FAILED'} ${s.name}: ${s.detail}`)));",
  "    button.removeAttribute('disabled');",
  '  });',
  "  app.append(el('h2', 'Gateway'), button, out);",
  '}'
);

const BROWSER_HTML = lines(
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
  '    <title>Ordex browser kit</title>',
  '    <style>',
  '      body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 64rem; padding: 1rem; color: #1a1a1a; background: #fff; }',
  '      table { border-collapse: collapse; width: 100%; font-size: 0.875rem; }',
  '      th, td { text-align: left; padding: 0.25rem 0.5rem; border-bottom: 1px solid #ccc; }',
  '      button { font: inherit; padding: 0.5rem 1rem; }',
  '      @media (prefers-color-scheme: dark) { body { color: #eee; background: #111; } th, td { border-color: #444; } }',
  '    </style>',
  '  </head>',
  '  <body>',
  '    <main id="app"><h1>Ordex browser kit</h1></main>',
  '    <script type="module" src="./app.js"></script>',
  '  </body>',
  '</html>'
);

const WORKER_TS = lines(
  "import { CAPABILITIES, GATEWAY_ORIGIN, MODE, NETWORK, SOURCE } from './config.js';",
  "import { capabilities } from './capabilities.js';",
  "import { runChecks } from './checks.js';",
  "import { checkGateway, gatewayReads } from './gateway.js';",
  '',
  '/** Bindings this worker reads. Both are optional and fall back to src/config.ts. */',
  'export interface Env {',
  '  ORDEX_GATEWAY_ORIGIN?: string;',
  '  ORDEX_NETWORK?: string;',
  '}',
  '',
  'const MAX_BODY_BYTES = 256 * 1024;',
  'const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });',
  '',
  'export default {',
  '  async fetch(request: Request, env: Env = {}): Promise<Response> {',
  '    const url = new URL(request.url);',
  '    const origin = env.ORDEX_GATEWAY_ORIGIN || GATEWAY_ORIGIN;',
  '    const network = env.ORDEX_NETWORK || NETWORK;',
  "    if (request.method === 'GET' && url.pathname === '/') {",
  "      return json({ source: SOURCE, mode: MODE, network, capabilities: CAPABILITIES, routes: ['GET /checks', 'POST /verify/<capability>', 'GET /gateway'] });",
  '    }',
  "    if (request.method === 'GET' && url.pathname === '/checks') {",
  '      const summary = runChecks();',
  '      return json(summary, summary.passed ? 200 : 500);',
  '    }',
  "    if (request.method === 'POST' && url.pathname.startsWith('/verify/')) {",
  "      const cap = capabilities.find((c) => c.id === url.pathname.slice('/verify/'.length));",
  "      if (!cap) return json({ error: `No capability ${url.pathname.slice('/verify/'.length)} in this kit.` }, 404);",
  '      const text = await request.text();',
  "      if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json({ error: 'The body is larger than 256 KiB.' }, 413);",
  '      let body: unknown;',
  '      try {',
  '        body = JSON.parse(text);',
  '      } catch {',
  "        return json({ error: 'The body is not valid JSON.' }, 400);",
  '      }',
  "      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Send one case as a JSON object.' }, 400);",
  '      return json({ capability: cap.id, verdict: cap.run(body as never) });',
  '    }',
  "    if (request.method === 'GET' && url.pathname === '/gateway') {",
  "      if (!origin) return json({ ok: false, error: 'No gateway origin is configured. Set the ORDEX_GATEWAY_ORIGIN binding.' }, 409);",
  '      const result = await checkGateway(origin, network, gatewayReads());',
  '      return json(result, result.ok ? 200 : 502);',
  '    }',
  "    return json({ error: 'Not found' }, 404);",
  '  }',
  '};'
);

function bundleScript(o: KitOptions) {
  const browser = o.runtime === 'browser';
  return lines(
    "// Bundles the app with esbuild. node:crypto resolves to the pure JavaScript implementation in",
    "// src/shims, and the one Buffer use in the SDK to a small TextEncoder-based stand-in, so the",
    "// output runs without Node built-ins.",
    "import { build } from 'esbuild';",
    "import { fileURLToPath } from 'node:url';",
    '',
    "const here = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));",
    'await build({',
    `  entryPoints: [here('${browser ? 'src/main.ts' : 'src/worker.ts'}')],`,
    `  outfile: here('${browser ? 'public/app.js' : 'dist/worker.js'}'),`,
    '  bundle: true,',
    "  format: 'esm',",
    `  platform: '${browser ? 'browser' : 'neutral'}',`,
    ...(browser ? [] : ["  mainFields: ['module', 'main'],"]),
    "  target: 'es2022',",
    "  legalComments: 'none',",
    "  alias: { 'node:crypto': here('src/shims/node-crypto.js') },",
    "  inject: [here('src/shims/buffer.js')],",
    "  logLevel: 'warning'",
    '});'
  );
}

const BUFFER_SHIM = lines(
  '// The Buffer subset the SDK uses, for runtimes without Node globals: Buffer.from(text, "utf8")',
  '// and toString("utf8" | "hex" | "base64"). Anything else throws.',
  'class KitBuffer extends Uint8Array {',
  "  static from(value, encoding = 'utf8') {",
  "    if (typeof value !== 'string' || (encoding !== 'utf8' && encoding !== 'utf-8')) throw new TypeError('Only Buffer.from(string, \"utf8\") is available here');",
  '    const bytes = new TextEncoder().encode(value);',
  '    const out = new KitBuffer(bytes.length);',
  '    out.set(bytes);',
  '    return out;',
  '  }',
  "  toString(encoding = 'utf8') {",
  "    if (encoding === 'utf8' || encoding === 'utf-8') return new TextDecoder().decode(this);",
  "    if (encoding === 'hex') return Array.from(this, (b) => b.toString(16).padStart(2, '0')).join('');",
  "    if (encoding === 'base64') {",
  "      let s = '';",
  '      for (const b of this) s += String.fromCharCode(b);',
  '      return btoa(s);',
  '    }',
  '    throw new TypeError(`Buffer encoding ${encoding} is not available here`);',
  '  }',
  '}',
  'export { KitBuffer as Buffer };'
);

function serveScript(o: KitOptions) {
  if (o.runtime === 'browser') {
    return lines(
      '// Serves public/ on loopback for local use. PORT overrides the default 4173 (0 picks a free port).',
      "import { createServer } from 'node:http';",
      "import { readFile } from 'node:fs/promises';",
      "import { extname, join, normalize } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      '',
      "const root = fileURLToPath(new URL('../public/', import.meta.url));",
      "const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };",
      'const port = Number(process.env.PORT || 4173);',
      'const server = createServer(async (req, res) => {',
      "  const path = new URL(req.url || '/', 'http://localhost').pathname;",
      "  const file = normalize(join(root, path === '/' ? 'index.html' : path));",
      "  if (!file.startsWith(root)) return res.writeHead(403).end();",
      '  try {',
      "    const body = await readFile(file);",
      "    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }).end(body);",
      '  } catch {',
      "    res.writeHead(404).end('Not found');",
      '  }',
      "});",
      "server.listen(port, '127.0.0.1', () => console.log(`Serving http://127.0.0.1:${server.address().port}/`));"
    );
  }
  return lines(
    '// Runs the bundled worker (dist/worker.js) on loopback with Node, passing the bindings from',
    '// the environment. PORT overrides the default 8788 (0 picks a free port).',
    "import { createServer } from 'node:http';",
    "import worker from '../dist/worker.js';",
    '',
    'const env = { ORDEX_GATEWAY_ORIGIN: process.env.ORDEX_GATEWAY_ORIGIN, ORDEX_NETWORK: process.env.ORDEX_NETWORK };',
    'const port = Number(process.env.PORT || 8788);',
    'const server = createServer(async (req, res) => {',
    '  const chunks = [];',
    '  for await (const c of req) chunks.push(c);',
    "  const hasBody = !['GET', 'HEAD'].includes(req.method || 'GET');",
    "  const request = new Request(new URL(req.url || '/', `http://127.0.0.1:${port}`), { method: req.method, headers: req.headers, body: hasBody ? Buffer.concat(chunks) : undefined });",
    '  const response = await worker.fetch(request, env);',
    '  res.writeHead(response.status, Object.fromEntries(response.headers));',
    '  res.end(Buffer.from(await response.arrayBuffer()));',
    "});",
    "server.listen(port, '127.0.0.1', () => console.log(`Worker on http://127.0.0.1:${server.address().port}/`));"
  );
}

const CHECKS_TEST_TS = lines(
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { capabilities } from '../src/capabilities.js';",
  "import { runChecks } from '../src/checks.js';",
  '',
  "test('every conformance case gives the recorded verdict through the SDK', () => {",
  '  const summary = runChecks();',
  '  const mismatches = summary.results.filter((r) => !r.match);',
  '  assert.deepEqual(mismatches, []);',
  '  assert.ok(summary.total > 0);',
  '});',
  '',
  "test('each capability is exercised with accepted and refused cases', () => {",
  '  for (const cap of capabilities) {',
  '    assert.ok(cap.cases.some((c) => c.expected.ok === true), `${cap.id} has an accepted case`);',
  '    assert.ok(cap.cases.some((c) => c.expected.ok === false), `${cap.id} has a refused case`);',
  '  }',
  '});',
  '',
  "test('a malformed case is refused, not accepted', () => {",
  '  for (const cap of capabilities) {',
  "    const verdict = cap.run({ name: 'malformed', expected: { ok: false } });",
  '    assert.equal(verdict.ok, false, cap.id);',
  '  }',
  '});'
);

function gatewayTestTs(o: KitOptions) {
  return lines(
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    "import { checkGateway, gatewayReads } from '../src/gateway.js';",
    '',
    '// A stand-in gateway: only the routes the client reads, with the fields the checks use.',
    'function fakeGateway(network: string, status = 200) {',
    '  const routes: Record<string, unknown> = {',
    "    '/api/ordex/health': { ok: true, status: 'active', network },",
    "    '/api/ordex/protocol': { network, protocolVersion: '1.2' },",
    "    '/api/ordex/orders': { orders: [], total: 0, limit: 5, nextCursor: '', hasMore: false },",
    "    '/api/ordex/activity': { entries: [], limit: 5, nextCursor: '', hasMore: false }",
    '  };',
    '  const calls: string[] = [];',
    '  const fetchImpl = (async (input: string | URL | Request) => {',
    '    const url = new URL(String(input));',
    '    calls.push(url.pathname);',
    '    const body = routes[url.pathname];',
    "    if (!body) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });",
    "    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });",
    '  }) as typeof fetch;',
    '  return { fetchImpl, calls };',
    '}',
    '',
    `const NETWORK: string = '${o.network}';`,
    "const OTHER = NETWORK === 'mainnet' ? 'signet' : 'mainnet';",
    '',
    "test('a gateway on the configured network passes, read-only', async () => {",
    '  const { fetchImpl, calls } = fakeGateway(NETWORK);',
    "  const result = await checkGateway('https://gateway.example', NETWORK, gatewayReads(), fetchImpl);",
    '  assert.equal(result.ok, true, JSON.stringify(result.steps));',
    "  assert.ok(calls.every((p) => p.startsWith('/api/ordex/')));",
    '});',
    '',
    "test('a gateway on another network is refused before any capability read', async () => {",
    '  const { fetchImpl, calls } = fakeGateway(OTHER);',
    "  const result = await checkGateway('https://gateway.example', NETWORK, gatewayReads(), fetchImpl);",
    '  assert.equal(result.ok, false);',
    "  assert.equal(result.steps.at(-1)?.name, 'network');",
    "  assert.deepEqual(calls, ['/api/ordex/health', '/api/ordex/protocol']);",
    '});',
    '',
    "test('an unreachable or failing gateway is a failure, never a pass', async () => {",
    "  const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;",
    "  assert.equal((await checkGateway('https://gateway.example', NETWORK, gatewayReads(), down)).ok, false);",
    '  const { fetchImpl } = fakeGateway(NETWORK, 500);',
    "  assert.equal((await checkGateway('https://gateway.example', NETWORK, gatewayReads(), fetchImpl)).ok, false);",
    "  assert.equal((await checkGateway('', NETWORK, gatewayReads())).ok, false);",
    '});'
  );
}

const BROWSER_TEST_TS = lines(
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { readFile } from 'node:fs/promises';",
  '',
  "test('the page bundle uses no Node built-ins, process or require', async () => {",
  "  const bundle = await readFile(new URL('../../public/app.js', import.meta.url), 'utf8');",
  "  assert.doesNotMatch(bundle, /from ?[\"']node:|import\\(\"node:/);",
  '  assert.doesNotMatch(bundle, /process\\.env|require\\(/);',
  '});'
);

const WORKER_TEST_TS = lines(
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { capabilities } from '../src/capabilities.js';",
  '',
  '// The bundled worker (dist/worker.js), exactly what a Workers runtime would load.',
  "const worker = (await import(new URL('../worker.js', import.meta.url).href)).default as { fetch(r: Request, env?: Record<string, string>): Promise<Response> };",
  "const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`http://kit.test${path}`, init), {});",
  '',
  "test('GET /checks runs every case through the bundled SDK', async () => {",
  "  const res = await call('/checks');",
  '  const body = await res.json();',
  '  assert.equal(res.status, 200);',
  '  assert.equal(body.passed, true);',
  '  assert.equal(body.matched, body.total);',
  '});',
  '',
  "test('POST /verify/<capability> returns the SDK verdict for one case', async () => {",
  '  for (const cap of capabilities) {',
  '    for (const c of [cap.cases.find((x) => x.expected.ok), cap.cases.find((x) => !x.expected.ok)]) {',
  "      const res = await call(`/verify/${cap.id}`, { method: 'POST', body: JSON.stringify(c) });",
  '      const body = await res.json();',
  '      assert.equal(res.status, 200);',
  '      assert.equal(body.verdict.ok, c!.expected.ok, `${cap.id}: ${c!.name}`);',
  '    }',
  '  }',
  '});',
  '',
  "test('bad requests are refused', async () => {",
  "  assert.equal((await call('/verify/nope', { method: 'POST', body: '{}' })).status, 404);",
  "  assert.equal((await call(`/verify/${capabilities[0]!.id}`, { method: 'POST', body: '{bad' })).status, 400);",
  "  assert.equal((await call(`/verify/${capabilities[0]!.id}`, { method: 'POST', body: '[]' })).status, 400);",
  "  assert.equal((await call('/nope')).status, 404);",
  '});',
  '',
  "test('the bundle uses no Node built-ins or process', async () => {",
  "  const { readFile } = await import('node:fs/promises');",
  "  const bundle = await readFile(new URL('../worker.js', import.meta.url), 'utf8');",
  "  assert.doesNotMatch(bundle, /from ?[\"']node:|import\\(\"node:/);",
  '  assert.doesNotMatch(bundle, /process\\.env|require\\(/);',
  '});'
);

function ciYaml() {
  return lines(
    'name: CI',
    '',
    'on:',
    '  pull_request:',
    '  push:',
    '    branches: [main]',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  test:',
    '    # Self-hosted runners only. Use the labels your organization authorizes, and never let',
    '    # a pull request from a fork reach a self-hosted runner of a public repository.',
    '    if: >-',
    "      github.event_name != 'pull_request' ||",
    '      github.event.pull_request.head.repo.full_name == github.repository',
    '    runs-on: [self-hosted, linux, x64]',
    '    timeout-minutes: 15',
    '    steps:',
    '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
    '        with:',
    '          persist-credentials: false',
    '      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
    '        with:',
    '          node-version-file: .nvmrc',
    '      - run: npm ci',
    '      - run: npm test'
  );
}

function readme(o: KitOptions, assets: KitAssets) {
  const runtime = KIT_RUNTIMES.find((r) => r.id === o.runtime)!;
  const caps = selected(o);
  const origin = o.mode === 'gateway' ? normalizedOrigin(o) : '';
  return lines(
    `# ${kitName(o)}`,
    '',
    `${runtime.label}: ${runtime.description}`,
    '',
    '## What it does',
    '',
    ...caps.map((c) => `- ${c.label}: runs every case of \`fixtures/${assets.fixtures[c.id].file}\` through the SDK and compares the verdict with the recorded one.`),
    o.mode === 'gateway'
      ? `- Gateway (read-only): checks \`${origin}\` is healthy and serves **${o.network}**, then ${gatewayReadText(caps.map((c) => c.id))}. A gateway on another network is refused.`
      : '- Offline: no network access. Generate the kit again in gateway mode to read a gateway.',
    '',
    'It never holds keys, signs or broadcasts. Keys, signing and broadcasting stay with your wallet and your own code.',
    '',
    '## Requirements',
    '',
    `- Node.js ${assets.node} (see \`.nvmrc\`) and npm.`,
    `- Pinned dev tools: TypeScript ${assets.tools.typescript}, @types/node ${assets.tools['@types/node']}${o.runtime === 'node' ? '' : `, esbuild ${assets.tools.esbuild}`}. \`package-lock.json\` pins them with integrity hashes.`,
    '',
    '## Commands',
    '',
    '```sh',
    'npm ci',
    'npm test',
    'npm start',
    '```',
    '',
    o.runtime === 'node' && '`npm start` prints one line per case and exits non-zero on any mismatch or failed gateway step.',
    o.runtime === 'node' && o.mode === 'gateway' && 'Override the settings with `ORDEX_GATEWAY_ORIGIN` and `ORDEX_NETWORK`.',
    o.runtime === 'browser' && '`npm start` serves `public/` on http://127.0.0.1:4173/ (set `PORT` to change it). The page runs the checks and renders a table. In gateway mode the gateway must allow the page origin (CORS).',
    o.runtime === 'worker' && '`npm start` runs `dist/worker.js` on http://127.0.0.1:8788/ with Node. Routes: `GET /checks`, `POST /verify/<capability>` with one case as JSON, `GET /gateway`. Bindings: `ORDEX_GATEWAY_ORIGIN` and `ORDEX_NETWORK`, read from `env` (and from the environment when run on Node).',
    '',
    '## Where it came from',
    '',
    `- Repository: ${REPOSITORY} at \`${o.revision}\``,
    `- SDK: \`${assets.sdk.name}@${assets.sdk.version}\`, vendored in \`vendor/ordex-sdk\` (built from \`sdk/src\`, SHA-256 of the sources \`${assets.sdk.sourceSha256}\`). It is not published to a registry.`,
    ...caps.map((c) => `- \`fixtures/${assets.fixtures[c.id].file}\`: SHA-256 \`${assets.fixtures[c.id].sha256}\``),
    o.runtime !== 'node' && `- \`src/shims/node-crypto.js\`: from \`${assets.cryptoShim.path}\`, SHA-256 \`${assets.cryptoShim.sha256}\``,
    '',
    '## CI',
    '',
    '`.github/workflows/ci.yml` runs `npm ci` and `npm test` on self-hosted runners. Set `runs-on` to the labels your organization authorizes.'
  );
}

function gatewayReadText(caps: string[]): string {
  const reads = [caps.includes('asks') && 'reads five orders', caps.includes('events') && 'reads five activity entries'].filter(Boolean) as string[];
  return reads.length ? reads.join(' and ') : 'stops there (the SDK has no read route for the other selected capabilities)';
}

/** Every file of the kit, sorted by path. Throws when the options are invalid. */
export function generateKit(o: KitOptions, assets: KitAssets): { name: string; files: KitFile[] } {
  const errors = validateKitOptions(o);
  if (errors.length) throw new Error(errors.join(' '));
  const files: Record<string, string> = {
    '.gitignore': lines('node_modules/', 'dist/', o.runtime === 'browser' && 'public/app.js'),
    '.nvmrc': `${assets.node}\n`,
    '.github/workflows/ci.yml': ciYaml(),
    'README.md': readme(o, assets),
    'package.json': json(packageJson(o, assets)),
    'package-lock.json': json(packageLock(o, assets)),
    'tsconfig.json': json(TSCONFIG),
    'vendor/ordex-sdk/package.json': json(sdkPackageJson(assets)),
    'src/config.ts': configTs(o, assets),
    'src/capabilities.ts': capabilitiesTs(o, assets),
    'src/checks.ts': CHECKS_TS,
    'src/gateway.ts': gatewayTs(),
    'test/checks.test.ts': CHECKS_TEST_TS,
    'test/gateway.test.ts': gatewayTestTs(o)
  };
  for (const [path, text] of Object.entries(assets.sdk.files)) files[`vendor/ordex-sdk/${path}`] = text;
  for (const c of selected(o)) files[`fixtures/${assets.fixtures[c.id].file}`] = assets.fixtures[c.id].text;
  if (o.runtime === 'node') files['src/index.ts'] = NODE_INDEX_TS;
  if (o.runtime !== 'node') {
    files['scripts/bundle.mjs'] = bundleScript(o);
    files['scripts/serve.mjs'] = serveScript(o);
    files['src/shims/node-crypto.js'] = assets.cryptoShim.text;
    files['src/shims/buffer.js'] = BUFFER_SHIM;
  }
  if (o.runtime === 'browser') {
    files['src/main.ts'] = BROWSER_MAIN_TS;
    files['public/index.html'] = BROWSER_HTML;
    files['test/bundle.test.ts'] = BROWSER_TEST_TS;
  }
  if (o.runtime === 'worker') {
    files['src/worker.ts'] = WORKER_TS;
    files['test/worker.test.ts'] = WORKER_TEST_TS;
  }
  return {
    name: kitName(o),
    files: Object.keys(files)
      .sort()
      .map((path) => ({ path, content: files[path]! }))
  };
}

interface ZipLike {
  file(path: string, data: string, options: { date: Date; createFolders: boolean }): unknown;
  generateAsync(options: { type: 'uint8array'; compression: 'DEFLATE'; compressionOptions: { level: number }; platform: 'UNIX' }): Promise<Uint8Array>;
}

/** The kit as ZIP bytes under a top-level folder. Same files, same bytes. */
export async function createKitZip(name: string, files: KitFile[], ZipCtor: new () => ZipLike): Promise<Uint8Array> {
  const zip = new ZipCtor();
  for (const f of files) zip.file(`${name}/${f.path}`, f.content, { date: KIT_ZIP_DATE, createFolders: false });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'UNIX' });
}

interface ZipReader {
  loadAsync(data: Uint8Array): Promise<{ files: Record<string, { dir: boolean; async(type: 'string'): Promise<string> }> }>;
}

/** Read the archive back and compare every entry with the generated files. Empty when exact. */
export async function verifyKitZip(name: string, files: KitFile[], bytes: Uint8Array, Zip: ZipReader): Promise<string[]> {
  const zip = await Zip.loadAsync(bytes);
  const expected = new Map(files.map((f) => [`${name}/${f.path}`, f.content]));
  const problems: string[] = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (!expected.has(path)) problems.push(`unexpected ${path}`);
    else if ((await entry.async('string')) !== expected.get(path)) problems.push(`changed ${path}`);
  }
  for (const path of expected.keys()) if (!zip.files[path]) problems.push(`missing ${path}`);
  return problems;
}
