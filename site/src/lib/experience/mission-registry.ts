/**
 * Ordex Launchpad Mission Registry
 * 
 * Defines the 9 authoritative missions for the Ordex Developer Experience.
 * Every mission strictly adheres to the standard 8-stage lifecycle:
 * 1. understand -> 2. prepare -> 3. simulate -> 4. inspect -> 5. verify -> 6. integrate -> 7. validate -> 8. finish
 */

export type StageId =
  | 'understand'
  | 'prepare'
  | 'simulate'
  | 'inspect'
  | 'verify'
  | 'integrate'
  | 'validate'
  | 'finish';

export interface MissionPrerequisite {
  id: string;
  label: string;
  satisfied: boolean;
  helpLink?: string;
}

export interface MissionStageDefinition {
  id: StageId;
  title: string;
  description: string;
  toolRoute?: string;
  toolActionLabel?: string;
  summaryTemplate: string;
}

export interface MissionCompletionCriteria {
  id: string;
  description: string;
  evidenceClass: 'Chain proof' | 'Protocol verification' | 'Gateway observation' | 'Publisher claim' | 'Deterministic example';
  verifierRef?: string;
}

export interface SourceReference {
  title: string;
  path: string;
  pointer?: string;
  type: 'spec' | 'openapi' | 'asyncapi' | 'verifier' | 'guide';
}

export interface MissionDefinition {
  id: string;
  title: string;
  plainEnglishGoal: string;
  category: string;
  roles: string[];
  supportedProtocolVersions: string[];
  prerequisites: MissionPrerequisite[];
  stages: MissionStageDefinition[];
  completionCriteria: MissionCompletionCriteria[];
  sourceRefs: SourceReference[];
}

function createStandardStages(cfg: {
  understandDesc: string;
  prepareDesc: string;
  prepareRoute: string;
  prepareLabel: string;
  simulateDesc: string;
  simulateLabel: string;
  inspectDesc: string;
  inspectLabel: string;
  verifyDesc: string;
  verifyLabel: string;
  integrateDesc: string;
  integrateLabel: string;
  validateDesc: string;
  validateLabel: string;
  finishDesc: string;
}): MissionStageDefinition[] {
  return [
    {
      id: 'understand',
      title: 'Understand Mechanics',
      description: cfg.understandDesc,
      toolRoute: '/learn',
      toolActionLabel: 'Review Guide',
      summaryTemplate: 'Protocol invariants and non-custodial boundaries reviewed.'
    },
    {
      id: 'prepare',
      title: 'Prepare Parameters',
      description: cfg.prepareDesc,
      toolRoute: cfg.prepareRoute,
      toolActionLabel: cfg.prepareLabel,
      summaryTemplate: 'Prerequisites gathered and parameters configured.'
    },
    {
      id: 'simulate',
      title: 'Simulate Execution',
      description: cfg.simulateDesc,
      toolRoute: '/sandbox',
      toolActionLabel: cfg.simulateLabel,
      summaryTemplate: 'Deterministic multi-actor simulation completed.'
    },
    {
      id: 'inspect',
      title: 'Inspect Artifacts',
      description: cfg.inspectDesc,
      toolRoute: '/inspect',
      toolActionLabel: cfg.inspectLabel,
      summaryTemplate: 'Transaction artifacts and sat-flow inspected in Artifact Lens.'
    },
    {
      id: 'verify',
      title: 'Run Verifier',
      description: cfg.verifyDesc,
      toolRoute: '/lab',
      toolActionLabel: cfg.verifyLabel,
      summaryTemplate: 'Authoritative reference verifier executed with PASS.'
    },
    {
      id: 'integrate',
      title: 'Generate Integration Code',
      description: cfg.integrateDesc,
      toolRoute: '/kits',
      toolActionLabel: cfg.integrateLabel,
      summaryTemplate: 'Integration boilerplate generated with pinned SDK.'
    },
    {
      id: 'validate',
      title: 'Validate Conformance',
      description: cfg.validateDesc,
      toolRoute: '/verify',
      toolActionLabel: cfg.validateLabel,
      summaryTemplate: 'Conformance vectors and compatibility checks verified.'
    },
    {
      id: 'finish',
      title: 'Mission Complete',
      description: cfg.finishDesc,
      toolRoute: '/workspace',
      toolActionLabel: 'Complete Mission',
      summaryTemplate: 'All completion criteria satisfied with verifiable proof.'
    }
  ];
}

