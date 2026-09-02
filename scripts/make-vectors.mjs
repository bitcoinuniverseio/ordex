// Regenerates the v1.2 conformance vector files. Run from the repo root:
//   node scripts/make-vectors.mjs
// The vector files are committed; this script exists so fixture digests and
// Merkle roots are recomputed by the same code the verifiers use instead of
// being maintained by hand.

import { writeFileSync } from 'node:fs';

import {
  SAFEOPS_PLAN_SCHEMA,
  SAFEOPS_SIGNED_RESULT_SCHEMA,
  safeopsPlanDigest,
} from '../verifier/safeops.js';
import { SWAP_INTENT_SCHEMA, SWAP_ACCEPTANCE_SCHEMA, swapIntentDigest } from '../verifier/swaps.js';
import { signWebhookDelivery } from '../verifier/events.js';
import {
  COLLECTION_MANIFEST_SCHEMA,
  COLLECTION_MANIFEST_REVOCATION_SCHEMA,
  membershipRoot,
  collectionManifestDigest,
  collectionRevocationDigest,
  buildMembershipProof,
} from '../verifier/collection-manifest.js';
import { COUNTERPARTY_UTXO_ASSET_SCHEMA } from '../verifier/counterparty-asset.js';
import {
  EXPECTED_TRANSACTION_MANIFEST_SCHEMA,
  OFFLINE_SIGNING_SESSION_SCHEMA,
  expectedTransactionDigest,
} from '../verifier/offline-signing.js';

const OUTPOINT_A = { txid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', vout: 0 };
const OUTPOINT_B = { txid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', vout: 1 };
const OUTPOINT_C = { txid: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', vout: 2 };
const OUTPOINT_D = { txid: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', vout: 0 };
const SCRIPT_P2TR = '5120aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SCRIPT_P2WPKH = '0014bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const INSCRIPTION = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeei0';
const BLOCK_HASH = '0000000000000000000111111111111111111111111111111111111111111112';
const LEDGER_HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const sats = (n) => String(n);

function basePlan(overrides = {}) {
  const plan = {
    schema: SAFEOPS_PLAN_SCHEMA,
    protocolVersion: '1.2',
    network: 'mainnet',
    operationKind: 'BTC_BATCH_SEND',
    createdAtHeight: 900000,
    expiryHeight: 900010,
    checkpoint: { height: 900000, blockHash: BLOCK_HASH },
    inputs: [
      { outpoint: OUTPOINT_A, valueSats: '50000', inventory: { examined: true } },
      { outpoint: OUTPOINT_B, valueSats: '60000', inventory: { examined: true } },
    ],
    outputs: [
      { scriptHex: SCRIPT_P2WPKH, valueSats: '10000', role: 'recipient' },
      { scriptHex: SCRIPT_P2TR, valueSats: '20000', role: 'recipient' },
      { scriptHex: SCRIPT_P2WPKH, valueSats: '79400', role: 'change' },
    ],
    assetTransitions: [],
    fee: { feeSats: '600', maxFeeSats: '2000', feeRateSatsPerVb: '12' },
    signing: { requiredIndexes: [0, 1], sighashType: 'DEFAULT' },
    findings: [],
    ...overrides,
  };
  plan.digest = safeopsPlanDigest(plan);
  return plan;
}

function ordinalPlan(overrides = {}) {
  const inventory = {
    examined: true,
    inscriptions: [{ inscriptionId: INSCRIPTION, satpoint: `${OUTPOINT_A.txid}:${OUTPOINT_A.vout}:0` }],
  };
  return basePlan({
    operationKind: 'ORDINAL_BATCH_TRANSFER',
    inputs: [
      { outpoint: OUTPOINT_A, valueSats: '50000', inventory },
      { outpoint: OUTPOINT_B, valueSats: '60000', inventory: { examined: true } },
    ],
    outputs: [
      { scriptHex: SCRIPT_P2TR, valueSats: '10000', role: 'recipient' },
      { scriptHex: SCRIPT_P2WPKH, valueSats: '99400', role: 'change' },
    ],
    assetTransitions: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput: 0 }],
    ...overrides,
  });
}

function signedResultFor(plan, mutate) {
  const signed = {
    schema: SAFEOPS_SIGNED_RESULT_SCHEMA,
    planDigest: plan.digest,
    tx: {
      inputs: plan.inputs.map((input) => ({
        txid: input.outpoint.txid,
        vout: input.outpoint.vout,
        valueSats: input.valueSats,
        signaturePresent: true,
        sighashType: plan.signing.sighashType,
      })),
      outputs: plan.outputs.map((output) => ({ scriptHex: output.scriptHex, valueSats: output.valueSats })),
    },
  };
  if (mutate) mutate(signed);
  return signed;
}

function baseIntent(overrides = {}) {
  const intent = {
    schema: SWAP_INTENT_SCHEMA,
    protocolVersion: '1.2',
    network: 'mainnet',
    visibility: 'PUBLIC',
    makerReceiveScriptHex: SCRIPT_P2WPKH,
    gives: [{ assetType: 'BTC', outpoint: OUTPOINT_A, quantitySats: '100000' }],
    requires: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, minQuantitySats: '80000' }],
    maxMakerFeeSats: '1000',
    expiryHeight: 900100,
    nonce: 'nonce-12345678',
    createdAtHeight: 900000,
    checkpoint: { height: 900000, blockHash: BLOCK_HASH },
    adapterVersions: [{ protocol: 'ordinals', version: '1.2' }],
    ...overrides,
  };
  intent.digest = swapIntentDigest(intent);
  intent.makerIdentityProof = overrides.makerIdentityProof === undefined
    ? { kind: 'bip322', address: 'bc1qexampleaddress0000000000000000000000000000', signature: 'MEUCIQ==' }
    : overrides.makerIdentityProof;
  return intent;
}

