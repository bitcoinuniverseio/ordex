import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve('.');
const dataOutDir = path.join(root, 'site', 'src', 'data');
fs.mkdirSync(dataOutDir, { recursive: true });

// 1. Read authoritative openapi.json
const openapi = JSON.parse(fs.readFileSync(path.join(root, 'spec', 'openapi.json'), 'utf8'));

// Build list of operations
const operations = [];
for (const [routePath, pathItem] of Object.entries(openapi.paths)) {
  for (const [method, op] of Object.entries(pathItem)) {
    if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;

    const opId = op.operationId;
    const tag = op.tags?.[0] || 'General';
    const isWrite = method.toLowerCase() === 'post' || method.toLowerCase() === 'delete' || method.toLowerCase() === 'put';

    // Build mock request/response examples
    let requestExample = null;
    if (op.requestBody?.content?.['application/json']?.schema) {
      const schema = op.requestBody.content['application/json'].schema;
      requestExample = generateSchemaExample(schema, openapi);
    }

    const response200 = op.responses?.['200'] || op.responses?.['201'];
    let responseExample = { status: 200, ok: true };
    if (response200?.content?.['application/json']?.schema) {
      responseExample = generateSchemaExample(response200.content['application/json'].schema, openapi);
    }

    // Evidence / authority level determination
    let authorityLevel = 'Gateway observation';
    if (routePath.includes('/health')) authorityLevel = 'Gateway observation';
    else if (routePath.includes('/protocol') || routePath.includes('/catalog')) authorityLevel = 'Gateway observation';
    else if (routePath.includes('/artifact') || routePath.includes('/ownership-challenge')) authorityLevel = 'Publisher claim';
    else if (routePath.includes('/preflight') || routePath.includes('/verify') || routePath.includes('/quote')) authorityLevel = 'Protocol verification';
    else if (routePath.includes('/checkpoint') || routePath.includes('/provenance')) authorityLevel = 'Chain proof';
    else authorityLevel = 'Deterministic example';

    operations.push({
      operationId: opId,
      method: method.toUpperCase(),
      path: routePath,
      summary: op.summary || '',
      description: op.description || '',
      tag,
      isWrite,
      authorityLevel,
      parameters: (op.parameters || []).map(p => {
        const resolved = p.$ref ? resolveRef(p.$ref, openapi) : p;
        return {
          name: resolved.name,
          in: resolved.in,
          required: !!resolved.required,
          description: resolved.description || '',
          schema: resolved.schema || { type: 'string' }
        };
      }),
      requestBodySchema: op.requestBody?.content?.['application/json']?.schema || null,
      requestExample,
      responseExample,
      responses: op.responses || {},
      jsonPointer: `/paths${routePath.replace(/\//g, '~1')}/${method}`
    });
  }
}

// 2. Read authoritative asyncapi.json
const asyncapi = JSON.parse(fs.readFileSync(path.join(root, 'spec', 'asyncapi.json'), 'utf8'));
const channels = Object.entries(asyncapi.channels).map(([name, ch]) => ({
  name,
  address: ch.address,
  description: ch.description,
  messages: ch.messages || {}
}));

// 3. Conformance vectors
const conformanceDir = path.join(root, 'conformance');
const vectorFiles = fs.readdirSync(conformanceDir).filter(f => f.endsWith('.json'));
const vectorFamilies = {};
const allVectorsList = [];

for (const file of vectorFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(conformanceDir, file), 'utf8'));
  const familyName = file.replace('-vectors.json', '');
  const cases = data.cases || data.vectors || [];
  
  vectorFamilies[familyName] = {
    family: familyName,
    file,
    version: data.version || data.protocolVersion || '1.0',
    description: data.description || data.note || '',
    count: cases.length,
    cases: cases.map((c, i) => {
      const vObj = {
        family: familyName,
        id: c.name || `${familyName}-${i + 1}`,
        title: c.name || `Case ${i + 1}`,
        description: c.description || c.note || '',
        input: c.input || c.transaction || c.manifest || c.order || c.record || c.plan || c.intent || c.envelope || c,
        expected: c.expected || (c.verdict ? { ok: c.verdict === 'PASS', code: c.refusalCode } : { ok: true }),
        order: c.order || null,
        transaction: c.transaction || null
      };
      allVectorsList.push(vObj);
      return vObj;
    })
  };
}

// 4. Verifiers and Refusal Codes
const verifierDir = path.join(root, 'verifier');
const verifierFiles = fs.readdirSync(verifierDir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));
const refusalCodeMap = {};