export const MISSIONS: MissionDefinition[] = [
  // 1. integrate-public-asks
  {
    id: 'integrate-public-asks',
    title: 'Integrate Public Asks',
    plainEnglishGoal: 'Create, sign, and publish portable public asks (listings) with SIGHASH_SINGLE | ANYONECANPAY, allowing anyone to purchase on-chain.',
    category: 'Orders & Marketplace',
    roles: ['Marketplace Integrator', 'Seller Wallet'],
    supportedProtocolVersions: ['1.0', '1.1', '1.2'],
    prerequisites: [
      { id: 'prereq-seller-asset', label: 'Confirmed digital asset outpoint (Inscription or Rune)', satisfied: true },
      { id: 'prereq-seller-payment-addr', label: 'Payment address receiving proceeds', satisfied: true }
    ],
    stages: createStandardStages({
      understandDesc: 'Learn how SIGHASH_SINGLE enables trustless, portable listings without custodial escrow.',
      prepareDesc: 'Configure price, payment address, and asset outpoint via order builder.',
      prepareRoute: '/build/playground',
      prepareLabel: 'Build Order',
      simulateDesc: 'Step through ask.publish-and-settle.success scenario in Transaction Sandbox.',
      simulateLabel: 'Open Sandbox',
      inspectDesc: 'Inspect unsigned and signed PSBT structure and byte-level fields in Artifact Lens.',
      inspectLabel: 'Inspect in Lens',
      verifyDesc: 'Execute the reference purchase verifier to guarantee sat-flow and payment invariants.',
      verifyLabel: 'Run Verifier',
      integrateDesc: 'Generate production-ready TypeScript code using @bitcoinuniverse/ordex-sdk.',
      integrateLabel: 'Download Kit',
      validateDesc: 'Confirm all checked-in test vectors for public asks pass.',
      validateLabel: 'Run Conformance',
      finishDesc: 'Public ask integration verified and ready for production deployment.'
    }),
    completionCriteria: [
      { id: 'crit-psbt-valid', description: 'PSBT passes structural binary parsing', evidenceClass: 'Deterministic example' },
      { id: 'crit-verifier-pass', description: 'Purchase reference verifier passes invariants 1 & 2', evidenceClass: 'Protocol verification', verifierRef: 'purchase' },
      { id: 'crit-order-published', description: 'Order registered in gateway catalog', evidenceClass: 'Gateway observation' }
    ],
    sourceRefs: [
      { title: 'Public Asks Specification', path: 'spec/purchase.md', type: 'spec' },
      { title: 'Reference Purchase Verifier', path: 'verifier/purchase.js', type: 'verifier' }
    ]
  },

  // 2. complete-single-or-batch-purchase
  {
    id: 'complete-single-or-batch-purchase',
    title: 'Complete Single or Batch Purchase',
    plainEnglishGoal: 'Fund, preflight, verify, and settle one or multiple public asks in a single atomic Bitcoin transaction.',
    category: 'Orders & Marketplace',
    roles: ['Marketplace Integrator', 'Buyer Wallet'],
    supportedProtocolVersions: ['1.0', '1.1', '1.2'],
    prerequisites: [
      { id: 'prereq-open-asks', label: 'One or more OPEN public asks available', satisfied: true },
      { id: 'prereq-buyer-utxo', label: 'Buyer funding UTXOs for price and miner fees', satisfied: true }
    ],
    stages: createStandardStages({
      understandDesc: 'Learn how atomic purchases combine seller inputs and buyer funding into one unspendable-if-altered tx.',
      prepareDesc: 'Fetch quote and preflight lock from the Ordex gateway.',
      prepareRoute: '/build/playground',
      prepareLabel: 'Request Quote',
      simulateDesc: 'Step through batch purchase scenario with multiple seller payouts in Sandbox.',
      simulateLabel: 'Simulate Batch',
      inspectDesc: 'Examine value conservation and asset output placement in Artifact Lens.',
      inspectLabel: 'Inspect Sat Flow',
      verifyDesc: 'Run reference purchase verifier to ensure no shortfall and correct output indices.',
      verifyLabel: 'Run Verifier',
      integrateDesc: 'Obtain boilerplate for wallet signing and broadcast.',
      integrateLabel: 'View Code',
      validateDesc: 'Execute batch purchase conformance vectors.',
      validateLabel: 'Run Vectors',
      finishDesc: 'Purchase flow verified and ready for user signature.'
    }),
    completionCriteria: [
      { id: 'crit-batch-balance', description: 'Inputs equal outputs plus miner fees exactly', evidenceClass: 'Protocol verification', verifierRef: 'purchase' },
      { id: 'crit-no-shortfall', description: 'Zero satoshi shortfall across all asks', evidenceClass: 'Protocol verification', verifierRef: 'purchase' }
    ],
    sourceRefs: [
      { title: 'Batch Purchase Specification', path: 'spec/batch-purchase.md', type: 'spec' },
      { title: 'Reference Purchase Verifier', path: 'verifier/purchase.js', type: 'verifier' }
    ]
  },

  // 3. integrate-buyer-funded-offers
  {
    id: 'integrate-buyer-funded-offers',
    title: 'Integrate Buyer-Funded Offers',
    plainEnglishGoal: 'Lock funds in a Taproot 2-of-2 multisig script, allowing seller acceptance or unilateral timelocked recovery.',
    category: 'Offers',
    roles: ['Marketplace Integrator', 'Trader'],
    supportedProtocolVersions: ['1.1', '1.2'],
    prerequisites: [
      { id: 'prereq-taproot', label: 'Taproot capable wallet or signer', satisfied: true }
    ],
    stages: createStandardStages({
      understandDesc: 'Examine Taproot script tree containing acceptance and CLTV recovery leaves.',
      prepareDesc: 'Set item/collection scope, priceSats, and expiryHeight.',
      prepareRoute: '/build/wizards',
      prepareLabel: 'Configure Offer',
      simulateDesc: 'Test both successful seller acceptance and post-expiry recovery in Sandbox.',
      simulateLabel: 'Run Offer Scenarios',
      inspectDesc: 'Verify leaf script construction and control block in Artifact Lens.',
      inspectLabel: 'Inspect Taproot Script',
      verifyDesc: 'Execute verifier/offers.js against terms hash and acceptance spend.',
      verifyLabel: 'Verify Offer Spend',
      integrateDesc: 'Generate client integration for creating and accepting offers.',
      integrateLabel: 'Get Offer Code',
      validateDesc: 'Execute all 18 Offers v1 conformance vectors.',
      validateLabel: 'Run Conformance',
      finishDesc: 'Taproot offer lifecycle fully tested and verified.'
    }),
    completionCriteria: [
      { id: 'crit-terms-hash', description: 'Terms hash matches deterministic sorted JSON', evidenceClass: 'Protocol verification', verifierRef: 'offers' },
      { id: 'crit-cltv-valid', description: 'Recovery path enforces CHECKLOCKTIMEVERIFY', evidenceClass: 'Chain proof' }
    ],
    sourceRefs: [
      { title: 'Offers v1 Specification', path: 'spec/offers-v1.md', type: 'spec' },
      { title: 'Offers Verifier', path: 'verifier/offers.js', type: 'verifier' }
    ]
  },

  // 4. protect-wallet-signing
  {
    id: 'protect-wallet-signing',
    title: 'Protect Wallet Signing Flow',
    plainEnglishGoal: 'Enforce pre-flight invariants and mutation detection to prevent malicious or accidental wallet signing exploits.',
    category: 'Wallet & Security',
    roles: ['Wallet Developer', 'Security Officer'],
    supportedProtocolVersions: ['1.0', '1.1', '1.2'],
    prerequisites: [
      { id: 'prereq-verifier-worker', label: 'Local verifier Web Worker initialized', satisfied: true }
    ],
    stages: createStandardStages({
      understandDesc: 'Review dangerous mutations: output reordering, sighash downgrades, fee inflation, and missing assets.',
      prepareDesc: 'Configure pre-flight signing policy and allowed sighash modes.',
      prepareRoute: '/build/wizards',
      prepareLabel: 'Define Policy',
      simulateDesc: 'Execute ask.wallet-output-reorder.refusal scenario in Sandbox.',
      simulateLabel: 'Simulate Attack',
      inspectDesc: 'Load before-and-after transaction artifacts in Artifact Lens to detect dangerous mutations.',
      inspectLabel: 'Open Mutation Lab',
      verifyDesc: 'Confirm signed PSBT matches the expected transaction manifest byte-for-byte.',
      verifyLabel: 'Run Verifier',
      integrateDesc: 'Embed pre-flight execution shield into wallet signing loop.',
      integrateLabel: 'Get Shield Code',
      validateDesc: 'Validate SafeOps consolidation and offline signing test vectors.',
      validateLabel: 'Run Vectors',
      finishDesc: 'Wallet signing protection fully established and active.'
    }),
    completionCriteria: [
      { id: 'crit-mutation-detected', description: 'Reordered outputs or altered scripts flagged as DANGEROUS', evidenceClass: 'Protocol verification' },
      { id: 'crit-manifest-match', description: 'Signed bytes strictly match the expected transaction manifest', evidenceClass: 'Protocol verification', verifierRef: 'offline-signing' }
    ],
    sourceRefs: [
      { title: 'Security Model & Wallet Protection', path: 'spec/security-model.md', type: 'spec' },
      { title: 'Offline Signing Verifier', path: 'verifier/offline-signing.js', type: 'verifier' }
    ]
  },

  // 5. integrate-atomic-swaps
  {
    id: 'integrate-atomic-swaps',
    title: 'Integrate Atomic Swaps',
    plainEnglishGoal: 'Execute direct peer-to-peer OTC swaps (Asset for BTC or Asset for Asset) settling in a single atomic transaction.',
    category: 'Swaps & OTC',
    roles: ['Marketplace Integrator', 'OTC Desk'],
    supportedProtocolVersions: ['1.1', '1.2'],
    prerequisites: [
      { id: 'prereq-swap-maker', label: 'Maker asset outpoint and requested consideration defined', satisfied: true }
    ],
    stages: createStandardStages({
      understandDesc: 'Learn how maker intent and taker acceptance combine without intermediate escrow.',
      prepareDesc: 'Create maker intent committed by Schnorr signature.',
      prepareRoute: '/build/wizards',
      prepareLabel: 'Configure Intent',
      simulateDesc: 'Execute swap.atomic-settlement.success in Sandbox.',
      simulateLabel: 'Simulate Swap',
      inspectDesc: 'Inspect atomic swap transaction shape and sat-flow balance in Lens.',
      inspectLabel: 'Inspect Swap Tx',
      verifyDesc: 'Confirm verifier/swaps.js accepts the combined transaction.',
      verifyLabel: 'Run Swap Verifier',
      integrateDesc: 'Generate OTC atomic swap settlement client code.',
      integrateLabel: 'Download Kit',
      validateDesc: 'Execute swaps conformance test suite.',
      validateLabel: 'Run Vectors',
      finishDesc: 'Bilateral atomic swaps enabled and verified.'
    }),
    completionCriteria: [
      { id: 'crit-atomic-pass', description: 'Single transaction settles both maker and taker obligations', evidenceClass: 'Protocol verification', verifierRef: 'swaps' }
    ],
    sourceRefs: [
      { title: 'Atomic Swaps Specification', path: 'spec/swaps.md', type: 'spec' },
      { title: 'Swaps Verifier', path: 'verifier/swaps.js', type: 'verifier' }
    ]
  },

  // 6. operate-gateway-and-events
  {
    id: 'operate-gateway-and-events',
    title: 'Operate Gateway and Events',
    plainEnglishGoal: 'Deploy an Ordex gateway catalog, subscribe to SSE/WebSocket event streams, and configure signed webhooks.',
    category: 'Operations & Infrastructure',
    roles: ['Gateway Operator', 'DevOps Engineer'],
    supportedProtocolVersions: ['1.0', '1.1', '1.2'],
    prerequisites: [
      { id: 'prereq-gateway-url', label: 'Ordex gateway origin or test environment', satisfied: true }
    ],
    stages: createStandardStages({
      understandDesc: 'Review stateless catalog endpoints, event cursors, and webhook signatures.',
      prepareDesc: 'Configure gateway URLs, CORS policies, and HMAC secrets.',
      prepareRoute: '/operate',
      prepareLabel: 'Configure Gateway',
      simulateDesc: 'Subscribe to real-time events and verify HMAC-SHA256 webhook signatures.',
      simulateLabel: 'Open Event Playground',
      inspectDesc: 'Inspect signed event envelopes and cursor headers.',
      inspectLabel: 'Inspect Envelopes',
      verifyDesc: 'Verify event delivery with verifier/events.js.',
      verifyLabel: 'Verify Events',
      integrateDesc: 'Generate webhook receiver server boilerplate.',
      integrateLabel: 'Get Receiver Code',
      validateDesc: 'Execute Gateway Doctor 17-step compatibility diagnosis.',
      validateLabel: 'Run Gateway Doctor',
      finishDesc: 'Gateway verified healthy and event streaming active.'
    }),
    completionCriteria: [
      { id: 'crit-gateway-doctor', description: 'Gateway Doctor reports zero critical health or CORS errors', evidenceClass: 'Gateway observation' },
      { id: 'crit-webhook-hmac', description: 'Webhook delivery passes HMAC-SHA256 signature verification', evidenceClass: 'Gateway observation', verifierRef: 'events' }
    ],
    sourceRefs: [
      { title: 'Gateway Operations Guide', path: 'docs/gateway-guide.md', type: 'spec' },
      { title: 'Events Verifier', path: 'verifier/events.js', type: 'verifier' }
    ]
  },

  // 7. verify-collection-and-attached-assets
  {
    id: 'verify-collection-and-attached-assets',
    title: 'Verify Collection and Attached Assets',
    plainEnglishGoal: 'Prove authentic collection provenance using BIP-322 Merkle roots, and track Counterparty heritage asset attachments.',
    category: 'Provenance & Heritage',
    roles: ['Creator', 'Curator', 'Marketplace'],
    supportedProtocolVersions: ['1.2'],
    prerequisites: [
      { id: 'prereq-collection-root', label: 'Collection manifest with creator signature or Counterparty record', satisfied: true }
    ],
    stages: createStandardStages({
      understandDesc: 'Understand O(log N) Merkle membership proofs and Counterparty sat-flow preservation.',
      prepareDesc: 'Load collection root and BIP-322 creator signature.',
      prepareRoute: '/build/wizards',
      prepareLabel: 'Load Manifest',
      simulateDesc: 'Run collection.membership.success in Sandbox.',
      simulateLabel: 'Run Sandbox',
      inspectDesc: 'Inspect Merkle proof siblings and sat ranges in Artifact Lens.',
      inspectLabel: 'Inspect Proof',
      verifyDesc: 'Execute verifiers for collection manifest and Counterparty attached UTXOs.',
      verifyLabel: 'Run Verifiers',
      integrateDesc: 'Embed provenance verification into catalog indexing pipeline.',
      integrateLabel: 'Get Indexer Code',
      validateDesc: 'Verify collection manifest test vectors.',
      validateLabel: 'Run Vectors',
      finishDesc: 'Cryptographic provenance and asset attachment verified.'
    }),
    completionCriteria: [
      { id: 'crit-merkle-proof', description: 'Item membership proof validates against creator root', evidenceClass: 'Chain proof', verifierRef: 'collection-manifest' },
      { id: 'crit-counterparty-bound', description: 'Attached UTXO preserves historical asset identity across sat flow', evidenceClass: 'Chain proof', verifierRef: 'counterparty-asset' }
    ],
    sourceRefs: [
      { title: 'Collection Provenance Spec', path: 'spec/provenance.md', type: 'spec' },
      { title: 'Collection Manifest Verifier', path: 'verifier/collection-manifest.js', type: 'verifier' },
      { title: 'Counterparty Asset Verifier', path: 'verifier/counterparty-asset.js', type: 'verifier' }
    ]
  },

  // 8. diagnose-protocol-failure
  {
    id: 'diagnose-protocol-failure',
    title: 'Diagnose Protocol Failure',
    plainEnglishGoal: 'Investigate and resolve transaction refusals, verifier rejections, or gateway error responses with ordered recovery steps.',
    category: 'Diagnostics',
    roles: ['Developer', 'Operator', 'Support'],
    supportedProtocolVersions: ['1.0', '1.1', '1.2'],
    prerequisites: [
      { id: 'prereq-error-payload', label: 'Refusal code, verifier output, or error log available', satisfied: true }
    ],
    stages: createStandardStages({
      understandDesc: 'Paste refusal code or error JSON for automated deterministic diagnosis.',
      prepareDesc: 'Collect raw error payload, HTTP headers, or verifier result.',
      prepareRoute: '/diagnose',
      prepareLabel: 'Triage Error',
      simulateDesc: 'Create a deterministic reproducer in Protocol Lab or Transaction Sandbox.',
      simulateLabel: 'Open Reproducer',
      inspectDesc: 'Examine exact invariant violated, missing evidence, and unsafe shortcuts to avoid.',
      inspectLabel: 'Review Cause Tree',
      verifyDesc: 'Run reference verifier against reproducer to confirm failure.',
      verifyLabel: 'Verify Failure',
      integrateDesc: 'Generate programmatic error handling code.',
      integrateLabel: 'Get Error Code',
      validateDesc: 'Check error envelope against authoritative OpenAPI schema.',
      validateLabel: 'Validate Schema',
      finishDesc: 'Executed remediation sequence and confirmed fix.'
    }),
    completionCriteria: [
      { id: 'crit-cause-identified', description: 'Exact refusal mapped to source invariant and recovery steps', evidenceClass: 'Protocol verification' }
    ],
    sourceRefs: [
      { title: 'Refusal Codes Directory', path: 'site/src/data/refusals.json', type: 'openapi' }
    ]
  },

  // 9. perform-security-review
  {
    id: 'perform-security-review',
    title: 'Perform Protocol Security Review',
    plainEnglishGoal: 'Audit application architecture against Ordex trust boundaries, fail-closed verifiers, and air-gapped cold storage standards.',
    category: 'Security & Audit',
    roles: ['Security Auditor', 'Architect'],
    supportedProtocolVersions: ['1.0', '1.1', '1.2'],
    prerequisites: [
      { id: 'prereq-audit-scope', label: 'Application integration architecture defined', satisfied: true }
    ],
    stages: createStandardStages({
      understandDesc: 'Inspect trust boundaries between browser workers, gateways, indexers, and nodes.',
      prepareDesc: 'Define audit scope and inspect architecture models.',
      prepareRoute: '/atlas',
      prepareLabel: 'Inspect Atlas',
      simulateDesc: 'Test edge-case mutation and failure injection scenarios.',
      simulateLabel: 'Run Sandbox',
      inspectDesc: 'Verify all 9 verifier families fail closed when evidence is unknown or ambiguous.',
      inspectLabel: 'Inspect Verifiers',
      verifyDesc: 'Run offline signing and SafeOps invariant verifiers.',
      verifyLabel: 'Run Verifiers',
      integrateDesc: 'Review signing policies and key isolation documentation.',
      integrateLabel: 'Review Policies',
      validateDesc: 'Run 151 checked-in conformance vectors across all protocol features.',
      validateLabel: 'Run Conformance Vectors',
      finishDesc: 'Security review report generated and exported.'
    }),
    completionCriteria: [
      { id: 'crit-audit-failclosed', description: 'All verifiers demonstrate strict fail-closed behavior on missing evidence', evidenceClass: 'Protocol verification' }
    ],
    sourceRefs: [
      { title: 'Security Model Specification', path: 'spec/security-model.md', type: 'spec' }
    ]
  }
];

export function getMissionById(id: string): MissionDefinition | undefined {
  return MISSIONS.find(m => m.id === id);
}

export function getMissionsByRole(role: string): MissionDefinition[] {
  return MISSIONS.filter(m => m.roles.includes(role));
}

export function getMissionsByVersion(version: string): MissionDefinition[] {
  return MISSIONS.filter(m => m.supportedProtocolVersions.includes(version));
}