const TAKER_ORDINAL_INPUT = { outpoint: OUTPOINT_B, party: 'taker', valueSats: '10000', assets: [{ assetType: 'ORDINAL', assetId: INSCRIPTION }] };
const MAKER_BTC_INPUT = (intent) => ({
  outpoint: intent.gives[0].outpoint,
  party: 'maker',
  valueSats: intent.gives[0].quantitySats,
  assets: intent.gives.map((g) => ({ assetType: g.assetType, assetId: g.assetId })),
});
const SWAP_OUTPUTS = (intent, takerChangeSats) => [
  { scriptHex: SCRIPT_P2TR, valueSats: '10000', role: 'takerAsset' },
  { scriptHex: intent.makerReceiveScriptHex, valueSats: '80000', role: 'makerConsideration' },
  { scriptHex: SCRIPT_P2TR, valueSats: takerChangeSats, role: 'takerChange' },
];

function acceptanceFor(intent, overrides = {}) {
  const acceptance = {
    schema: SWAP_ACCEPTANCE_SCHEMA,
    intentDigest: intent.digest,
    network: intent.network,
    tx: {
      inputs: [TAKER_ORDINAL_INPUT, MAKER_BTC_INPUT(intent)],
      outputs: SWAP_OUTPUTS(intent, '15400'),
    },
    assetTransitions: [
      { assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput: 0 },
      { assetType: 'BTC', assetId: 'BTC', fromInput: 1, toOutput: 1 },
    ],
    fee: { feeSats: '4600', makerFeeSats: '0', takerFeeSats: '4600' },
    signing: { sighashPolicy: 'ALL' },
    ...overrides,
  };
  if (overrides.tx) acceptance.tx = overrides.tx;
  return acceptance;
}

const MEMBER_BASE = (ch) => ch.repeat(60) + 'i';
function baseManifest(overrides = {}) {
  const manifest = {
    schema: COLLECTION_MANIFEST_SCHEMA,
    protocolVersion: '1.2',
    network: 'mainnet',
    protocol: 'ordinals',
    collectionId: 'heritage-demo-collection',
    displayName: 'Heritage Demo Collection',
    creatorAddress: 'bc1qcreator0000000000000000000000000000000000',
    memberIdentityType: 'inscriptionId',
    members: [`${MEMBER_BASE('0')}0`, `${MEMBER_BASE('1')}1`, `${MEMBER_BASE('2')}2`],
    supplyStatement: { kind: 'FIXED', declared: '3' },
    createdAtHeight: 900000,
    version: 1,
    status: 'CREATOR_SIGNED',
    ...overrides,
  };
  manifest.membershipRoot = overrides.membershipRoot || membershipRoot(manifest.collectionId, manifest.members);
  manifest.creatorSignature = {
    kind: 'bip322',
    address: manifest.creatorAddress,
    signature: 'MEUCIQ==',
  };
  manifest.digest = collectionManifestDigest(manifest);
  return manifest;
}

function makeRevocation(manifest, overrides = {}) {
  const revocation = {
    schema: COLLECTION_MANIFEST_REVOCATION_SCHEMA,
    protocolVersion: '1.2',
    network: 'mainnet',
    collectionId: manifest.collectionId,
    manifestDigest: manifest.digest,
    reason: 'Creator asked to retire this manifest version.',
    creatorSignature: { kind: 'bip322', address: manifest.creatorAddress, signature: 'MEUCIQ==' },
    ...overrides,
  };
  revocation.digest = collectionRevocationDigest(revocation);
  return revocation;
}

function counterpartyRecord(overrides = {}) {
  return {
    schema: COUNTERPARTY_UTXO_ASSET_SCHEMA,
    network: 'mainnet',
    asset: { name: 'RAREPEPE', assetId: '137', divisible: false, quantitySats: '1' },
    outpoint: OUTPOINT_C,
    address: '1CounterpartyExampleAddress000000000',
    sourceValueSats: '20000',
    coTravelingAssets: [],
    checkpoint: { height: 900000, blockHash: BLOCK_HASH, ledgerHash: LEDGER_HASH },
    authority: { kind: 'counterparty-core', ready: true },
    attached: true,
    ...overrides,
  };
}

function signingManifest(overrides = {}) {
  const manifest = {
    schema: EXPECTED_TRANSACTION_MANIFEST_SCHEMA,
    network: 'mainnet',
    purpose: 'Transfer one inscription and pay one recipient.',
    watchOnly: false,
    unsignedTx: {
      inputs: [
        {
          txid: OUTPOINT_A.txid,
          vout: OUTPOINT_A.vout,
          valueSats: '50000',
          scriptPubKeyHex: SCRIPT_P2TR,
          controlledByUser: true,
          sighashType: 'DEFAULT',
          explanation: 'Your sealed inscription output, spent whole.',
        },
        {
          txid: OUTPOINT_B.txid,
          vout: OUTPOINT_B.vout,
          valueSats: '30000',
          scriptPubKeyHex: SCRIPT_P2WPKH,
          controlledByUser: true,
          sighashType: 'DEFAULT',
          explanation: 'Cardinal change funding the fee.',
        },
      ],
      outputs: [
        {
          scriptHex: SCRIPT_P2TR,
          valueSats: '10000',
          role: 'recipient',
          explanation: 'The buyer receives the inscription here.',
          expectedAssets: [{ assetType: 'ORDINAL', assetId: INSCRIPTION }],
        },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '69400', role: 'change', explanation: 'Your change returns here.' },
      ],
    },
    fee: { feeSats: '600', maxFeeSats: '2000' },
    ...overrides,
  };
  manifest.digest = expectedTransactionDigest(manifest);
  return manifest;
}

