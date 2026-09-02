import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');

// 1. OpenAPI
const openapi = JSON.parse(fs.readFileSync(path.join(root, 'spec', 'openapi.json'), 'utf8'));
const openapiOps = [];
for (const [routePath, item] of Object.entries(openapi.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
      openapiOps.push({
        method: method.toUpperCase(),
        path: routePath,
        operationId: op.operationId,
        summary: op.summary || '',
        description: op.description || '',
        tags: op.tags || [],
        parameters: op.parameters || [],
        requestBody: op.requestBody || null,
        responses: op.responses || {}
      });
    }
  }
}

// 2. AsyncAPI
const asyncapi = JSON.parse(fs.readFileSync(path.join(root, 'spec', 'asyncapi.json'), 'utf8'));
const asyncapiChannels = Object.entries(asyncapi.channels).map(([name, ch]) => ({
  name,
  address: ch.address,
  description: ch.description,
  messages: ch.messages
}));

// 3. Conformance Vectors
const conformanceDir = path.join(root, 'conformance');
const vectorFiles = fs.readdirSync(conformanceDir).filter(f => f.endsWith('.json'));
const vectorFamilies = {};
let totalVectors = 0;
for (const file of vectorFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(conformanceDir, file), 'utf8'));
  const familyName = file.replace('-vectors.json', '');
  const cases = data.cases || data.vectors || (Array.isArray(data) ? data : []);
  vectorFamilies[familyName] = {
    file,
    count: cases.length,
    description: data.description || data.note || '',
    version: data.version || data.protocolVersion || '',
    vectors: cases.map((v, idx) => ({
      id: v.name || v.id || v.description || `${familyName}-${idx}`,
      title: v.name || v.title || v.description || v.id,
      expected: v.expected || (v.verdict ? { verdict: v.verdict } : null)
    }))
  };
  totalVectors += cases.length;
}

// 4. Verifiers and Refusal Codes
const verifierDir = path.join(root, 'verifier');
const verifierFiles = fs.readdirSync(verifierDir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
const refusalCodeMap = {};

for (const file of verifierFiles) {
  const content = fs.readFileSync(path.join(verifierDir, file), 'utf8');
  // Match refuse calls or object returns with codes
  const matches = content.matchAll(/(?:refuse|termsRefuse|acceptanceRefuse|recoveryRefuse)\s*\(\s*['"]([A-Z0-9_-]+)['"](?:\s*,\s*(?:`([^`]+)`|'([^']+)'|"([^"]+)"))?/g);
  for (const m of matches) {
    const code = m[1];
    const reason = m[2] || m[3] || m[4] || '';
    if (!refusalCodeMap[code]) {
      refusalCodeMap[code] = { code, verifiers: new Set(), reasons: new Set() };
    }
    refusalCodeMap[code].verifiers.add(file);
    if (reason) refusalCodeMap[code].reasons.add(reason.trim());
  }

  // Also check runes.js and direct code references
  const matches2 = content.matchAll(/code:\s*['"]([A-Z0-9_-]+)['"]/g);
  for (const m of matches2) {
    const code = m[1];
    if (code !== 'utf8') {
      if (!refusalCodeMap[code]) {
        refusalCodeMap[code] = { code, verifiers: new Set(), reasons: new Set() };
      }
      refusalCodeMap[code].verifiers.add(file);
    }
  }
}

const refusalList = Object.values(refusalCodeMap).map(r => ({
  code: r.code,
  verifiers: [...r.verifiers],
  reasons: [...r.reasons]
})).sort((a, b) => a.code.localeCompare(b.code));

// 5. Specs
const specDir = path.join(root, 'spec');
const specFiles = fs.readdirSync(specDir).filter(f => f.endsWith('.md'));
const specs = specFiles.map(file => {
  const content = fs.readFileSync(path.join(specDir, file), 'utf8');
  const headings = [...content.matchAll(/^(#{1,4})\s+(.+)$/gm)].map(m => ({
    level: m[1].length,
    title: m[2].trim()
  }));
  return { file, headings };
});

const summary = {
  openapiOpsCount: openapiOps.length,
  asyncapiChannelsCount: asyncapiChannels.length,
  vectorFamiliesCount: Object.keys(vectorFamilies).length,
  totalVectors,
  uniqueRefusalCodesCount: refusalList.length,
  specsCount: specs.length
};

console.log('Metadata extraction summary:', JSON.stringify(summary, null, 2));

const outDir = path.join(root, 'scripts', 'docs', 'generated');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'metadata.json'), JSON.stringify({
  openapiOps,
  asyncapiChannels,
  vectorFamilies,
  refusalList,
  specs
}, null, 2));
console.log('Wrote metadata to scripts/docs/generated/metadata.json');
