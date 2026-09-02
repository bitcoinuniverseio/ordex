import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';

export default defineConfig({
  site: 'https://bitcoinuniverseio.github.io',
  base: '/ordex',
  output: 'static',
  integrations: [preact()],
  outDir: '../dist/client'
});