function signedFor(manifest, mutate) {
  const signed = {
    schema: OFFLINE_SIGNING_SESSION_SCHEMA,
    manifestDigest: manifest.digest,
    tx: {
      inputs: manifest.unsignedTx.inputs.map((input) => ({
        txid: input.txid,
        vout: input.vout,
        valueSats: input.valueSats,
        signaturePresent: input.controlledByUser,
        sighashType: input.sighashType,
      })),
      outputs: manifest.unsignedTx.outputs.map((output) => ({ scriptHex: output.scriptHex, valueSats: output.valueSats })),
      carriedAssets: [{ outputIndex: 0, assetType: 'ORDINAL', assetId: INSCRIPTION }],
    },
  };
  if (mutate) mutate(signed);
  return signed;
}

const safeopsCases = [
  {
    name: 'a cardinal batch send plan with examined inputs is accepted',
    plan: basePlan(),
    expected: { ok: true },
  },
  {
    name: 'an input that was never examined fails closed',
    plan: basePlan({ inputs: [{ outpoint: OUTPOINT_A, valueSats: '50000', inventory: { examined: false } }] }),
    expected: { ok: false, code: 'INVENTORY_UNEXAMINED' },
  },
  {
    name: 'a cardinal operation refuses an input that carries an inscription',
    plan: basePlan({
      inputs: [
        {
          outpoint: OUTPOINT_A,
          valueSats: '50000',
          inventory: { examined: true, inscriptions: [{ inscriptionId: INSCRIPTION }] },
        },
        { outpoint: OUTPOINT_B, valueSats: '60000', inventory: { examined: true } },
      ],
    }),
    expected: { ok: false, code: 'ASSET_IN_CARDINAL_OPERATION' },
  },
  {
    name: 'a tracked asset without a transition is refused',
    plan: ordinalPlan({ assetTransitions: [] }),
    expected: { ok: false, code: 'TRACKED_ASSET_UNASSIGNED' },
  },
  {
    name: 'a transition naming a missing output is refused',
    plan: ordinalPlan({
      assetTransitions: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput: 5 }],
    }),
    expected: { ok: false, code: 'TRANSITION_OUTPUT_MISSING' },
  },
  {
    name: 'a transition against the sat flow is refused',
    plan: ordinalPlan({
      assetTransitions: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput: 1 }],
    }),
    expected: { ok: false, code: 'TRANSITION_SAT_FLOW_MISMATCH' },
  },
  {
    name: 'an unknown claim fails closed even with a transition',
    plan: ordinalPlan({
      inputs: [
        {
          outpoint: OUTPOINT_A,
          valueSats: '50000',
          inventory: {
            examined: true,
            inscriptions: [{ inscriptionId: INSCRIPTION }],
            unknownClaims: ['mystery-token-at-outpoint'],
          },
        },
        { outpoint: OUTPOINT_B, valueSats: '60000', inventory: { examined: true } },
      ],
    }),
    expected: { ok: false, code: 'UNKNOWN_CLAIM_FAILS_CLOSED' },
  },
  {
    name: 'outputs that do not conserve value are refused',
    plan: basePlan({
      outputs: basePlan().outputs.map((output) => ({ ...output, valueSats: sats(BigInt(output.valueSats) + 1n) })),
    }),
    expected: { ok: false, code: 'VALUE_NOT_CONSERVED' },
  },
  {
    name: 'a dust output is refused',
    plan: basePlan({
      outputs: [
        { scriptHex: SCRIPT_P2WPKH, valueSats: '100', role: 'recipient' },
        { scriptHex: SCRIPT_P2TR, valueSats: '20000', role: 'recipient' },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '69300', role: 'change' },
      ],
    }),
    expected: { ok: false, code: 'DUST_OUTPUT' },
  },
  {
    name: 'a rune operation without a rune allocation is refused',
    plan: ordinalPlan({ operationKind: 'RUNE_BATCH_TRANSFER' }),
    expected: { ok: false, code: 'RUNE_INPUT_MISSING_ALLOCATION' },
  },
  {
    name: 'a plan whose digest was edited is refused',
    plan: (() => {
      const plan = basePlan();
      plan.digest = 'f'.repeat(64);
      return plan;
    })(),
    expected: { ok: false, code: 'DIGEST_MISMATCH' },
  },
  {
    name: 'a fully signed result matching its plan is accepted',
    plan: ordinalPlan(),
    signed: signedResultFor(ordinalPlan()),
    expected: { ok: true },
  },
  {
    name: 'a signed result from a different plan is refused',
    plan: ordinalPlan(),
    signed: signedResultFor(ordinalPlan({ expiryHeight: 900050 })),
    expected: { ok: false, code: 'PLAN_DIGEST_MISMATCH' },
  },
  {
    name: 'a changed output script is refused after signing',
    plan: ordinalPlan(),
    signed: signedResultFor(ordinalPlan(), (signed) => {
      signed.tx.outputs[0] = { scriptHex: SCRIPT_P2WPKH, valueSats: '10000' };
    }),
    expected: { ok: false, code: 'SCRIPT_CHANGED' },
  },
  {
    name: 'an unsigned required input is refused',
    plan: ordinalPlan(),
    signed: signedResultFor(ordinalPlan(), (signed) => {
      signed.tx.inputs[0].signaturePresent = false;
    }),
    expected: { ok: false, code: 'SIGNATURE_MISSING' },
  },
  {
    name: 'a signature outside the signing policy is refused',
    plan: ordinalPlan({ signing: { requiredIndexes: [0], sighashType: 'DEFAULT' } }),
    signed: signedResultFor(ordinalPlan({ signing: { requiredIndexes: [0], sighashType: 'DEFAULT' } })),
    expected: { ok: false, code: 'UNEXPECTED_SIGNATURE' },
  },
  {
    name: 'a changed sighash is refused',
    plan: ordinalPlan(),
    signed: signedResultFor(ordinalPlan(), (signed) => {
      signed.tx.inputs[0].sighashType = 'ALL';
    }),
    expected: { ok: false, code: 'SIGHASH_CHANGED' },
  },
];

