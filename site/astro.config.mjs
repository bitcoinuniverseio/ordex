import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// OX-S07: client and Worker bundles resolve the verifiers' node:crypto import to the
// pinned browser implementation. Server rendering keeps Node's own module. Vite otherwise
// replaces node built-ins with an empty stub and the islands fail to hydrate.
const browserCrypto = fileURLToPath(new URL('./src/lib/browser/node-crypto.mjs', import.meta.url));

function browserVerifierCrypto() {
  return {
    name: 'ordex-browser-verifier-crypto',
    enforce: 'pre',
    resolveId(id, _importer, options) {
      if ((id === 'node:crypto' || id === 'crypto') && !options?.ssr) return browserCrypto;
      return null;
    }
  };
}

// The exact source revision the site was built from, shown in exports and evidence.
function buildRevision() {
  if (process.env.ORDEX_BUILD_REVISION) return process.env.ORDEX_BUILD_REVISION;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

// OX-P08: origin of the self-hosted docs service (worker/node-host.mjs) that Ask, Feedback,
// Insights and the Agent Bridge call. Empty means the site's own origin. Anything else must
// be an absolute http(s) origin, or the build stops.
function docsApiBase() {
  const raw = (process.env.PUBLIC_ORDEX_DOCS_API_BASE || '').trim().replace(/\/+$/, '');
  if (raw === '') return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_ORDEX_DOCS_API_BASE is not an absolute URL: ${raw}`);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.search || url.hash) throw new Error(`PUBLIC_ORDEX_DOCS_API_BASE must be an http(s) URL without query or fragment: ${raw}`);
  return raw;
}

export default defineConfig({
  site: 'https://bitcoinuniverseio.github.io',
  base: '/ordex',
  output: 'static',
  build: {
    assets: 'assets'
  },
  integrations: [preact()],
  outDir: '../dist/client',
  vite: {
    plugins: [browserVerifierCrypto()],
    worker: {
      format: 'es',
      plugins: () => [browserVerifierCrypto()]
    },
    define: {
      'import.meta.env.PUBLIC_ORDEX_BUILD_REVISION': JSON.stringify(buildRevision()),
      'import.meta.env.PUBLIC_ORDEX_DOCS_API_BASE': JSON.stringify(docsApiBase())
    }
  }
});
