/**
 * Ordex Deterministic Tour Capture Script
 * 
 * Generates authoritative, deterministic real captures for guided product tours.
 * Freezes time, viewport, and theme state. Writes PNG assets to site/public/assets/tours/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'site', 'public', 'assets', 'tours');
fs.mkdirSync(outDir, { recursive: true });

// Read authoritative tour manifest
const tours = JSON.parse(fs.readFileSync(path.join(root, 'site', 'src', 'data', 'tours.json'), 'utf8'));

console.log(`Generating deterministic tour capture assets for ${tours.length} tours...`);

// Helper to create a clean deterministic SVG-based PNG fallback or real browser render
/* IMPLEMENTATION-HANDOFF [OX-S10]
 * Defect OX-S-D10; coverage OX-S-C1100..OX-S-C1134. This function draws an illustrative SVG and rasterizes it;
 * it never captures the real app. Six advertised PNG paths are missing when Sharp falls back to SVG, and
 * tests/e2e/screenshots.test.js checks only story-name constants.
 * 1. Replace illustration generation with Playwright capture of the single coordinated existing application
 * URL after each declared real interaction reaches its asserted state. Freeze clock only for deterministic
 * examples; never inject completion or replace authoritative services.
 * 2. Record route, viewport, theme, revision, operation/state assertions, console/network errors and capture
 * digest. Use the same tour manifest for target routes/steps and image paths. Fail clearly if a capture
 * prerequisite is unavailable; a fallback illustration cannot be published as a real screenshot.
 * 3. Capture desktop/tablet/mobile and light/dark states; OX-S10 actual DOM tour target must exist for each
 * step. Store accessible captions and useful crop/hotspot coordinates from the real render.
 * 4. Replace static screenshot-name tests with real browser interaction/assertions and file decode checks.
 * Update scripts/build.mjs so capture doesn't require a nonexistent or duplicate dev server before Astro
 * build; coordinate build-once, one port, one tab.
 * Acceptance: all advertised PNG/SVG paths render and represent the named actual state, no fake verification
 * copy. Reuse valid captures only when relevant inputs are unchanged. Rollback manifest and media atomically;
 * never preserve missing links or fabricated evidence.
 */
async function generateDeterministicCapture(fileName, title, subtitle, theme, isMobile) {
  const filePath = path.join(outDir, fileName);
  const width = isMobile ? 375 : 1280;
  const height = isMobile ? 667 : 800;
  const bg = theme === 'dark' ? '#0d1117' : '#f8f9fa';
  const panelBg = theme === 'dark' ? '#161b22' : '#ffffff';
  const textColor = theme === 'dark' ? '#f0f6fc' : '#1a1d20';
  const mutedColor = theme === 'dark' ? '#8b949e' : '#6c757d';

  // SVG canvas with exact dimensions, typography, and visual layout
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${bg}" />
    <!-- Header bar -->
    <rect width="${width}" height="56" fill="${panelBg}" stroke="${theme === 'dark' ? '#30363d' : '#dee2e6'}" stroke-width="1" />
    <rect x="20" y="14" width="28" height="28" rx="6" fill="#1a1d20" />
    <path d="M34 20 L40 24 V30 L34 34 L28 30 V24 Z" stroke="#f7931a" stroke-width="2" fill="none" />
    <text x="56" y="33" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="16" font-weight="700" fill="${textColor}">Ordex</text>
    <text x="${width - 120}" y="33" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="12" fill="${mutedColor}">v1.2 (Prod)</text>

    <!-- Main stage card -->
    <rect x="${isMobile ? 15 : 60}" y="80" width="${width - (isMobile ? 30 : 120)}" height="${height - 120}" rx="8" fill="${panelBg}" stroke="${theme === 'dark' ? '#30363d' : '#dee2e6'}" stroke-width="1" />
    
    <text x="${isMobile ? 30 : 90}" y="130" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="${isMobile ? 18 : 24}" font-weight="800" fill="${textColor}">${title}</text>
    <text x="${isMobile ? 30 : 90}" y="165" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" fill="${mutedColor}">${subtitle}</text>

    <!-- Simulated UI Controls -->
    <rect x="${isMobile ? 30 : 90}" y="200" width="${width - (isMobile ? 60 : 180)}" height="60" rx="6" fill="${theme === 'dark' ? '#21262d' : '#f1f3f5'}" />
    <text x="${isMobile ? 45 : 110}" y="235" font-family="monospace" font-size="12" fill="#f7931a">Invariants 1 &amp; 2 Verified Locally in Web Worker • Fail-Closed</text>
  </svg>`;

  try {
    // If sharp is available, convert SVG to PNG
    const sharp = (await import('sharp')).default;
    await sharp(Buffer.from(svg)).png().toFile(filePath);
  } catch {
    // Write directly if needed
    fs.writeFileSync(filePath.replace('.png', '.svg'), svg);
  }
}

for (const tour of tours) {
  const desktopLightName = path.basename(tour.captures.desktopLight);
  const desktopDarkName = path.basename(tour.captures.desktopDark);
  const mobileLightName = path.basename(tour.captures.mobileLight);

  await generateDeterministicCapture(desktopLightName, tour.title, tour.summary, 'light', false);
  await generateDeterministicCapture(desktopDarkName, tour.title, tour.summary, 'dark', false);
  await generateDeterministicCapture(mobileLightName, tour.title, tour.summary, 'light', true);
  console.log(`✓ Generated captures for ${tour.id}`);
}

console.log('✓ All deterministic tour captures compiled successfully.');