const swapCases = [
  { name: 'a public intent with exact outpoints is accepted', intent: baseIntent(), expected: { ok: true } },
  {
    name: 'an intent with the wrong schema is refused',
    intent: baseIntent({ schema: 'ordex.swap-intent/v2' }),
    expected: { ok: false, code: 'SCHEMA_UNSUPPORTED' },
  },
  {
    name: 'an intent for an unnamed network is refused',
    intent: baseIntent({ network: 'livenet' }),
    expected: { ok: false, code: 'NETWORK_UNKNOWN' },
  },
  {
    name: 'a non-BTC give without an asset id is refused',
    intent: baseIntent({ gives: [{ assetType: 'ORDINAL', outpoint: OUTPOINT_A, quantitySats: '1' }] }),
    expected: { ok: false, code: 'GIVES_INVALID' },
  },
  {
    name: 'an intent expiring before its checkpoint is refused',
    intent: baseIntent({ expiryHeight: 899999 }),
    expected: { ok: false, code: 'EXPIRY_INVALID' },
  },
  {
    name: 'an intent whose digest was edited is refused',
    intent: (() => {
      const intent = baseIntent();
      intent.digest = '0'.repeat(64);
      return intent;
    })(),
    expected: { ok: false, code: 'DIGEST_MISMATCH' },
  },
  {
    name: 'an intent without a maker identity proof is refused',
    intent: (() => {
      const intent = baseIntent();
      delete intent.makerIdentityProof;
      return intent;
    })(),
    expected: { ok: false, code: 'MAKER_PROOF_INVALID' },
  },
  {
    name: 'a private intent bound to a taker is accepted',
    intent: baseIntent({ visibility: 'PRIVATE', takerBinding: { address: 'bc1qtaker000000000000000000000000000000000' } }),
    expected: { ok: true },
  },
  {
    name: 'an acceptance plan matching its intent is accepted',
    intent: baseIntent(),
    acceptance: acceptanceFor(baseIntent()),
    expected: { ok: true },
  },
  {
    name: 'an acceptance plan from a different intent is refused',
    intent: baseIntent(),
    acceptance: acceptanceFor(baseIntent({ nonce: 'nonce-87654321' })),
    expected: { ok: false, code: 'INTENT_DIGEST_MISMATCH' },
  },
  {
    name: 'a one sided transaction cannot settle atomically',
    intent: baseIntent(),
    acceptance: acceptanceFor(baseIntent(), {
      tx: {
        inputs: [MAKER_BTC_INPUT(baseIntent())],
        outputs: SWAP_OUTPUTS(baseIntent(), '15400'),
      },
    }),
    expected: { ok: false, code: 'ATOMICITY_IMPOSSIBLE' },
  },
  {
    name: 'a sighash that does not close the transaction is refused',
    intent: baseIntent(),
    acceptance: acceptanceFor(baseIntent(), { signing: { sighashPolicy: 'SINGLE|ANYONECANPAY' } }),
    expected: { ok: false, code: 'UNCLOSED_SIGHASH' },
  },
  {
    name: 'an acceptance plan that drops a committed outpoint is refused',
    intent: baseIntent(),
    acceptance: acceptanceFor(baseIntent(), {
      tx: {
        inputs: [TAKER_ORDINAL_INPUT, { outpoint: OUTPOINT_C, party: 'taker', valueSats: '90000', assets: [] }],
        outputs: SWAP_OUTPUTS(baseIntent(), '15400'),
      },
    }),
    expected: { ok: false, code: 'MAKER_OUTPOINT_MISSING' },
  },
  {
    name: 'a maker input the intent never committed is refused',
    intent: baseIntent(),
    acceptance: acceptanceFor(baseIntent(), {
      tx: {
        inputs: [
          TAKER_ORDINAL_INPUT,
          MAKER_BTC_INPUT(baseIntent()),
          { outpoint: OUTPOINT_D, party: 'maker', valueSats: '5000', assets: [] },
        ],
        outputs: SWAP_OUTPUTS(baseIntent(), '20400'),
      },
      fee: { feeSats: '4600', makerFeeSats: '0', takerFeeSats: '4600' },
    }),
    expected: { ok: false, code: 'UNEXPECTED_MAKER_INPUT' },
  },
  {
    name: 'a consideration shortfall is refused',
    intent: baseIntent(),
    acceptance: acceptanceFor(baseIntent(), {
      tx: {
        inputs: [TAKER_ORDINAL_INPUT, MAKER_BTC_INPUT(baseIntent())],
        outputs: [
          { scriptHex: SCRIPT_P2TR, valueSats: '10000', role: 'takerAsset' },
          { scriptHex: SCRIPT_P2WPKH, valueSats: '79999', role: 'makerConsideration' },
          { scriptHex: SCRIPT_P2TR, valueSats: '15401', role: 'takerChange' },
        ],
      },
    }),
    expected: { ok: false, code: 'CONSIDERATION_SHORTFALL' },
  },
  {
    name: 'a maker fee above the intent budget is refused',
    intent: baseIntent(),
    acceptance: acceptanceFor(baseIntent(), {
      fee: { feeSats: '4600', makerFeeSats: '4600', takerFeeSats: '0' },
    }),
    expected: { ok: false, code: 'FEE_BUDGET_EXCEEDED' },
  },
  {
    name: 'a maker asset without a delivery transition is refused',
    intent: baseIntent(),
    acceptance: acceptanceFor(baseIntent(), { assetTransitions: [] }),
    expected: { ok: false, code: 'MAKER_ASSET_UNASSIGNED' },
  },
];

