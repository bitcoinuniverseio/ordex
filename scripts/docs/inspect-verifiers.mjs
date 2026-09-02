import fs from 'node:fs';
import path from 'node:path';

const verifierDir = path.resolve('verifier');
const verifierFiles = fs.readdirSync(verifierDir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));

const verifierMap = {};
const allRefusals = new Set();

for (const file of verifierFiles) {
  const content = fs.readFileSync(path.join(verifierDir, file), 'utf8');
  const refusals = [];
  const re = /refuse\s*\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    refusals.push(match[1]);
    allRefusals.add(match[1]);
  }
  
  // Also check for any other pattern like { ok: false, code: '...' }
  const re2 = /code:\s*['"]([A-Za-z0-9_-]+)['"]/g;
  while ((match = re2.exec(content)) !== null) {
    if (match[1] !== 'utf8') {
      refusals.push(match[1]);
      allRefusals.add(match[1]);
    }
  }

  verifierMap[file] = [...new Set(refusals)];
}

console.log('Verifiers and refusal codes:');
console.log(JSON.stringify(verifierMap, null, 2));
console.log(`\nTotal unique refusal codes: ${allRefusals.size}`);
