import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve('.');
const docsDir = resolve(root, 'docs');
const siteSrc = resolve(root, 'site', 'src');

function findFiles(dir, exts) {
  let results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.git' && entry !== 'pagefind') {
        results = results.concat(findFiles(full, exts));
      }
    } else if (exts.some(ext => entry.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

console.log('=== Step 1: Auditing compiled HTML in docs/ for base path compliance ===');
const htmlFiles = findFiles(docsDir, ['.html']);
console.log(`Found ${htmlFiles.length} HTML files in docs/`);

let brokenPrefixLinks = 0;
const hrefRegex = /href=["'](\/[^"'#][^"']*)["']/g;

for (const file of htmlFiles) {
  const content = readFileSync(file, 'utf8');
  let match;
  while ((match = hrefRegex.exec(content)) !== null) {
    const target = match[1];
    if (!target.startsWith('/ordex/')) {
      brokenPrefixLinks++;
      console.error(`[MISSING BASE PATH in ${file.replace(root, '')}]: ${target}`);
    }
  }
}

console.log(`Total missing /ordex/ prefix links: ${brokenPrefixLinks}`);

console.log('\n=== Step 2: Auditing site/src source files for raw root-relative hrefs ===');
const srcFiles = findFiles(siteSrc, ['.astro', '.jsx', '.tsx']);
console.log(`Found ${srcFiles.length} source files in site/src/`);

let brokenSrcLinks = 0;
const srcHrefRegex = /href=["'](\/(?!ordex\/)[^"'#][^"']*)["']/g;

for (const file of srcFiles) {
  const content = readFileSync(file, 'utf8');
  let match;
  while ((match = srcHrefRegex.exec(content)) !== null) {
    const target = match[1];
    brokenSrcLinks++;
    console.error(`[RAW ROOT-RELATIVE in ${file.replace(root, '')}]: ${target}`);
  }
}
console.log(`Total raw root-relative links in site/src: ${brokenSrcLinks}`);

console.log('\n=== Step 3: Validating target destination exists for every internal link ===');
let deadLinks = 0;
const allLinksRegex = /href=["']([^"']+)["']/g;

// Cache page HTML for anchor checking
const pageCache = new Map();
function getPageContent(filePath) {
  if (!pageCache.has(filePath)) {
    pageCache.set(filePath, readFileSync(filePath, 'utf8'));
  }
  return pageCache.get(filePath);
}

for (const file of htmlFiles) {
  const content = readFileSync(file, 'utf8');
  let match;
  while ((match = allLinksRegex.exec(content)) !== null) {
    const link = match[1];
    // Skip external links, mailto, tel, javascript
    if (link.startsWith('http://') || link.startsWith('https://') || link.startsWith('mailto:') || link.startsWith('tel:') || link.startsWith('javascript:')) {
      continue;
    }

    // Handle pure in-page anchor e.g. #main-content
    if (link.startsWith('#')) {
      const anchorId = link.slice(1);
      if (anchorId && !content.includes(`id="${anchorId}"`) && !content.includes(`name="${anchorId}"`)) {
        console.warn(`[MISSING IN-PAGE ANCHOR in ${file.replace(root, '')}]: #${anchorId}`);
      }
      continue;
    }

    // Internal path starting with /ordex/
    if (link.startsWith('/ordex')) {
      const withoutBase = link.replace(/^\/ordex\/?/, '');
      const [pathPart, anchorPart] = withoutBase.split('#');
      const cleanPath = pathPart.split('?')[0];

      // Possible file targets
      let targetFile = null;
      const directPath = join(docsDir, cleanPath);
      const indexPath = join(docsDir, cleanPath, 'index.html');
      const htmlPath = join(docsDir, `${cleanPath}.html`);

      if (existsSync(indexPath) && statSync(indexPath).isFile()) {
        targetFile = indexPath;
      } else if (existsSync(directPath) && statSync(directPath).isFile()) {
        targetFile = directPath;
      } else if (existsSync(htmlPath) && statSync(htmlPath).isFile()) {
        targetFile = htmlPath;
      }

      if (!targetFile) {
        deadLinks++;
        console.error(`[DEAD LINK 404 in ${file.replace(root, '')}]: ${link} -> Target file not found in docs/`);
      }
    }
  }
}

console.log(`Total 404 dead internal links found: ${deadLinks}`);

if (brokenPrefixLinks > 0 || brokenSrcLinks > 0 || deadLinks > 0) {
  process.exit(1);
} else {
  console.log('\nAll links strictly verified: 0 missing base prefixes, 0 raw root-relative links, 0 dead 404 links.');
}