function validEvent(overrides = {}) {
  return {
    id: '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0',
    type: 'ordex.order.published',
    schemaVersion: '1',
    network: 'mainnet',
    sequence: 42000,
    aggregate: { type: 'order', id: '01J8ZQ0V2M3N4P5Q6R7S8T9UVW', version: 1 },
    observedAt: '2026-09-02T12:00:00Z',
    checkpoint: { height: 900000, blockHash: BLOCK_HASH },
    status: 'canonical',
    payload: { orderId: '01J8ZQ0V2M3N4P5Q6R7S8T9UVW' },
    artifactDigests: [LEDGER_HASH],
    traceId: 'trace-1a2b3c4d',
    ...overrides,
  };
}

const eventCases = [
  { name: 'a canonical event envelope is accepted', event: validEvent(), expected: { ok: true } },
  {
    name: 'a reverted event naming the event it reverses is accepted',
    event: validEvent({
      id: '1f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0',
      type: 'ordex.order.reorged',
      status: 'reverted',
      revertedEventId: '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0',
    }),
    expected: { ok: true },
  },
  {
    name: 'a reverted event without a reversed id is refused',
    event: validEvent({ status: 'reverted' }),
    expected: { ok: false, code: 'REVERTED_EVENT_REQUIRED' },
  },
  {
    name: 'a canonical event may not name a reversed id',
    event: validEvent({ revertedEventId: '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0' }),
    expected: { ok: false, code: 'STATUS_INVALID' },
  },
  {
    name: 'an unknown event type is refused',
    event: validEvent({ type: 'ordex.mystery' }),
    expected: { ok: false, code: 'EVENT_TYPE_INVALID' },
  },
  {
    name: 'a non increasing sequence is refused',
    event: validEvent({ sequence: 0 }),
    expected: { ok: false, code: 'SEQUENCE_INVALID' },
  },
  {
    name: 'an event without a chain checkpoint is refused',
    event: validEvent({ checkpoint: { height: 900000, blockHash: 'nothex' } }),
    expected: { ok: false, code: 'CHECKPOINT_INVALID' },
  },
  {
    name: 'an array payload is refused',
    event: validEvent({ payload: [] }),
    expected: { ok: false, code: 'PAYLOAD_INVALID' },
  },
  {
    name: 'a malformed artifact digest is refused',
    event: validEvent({ artifactDigests: ['XYZ'] }),
    expected: { ok: false, code: 'ARTIFACT_DIGEST_INVALID' },
  },
];

const WEBHOOK_SECRET = 'whsec_test_secret_0123456789abcdef';
const webhookCases = [
  {
    name: 'a freshly signed delivery verifies',
    signing: { secret: WEBHOOK_SECRET, timestamp: 1787400000, deliveryId: 'evt_0001', body: '{"ok":true}' },
    verifying: { secret: WEBHOOK_SECRET, body: '{"ok":true}', nowSeconds: 1787400100, toleranceSeconds: 300 },
    expected: { ok: true },
  },
  {
    name: 'a tampered body fails the digest binding',
    signing: { secret: WEBHOOK_SECRET, timestamp: 1787400000, deliveryId: 'evt_0001', body: '{"ok":true}' },
    verifying: { secret: WEBHOOK_SECRET, body: '{"ok":false}', nowSeconds: 1787400100, toleranceSeconds: 300 },
    expected: { ok: false, code: 'SIGNATURE_INVALID' },
  },
  {
    name: 'a replayed delivery outside the tolerance is refused',
    signing: { secret: WEBHOOK_SECRET, timestamp: 1787400000, deliveryId: 'evt_0001', body: '{"ok":true}' },
    verifying: { secret: WEBHOOK_SECRET, body: '{"ok":true}', nowSeconds: 1787401000, toleranceSeconds: 300 },
    expected: { ok: false, code: 'TIMESTAMP_OUT_OF_TOLERANCE' },
  },
  {
    name: 'a different secret fails',
    signing: { secret: WEBHOOK_SECRET, timestamp: 1787400000, deliveryId: 'evt_0001', body: '{"ok":true}' },
    verifying: { secret: 'whsec_other', body: '{"ok":true}', nowSeconds: 1787400100, toleranceSeconds: 300 },
    expected: { ok: false, code: 'SIGNATURE_INVALID' },
  },
  {
    name: 'a truncated header is refused',
    signing: { secret: WEBHOOK_SECRET, timestamp: 1787400000, deliveryId: 'evt_0001', body: '{"ok":true}' },
    verifying: {
      secret: WEBHOOK_SECRET,
      body: '{"ok":true}',
      nowSeconds: 1787400100,
      toleranceSeconds: 300,
      headerOverride: 't=1787400000,v1=deadbeef',
    },
    expected: { ok: false, code: 'HEADER_MALFORMED' },
  },
];