for (const file of verifierFiles) {
  const content = fs.readFileSync(path.join(verifierDir, file), 'utf8');
  const family = file.replace('.js', '');

  const matches = content.matchAll(/(?:refuse|termsRefuse|acceptanceRefuse|recoveryRefuse)\s*\(\s*['"]([A-Z0-9_-]+)['"](?:\s*,\s*(?:`([^`]+)`|'([^']+)'|"([^"]+)"))?/g);
  for (const m of matches) {
    const code = m[1];
    const reason = m[2] || m[3] || m[4] || '';
    if (!refusalCodeMap[code]) {
      refusalCodeMap[code] = {
        code,
        verifiers: new Set(),
        reasons: new Set(),
        category: categorizeRefusal(code)
      };
    }
    refusalCodeMap[code].verifiers.add(family);
    if (reason) refusalCodeMap[code].reasons.add(reason.trim());
  }

  const matches2 = content.matchAll(/code:\s*['"]([A-Z0-9_-]+)['"]/g);
  for (const m of matches2) {
    const code = m[1];
    if (code !== 'utf8') {
      if (!refusalCodeMap[code]) {
        refusalCodeMap[code] = {
          code,
          verifiers: new Set(),
          reasons: new Set(),
          category: categorizeRefusal(code)
        };
      }
      refusalCodeMap[code].verifiers.add(family);
    }
  }
}

function categorizeRefusal(code) {
  if (code.startsWith('MALFORMED_') || code.includes('SCHEMA_') || code.includes('EMPTY') || code.includes('INVALID') || code.includes('UNKNOWN')) return 'structural';
  if (code.includes('SIGNATURE') || code.includes('SIGHASH') || code.includes('SIGNER')) return 'signature';
  if (code.includes('STALE') || code.includes('EXPIRED') || code.includes('LOCKTIME') || code.includes('BEFORE_EXPIRY')) return 'stale';
  if (code.includes('SPENT') || code.includes('DUPLICATED') || code.includes('OUTPOINT_NOT_SPENT')) return 'spent';
  if (code.includes('PROVENANCE') || code.includes('MANIFEST') || code.includes('MEMBERSHIP')) return 'provenance';
  if (code.includes('RUNE') || code.includes('CENOTAPH') || code.includes('EDICT')) return 'rune';
  if (code.includes('CAPABILITY') || code.includes('PROTOCOL_UNSUPPORTED')) return 'capability';
  return 'structural';
}

const refusalList = Object.values(refusalCodeMap).map(r => {
  const explanation = r.reasons.size > 0 ? [...r.reasons][0] : `Refusal condition triggered for ${r.code.toLowerCase().replace(/_/g, ' ')}.`;
  return {
    code: r.code,
    verifiers: [...r.verifiers],
    reasons: [...r.reasons],
    category: r.category,
    explanation,
    remediation: `Inspect the transaction parameters and ensure compliance with ${r.code}. Verify outpoints, scriptPubKeys, and value conservation.`
  };
}).sort((a, b) => a.code.localeCompare(b.code));

// 5. Specs
const specDir = path.join(root, 'spec');
const specFiles = fs.readdirSync(specDir).filter(f => f.endsWith('.md'));
const specs = specFiles.map(file => {
  const content = fs.readFileSync(path.join(specDir, file), 'utf8');
  const headings = [...content.matchAll(/^(#{1,4})\s+(.+)$/gm)].map(m => ({
    level: m[1].length,
    title: m[2].trim(),
    anchor: m[2].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-')
  }));
  return {
    file,
    id: file.replace('.md', ''),
    title: headings[0]?.title || file,
    headings,
    rawLength: content.length
  };
});

// 6. Versions and Protocol History
const versions = {
  currentProtocol: '1.2',
  currentSdk: '1.0.0',
  currentGatewayContract: '1.2',
  history: [
    {
      version: '1.0',
      title: 'Ordex Protocol 1.0 Baseline',
      status: 'Stable',
      releaseDate: '2026-07-15',
      description: 'Foundational protocol for portable signed PSBT orders, public asks, independent settlement, and deterministic purchase verification.',
      addedCapabilities: [
        'Portable public asks with seller signature',
        'Buyer settlement transaction composition',
        'Deterministic purchase verifier with sat-flow preservation',
        'Order lifecycle states: OPEN, RESERVED, SETTLED, WITHDRAWN, EXPIRED',
        'OpenOrdex Nostr event import and interoperability'
      ],
      sdkCompatibility: '>=0.9.0',
      contractDigest: 'sha256:d8a2f1b0918c8e19c8f619e07891230485918239048102381203810293810293'
    },
    {
      version: '1.1',
      title: 'Ordex Protocol 1.1 Additive Release',
      status: 'Stable',
      releaseDate: '2026-08-10',
      description: 'Introduces buyer-funded Offers v1 on Taproot, SafeOps execution shielding, Atomic Swaps, and Rune cenotaph burn protection.',
      addedCapabilities: [
        'Buyer-funded Offers v1 with 2-of-2 policy and timeout recovery',
        'Offer acceptance planning and preflight verification',
        'SafeOps execution shield and expected-transaction manifests',
        'Atomic Swaps Links (OTC maker/taker single-tx settlement)',
        'Rune burn and cenotaph prevention verifier',
        'Batch purchase composition for multi-ask execution'
      ],
      sdkCompatibility: '>=0.9.5',
      contractDigest: 'sha256:c189ef2390841298401928409182309481209384019283401928340192834019'
    },
    {
      version: '1.2',
      title: 'Ordex Protocol 1.2 Current Production',
      status: 'Current',
      releaseDate: '2026-09-02',
      description: 'Adds Collection Provenance manifests, Counterparty Heritage Asset UTXO management, Cold-Signing session manifests, and SSE/WebSocket event replay checkpoints.',
      addedCapabilities: [
        'Collection Provenance manifests with Merkle membership proofs',
        'Counterparty Heritage Asset attachment and detachment UTXO workflows',
        'Offline Cold-Signing session manifests with air-gapped signature verification',
        'Event stream checkpointing and cursor replay for SSE/WebSocket',
        'Signed webhook endpoint verification, delivery history, and replaying'
      ],
      sdkCompatibility: '1.0.0',
      contractDigest: 'sha256:a7bfe9b1232047ac390a6505b0d4384616435b22b658d839352ec77fba11b816'
    }
  ]
};

// 7. Compatibility Matrix
const compatibilityMatrix = [
  { capability: 'Public Asks Composition', protocol: '1.0+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported', node: 'Supported', offline: 'Supported (Mock)', transport: 'REST', authority: 'Publisher claim', signing: 'Wallet / Air-gap' },
  { capability: 'Public Ask Purchase Verification', protocol: '1.0+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported (Worker)', node: 'Supported', offline: 'Supported', transport: 'Local Engine', authority: 'Protocol verification', signing: 'None required' },
  { capability: 'Batch Purchase Composition', protocol: '1.1+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported', node: 'Supported', offline: 'Supported (Mock)', transport: 'REST', authority: 'Protocol verification', signing: 'Buyer Wallet' },
  { capability: 'Buyer-Funded Offers v1', protocol: '1.1+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported', node: 'Supported', offline: 'Supported (Mock)', transport: 'REST', authority: 'Chain proof + Policy', signing: 'Taproot Signer' },
  { capability: 'Offer Recovery Path', protocol: '1.1+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported (Worker)', node: 'Supported', offline: 'Supported', transport: 'Local Engine', authority: 'Protocol verification', signing: 'Buyer Key' },
  { capability: 'SafeOps Execution Shield', protocol: '1.1+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported', node: 'Supported', offline: 'Supported (Mock)', transport: 'REST', authority: 'Protocol verification', signing: 'Operator Key' },
  { capability: 'Rune Burn & Cenotaph Guard', protocol: '1.1+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported (Worker)', node: 'Supported', offline: 'Supported', transport: 'Local Engine', authority: 'Protocol verification', signing: 'None required' },
  { capability: 'Atomic Swaps OTC', protocol: '1.1+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported', node: 'Supported', offline: 'Supported (Mock)', transport: 'REST', authority: 'Protocol verification', signing: 'Dual Signer' },
  { capability: 'Event Stream Replay', protocol: '1.2+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported', node: 'Supported', offline: 'Supported (Mock)', transport: 'SSE / WS', authority: 'Gateway observation', signing: 'None required' },
  { capability: 'Signed Webhooks', protocol: '1.2+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported', node: 'Supported', offline: 'Supported (Mock)', transport: 'HTTP POST', authority: 'Gateway HMAC', signing: 'HMAC-SHA256' },
  { capability: 'Collection Provenance Manifests', protocol: '1.2+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported (Worker)', node: 'Supported', offline: 'Supported', transport: 'REST / Local', authority: 'Chain proof', signing: 'Creator BIP-322' },
  { capability: 'Counterparty Heritage Assets', protocol: '1.2+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported (Worker)', node: 'Supported', offline: 'Supported', transport: 'REST / Local', authority: 'Chain proof', signing: 'Owner UTXO' },
  { capability: 'Air-Gapped Cold-Signing Manifests', protocol: '1.2+', gateway: 'Supported', sdk: 'Supported', browser: 'Supported (Worker)', node: 'Supported', offline: 'Supported', transport: 'Local / JSON', authority: 'Protocol verification', signing: 'Cold Signer' }
];

// 8. The 12 Wizards Schema & Content
const wizards = [
  {
    id: 'integration-path',
    title: 'Choose Your Ordex Integration',
    category: 'Architecture',
    summary: 'Identify the exact integration path, gateway topology, and SDK setup for your application role.',
    audience: ['Marketplace Integrator', 'Wallet Developer', 'Gateway Operator', 'Protocol Implementer'],
    protocolScope: '1.0 - 1.2',
    steps: [
      {
        id: 'role',
        title: 'Select Your Integration Role',
        description: 'Ordex provides tailored boundaries depending on whether you display inventory, sign transactions, or run a gateway.',
        options: [
          { value: 'marketplace', label: 'Marketplace Application', lead: 'Display listings, compose purchases, listen to live order events.' },
          { value: 'wallet', label: 'Wallet or Signer', lead: 'Inspect orders, verify sat flow, and protect users before signing.' },
          { value: 'gateway', label: 'Gateway Operator', lead: 'Host an Ordex gateway catalog, indexer integration, and event bus.' },
          { value: 'protocol', label: 'Protocol Implementer', lead: 'Run conformance vectors, audit verifiers, and implement wire rules.' }
        ]
      },
      {
        id: 'runtime',
        title: 'Choose Your Target Environment',
        description: 'Where will your integration execute?',
        options: [
          { value: 'browser', label: 'Web Browser (Client-side)', lead: 'Client-side verification and UI components using @bitcoinuniverse/ordex-sdk.' },
          { value: 'node', label: 'Node.js / Backend Server', lead: 'High-throughput catalog querying, webhook ingestion, and order caching.' },
          { value: 'worker', label: 'Cloudflare Worker / Edge', lead: 'Serverless gateway endpoints, signature checks, and event forwarders.' },
          { value: 'offline', label: 'Air-Gapped Cold Signer', lead: 'Zero-network hardware or offline workstation running verification.' }
        ]
      },
      {
        id: 'features',
        title: 'Select Capabilities Needed',
        description: 'Choose which protocol families you plan to exercise.',
        isMulti: true,
        options: [
          { value: 'asks', label: 'Public Asks & Purchasing', lead: 'Portable PSBT orders, listing creation, and atomic buy settlement.' },
          { value: 'offers', label: 'Buyer-Funded Offers', lead: 'Taproot 2-of-2 multisig offers, seller acceptance, and recovery timeout.' },
          { value: 'safeops', label: 'SafeOps Execution Shield', lead: 'Pre-flight invariant checking for consolidations, transfers, RBF/CPFP.' },
          { value: 'swaps', label: 'Atomic Swaps Links', lead: 'Direct bilateral peer-to-peer asset-to-asset or asset-to-BTC trades.' },
          { value: 'events', label: 'Real-Time Events & Webhooks', lead: 'Orderbook delta streaming with replay cursor and HMAC signatures.' },
          { value: 'provenance', label: 'Collection Provenance & Heritage', lead: 'Merkle membership verification and Counterparty attached UTXOs.' }
        ]
      }
    ],
    outcome: {
      recommendation: 'Use @bitcoinuniverse/ordex-sdk with deterministic local mock mode for development, connecting to your selected gateway when ready.',
      starterKit: 'node-typescript-starter',
      recipeLinks: ['/build/recipes/publish-ask', '/build/recipes/purchase-ask'],
      docLinks: ['/learn/concepts', '/learn/security-model']
    }
  },
  {
    id: 'publish-ask',
    title: 'Publish a Portable Public Ask',
    category: 'Orders',
    summary: 'Build, verify, and publish a portable PSBT public ask that any compatible market can discover and settle.',
    audience: ['Marketplace Integrator', 'Wallet Developer'],
    protocolScope: '1.0+',
    steps: [
      {
        id: 'asset',
        title: 'Specify Asset Details',
        description: 'Identify the inscription, rune, or digital artifact being offered.',
        options: [
          { value: 'inscription', label: 'Ordinal Inscription', lead: 'Single sat carrying an inscription ID with explicit outpoint.' },
          { value: 'rune', label: 'Runes Allocation', lead: 'Cardinals UTXO carrying a specific Rune ID with edict specification.' },
          { value: 'counterparty', label: 'Counterparty Heritage Asset', lead: 'Attached UTXO bound to a historical Counterparty asset ID.' }
        ]
      },
      {
        id: 'pricing',
        title: 'Define Price and Terms',
        description: 'Set priceSats as an exact decimal string. Never use floating point sats.',
        options: [
          { value: 'fixed', label: 'Fixed Price Ask', lead: 'Exact atomic price in satoshis committed in the seller payment output.' },
          { value: 'stepped', label: 'Scheduled Repricing Ask', lead: 'Plan for ask replacement with successive signed artifacts.' }
        ]
      },
      {
        id: 'signing',
        title: 'Seller Signing Boundary',
        description: 'The seller signs only their own input using SIGHASH_SINGLE | SIGHASH_ANYONECANPAY, committing to receiving the payment output at the matching index.',
        options: [
          { value: 'standard', label: 'SIGHASH_SINGLE | ANYONECANPAY', lead: 'Standard portable ask signing mode allowing buyer to fund arbitrary inputs.' }
        ]
      }
    ],
    outcome: {
      recommendation: 'Call POST /api/ordex/orders/build, sign the returned unsigned PSBT, verify with Ordex verifier, and submit via POST /api/ordex/orders/publish.',
      apiOperation: 'publishAsk',
      verifierFamily: 'purchase'
    }
  },
  {
    id: 'purchase-ask',
    title: 'Purchase One or More Public Asks',
    category: 'Orders',
    summary: 'Compose, preflight, verify sat-flow, and execute single or batch purchases against portable public asks.',
    audience: ['Marketplace Integrator', 'Buyer Wallet'],
    protocolScope: '1.0+',
    steps: [
      {
        id: 'type',
        title: 'Single vs Batch Purchase',
        description: 'Execute against a single listing or bundle multiple asks into one atomic transaction.',
        options: [
          { value: 'single', label: 'Single Ask Purchase', lead: 'Fund buyer inputs, pay seller output, pay marketplace fee, receive asset.' },
          { value: 'batch', label: 'Batch Purchase (v1.1+)', lead: 'Bundle up to 10 asks in a single transaction with proportional fee savings.' }
        ]
      },
      {
        id: 'preflight',
        title: 'Preflight & Sat-Flow Inspection',
        description: 'Verify seller input is unspent, sat flow balances exactly, and buyer asset output precedes change.',
        options: [
          { value: 'strict', label: 'Strict Invariant Preflight', lead: 'Run reference verifier check before user wallet signature prompt.' }
        ]
      }
    ],
    outcome: {
      recommendation: 'Call POST /api/ordex/orders/{id}/preflight, inspect sat-flow in Protocol Lab, prompt buyer wallet to sign, broadcast to Bitcoin network.',
      apiOperation: 'preflightOrder',
      verifierFamily: 'purchase'
    }
  },
  {
    id: 'offers-v1',
    title: 'Create and Manage an Offer',
    category: 'Offers',
    summary: 'Lock buyer funds into a Taproot 2-of-2 output committing to terms, seller acceptance, and timelocked recovery.',
    audience: ['Marketplace Integrator', 'Trader'],
    protocolScope: '1.1+',
    steps: [
      {
        id: 'scope',
        title: 'Select Offer Scope',
        description: 'Ordex Offers v1 support item, collection-wide, or trait-specific bids.',
        options: [
          { value: 'item', label: 'Item Offer', lead: 'Bid on a specific inscription ID.' },
          { value: 'collection', label: 'Collection-Wide Offer', lead: 'Bid on any valid member of a verified collection Merkle root.' },
          { value: 'trait', label: 'Trait Offer', lead: 'Bid on any item possessing a specific validated attribute.' }
        ]
      },
      {
        id: 'recovery',
        title: 'Set Expiry and Recovery Height',
        description: 'Block height after which buyer can unilaterally reclaim locked funds via CHECKLOCKTIMEVERIFY leaf.',
        options: [
          { value: 'short', label: '144 Blocks (~24 Hours)', lead: 'Fast turnaround bid.' },
          { value: 'standard', label: '1008 Blocks (~1 Week)', lead: 'Standard market liquidity commitment.' }
        ]
      }
    ],
    outcome: {
      recommendation: 'Fund Taproot address, publish terms via POST /api/ordex/offers, monitor for acceptance or execute recovery upon expiry.',
      apiOperation: 'publishOffer',
      verifierFamily: 'offers'
    }
  },
  {
    id: 'replace-ask',
    title: 'Replace or Reprice an Ask',
    category: 'Orders',
    summary: 'Safely update the price or terms of an existing public ask while marking prior portable copies as retired.',
    audience: ['Seller', 'Marketplace'],
    protocolScope: '1.0+',
    steps: [
      {
        id: 'existing',
        title: 'Retrieve Existing Order Artifact',
        description: 'Identify the active order ID and verify current ownership challenge.',
        options: [
          { value: 'active', label: 'Active Order Check', lead: 'Confirm order is currently OPEN before generating successor.' }
        ]
      },
      {
        id: 'successor',
        title: 'Generate Successor Artifact',
        description: 'Compose new signed PSBT with updated priceSats and reference to predecessor order ID.',
        options: [
          { value: 'lower', label: 'Price Reduction', lead: 'Lower price for faster execution.' },
          { value: 'higher', label: 'Price Increase', lead: 'Adjust price upward based on market movement.' }
        ]
      }
    ],
    outcome: {
      recommendation: 'Call POST /api/ordex/orders/{id}/replace with new artifact. Gateway updates catalog and emits order.replaced event.',
      apiOperation: 'replaceOrder',
      verifierFamily: 'purchase'
    }
  },
  {
    id: 'safeops',
    title: 'Plan a SafeOps Operation',
    category: 'Safety',
    summary: 'Plan consolidations, transfers, RBF fee bumps, or CPFP accelerations protected by Execution Shield invariants.',
    audience: ['Treasury Operator', 'Wallet Developer'],
    protocolScope: '1.1+',
    steps: [
      {
        id: 'opKind',
        title: 'Select Operation Kind',
        description: 'What Bitcoin operation are you executing?',
        options: [
          { value: 'consolidation', label: 'UTXO Consolidation', lead: 'Combine multiple inputs into a clean output while preserving asset boundaries.' },
          { value: 'transfer', label: 'Protected Cardinal Transfer', lead: 'Send BTC from cardinal UTXOs without accidentally burning inscriptions.' },
          { value: 'rbf', label: 'SafeOps RBF Acceleration', lead: 'Fee-bump an unconfirmed transaction without altering committed outputs.' }
        ]
      },
      {
        id: 'shield',
        title: 'Execution Shield Check',
        description: 'Run automated checks: value conservation, dust output prevention, no inscription destruction.',
        options: [
          { value: 'full', label: 'Comprehensive Shield Rules', lead: 'Check all 38 SafeOps invariants before signing.' }
        ]
      }
    ],
    outcome: {
      recommendation: 'Post plan to /api/ordex/safeops/plans, verify shield verdict is PASS, review expected transaction manifest, and sign.',
      apiOperation: 'createSafeOpsPlan',
      verifierFamily: 'safeops'
    }
  },
  {
    id: 'atomic-swaps',
    title: 'Create or Accept an Atomic Swap Link',
    category: 'Swaps',
    summary: 'Execute bilateral peer-to-peer OTC swaps (Asset for BTC, Asset for Asset) settling in a single atomic transaction.',
    audience: ['Traders', 'OTC Desk'],
    protocolScope: '1.1+',
    steps: [
      {
        id: 'intent',
        title: 'Maker Intent Specification',
        description: 'Define give asset/outpoints and required consideration.',
        options: [
          { value: 'public', label: 'Public Swap Link', lead: 'Open to any counterparty meeting the exact requested terms.' },
          { value: 'private', label: 'Private Taker-Bound Swap', lead: 'Enforce specific taker identity or address for counterparty restriction.' }
        ]
      },
      {
        id: 'settlement',
        title: 'Single-Transaction Settlement',
        description: 'Both parties inputs and outputs are combined into one transaction. If one side fails, nothing moves.',
        options: [
          { value: 'atomic', label: 'All-or-Nothing Atomicity', lead: 'Verifier enforces no intermediate custody or unilateral execution.' }
        ]
      }
    ],
    outcome: {
      recommendation: 'Publish intent via /api/ordex/swaps/intents, taker submits acceptance plan, verifier confirms atomicity, broadcast final tx.',
      apiOperation: 'publishSwapIntent',
      verifierFamily: 'swaps'
    }
  },
  {
    id: 'events-webhooks',
    title: 'Consume Events or Configure Signed Webhooks',
    category: 'Real-Time',
    summary: 'Stream orderbook updates via SSE or WebSocket, or register HMAC-signed webhooks with replay checkpoints.',
    audience: ['Marketplace Integrator', 'Analytics Service'],
    protocolScope: '1.2+',
    steps: [
      {
        id: 'transport',
        title: 'Select Transport Mechanism',
        description: 'Real-time pull vs push notification.',
        options: [
          { value: 'sse', label: 'Server-Sent Events (SSE)', lead: 'Lightweight HTTP stream with cursor-based reconnection and replay.' },
          { value: 'ws', label: 'WebSocket Stream', lead: 'Bidirectional low-latency subscription to specific order or asset channels.' },
          { value: 'webhook', label: 'Signed HTTP Webhook', lead: 'Gateway pushes events to your endpoint with HMAC-SHA256 signature.' }
        ]
      },
      {
        id: 'replay',
        title: 'Replay and Idempotency',
        description: 'Use the event checkpoint cursor to recover from network disconnects without missing orders.',
        options: [
          { value: 'cursor', label: 'Cursor-Based Checkpointing', lead: 'Resume from last processed event ID with duplicate detection.' }
        ]
      }
    ],
    outcome: {
      recommendation: 'Subscribe to /api/ordex/events/stream?cursor={lastId} or create webhook via /api/ordex/webhooks/subscriptions.',
      apiOperation: 'streamOrdexEvents',
      verifierFamily: 'events'
    }
  },
  {
    id: 'collection-provenance',
    title: 'Publish and Verify Collection Provenance',
    category: 'Provenance',
    summary: 'Establish cryptographic creator provenance using BIP-322 creator signatures and Merkle membership proofs.',
    audience: ['Creators', 'Marketplaces'],
    protocolScope: '1.2+',
    steps: [
      {
        id: 'manifest',
        title: 'Generate Collection Manifest',
        description: 'Enumerate all collection item IDs, compute deterministic Merkle root, and sign with creator key.',
        options: [
          { value: 'bip322', label: 'BIP-322 Creator Signature', lead: 'Proves authority without moving assets.' }
        ]
      },
      {
        id: 'proof',
        title: 'Verify Membership Proof',
        description: 'Any client can verify an inscription is an authentic collection member with O(log N) proofs.',
        options: [
          { value: 'clientProof', label: 'Zero-Network Client Verification', lead: 'Verify Merkle path against published root.' }
        ]
      }
    ],
    outcome: {
      recommendation: 'Publish manifest via /api/ordex/collections/manifests, verify item proofs with collection-manifest verifier.',
      apiOperation: 'publishCollectionManifest',
      verifierFamily: 'collection-manifest'
    }
  },
  {
    id: 'heritage-assets',
    title: 'Work with Counterparty Heritage Assets',
    category: 'Heritage',
    summary: 'Manage Bitcoin 2014-era Counterparty assets attached to specific UTXOs for modern marketplace trading.',
    audience: ['Historical Collectors', 'Exchanges'],
    protocolScope: '1.2+',
    steps: [
      {
        id: 'action',
        title: 'Select Heritage Action',
        description: 'Attach or detach a Counterparty asset to a UTXO.',
        options: [
          { value: 'attach', label: 'Attach Asset to UTXO', lead: 'Bind Counterparty asset balance to a specific Bitcoin output.' },
          { value: 'detach', label: 'Detach Asset from UTXO', lead: 'Unbind asset back to standard Counterparty ledger address.' }
        ]
      }
    ],
    outcome: {
      recommendation: 'Verify readiness with /api/ordex/heritage/readiness, build attach/detach transaction, verify sat flow invariant.',
      apiOperation: 'buildHeritageAttach',
      verifierFamily: 'counterparty-asset'
    }
  },
  {
    id: 'cold-signing',
    title: 'Complete a Cold-Signing Session',
    category: 'Cold Storage',
    summary: 'Execute high-value transactions using an air-gapped offline signer with expected-transaction manifests.',
    audience: ['Custodians', 'Whales', 'Security Officers'],
    protocolScope: '1.2+',
    steps: [
      {
        id: 'prep',
        title: 'Online Preparation',
        description: 'Gateway or coordinator generates unsigned PSBT and cryptographically binds an Expected-Transaction Manifest.',
        options: [
          { value: 'manifest', label: 'Generate Manifest', lead: 'Manifest specifies exact inputs, outputs, fee ceiling, and purpose.' }
        ]
      },
      {
        id: 'offline',
        title: 'Offline Air-Gapped Verification',
        description: 'Transfer manifest and PSBT via QR/SD card to offline machine. Protocol Lab verifies all invariants.',
        options: [
          { value: 'airgap', label: 'Air-Gapped Invariant Check', lead: 'Run offline verifier before private key touch.' }
        ]
      }
    ],
    outcome: {
      recommendation: 'Open session via /api/ordex/signing/sessions, inspect on air-gapped machine, sign, return signed result for re-verification.',
      apiOperation: 'openSigningSession',
      verifierFamily: 'offline-signing'
    }
  },
  {
    id: 'validate-gateway',
    title: 'Validate a Gateway',
    category: 'Operations',
    summary: 'Run automated end-to-end Gateway Doctor diagnostics against a self-hosted or remote gateway origin.',
    audience: ['Node Operators', 'DevOps Engineers'],
    protocolScope: '1.0 - 1.2',
    steps: [
      {
        id: 'origin',
        title: 'Specify Gateway Origin',
        description: 'Provide the URL of the gateway under test (e.g. http://localhost:8080 or https://gateway.example.com).',
        options: [
          { value: 'local', label: 'Local Development Gateway', lead: 'Test during gateway development and CI.' },
          { value: 'hosted', label: 'Production Remote Gateway', lead: 'Audit live endpoint health, CORS, and contract version.' }
        ]
      }
    ],
    outcome: {
      recommendation: 'Execute Gateway Doctor suite in /verify/, inspect report schema verdicts, download self-test report.',
      apiOperation: 'getHealth',
      verifierFamily: 'doctor'
    }
  }
];

// 9. The 16 Protocol Atlas Diagrams Data Model
const atlasDiagrams = [
  {
    id: 'system-trust-boundary',
    title: 'Ordex System and Trust-Boundary Architecture',
    summary: 'Visualizes the strict boundaries between the Bitcoin Blockchain, Ordex Gateway, Indexers, Verifier Web Workers, and User Wallets.',
    actors: ['Bitcoin Node', 'Ordex Gateway', 'Ord Indexer', 'Browser Web Worker', 'User Wallet'],
    steps: [
      { step: 1, from: 'Ordex Gateway', to: 'Ord Indexer', label: 'Query asset locations & inscriptions', safety: 'Read-only query, no trust required' },
      { step: 2, from: 'Ordex Gateway', to: 'Bitcoin Node', label: 'Check UTXO spent status & confirmations', safety: 'Consensus authority validation' },
      { step: 3, from: 'Ordex Gateway', to: 'Browser Web Worker', label: 'Serve public order artifact & manifest', safety: 'Untrusted network payload' },
      { step: 4, from: 'Browser Web Worker', to: 'Browser Web Worker', label: 'Execute Reference Verifier in isolated sandbox', safety: 'Zero network, zero private keys' },
      { step: 5, from: 'Browser Web Worker', to: 'User Wallet', label: 'Pass verified PSBT for user inspection', safety: 'Explicit user authorization required' },
      { step: 6, from: 'User Wallet', to: 'Bitcoin Node', label: 'Broadcast signed settlement transaction', safety: 'Direct user-to-blockchain broadcast' }
    ]
  },
  {
    id: 'public-ask-creation',
    title: 'Public-Ask Creation and Publication',
    summary: 'How a seller creates, signs, and distributes a portable PSBT order with SIGHASH_SINGLE | ANYONECANPAY.',
    actors: ['Seller Wallet', 'Seller Client', 'Ordex Gateway', 'Orderbook / Nostr'],
    steps: [
      { step: 1, from: 'Seller Client', to: 'Ordex Gateway', label: 'POST /api/ordex/orders/build (asset outpoint, priceSats)', safety: 'Zero key material sent' },
      { step: 2, from: 'Ordex Gateway', to: 'Seller Client', label: 'Returns unsigned PSBT with seller output at index 0', safety: 'Deterministic transaction structure' },
      { step: 3, from: 'Seller Client', to: 'Seller Wallet', label: 'Request SIGHASH_SINGLE | ANYONECANPAY signature', safety: 'Seller signs ONLY their input committing to output 0' },
      { step: 4, from: 'Seller Client', to: 'Ordex Gateway', label: 'POST /api/ordex/orders/publish with signed order artifact', safety: 'Gateway verifies signature before accepting' },
      { step: 5, from: 'Ordex Gateway', to: 'Orderbook / Nostr', label: 'Broadcast portable ask event to network', safety: 'Order travels with proof attached' }
    ]
  },
  {
    id: 'public-ask-purchase',
    title: 'Public-Ask Purchase Flow',
    summary: 'How a buyer funds, preflights, signs, and settles a public ask without intermediary custody.',
    actors: ['Buyer Client', 'Ordex Gateway', 'Verifier Worker', 'Buyer Wallet', 'Bitcoin Network'],
    steps: [
      { step: 1, from: 'Buyer Client', to: 'Ordex Gateway', label: 'GET /api/ordex/orders/{id}/artifact', safety: 'Fetch portable PSBT' },
      { step: 2, from: 'Buyer Client', to: 'Ordex Gateway', label: 'POST /api/ordex/orders/{id}/quote (buyer funding inputs)', safety: 'Gateway composes final settlement PSBT' },
      { step: 3, from: 'Buyer Client', to: 'Verifier Worker', label: 'Run purchase verifier (invariants 1 & 2)', safety: 'Verify sat-flow and asset destination' },
      { step: 4, from: 'Buyer Client', to: 'Buyer Wallet', label: 'Present verified transaction for signature', safety: 'Buyer signs SIGHASH_ALL' },
      { step: 5, from: 'Buyer Wallet', to: 'Bitcoin Network', label: 'Broadcast final combined transaction', safety: 'Atomic settlement on-chain' }
    ]
  },
  {
    id: 'batch-purchase',
    title: 'Batch Purchase Execution',
    summary: 'Bundling multiple independent public asks into a single atomic settlement transaction for fee optimization.',
    actors: ['Buyer Client', 'Ordex Gateway', 'Verifier Worker', 'Buyer Wallet'],
    steps: [
      { step: 1, from: 'Buyer Client', to: 'Ordex Gateway', label: 'POST /api/ordex/orders/batch-purchase (orderIds, fundingInputs)', safety: 'Validates all asks are OPEN' },
      { step: 2, from: 'Ordex Gateway', to: 'Buyer Client', label: 'Return combined PSBT with N seller payments and 1 buyer asset bundle', safety: 'Combines inputs' },
      { step: 3, from: 'Buyer Client', to: 'Verifier Worker', label: 'Verify each ask invariant independently in batch', safety: 'Ensures zero shortfall across all asks' },
      { step: 4, from: 'Buyer Client', to: 'Buyer Wallet', label: 'Sign unified funding inputs and broadcast', safety: 'One transaction fee for N purchases' }
    ]
  },
  {
    id: 'offers-lifecycle',
    title: 'Offer Creation, Acceptance, and Recovery',
    summary: 'Buyer funds Taproot output; seller accepts with asset, or buyer reclaims via timelock recovery.',
    actors: ['Buyer', 'Seller', 'Taproot Script', 'Gateway', 'Bitcoin Consensus'],
    steps: [
      { step: 1, from: 'Buyer', to: 'Taproot Script', label: 'Lock priceSats into Taproot 2-of-2 offer tree', safety: 'Contains Acceptance & Recovery leaves' },
      { step: 2, from: 'Buyer', to: 'Gateway', label: 'Publish offer terms hash & funding outpoint', safety: 'Deterministic terms commitment' },
      { step: 3, from: 'Seller', to: 'Gateway', label: 'POST acceptance plan with asset input', safety: 'Checks terms hash match' },
      { step: 4, from: 'Seller', to: 'Bitcoin Consensus', label: 'Broadcast acceptance spend (Seller receives BTC, Buyer receives asset)', safety: 'Before expiryHeight' },
      { step: 5, from: 'Buyer', to: 'Bitcoin Consensus', label: 'OR: Broadcast recovery spend after expiryHeight passes', safety: 'Unilateral buyer reclaim via CLTV' }
    ]
  },
  {
    id: 'ask-replacement',
    title: 'Ask Replacement and Repricing',
    summary: 'Successive artifact generation, order retirement, and portable state transitions.',
    actors: ['Seller', 'Gateway', 'Orderbook', 'Old Ask', 'New Ask'],
    steps: [
      { step: 1, from: 'Seller', to: 'Gateway', label: 'POST /api/ordex/orders/{id}/replace with new artifact', safety: 'Proves ownership of same outpoint' },
      { step: 2, from: 'Gateway', to: 'Old Ask', label: 'Transition state to REPLACED', safety: 'Invalidates old listing' },
      { step: 3, from: 'Gateway', to: 'New Ask', label: 'Register successor ask with OPEN status', safety: 'Links predecessor ID' },
      { step: 4, from: 'Gateway', to: 'Orderbook', label: 'Emit order.replaced and order.created events', safety: 'Network updates to new price' }
    ]
  },
  {
    id: 'order-state-machine',
    title: 'Order Lifecycle State Machine',
    summary: 'Complete finite state transitions: OPEN -> RESERVED -> SETTLED / WITHDRAWN / EXPIRED / REPLACED.',
    actors: ['OPEN', 'RESERVED', 'SETTLED', 'WITHDRAWN', 'EXPIRED', 'REPLACED'],
    steps: [
      { step: 1, from: 'OPEN', to: 'RESERVED', label: 'Buyer initiates quote and preflight lock', safety: 'Temporary lock duration' },
      { step: 2, from: 'RESERVED', to: 'SETTLED', label: 'Settlement transaction confirmed on Bitcoin', safety: 'Final terminal state' },
      { step: 3, from: 'RESERVED', to: 'OPEN', label: 'Lock timeout expires without broadcast', safety: 'Restores to public pool' },
      { step: 4, from: 'OPEN', to: 'WITHDRAWN', label: 'Seller spends input or publishes withdrawal', safety: 'Immediate invalidation' },
      { step: 5, from: 'OPEN', to: 'REPLACED', label: 'Seller publishes valid successor artifact', safety: 'Points to new order' }
    ]
  },
  {
    id: 'runes-burn-safety',
    title: 'Rune Burn and Cenotaph Safety Path',
    summary: 'Preventing catastrophic accidental burns of Runes balances during transaction composition.',
    actors: ['Composer', 'Runestone Parser', 'Runes Verifier', 'Outputs'],
    steps: [
      { step: 1, from: 'Composer', to: 'Runestone Parser', label: 'Parse OP_RETURN script and decipher Runestone', safety: 'Checks even tags and varints' },
      { step: 2, from: 'Runestone Parser', to: 'Runes Verifier', label: 'Validate edicts against input balances', safety: 'Detects malformed tags or missing inputs' },
      { step: 3, from: 'Runes Verifier', to: 'Composer', label: 'VERDICT: Clean Edict Routing vs CENOTAPH Refusal', safety: 'Rejects cenotaphs that burn balances' },
      { step: 4, from: 'Composer', to: 'Outputs', label: 'Route allocated Runes to explicit output index', safety: 'Zero unassigned balances' }
    ]
  },
  {
    id: 'interop-portable-orders',
    title: 'Interoperability and Portable-Order Distribution',
    summary: 'Distribution of Ordex orders across Nostr relays and OpenOrdex-compatible interfaces.',
    actors: ['Publisher', 'Ordex Gateway', 'Nostr Relay Mesh', 'External Aggregator'],
    steps: [
      { step: 1, from: 'Publisher', to: 'Ordex Gateway', label: 'Publish signed order with proof', safety: 'Verifies BIP-340 / Schnorr' },
      { step: 2, from: 'Ordex Gateway', to: 'Nostr Relay Mesh', label: 'Publish Kind 10008 / 10009 Nostr events', safety: 'Cryptographic event envelope' },
      { step: 3, from: 'Nostr Relay Mesh', to: 'External Aggregator', label: 'Sync portable inventory peer-to-peer', safety: 'Order remains verifiable everywhere' }
    ]
  },
  {
    id: 'safeops-shield',
    title: 'SafeOps Planning and Execution Shield',
    summary: '38-rule invariant checking for UTXO management, consolidations, and fee accelerations.',
    actors: ['Treasury', 'SafeOps Engine', 'Execution Shield', 'Signer'],
    steps: [
      { step: 1, from: 'Treasury', to: 'SafeOps Engine', label: 'Submit raw UTXO consolidation plan', safety: 'Specifies intended outputs' },
      { step: 2, from: 'SafeOps Engine', to: 'Execution Shield', label: 'Run invariant checks (dust, conservation, asset tracking)', safety: 'Fails closed on unknown claims' },
      { step: 3, from: 'Execution Shield', to: 'Signer', label: 'Generate Expected-Transaction Manifest with SHA-256 digest', safety: 'Immutable contract of intent' },
      { step: 4, from: 'Signer', to: 'SafeOps Engine', label: 'Return signed result matching manifest digest exactly', safety: 'Refuses altered scripts or values' }
    ]
  },
  {
    id: 'atomic-swap-settlement',
    title: 'Atomic Swap Settlement Sequence',
    summary: 'Single-transaction dual-settlement between Maker and Taker with no third-party custody.',
    actors: ['Maker', 'Gateway', 'Taker', 'Verifier', 'Bitcoin Network'],
    steps: [
      { step: 1, from: 'Maker', to: 'Gateway', label: 'Publish swap intent with exact outpoint commitment', safety: 'Maker proof included' },
      { step: 2, from: 'Taker', to: 'Gateway', label: 'Submit acceptance plan matching consideration', safety: 'Validates fee split' },
      { step: 3, from: 'Gateway', to: 'Verifier', label: 'Verify atomicity invariant (unclosed sighashes refused)', safety: 'Both parties bound' },
      { step: 4, from: 'Gateway', to: 'Bitcoin Network', label: 'Broadcast single combined settlement transaction', safety: 'Assets exchange simultaneously' }
    ]
  },
  {
    id: 'event-stream-replay',
    title: 'Event Stream, Cursor, and Webhook Delivery',
    summary: 'Cursor-driven resumption, duplicate suppression, and HMAC-SHA256 signature verification.',
    actors: ['Event Bus', 'Checkpoint Store', 'SSE / WebSocket Stream', 'Subscriber', 'Webhook Receiver'],
    steps: [
      { step: 1, from: 'Event Bus', to: 'Checkpoint Store', label: 'Persist event with sequential ID and digest', safety: 'Total order guarantees' },
      { step: 2, from: 'Subscriber', to: 'SSE / WebSocket Stream', label: 'Connect with ?cursor={lastSeenEventId}', safety: 'Replays missed events' },
      { step: 3, from: 'Event Bus', to: 'Webhook Receiver', label: 'POST webhook with X-Ordex-Signature & Timestamp', safety: 'HMAC-SHA256 authenticated' },
      { step: 4, from: 'Webhook Receiver', to: 'Webhook Receiver', label: 'Validate signature locally using shared secret', safety: 'Prevents forged payloads' }
    ]
  },
  {
    id: 'collection-provenance-flow',
    title: 'Collection Manifest and Membership Proof',
    summary: 'Merkle tree construction, BIP-322 creator signature, and client-side verification.',
    actors: ['Collection Creator', 'Manifest Compiler', 'Ordex Registry', 'Client Verifier'],
    steps: [
      { step: 1, from: 'Collection Creator', to: 'Manifest Compiler', label: 'Supply verified item list of inscription IDs', safety: 'Lexicographically sorted' },
      { step: 2, from: 'Manifest Compiler', to: 'Manifest Compiler', label: 'Compute Merkle Root and digest', safety: 'Deterministic tree hash' },
      { step: 3, from: 'Collection Creator', to: 'Ordex Registry', label: 'Publish manifest with BIP-322 creator signature', safety: 'Proves authority' },
      { step: 4, from: 'Client Verifier', to: 'Client Verifier', label: 'Verify item membership proof against published root', safety: 'O(log N) verification' }
    ]
  },
  {
    id: 'counterparty-heritage-flow',
    title: 'Counterparty Heritage Attachment Model',
    summary: 'Binding historical 2014 Counterparty asset balances to modern UTXOs for ord-compatible trading.',
    actors: ['Asset Holder', 'Heritage Coordinator', 'UTXO State', 'Verifier'],
    steps: [
      { step: 1, from: 'Asset Holder', to: 'Heritage Coordinator', label: 'Request attach plan for Counterparty asset ID', safety: 'Reads address balance' },
      { step: 2, from: 'Heritage Coordinator', to: 'UTXO State', label: 'Compose Bitcoin transaction attaching balance to output', safety: 'Ensures sat-flow conservation' },
      { step: 3, from: 'Verifier', to: 'Asset Holder', label: 'Confirm attached UTXO invariant and readiness', safety: 'Refuses unproven inputs' }
    ]
  },
  {
    id: 'cold-signing-roundtrip',
    title: 'Cold-Signing Air-Gapped Round Trip',
    summary: 'Coordinator creates manifest; offline workstation verifies and signs; coordinator broadcasts.',
    actors: ['Online Coordinator', 'Air-Gapped Workstation', 'Protocol Lab (Offline)', 'Hardware Signer'],
    steps: [
      { step: 1, from: 'Online Coordinator', to: 'Air-Gapped Workstation', label: 'Transfer PSBT + Expected Transaction Manifest via QR / USB', safety: 'No live network connection' },
      { step: 2, from: 'Air-Gapped Workstation', to: 'Protocol Lab (Offline)', label: 'Load manifest and PSBT into local worker', safety: 'Inspects all inputs and outputs' },
      { step: 3, from: 'Protocol Lab (Offline)', to: 'Hardware Signer', label: 'Approve signing if all 26 invariants pass', safety: 'Keys never exposed to online PC' },
      { step: 4, from: 'Hardware Signer', to: 'Online Coordinator', label: 'Return signed transaction for re-verification & broadcast', safety: 'Coordinator verifies matching digest' }
    ]
  },
  {
    id: 'evidence-authority-hierarchy',
    title: 'Evidence and Authority Hierarchy',
    summary: 'Distinguishing Publisher Claims, Gateway Observations, Protocol Verifications, and Chain Proofs.',
    actors: ['Deterministic Example', 'Publisher Claim', 'Gateway Observation', 'Protocol Verification', 'Chain Proof'],
    steps: [
      { step: 1, from: 'Deterministic Example', to: 'Deterministic Example', label: 'Level 0: Mock data generated from contract fixtures', safety: 'Zero network or trust' },
      { step: 2, from: 'Publisher Claim', to: 'Publisher Claim', label: 'Level 1: Unverified payload provided by counterparty', safety: 'Subject to verification' },
      { step: 3, from: 'Gateway Observation', to: 'Gateway Observation', label: 'Level 2: Information observed & reported by gateway', safety: 'Gateway-trusted' },
      { step: 4, from: 'Protocol Verification', to: 'Protocol Verification', label: 'Level 3: Verified by Ordex reference rules in Web Worker', safety: 'Cryptographically checked' },
      { step: 5, from: 'Chain Proof', to: 'Chain Proof', label: 'Level 4: Confirmed by Bitcoin consensus & block inclusion', safety: 'Highest cryptographic proof' }
    ]
  }
];

// 10. Generate Assistant Corpus Chunks
const corpusChunks = [];
let chunkId = 0;

// Chunk specifications
for (const spec of specs) {
  const content = fs.readFileSync(path.join(specDir, spec.file), 'utf8');
  const sections = content.split(/\n(?=##?\s)/);
  for (const sec of sections) {
    const lines = sec.trim().split('\n');
    const title = lines[0].replace(/^#+\s*/, '');
    const body = lines.slice(1).join('\n').trim();
    if (body.length < 20) continue;

    chunkId++;
    const digest = crypto.createHash('sha256').update(sec, 'utf8').digest('hex').slice(0, 16);
    corpusChunks.push({
      id: `spec-${spec.id}-${chunkId}`,
      sourcePath: `spec/${spec.file}`,
      pointer: `heading:${title}`,
      product: 'Protocol Specification',
      protocolVersion: '1.2',
      contentType: 'specification',
      title: `${spec.title} - ${title}`,
      content: body.slice(0, 1200),
      digest,
      docUrl: `/reference/specifications/${spec.id}`
    });
  }
}

// Chunk OpenAPI operations
for (const op of operations) {
  chunkId++;
  const text = `${op.method} ${op.path} (${op.operationId}): ${op.summary}. ${op.description}. Evidence level: ${op.authorityLevel}. Tag: ${op.tag}.`;
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  corpusChunks.push({
    id: `api-op-${op.operationId}`,
    sourcePath: 'spec/openapi.json',
    pointer: op.jsonPointer,
    product: op.tag,
    protocolVersion: '1.2',
    contentType: 'api-operation',
    title: `${op.method} ${op.path} (${op.operationId})`,
    content: text,
    digest,
    docUrl: `/reference/api/#${op.operationId}`
  });
}

// Chunk Refusal codes
for (const ref of refusalList) {
  chunkId++;
  const text = `Refusal Code: ${ref.code}. Category: ${ref.category}. Verifiers: ${ref.verifiers.join(', ')}. Explanation: ${ref.explanation}`;
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  corpusChunks.push({
    id: `ref-${ref.code}`,
    sourcePath: `verifier/${ref.verifiers[0] || 'purchase'}.js`,
    pointer: `refusal:${ref.code}`,
    product: 'refusals',
    protocolVersion: '1.2',
    contentType: 'refusal-code',
    title: `Refusal: ${ref.code}`,
    content: `${ref.explanation} Category: ${ref.category}. Remediation: ${ref.remediation}`,
    digest: 'sha256:refusal',
    docUrl: `/reference/refusal-codes/#${ref.code}`
  });
}

// Helper to generate schema examples
function generateSchemaExample(schema, doc) {
  if (!schema) return {};
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, doc);
    return generateSchemaExample(resolved, doc);
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'string') {
    if (schema.format === 'date-time') return '2026-09-02T16:00:00Z';
    if (schema.pattern && schema.pattern.includes('^[0-9a-f]{64}$')) return 'a0b1c2d3e4f5061728394a5b6c7d8e9f0123456789abcdef0123456789abcdef';
    return 'example-string';
  }
  if (schema.type === 'integer' || schema.type === 'number') return 10000;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'array') {
    return [generateSchemaExample(schema.items || {}, doc)];
  }
  if (schema.type === 'object' || schema.properties) {
    const obj = {};
    for (const [propName, propSchema] of Object.entries(schema.properties || {})) {
      obj[propName] = generateSchemaExample(propSchema, doc);
    }
    return obj;
  }
  return {};
}

function resolveRef(ref, doc) {
  const parts = ref.replace(/^#\//, '').split('/');
  let curr = doc;
  for (const part of parts) {
    curr = curr?.[part];
  }
  return curr || {};
}

// 10. Diagnostics Registry Generation for Failure Navigator
const diagnostics = refusalList.map(r => {
  const family = r.verifiers[0] || 'purchase';
  let versions = ['1.0', '1.1', '1.2'];
  if (['offers', 'safeops', 'swaps', 'runes'].includes(family)) {
    versions = ['1.1', '1.2'];
  } else if (['collection-manifest', 'counterparty-asset', 'offline-signing', 'events'].includes(family)) {
    versions = ['1.2'];
  }

  const destinationProduct = family === 'purchase' ? 'sandbox' : family === 'doctor' ? 'doctor' : 'lab';

  return {
    id: `diag-${r.code.toLowerCase().replace(/_/g, '-')}`,
    exactCodes: [r.code],
    family,
    lifecyclePhases: ['composition', 'preflight', 'verification'],
    supportedProtocolVersions: versions,
    summary: r.explanation,
    invariant: `Rule ${r.code}: All parameters must satisfy ${family} invariant requirements before signing.`,
    likelyCauses: [
      { cause: r.explanation, probability: 'High' },
      { cause: 'Client state out of sync with current UTXO set', probability: 'Medium' }
    ],
    evidenceRequirements: [
      { evidenceType: 'PSBT binary or transaction hex', required: true },
      { evidenceType: 'Offered outpoint prevout value and script', required: true }
    ],
    resolutionSteps: [
      { step: 1, action: r.remediation },
      { step: 2, action: 'Inspect field values in Artifact Lens' },
      { step: 3, action: 'Execute reference verifier in Protocol Lab' }
    ],
    reproducerFactoryId: `reproducer-${r.code.toLowerCase().replace(/_/g, '-')}`,
    destinationProduct,
    sourceRefs: [
      { title: `${family} Verifier`, path: `verifier/${family}.js`, type: 'verifier' }
    ]
  };
});

// Write out all files
fs.writeFileSync(path.join(dataOutDir, 'operations.json'), JSON.stringify(operations, null, 2));
fs.writeFileSync(path.join(dataOutDir, 'channels.json'), JSON.stringify(channels, null, 2));
fs.writeFileSync(path.join(dataOutDir, 'vectorFamilies.json'), JSON.stringify(vectorFamilies, null, 2));
fs.writeFileSync(path.join(dataOutDir, 'allVectors.json'), JSON.stringify(allVectorsList, null, 2));
fs.writeFileSync(path.join(dataOutDir, 'refusals.json'), JSON.stringify(refusalList, null, 2));
fs.writeFileSync(path.join(dataOutDir, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
fs.writeFileSync(path.join(dataOutDir, 'specs.json'), JSON.stringify(specs, null, 2));
fs.writeFileSync(path.join(dataOutDir, 'versions.json'), JSON.stringify(versions, null, 2));
fs.writeFileSync(path.join(dataOutDir, 'compatibility.json'), JSON.stringify(compatibilityMatrix, null, 2));
fs.writeFileSync(path.join(dataOutDir, 'wizards.json'), JSON.stringify(wizards, null, 2));
fs.writeFileSync(path.join(dataOutDir, 'atlas.json'), JSON.stringify(atlasDiagrams, null, 2));
fs.writeFileSync(path.join(dataOutDir, 'corpus.json'), JSON.stringify(corpusChunks, null, 2));

console.log('Successfully generated all structured documentation data in site/src/data:');
console.log(`- ${operations.length} OpenAPI operations`);
console.log(`- ${channels.length} AsyncAPI channels`);
console.log(`- ${Object.keys(vectorFamilies).length} vector families (${allVectorsList.length} cases)`);
console.log(`- ${refusalList.length} refusal codes`);
console.log(`- ${diagnostics.length} diagnostic rules`);
console.log(`- ${specs.length} specifications`);
console.log(`- ${wizards.length} guided wizards`);
console.log(`- ${atlasDiagrams.length} Visual Protocol Atlas diagrams`);
console.log(`- ${corpusChunks.length} Ask Ordex corpus chunks`);

