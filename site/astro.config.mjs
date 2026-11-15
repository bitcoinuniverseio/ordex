import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import { generateMetadata } from './version-build/metadata.mjs';

const metadata = await generateMetadata();

export default defineConfig({
  site: 'https://bitcoinuniverseio.github.io',
  base: '/ordex',
  output: 'static',
  build: {
    assets: 'assets'
  },
  integrations: [preact(), {
    name: 'app-version',
    hooks: {
      'astro:config:setup': ({ injectScript }) => {
        injectScript('page', `window.__APP_VERSION__ = ${JSON.stringify(metadata)};`);
      }
    }
  }],
  outDir: '../dist/client'
});