const collectionCases = (() => {
  const manifest = baseManifest();
  const editedAfterSigning = baseManifest();
  editedAfterSigning.displayName = 'Renamed After Signing';
  const cases = [
    { name: 'a creator signed manifest is accepted', manifest, expected: { ok: true } },
    {
      name: 'an unsorted member list is refused',
      manifest: baseManifest({ members: [`${MEMBER_BASE('1')}1`, `${MEMBER_BASE('0')}0`, `${MEMBER_BASE('2')}2`] }),
      expected: { ok: false, code: 'MEMBERS_UNSORTED' },
    },
    {
      name: 'a duplicated member is refused',
      manifest: baseManifest({ members: [`${MEMBER_BASE('0')}0`, `${MEMBER_BASE('0')}0`, `${MEMBER_BASE('1')}1`] }),
      expected: { ok: false, code: 'MEMBERS_DUPLICATED' },
    },
    {
      name: 'a membership root that does not match the members is refused',
      manifest: baseManifest({ membershipRoot: 'f'.repeat(64) }),
      expected: { ok: false, code: 'MEMBERSHIP_ROOT_MISMATCH' },
    },
    {
      name: 'a fixed supply that disagrees with the member count is refused',
      manifest: baseManifest({ supplyStatement: { kind: 'FIXED', declared: '4' } }),
      expected: { ok: false, code: 'SUPPLY_MISMATCH' },
    },
    {
      name: 'a version 2 manifest without a previous digest is refused',
      manifest: baseManifest({ version: 2 }),
      expected: { ok: false, code: 'PREVIOUS_DIGEST_REQUIRED' },
    },
    {
      name: 'a manifest edited after signing no longer matches its digest',
      manifest: editedAfterSigning,
      expected: { ok: false, code: 'DIGEST_MISMATCH' },
    },
    {
      name: 'a signature by an address that is not the creator is refused',
      manifest: (() => {
        const m = baseManifest();
        m.creatorSignature = { kind: 'bip322', address: 'bc1qnotcreator000000000000000000000000000000', signature: 'MEUCIQ==' };
        return m;
      })(),
      expected: { ok: false, code: 'SIGNER_IDENTITY_MISMATCH' },
    },
    {
      name: 'a revocation signed by the creator is accepted',
      revocation: makeRevocation(manifest),
      manifest,
      expected: { ok: true },
    },
    {
      name: 'a revocation naming a different manifest is refused',
      manifest,
      revocation: makeRevocation(manifest, { manifestDigest: 'a'.repeat(64), reason: 'Wrong target.' }),
      expected: { ok: false, code: 'MANIFEST_DIGEST_MISMATCH' },
    },
    {
      name: 'a revocation signed by a non creator is refused',
      manifest,
      revocation: makeRevocation(manifest, {
        reason: 'Not the creator.',
        creatorSignature: { kind: 'bip322', address: 'bc1qnotcreator000000000000000000000000000000', signature: 'MEUCIQ==' },
      }),
      expected: { ok: false, code: 'SIGNER_IDENTITY_MISMATCH' },
    },
    {
      name: 'a membership proof resolves for a real member',
      manifest,
      membership: {
        memberIdentity: manifest.members[1],
        proof: buildMembershipProof(manifest.collectionId, manifest.members, manifest.members[1]),
      },
      expected: { ok: true },
    },
    {
      name: 'a membership proof for a stranger does not resolve',
      manifest,
      membership: {
        memberIdentity: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzi999',
        proof: buildMembershipProof(manifest.collectionId, manifest.members, manifest.members[1]),
      },
      expected: { ok: false, code: 'MEMBER_NOT_PROVEN' },
    },
    {
      name: 'a tampered proof step does not resolve',
      manifest,
      membership: (() => {
        const proof = buildMembershipProof(manifest.collectionId, manifest.members, manifest.members[0]);
        proof[0] = { ...proof[0], sibling: 'e'.repeat(64) };
        return { memberIdentity: manifest.members[0], proof };
      })(),
      expected: { ok: false, code: 'MEMBER_NOT_PROVEN' },
    },
  ];
  return cases;
})();

const counterpartyCases = [
  { name: 'a ready attachment record is accepted', record: counterpartyRecord(), expected: { ok: true } },
  {
    name: 'a name without the numeric asset id is refused',
    record: counterpartyRecord({ asset: { name: 'RAREPEPE', divisible: false, quantitySats: '1' } }),
    expected: { ok: false, code: 'ASSET_ID_REQUIRED' },
  },
  {
    name: 'a non integer quantity is refused',
    record: counterpartyRecord({ asset: { name: 'RAREPEPE', assetId: '137', divisible: true, quantitySats: '1.5' } }),
    expected: { ok: false, code: 'QUANTITY_INVALID' },
  },
  {
    name: 'a record produced while the authority was not ready is refused',
    record: counterpartyRecord({ authority: { kind: 'counterparty-core', ready: false } }),
    expected: { ok: false, code: 'AUTHORITY_NOT_READY' },
  },
  {
    name: 'a record that does not state an existing attachment is refused',
    record: counterpartyRecord({ attached: false }),
    expected: { ok: false, code: 'ATTACHMENT_STATE_UNKNOWN' },
  },
  {
    name: 'a record without a ledger hash is refused',
    record: counterpartyRecord({ checkpoint: { height: 900000, blockHash: BLOCK_HASH } }),
    expected: { ok: false, code: 'CHECKPOINT_INVALID' },
  },
  {
    name: 'a spend that carries the attachment to the planned output is accepted',
    record: counterpartyRecord(),
    spendTx: {
      inputs: [
        { txid: OUTPOINT_A.txid, vout: OUTPOINT_A.vout, valueSats: '15000' },
        { txid: OUTPOINT_C.txid, vout: OUTPOINT_C.vout, valueSats: '20000' },
      ],
      outputs: [
        { scriptHex: SCRIPT_P2WPKH, valueSats: '10000' },
        { scriptHex: SCRIPT_P2TR, valueSats: '25000' },
      ],
    },
    expectedOutputIndex: 1,
    expected: { ok: true, carriedToIndex: 1 },
  },
  {
    name: 'a spend that never touches the outpoint is refused',
    record: counterpartyRecord(),
    spendTx: {
      inputs: [{ txid: OUTPOINT_A.txid, vout: OUTPOINT_A.vout, valueSats: '15000' }],
      outputs: [{ scriptHex: SCRIPT_P2WPKH, valueSats: '15000' }],
    },
    expectedOutputIndex: 0,
    expected: { ok: false, code: 'OUTPOINT_NOT_SPENT' },
  },
  {
    name: 'a spend whose sat flow lands the asset elsewhere is refused',
    record: counterpartyRecord(),
    spendTx: {
      inputs: [
        { txid: OUTPOINT_A.txid, vout: OUTPOINT_A.vout, valueSats: '15000' },
        { txid: OUTPOINT_C.txid, vout: OUTPOINT_C.vout, valueSats: '20000' },
      ],
      outputs: [
        { scriptHex: SCRIPT_P2WPKH, valueSats: '10000' },
        { scriptHex: SCRIPT_P2TR, valueSats: '25000' },
      ],
    },
    expectedOutputIndex: 0,
    expected: { ok: false, code: 'DESTINATION_MISMATCH' },
  },
  {
    name: 'a spend that never reabsorbs the range start is refused',
    record: counterpartyRecord(),
    spendTx: {
      inputs: [
        { txid: OUTPOINT_A.txid, vout: OUTPOINT_A.vout, valueSats: '15000' },
        { txid: OUTPOINT_C.txid, vout: OUTPOINT_C.vout, valueSats: '20000' },
      ],
      outputs: [{ scriptHex: SCRIPT_P2WPKH, valueSats: '5000' }],
    },
    expectedOutputIndex: 0,
    expected: { ok: false, code: 'SAT_FLOW_SHORTFALL' },
  },
  {
    name: 'a spend whose value disagrees with the record is refused',
    record: counterpartyRecord({ sourceValueSats: '99999' }),
    spendTx: {
      inputs: [{ txid: OUTPOINT_C.txid, vout: OUTPOINT_C.vout, valueSats: '20000' }],
      outputs: [
        { scriptHex: SCRIPT_P2WPKH, valueSats: '10000' },
        { scriptHex: SCRIPT_P2TR, valueSats: '10000' },
      ],
    },
    expectedOutputIndex: 0,
    expected: { ok: false, code: 'SOURCE_VALUE_MISMATCH' },
  },
  {
    name: 'a duplicated attached outpoint is refused',
    record: counterpartyRecord(),
    spendTx: {
      inputs: [
        { txid: OUTPOINT_C.txid, vout: OUTPOINT_C.vout, valueSats: '20000' },
        { txid: OUTPOINT_C.txid, vout: OUTPOINT_C.vout, valueSats: '20000' },
      ],
      outputs: [{ scriptHex: SCRIPT_P2WPKH, valueSats: '39500' }],
    },
    expectedOutputIndex: 0,
    expected: { ok: false, code: 'OUTPOINT_DUPLICATED' },
  },
];

const offlineCases = (() => {
  const manifest = signingManifest();
  const foreignManifest = signingManifest({
    unsignedTx: (() => {
      const inner = signingManifest();
      inner.unsignedTx.inputs[1].controlledByUser = false;
      return inner.unsignedTx;
    })(),
  });
  const tightFeeManifest = signingManifest({ fee: { feeSats: '600', maxFeeSats: '700' } });
  return [
    { name: 'a complete manifest is accepted', manifest, expected: { ok: true } },
    {
      name: 'a manifest whose digest was edited is refused',
      manifest: (() => {
        const m = signingManifest();
        m.digest = '9'.repeat(64);
        return m;
      })(),
      expected: { ok: false, code: 'DIGEST_MISMATCH' },
    },
    {
      name: 'an input without an explanation is refused',
      manifest: (() => {
        const m = signingManifest();
        delete m.unsignedTx.inputs[0].explanation;
        return m;
      })(),
      expected: { ok: false, code: 'INPUT_DESCRIPTION_INVALID' },
    },
    {
      name: 'a manifest that does not conserve value is refused',
      manifest: (() => {
        const m = signingManifest();
        m.unsignedTx.outputs[1] = { ...m.unsignedTx.outputs[1], valueSats: '69401' };
        return m;
      })(),
      expected: { ok: false, code: 'VALUE_NOT_CONSERVED' },
    },
    {
      name: 'a dust recipient output is refused',
      manifest: signingManifest({
        unsignedTx: {
          inputs: [
            {
              txid: OUTPOINT_A.txid,
              vout: OUTPOINT_A.vout,
              valueSats: '50000',
              scriptPubKeyHex: SCRIPT_P2TR,
              controlledByUser: true,
              sighashType: 'DEFAULT',
              explanation: 'Your sealed output, spent whole.',
            },
          ],
          outputs: [
            { scriptHex: SCRIPT_P2TR, valueSats: '100', role: 'recipient', explanation: 'Too small to send.' },
            { scriptHex: SCRIPT_P2WPKH, valueSats: '49300', role: 'change', explanation: 'Your change.' },
          ],
        },
      }),
      expected: { ok: false, code: 'DUST_OUTPUT' },
    },
    {
      name: 'a signed result matching the manifest is accepted',
      manifest,
      signed: signedFor(manifest),
      expected: { ok: true },
    },
    {
      name: 'a signed result from a different manifest is refused',
      manifest,
      signed: signedFor(
        signingManifest({
          unsignedTx: (() => {
            const inner = signingManifest();
            inner.unsignedTx.outputs[1] = { ...inner.unsignedTx.outputs[1], valueSats: '69500' };
            return inner.unsignedTx;
          })(),
        }),
      ),
      expected: { ok: false, code: 'MANIFEST_DIGEST_MISMATCH' },
    },
    {
      name: 'a reordered input is refused',
      manifest,
      signed: signedFor(manifest, (signed) => {
        signed.tx.inputs = [signed.tx.inputs[1], signed.tx.inputs[0]];
      }),
      expected: { ok: false, code: 'INPUT_REORDERED' },
    },
    {
      name: 'an added output is refused',
      manifest,
      signed: signedFor(manifest, (signed) => {
        signed.tx.outputs.push({ scriptHex: SCRIPT_P2TR, valueSats: '1' });
      }),
      expected: { ok: false, code: 'OUTPUT_SET_CHANGED' },
    },
    {
      name: 'a changed output script is refused',
      manifest,
      signed: signedFor(manifest, (signed) => {
        signed.tx.outputs[0] = { scriptHex: SCRIPT_P2WPKH, valueSats: '10000' };
      }),
      expected: { ok: false, code: 'SCRIPT_CHANGED' },
    },
    {
      name: 'a fee outside the approved bound is refused',
      manifest: tightFeeManifest,
      signed: signedFor(tightFeeManifest, (signed) => {
        signed.tx.outputs[1] = { scriptHex: SCRIPT_P2WPKH, valueSats: '69100' };
      }),
      expected: { ok: false, code: 'FEE_OUT_OF_BOUNDS' },
    },
    {
      name: 'a missing user signature is refused',
      manifest,
      signed: signedFor(manifest, (signed) => {
        signed.tx.inputs[0].signaturePresent = false;
      }),
      expected: { ok: false, code: 'REQUIRED_SIGNATURE_MISSING' },
    },
    {
      name: 'a signature on a foreign input is refused',
      manifest: foreignManifest,
      signed: signedFor(foreignManifest, (signed) => {
        signed.tx.inputs[1].signaturePresent = true;
      }),
      expected: { ok: false, code: 'SIGNATURE_ON_FOREIGN_INPUT' },
    },
    {
      name: 'an unapproved sighash is refused',
      manifest,
      signed: signedFor(manifest, (signed) => {
        signed.tx.inputs[0].sighashType = 'ALL';
      }),
      expected: { ok: false, code: 'SIGHASH_UNEXPECTED' },
    },
    {
      name: 'a protected asset that moved elsewhere is refused',
      manifest,
      signed: signedFor(manifest, (signed) => {
        signed.tx.carriedAssets = [{ outputIndex: 1, assetType: 'ORDINAL', assetId: INSCRIPTION }];
      }),
      expected: { ok: false, code: 'PROTECTED_ASSET_MISPLACED' },
    },
    {
      name: 'an unknown critical field is refused',
      manifest,
      signed: signedFor(manifest, (signed) => {
        signed.unknownCriticalFields = ['proprietary.key.mystery'];
      }),
      expected: { ok: false, code: 'UNKNOWN_CRITICAL_FIELDS' },
    },
  ];
})();

function writeVectors(path, document) {
  writeFileSync(new URL(path, import.meta.url), `${JSON.stringify(document, null, 2)}\n`);
}

writeVectors('../conformance/safeops-vectors.json', {
  version: 1,
  description: 'SafeOps plan and signed result vectors. Every plan digest in this file was computed by safeopsPlanDigest.',
  cases: safeopsCases,
});

writeVectors('../conformance/swap-vectors.json', {
  version: 1,
  protocolVersion: '1.2',
  description: 'Swap intent and acceptance plan vectors. Intent digests were computed by swapIntentDigest.',
  cases: swapCases,
});

writeVectors('../conformance/event-vectors.json', {
  version: 1,
  description: 'ordex-event/v1 envelope and webhook signature vectors.',
  cases: [
    ...eventCases.map((c) => ({ name: c.name, kind: 'event', event: c.event, expected: c.expected })),
    ...webhookCases.map((c) => ({
      name: c.name,
      kind: 'webhook',
      signing: c.signing,
      verifying: c.verifying,
      expected: c.expected,
    })),
  ],
});

writeVectors('../conformance/collection-manifest-vectors.json', {
  version: 1,
  protocolVersion: '1.2',
  description: 'Collection manifest, revocation, and membership proof vectors.',
  cases: collectionCases,
});

writeVectors('../conformance/counterparty-asset-vectors.json', {
  version: 1,
  description: 'Counterparty UTXO attachment record and attachment-follows vectors.',
  cases: counterpartyCases,
});

writeVectors('../conformance/offline-signing-vectors.json', {
  version: 1,
  description: 'Expected transaction manifest and signed result comparison vectors.',
  cases: offlineCases,
});

console.log('conformance vectors regenerated');
