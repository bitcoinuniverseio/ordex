// Regenerates the v1.2 conformance vector files. Run from the repo root:
//   node scripts/make-vectors.mjs
// The vector files are committed; this script exists so fixture digests and
// Merkle roots are recomputed by the same code the verifiers use instead of
// being maintained by hand.

import { writeFileSync } from 'node:fs';

import { bytesToHex, serializeTransaction } from '../verifier/bitcoin-tx.js';
import {
  SAFEOPS_PLAN_SCHEMA,
  SAFEOPS_SIGNED_RESULT_SCHEMA,
  safeopsPlanDigest,
  safeopsUnsignedTransaction,
} from '../verifier/safeops.js';
import { p2trKeyPath, p2wpkhScript, signP2wpkh, signTaprootKeyPath, testKey } from './vector-signer.mjs';
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

// OX-P01: SafeOps v2 fixtures spend outputs locked to test keys, so the signed
// results carry real signatures the verifier checks from the transaction bytes.
const SAFEOPS_USER_KEY = testKey('safeops-user-taproot');
const SAFEOPS_USER_TR = p2trKeyPath(SAFEOPS_USER_KEY).scriptHex;
const SAFEOPS_SEGWIT_KEY = testKey('safeops-user-segwit');
const SAFEOPS_USER_WPKH = p2wpkhScript(SAFEOPS_SEGWIT_KEY);
const SAFEOPS_KEYS = { [SAFEOPS_USER_TR]: SAFEOPS_USER_KEY, [SAFEOPS_USER_WPKH]: SAFEOPS_SEGWIT_KEY };
const SEQUENCE_RBF = 0xfffffffd;
const RUNESTONE_TO_OUTPUT_1 = '6a5d0800c0a23301f40301'; // 500 of 840000:1 to output 1

const planInput = (outpoint, valueSats, inventory = { examined: true }, scriptPubKeyHex = SAFEOPS_USER_TR) => ({
  outpoint,
  valueSats,
  scriptPubKeyHex,
  sequence: SEQUENCE_RBF,
  inventory,
});

function basePlan(overrides = {}) {
  const plan = {
    schema: SAFEOPS_PLAN_SCHEMA,
    protocolVersion: '1.2',
    network: 'mainnet',
    operationKind: 'BTC_BATCH_SEND',
    createdAtHeight: 900000,
    expiryHeight: 900010,
    checkpoint: { height: 900000, blockHash: BLOCK_HASH },
    transaction: { version: 2, lockTime: 0 },
    inputs: [planInput(OUTPOINT_A, '50000'), planInput(OUTPOINT_B, '60000', { examined: true }, SAFEOPS_USER_WPKH)],
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
    inscriptions: [{ inscriptionId: INSCRIPTION, offset: '0', satpoint: `${OUTPOINT_A.txid}:${OUTPOINT_A.vout}:0` }],
  };
  return basePlan({
    operationKind: 'ORDINAL_BATCH_TRANSFER',
    inputs: [planInput(OUTPOINT_A, '50000', inventory), planInput(OUTPOINT_B, '60000', { examined: true }, SAFEOPS_USER_WPKH)],
    outputs: [
      { scriptHex: SCRIPT_P2TR, valueSats: '10000', role: 'recipient' },
      { scriptHex: SCRIPT_P2WPKH, valueSats: '99400', role: 'change' },
    ],
    assetTransitions: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput: 0, quantity: '1' }],
    ...overrides,
  });
}

/** P-R01: an inscription 1500 sats into a 2000 sat input sits in output 1. */
function offsetPlan(toOutput) {
  return basePlan({
    operationKind: 'ORDINAL_BATCH_TRANSFER',
    inputs: [planInput(OUTPOINT_A, '2000', { examined: true, inscriptions: [{ inscriptionId: INSCRIPTION, offset: '1500' }] })],
    outputs: [
      { scriptHex: SCRIPT_P2TR, valueSats: '1000', role: 'recipient' },
      { scriptHex: SCRIPT_P2TR, valueSats: '900', role: 'recipient' },
    ],
    assetTransitions: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput, quantity: '1' }],
    fee: { feeSats: '100', maxFeeSats: '100', feeRateSatsPerVb: '1' },
    signing: { requiredIndexes: [0], sighashType: 'DEFAULT' },
  });
}

function runePlan(overrides = {}) {
  return basePlan({
    operationKind: 'RUNE_BATCH_TRANSFER',
    inputs: [
      planInput(OUTPOINT_A, '10000', { examined: true, runeAllocations: [{ runeId: '840000:1', amount: '1000' }] }),
      planInput(OUTPOINT_B, '20000', { examined: true, runeAllocations: [{ runeId: '840000:1', amount: '200' }] }, SAFEOPS_USER_WPKH),
    ],
    outputs: [
      { scriptHex: RUNESTONE_TO_OUTPUT_1, valueSats: '0', role: 'data' },
      { scriptHex: SCRIPT_P2TR, valueSats: '546', role: 'recipient' },
      { scriptHex: SCRIPT_P2WPKH, valueSats: '28854', role: 'change' },
    ],
    assetTransitions: [{ assetType: 'RUNE', assetId: '840000:1', toOutput: 1, quantity: '1200' }],
    ...overrides,
  });
}

function signedResultFor(plan, { beforeSign, afterSign, hashType = 0x00, skip = [] } = {}) {
  const tx = safeopsUnsignedTransaction(plan);
  if (beforeSign) beforeSign(tx);
  const prevouts = plan.inputs.map((input) => ({ valueSats: input.valueSats, scriptHex: input.scriptPubKeyHex }));
  tx.inputs.forEach((input, i) => {
    if (skip.includes(i)) return;
    const script = prevouts[i].scriptHex;
    input.witness = script.startsWith('5120')
      ? [signTaprootKeyPath(tx, i, prevouts, SAFEOPS_KEYS[script], hashType)]
      : signP2wpkh(tx, i, prevouts, SAFEOPS_KEYS[script]);
  });
  if (afterSign) afterSign(tx);
  return {
    schema: SAFEOPS_SIGNED_RESULT_SCHEMA,
    planDigest: plan.digest,
    signedTxHex: bytesToHex(serializeTransaction(tx)),
  };
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
    plan: basePlan({ inputs: [planInput(OUTPOINT_A, '50000', { examined: false })] }),
    expected: { ok: false, code: 'INVENTORY_UNEXAMINED' },
  },
  {
    name: 'P-R04: the same outpoint spent twice is refused',
    plan: basePlan({ inputs: [planInput(OUTPOINT_A, '50000'), planInput(OUTPOINT_A, '60000')] }),
    expected: { ok: false, code: 'INPUT_DUPLICATED' },
  },
  {
    name: 'a cardinal operation refuses an input that carries an inscription',
    plan: basePlan({
      inputs: [
        planInput(OUTPOINT_A, '50000', { examined: true, inscriptions: [{ inscriptionId: INSCRIPTION, offset: '0' }] }),
        planInput(OUTPOINT_B, '60000', { examined: true }, SAFEOPS_USER_WPKH),
      ],
    }),
    expected: { ok: false, code: 'ASSET_IN_CARDINAL_OPERATION' },
  },
  {
    name: 'an inscription at offset 0 moves with the first sat of its input',
    plan: ordinalPlan(),
    expected: { ok: true },
  },
  {
    name: 'a tracked asset without a transition is refused',
    plan: ordinalPlan({ assetTransitions: [] }),
    expected: { ok: false, code: 'TRACKED_ASSET_UNASSIGNED' },
  },
  {
    name: 'a transition naming a missing output is refused',
    plan: ordinalPlan({
      assetTransitions: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput: 5, quantity: '1' }],
    }),
    expected: { ok: false, code: 'TRANSITION_OUTPUT_MISSING' },
  },
  {
    name: 'P-R01: an inscription 1500 sats in is not delivered to output 0',
    plan: offsetPlan(0),
    expected: { ok: false, code: 'TRANSITION_MISMATCH' },
  },
  {
    name: 'P-R01: the same inscription is correctly planned to output 1',
    plan: offsetPlan(1),
    expected: { ok: true },
  },
  {
    name: 'an inscription whose sat would fall into the fee is refused',
    plan: basePlan({
      operationKind: 'ORDINAL_BATCH_TRANSFER',
      inputs: [planInput(OUTPOINT_A, '2000', { examined: true, inscriptions: [{ inscriptionId: INSCRIPTION, offset: '1950' }] })],
      outputs: [{ scriptHex: SCRIPT_P2TR, valueSats: '1900', role: 'recipient' }],
      assetTransitions: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput: 0, quantity: '1' }],
      fee: { feeSats: '100', maxFeeSats: '100', feeRateSatsPerVb: '1' },
      signing: { requiredIndexes: [0], sighashType: 'DEFAULT' },
    }),
    expected: { ok: false, code: 'ASSET_TO_FEE' },
  },
  {
    name: 'an inscription below the product postage floor is refused',
    plan: basePlan({
      operationKind: 'ORDINAL_BATCH_TRANSFER',
      inputs: [planInput(OUTPOINT_A, '2000', { examined: true, inscriptions: [{ inscriptionId: INSCRIPTION, offset: '0' }] })],
      outputs: [
        { scriptHex: SCRIPT_P2TR, valueSats: '400', role: 'recipient' },
        { scriptHex: SCRIPT_P2TR, valueSats: '1500', role: 'change' },
      ],
      assetTransitions: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput: 0, quantity: '1' }],
      fee: { feeSats: '100', maxFeeSats: '100', feeRateSatsPerVb: '1' },
      signing: { requiredIndexes: [0], sighashType: 'DEFAULT' },
    }),
    expected: { ok: false, code: 'POSTAGE_BELOW_FLOOR' },
  },
  {
    name: 'a rare sat range delivered whole is accepted',
    plan: basePlan({
      operationKind: 'SPLIT_AND_POSTAGE',
      inputs: [planInput(OUTPOINT_A, '20000', { examined: true, rareSatRanges: [{ rangeId: 'uncommon-1', offset: '600', count: '1' }] })],
      outputs: [
        { scriptHex: SCRIPT_P2TR, valueSats: '600', role: 'change' },
        { scriptHex: SCRIPT_P2TR, valueSats: '600', role: 'preserve' },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '18500', role: 'change' },
      ],
      assetTransitions: [{ assetType: 'RARE_SAT', assetId: 'uncommon-1', fromInput: 0, toOutput: 1, quantity: '1' }],
      fee: { feeSats: '300', maxFeeSats: '500', feeRateSatsPerVb: '2' },
      signing: { requiredIndexes: [0], sighashType: 'DEFAULT' },
    }),
    expected: { ok: true },
  },
  {
    name: 'a rare sat range split across outputs is refused',
    plan: basePlan({
      operationKind: 'SPLIT_AND_POSTAGE',
      inputs: [planInput(OUTPOINT_A, '20000', { examined: true, rareSatRanges: [{ rangeId: 'block-9', offset: '500', count: '200' }] })],
      outputs: [
        { scriptHex: SCRIPT_P2TR, valueSats: '600', role: 'preserve' },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '19100', role: 'change' },
      ],
      assetTransitions: [{ assetType: 'RARE_SAT', assetId: 'block-9', fromInput: 0, toOutput: 0, quantity: '200' }],
      fee: { feeSats: '300', maxFeeSats: '500', feeRateSatsPerVb: '2' },
      signing: { requiredIndexes: [0], sighashType: 'DEFAULT' },
    }),
    expected: { ok: false, code: 'RARE_SAT_RANGE_SPLIT' },
  },
  {
    name: 'an unknown claim fails closed even with a transition',
    plan: ordinalPlan({
      inputs: [
        planInput(OUTPOINT_A, '50000', {
          examined: true,
          inscriptions: [{ inscriptionId: INSCRIPTION, offset: '0' }],
          unknownClaims: ['mystery-token-at-outpoint'],
        }),
        planInput(OUTPOINT_B, '60000', { examined: true }, SAFEOPS_USER_WPKH),
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
    name: 'an output below its script dust threshold is refused',
    plan: basePlan({
      outputs: [
        { scriptHex: SCRIPT_P2WPKH, valueSats: '293', role: 'recipient' },
        { scriptHex: SCRIPT_P2TR, valueSats: '20000', role: 'recipient' },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '89107', role: 'change' },
      ],
    }),
    expected: { ok: false, code: 'DUST_OUTPUT' },
  },
  {
    name: 'a P2WPKH output at the Bitcoin Core dust threshold of 294 sats is accepted',
    plan: basePlan({
      outputs: [
        { scriptHex: SCRIPT_P2WPKH, valueSats: '294', role: 'recipient' },
        { scriptHex: SCRIPT_P2TR, valueSats: '20000', role: 'recipient' },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '89106', role: 'change' },
      ],
    }),
    expected: { ok: true },
  },
  {
    name: 'a rune operation without a rune allocation is refused',
    plan: ordinalPlan({ operationKind: 'RUNE_BATCH_TRANSFER' }),
    expected: { ok: false, code: 'RUNE_INPUT_MISSING_ALLOCATION' },
  },
  {
    name: 'P-R02: a zero-sat runestone with a proved allocation is accepted',
    plan: runePlan(),
    expected: { ok: true },
  },
  {
    name: 'a runestone whose edict names its own OP_RETURN burns runes and is refused',
    plan: runePlan({
      outputs: [
        { scriptHex: '6a5d0800c0a23301f40300', valueSats: '0', role: 'data' },
        { scriptHex: SCRIPT_P2TR, valueSats: '546', role: 'recipient' },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '28854', role: 'change' },
      ],
      assetTransitions: [{ assetType: 'RUNE', assetId: '840000:1', toOutput: 1, quantity: '700' }],
    }),
    expected: { ok: false, code: 'ALLOCATION_BURNS_BALANCE' },
  },
  {
    name: 'a rune transition that states the wrong quantity is refused',
    plan: runePlan({ assetTransitions: [{ assetType: 'RUNE', assetId: '840000:1', toOutput: 1, quantity: '500' }] }),
    expected: { ok: false, code: 'RUNE_ALLOCATION_MISMATCH' },
  },
  {
    name: 'a data output that carries value is refused as a burn',
    plan: runePlan({
      outputs: [
        { scriptHex: RUNESTONE_TO_OUTPUT_1, valueSats: '100', role: 'data' },
        { scriptHex: SCRIPT_P2TR, valueSats: '546', role: 'recipient' },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '28754', role: 'change' },
      ],
    }),
    expected: { ok: false, code: 'DATA_OUTPUT_BURNS_VALUE' },
  },
  {
    name: 'an OP_RETURN given a spendable role is refused',
    plan: runePlan({
      outputs: [
        { scriptHex: RUNESTONE_TO_OUTPUT_1, valueSats: '0', role: 'preserve' },
        { scriptHex: SCRIPT_P2TR, valueSats: '546', role: 'recipient' },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '28854', role: 'change' },
      ],
    }),
    expected: { ok: false, code: 'DATA_OUTPUT_ROLE_MISMATCH' },
  },
  {
    name: 'an OP_RETURN that is not a runestone is refused',
    plan: basePlan({
      outputs: [
        { scriptHex: '6a0401020304', valueSats: '0', role: 'data' },
        { scriptHex: SCRIPT_P2TR, valueSats: '20000', role: 'recipient' },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '89400', role: 'change' },
      ],
    }),
    expected: { ok: false, code: 'DATA_OUTPUT_NOT_PERMITTED' },
  },
  {
    name: 'a Counterparty attachment moves to the first spendable output',
    plan: basePlan({
      operationKind: 'RECOVERY',
      inputs: [
        planInput(OUTPOINT_A, '50000', { examined: true }),
        planInput(OUTPOINT_C, '20000', {
          examined: true,
          counterpartyAssets: [{ name: 'RAREPEPE', assetId: '137', quantitySats: '1' }],
        }),
      ],
      outputs: [
        { scriptHex: SCRIPT_P2TR, valueSats: '1000', role: 'preserve' },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '68400', role: 'change' },
      ],
      assetTransitions: [{ assetType: 'COUNTERPARTY', assetId: '137', fromInput: 1, toOutput: 0, quantity: '1' }],
    }),
    expected: { ok: true },
  },
  {
    name: 'a Counterparty attachment planned along its sat range is refused',
    plan: basePlan({
      operationKind: 'RECOVERY',
      inputs: [
        planInput(OUTPOINT_A, '50000', { examined: true }),
        planInput(OUTPOINT_C, '20000', {
          examined: true,
          counterpartyAssets: [{ name: 'RAREPEPE', assetId: '137', quantitySats: '1' }],
        }),
      ],
      outputs: [
        { scriptHex: SCRIPT_P2TR, valueSats: '1000', role: 'preserve' },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '68400', role: 'change' },
      ],
      assetTransitions: [{ assetType: 'COUNTERPARTY', assetId: '137', fromInput: 1, toOutput: 1, quantity: '1' }],
    }),
    expected: { ok: false, code: 'TRANSITION_MISMATCH' },
  },
  {
    name: 'P-R03: a null signing policy is refused, never thrown on',
    plan: basePlan({ signing: null }),
    expected: { ok: false, code: 'SIGNING_INVALID' },
  },
  {
    name: 'a signing policy that skips an input is refused',
    plan: basePlan({ signing: { requiredIndexes: [0], sighashType: 'DEFAULT' } }),
    expected: { ok: false, code: 'SIGNING_INVALID' },
  },
  {
    name: 'a sighash that lets the transaction change after signing is refused',
    plan: basePlan({ signing: { requiredIndexes: [0, 1], sighashType: 'SINGLE|ANYONECANPAY' } }),
    expected: { ok: false, code: 'SIGHASH_NOT_PERMITTED' },
  },
  {
    name: 'a plan that does not fix version and locktime is refused',
    plan: basePlan({ transaction: undefined }),
    expected: { ok: false, code: 'TRANSACTION_INVALID' },
  },
  {
    name: 'a v1 plan is refused rather than reinterpreted',
    plan: basePlan({ schema: 'ordex.safeops-plan/v1' }),
    expected: { ok: false, code: 'SCHEMA_UNSUPPORTED' },
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
    name: 'a signed rune transfer with its runestone is accepted',
    plan: runePlan(),
    signed: signedResultFor(runePlan()),
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
    signed: signedResultFor(ordinalPlan(), {
      afterSign: (tx) => {
        tx.outputs[0].scriptHex = SCRIPT_P2WPKH;
      },
    }),
    expected: { ok: false, code: 'SCRIPT_CHANGED' },
  },
  {
    name: 'an unsigned required input is refused',
    plan: ordinalPlan(),
    signed: signedResultFor(ordinalPlan(), { skip: [0] }),
    expected: { ok: false, code: 'SIGNATURE_MISSING' },
  },
  {
    name: 'a signature made over another transaction is refused',
    plan: ordinalPlan(),
    signed: signedResultFor(ordinalPlan(), {
      beforeSign: (tx) => {
        tx.outputs[1].valueSats = '99399';
      },
      afterSign: (tx) => {
        tx.outputs[1].valueSats = '99400';
      },
    }),
    expected: { ok: false, code: 'SIGNATURE_INVALID' },
  },
  {
    name: 'a changed sighash is refused',
    plan: ordinalPlan(),
    signed: signedResultFor(ordinalPlan(), { hashType: 0x01 }),
    expected: { ok: false, code: 'SIGHASH_CHANGED' },
  },
  {
    name: 'a changed sequence is refused',
    plan: ordinalPlan(),
    signed: signedResultFor(ordinalPlan(), {
      afterSign: (tx) => {
        tx.inputs[1].sequence = 0xffffffff;
      },
    }),
    expected: { ok: false, code: 'SEQUENCE_CHANGED' },
  },
  {
    name: 'a changed locktime is refused',
    plan: ordinalPlan(),
    signed: signedResultFor(ordinalPlan(), {
      afterSign: (tx) => {
        tx.lockTime = 900001;
      },
    }),
    expected: { ok: false, code: 'TRANSACTION_CHANGED' },
  },
  {
    name: 'signed bytes that do not parse are refused',
    plan: ordinalPlan(),
    signed: { schema: SAFEOPS_SIGNED_RESULT_SCHEMA, planDigest: ordinalPlan().digest, signedTxHex: '0200' },
    expected: { ok: false, code: 'MALFORMED_SIGNED_RESULT' },
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
    status: 'current',
    payload: { orderId: '01J8ZQ0V2M3N4P5Q6R7S8T9UVW' },
    artifactDigests: [LEDGER_HASH],
    traceId: 'trace-1a2b3c4d',
    ...overrides,
  };
}

const eventCases = [
  { name: 'a current event envelope is accepted', event: validEvent(), expected: { ok: true } },
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
    name: 'a current event may not name a reversed id',
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
  // OX-P10: spends follow the Counterparty Core v11.4.0 destination rule. Every
  // input carries the attachments the ledger holds on it; [] for none.
  ...(() => {
    const RAREPEPE = { name: 'RAREPEPE', assetId: '137', quantitySats: '1' };
    const PEPECASH = { name: 'PEPECASH', assetId: '18279', quantitySats: '100' };
    const spend = (inputs, outputs, extra = {}) => ({
      inputs: inputs.map(([outpoint, valueSats, attachments]) => ({
        txid: outpoint.txid,
        vout: outpoint.vout,
        valueSats,
        ...(attachments ? { attachments } : {}),
      })),
      outputs: outputs.map(([scriptHex, valueSats]) => ({ scriptHex, valueSats })),
      ...extra,
    });
    const plain = [OUTPOINT_A, '20000', []];
    const attached = [OUTPOINT_C, '20000', [RAREPEPE]];
    const twoOutputs = [[SCRIPT_P2WPKH, '20000'], [SCRIPT_P2TR, '19000']];
    const opReturnOnly = [['6a0401020304', '0']];
    return [
      {
        name: 'P-R18: the attachment moves to the first non-OP_RETURN output, not along its sat range',
        record: counterpartyRecord(),
        spendTx: spend([plain, attached], twoOutputs),
        expectedOutputIndex: 0,
        expected: { ok: true, carriedToIndex: 0 },
      },
      {
        name: 'P-R18: planning the sat-range output instead is refused',
        record: counterpartyRecord(),
        spendTx: spend([plain, attached], twoOutputs),
        expectedOutputIndex: 1,
        expected: { ok: false, code: 'DESTINATION_MISMATCH' },
      },
      {
        name: 'output values play no part in the destination',
        record: counterpartyRecord(),
        spendTx: spend([attached], [[SCRIPT_P2WPKH, '546']]),
        expectedOutputIndex: 0,
        expected: { ok: true, carriedToIndex: 0 },
      },
      {
        name: 'a leading OP_RETURN is passed over',
        record: counterpartyRecord(),
        spendTx: spend([attached], [['6a0401020304', '0'], ...twoOutputs]),
        expectedOutputIndex: 1,
        expected: { ok: true, carriedToIndex: 1 },
      },
      {
        name: 'a one-byte push of 0x6a is passed over like OP_RETURN',
        record: counterpartyRecord(),
        spendTx: spend([attached], [['016a', '1000'], [SCRIPT_P2WPKH, '18000']]),
        expectedOutputIndex: 1,
        expected: { ok: true, carriedToIndex: 1 },
      },
      {
        name: 'an OP_RETURN that fails to decode is a destination, and it cannot be spent',
        record: counterpartyRecord(),
        spendTx: spend([attached], [['6a4c', '0'], [SCRIPT_P2WPKH, '19000']]),
        expectedOutputIndex: 0,
        expected: { ok: false, code: 'DESTINATION_UNSPENDABLE' },
      },
      {
        name: 'an OP_RETURN ending in OP_CHECKMULTISIG is never passed over',
        record: counterpartyRecord(),
        spendTx: spend([attached], [['6a51ae', '0'], [SCRIPT_P2WPKH, '19000']]),
        expectedOutputIndex: 1,
        expected: { ok: false, code: 'DESTINATION_MISMATCH' },
      },
      {
        name: 'another attached input would co-move to the same output',
        record: counterpartyRecord(),
        spendTx: spend([attached, [OUTPOINT_A, '20000', [PEPECASH]]], twoOutputs),
        expectedOutputIndex: 0,
        expected: { ok: false, code: 'OTHER_ATTACHMENTS_COMOVE' },
      },
      {
        name: 'an undeclared co-traveling asset on the outpoint is refused',
        record: counterpartyRecord(),
        spendTx: spend([[OUTPOINT_C, '20000', [RAREPEPE, PEPECASH]]], twoOutputs),
        expectedOutputIndex: 0,
        expected: { ok: false, code: 'ATTACHMENT_INVENTORY_MISMATCH' },
      },
      {
        name: 'declared co-traveling assets move together',
        record: counterpartyRecord({ coTravelingAssets: [PEPECASH] }),
        spendTx: spend([[OUTPOINT_C, '20000', [PEPECASH, RAREPEPE]]], twoOutputs),
        expectedOutputIndex: 0,
        expected: { ok: true, carriedToIndex: 0 },
      },
      {
        name: 'an input without its ledger attachment reading is refused',
        record: counterpartyRecord(),
        spendTx: spend([[OUTPOINT_A, '20000'], attached], twoOutputs),
        expectedOutputIndex: 0,
        expected: { ok: false, code: 'INPUT_ATTACHMENTS_UNKNOWN' },
      },
      {
        name: 'with no spendable output the spend detaches to the owner',
        record: counterpartyRecord(),
        spendTx: spend([attached], opReturnOnly),
        expectedOutputIndex: 0,
        expected: { ok: false, code: 'NO_DESTINATION_DETACHES' },
      },
      {
        name: 'before spend_utxo_to_detach an OP_RETURN-only spend strands the attachment',
        record: counterpartyRecord({ checkpoint: { height: 870000, blockHash: BLOCK_HASH, ledgerHash: LEDGER_HASH } }),
        spendTx: spend([attached], opReturnOnly),
        expectedOutputIndex: 0,
        expected: { ok: false, code: 'NO_DESTINATION_STRANDS' },
      },
      {
        name: 'before utxo_support there is no attachment to move',
        record: counterpartyRecord({ checkpoint: { height: 800000, blockHash: BLOCK_HASH, ledgerHash: LEDGER_HASH } }),
        spendTx: spend([attached], twoOutputs),
        expectedOutputIndex: 0,
        expected: { ok: false, code: 'UTXO_SUPPORT_INACTIVE' },
      },
      {
        name: 'a detach message sends the asset to an address, not an output',
        record: counterpartyRecord(),
        spendTx: spend([attached], twoOutputs, { counterpartyMessage: 'detach' }),
        expectedOutputIndex: 0,
        expected: { ok: false, code: 'DETACH_NOT_A_MOVE' },
      },
      {
        name: 'an attach message still moves existing attachments to the first spendable output',
        record: counterpartyRecord(),
        spendTx: spend([attached], twoOutputs, { counterpartyMessage: 'attach' }),
        expectedOutputIndex: 0,
        expected: { ok: true, carriedToIndex: 0 },
      },
      {
        name: 'an unknown message kind is refused',
        record: counterpartyRecord(),
        spendTx: spend([attached], twoOutputs, { counterpartyMessage: 'send' }),
        expectedOutputIndex: 0,
        expected: { ok: false, code: 'COUNTERPARTY_MESSAGE_UNKNOWN' },
      },
      {
        name: 'a Signet attachment follows the same rule from its first block',
        record: counterpartyRecord({
          network: 'signet',
          address: 'tb1qcounterpartysignetexample000000000000',
          checkpoint: { height: 1000, blockHash: BLOCK_HASH, ledgerHash: LEDGER_HASH },
        }),
        spendTx: spend([plain, attached], twoOutputs),
        expectedOutputIndex: 0,
        expected: { ok: true, carriedToIndex: 0 },
      },
      {
        name: 'a spend that never touches the outpoint is refused',
        record: counterpartyRecord(),
        spendTx: spend([plain], [[SCRIPT_P2WPKH, '15000']]),
        expectedOutputIndex: 0,
        expected: { ok: false, code: 'OUTPOINT_NOT_SPENT' },
      },
      {
        name: 'a plan naming a missing output is refused',
        record: counterpartyRecord(),
        spendTx: spend([attached], twoOutputs),
        expectedOutputIndex: 2,
        expected: { ok: false, code: 'DESTINATION_MISSING' },
      },
      {
        name: 'a spend whose value disagrees with the record is refused',
        record: counterpartyRecord({ sourceValueSats: '99999' }),
        spendTx: spend([attached], twoOutputs),
        expectedOutputIndex: 0,
        expected: { ok: false, code: 'SOURCE_VALUE_MISMATCH' },
      },
      {
        name: 'a duplicated attached outpoint is refused',
        record: counterpartyRecord(),
        spendTx: spend([attached, attached], [[SCRIPT_P2WPKH, '39500']]),
        expectedOutputIndex: 0,
        expected: { ok: false, code: 'OUTPOINT_DUPLICATED' },
      },
    ];
  })(),
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

// Rune burn and allocation vectors. The first 25 cases predate OX-P04 and are
// kept verbatim. The rest are ord 0.29.0 parity and allocation cases; their
// deciphered fields and allocations are checked against the pinned ord oracle
// in conformance/ord-differential by verifier/runes.ord-parity.test.js.
const LEGACY_RUNE_CASES = [
  {"name":"no-runestone","description":"A purchase with no runestone output. Unallocated runes go to the first non-OP_RETURN output, so nothing burns.","outputScriptsHex":["00141111111111111111111111111111111111111111","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":true,"runestone":"NONE"}},
  {"name":"plain-op-return","description":"An OP_RETURN that is not a runestone is not read as one.","outputScriptsHex":["6a0401020304","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":true,"runestone":"NONE"}},
  {"name":"single-edict","description":"A readable transfer of 500 units of rune 840000:1 to output 1.","outputScriptsHex":["6a5d0800c0a23301f40301","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":true,"runestone":"RUNESTONE"}},
  {"name":"edict-split-across-all","description":"An edict addressed to the output count means split across every non-OP_RETURN output.","outputScriptsHex":["6a5d0800c0a23301f40302","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":true,"runestone":"RUNESTONE"}},
  {"name":"pointer-in-range","description":"A pointer that addresses a real output is consumed as a pointer.","outputScriptsHex":["6a5d0a160100c0a23301f40301","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":true,"runestone":"RUNESTONE"}},
  {"name":"unrecognized-odd-tag","description":"Tag 127 is the reserved nop. Odd tags stay ignorable so the format can grow without burning balances held by older readers.","outputScriptsHex":["6a5d0a7f6300c0a23301f40301","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":true,"runestone":"RUNESTONE"}},
  {"name":"op-0-is-an-empty-push","description":"OP_0 is an empty push to the protocol, not an opcode.","outputScriptsHex":["6a5d000800c0a23301f40301","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":true,"runestone":"RUNESTONE"}},
  {"name":"cenotaph-clean-inputs","description":"Malformed, but every input is indexed and holds no runes, so there is no balance to destroy.","outputScriptsHex":["6a5d027e01","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":0}],"expected":{"safe":true,"runestone":"CENOTAPH"}},
  {"name":"unrecognized-even-tag","description":"Tag 126 is even and unrecognized, the shortest cenotaph there is.","outputScriptsHex":["6a5d077e000001010200","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"UNRECOGNIZED_EVEN_TAG"}},
  {"name":"unrecognized-flag","description":"A flag bit outside Etching, Terms and Turbo stays set after the protocol consumes what it knows.","outputScriptsHex":["6a5d1902808080808080808080808080808080808080020001010200","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"UNRECOGNIZED_FLAG"}},
  {"name":"terms-without-etching","description":"Terms is read only when Etching is set, so on its own its bit stays standing.","outputScriptsHex":["6a5d0a020200c0a23301f40301","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"UNRECOGNIZED_FLAG"}},
  {"name":"pointer-out-of-range","description":"A pointer addressing no output is never consumed, leaving even tag 22 in the field map.","outputScriptsHex":["6a5d0a160700c0a23301f40301","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"UNRECOGNIZED_EVEN_TAG"}},
  {"name":"truncated-field","description":"A tag with no value following it.","outputScriptsHex":["6a5d03020102","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"TRUNCATED_FIELD"}},
  {"name":"trailing-integers","description":"The body carries a partial edict: edicts come in groups of four.","outputScriptsHex":["6a5d06000101020000","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"TRAILING_INTEGERS"}},
  {"name":"edict-output-over-max","description":"An edict addressed beyond the output count.","outputScriptsHex":["6a5d050001010202"],"outputCount":1,"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"EDICT_OUTPUT"}},
  {"name":"edict-rune-id-zero-block","description":"Block 0 with a nonzero tx is not a rune any block ever produced.","outputScriptsHex":["6a5d050000010200"],"outputCount":1,"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"EDICT_RUNE_ID"}},
  {"name":"edict-block-delta-overflow","description":"A block delta that carries the rune id past a u64.","outputScriptsHex":["6a5d120001000000ffffffffffffffffff01000000"],"outputCount":1,"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"EDICT_RUNE_ID"}},
  {"name":"edict-tx-delta-overflow","description":"A tx delta that carries the rune id past a u32.","outputScriptsHex":["6a5d12000101000000ffffffffffffffffff010000"],"outputCount":1,"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"EDICT_RUNE_ID"}},
  {"name":"varint-unterminated","description":"Every byte sets the continuation bit and the payload ends.","outputScriptsHex":["6a5d03808080","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"VARINT"}},
  {"name":"varint-overlong","description":"More than nineteen groups.","outputScriptsHex":["6a5d148080808080808080808080808080808080808080","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"VARINT"}},
  {"name":"varint-overflows-u128","description":"Nineteen groups are permitted, but the last carries only two bits.","outputScriptsHex":["6a5d1380808080808080808080808080808080808040","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"VARINT"}},
  {"name":"opcode-in-payload","description":"OP_1 after the magic number is an opcode, not a push.","outputScriptsHex":["6a5d51","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"OPCODE"}},
  {"name":"push-past-end-of-script","description":"A push claiming more bytes than the script carries.","outputScriptsHex":["6a5d200102","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"INVALID_SCRIPT"}},
  {"name":"first-runestone-wins","description":"A later readable runestone does not rescue an earlier malformed one.","outputScriptsHex":["6a5d027e01","6a5d0800c0a23301f40301","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":true,"runes":1}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_BURNS_BALANCE","flaw":"UNRECOGNIZED_EVEN_TAG"}},
  {"name":"cenotaph-unindexed-input","description":"Malformed, and the index has not examined an input, so it cannot be proven to hold no runes.","outputScriptsHex":["6a5d027e01","00141111111111111111111111111111111111111111"],"inputs":[{"indexed":false,"runes":0}],"expected":{"safe":false,"runestone":"CENOTAPH","code":"CENOTAPH_WITH_UNPROVEN_INPUT","flaw":"UNRECOGNIZED_EVEN_TAG"}},
];
const RUNE_SPEND_1 = '0014' + '11'.repeat(20);
const RUNE_SPEND_2 = '0014' + '22'.repeat(20);
const RUNE_SPEND_3 = '0014' + '33'.repeat(20);
const U128_MAX = (1n << 128n) - 1n;

function runeVarint(value) {
  let n = BigInt(value);
  const bytes = [];
  while (n >> 7n > 0n) {
    bytes.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  bytes.push(Number(n));
  return bytes;
}

/** OP_RETURN OP_13 followed by one data push of the varint-encoded integers. */
function runestoneScript(integers) {
  const payload = integers.flatMap(runeVarint);
  const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  if (payload.length === 0) return '6a5d';
  if (payload.length <= 75) return '6a5d' + hex([payload.length, ...payload]);
  return '6a5d' + hex([0x4c, payload.length, ...payload]);
}

const counted = [{ indexed: true, runes: 1 }];
const held = (...balances) => [{ indexed: true, balances: balances.map(([runeId, amount]) => ({ runeId, amount })) }];
const refused = (runestone, code, flaw) => ({ safe: false, runestone, code, ...(flaw ? { flaw } : {}) });
const accepted = (runestone) => ({ safe: true, runestone });
const cenotaph = (flaw) => refused('CENOTAPH', 'CENOTAPH_BURNS_BALANCE', flaw);

function runeCase(name, description, outputScriptsHex, inputs, expected, extra = {}) {
  return { name, description, outputScriptsHex, inputs, ...extra, expected };
}

const runeParityCases = [
  runeCase('duplicate-pointer-is-a-cenotaph', 'P-R05: tag 22 twice. Tag::take consumes one pointer and the second stays behind as an even field.', ['6a5d0416011601', '51'], counted, cenotaph('UNRECOGNIZED_EVEN_TAG')),
  runeCase('premine-without-etching-is-a-cenotaph', 'P-R06: premine is consumed only inside an etching, so without the Etching flag tag 6 stays behind.', ['6a5d020601', '51'], counted, cenotaph('UNRECOGNIZED_EVEN_TAG')),
  runeCase('incomplete-mint-is-a-cenotaph', 'P-R07: Mint takes two values. One value is never consumed.', ['6a5d021401', '51'], counted, cenotaph('UNRECOGNIZED_EVEN_TAG')),
  runeCase('pointer-to-its-own-op-return-burns', 'P-R08: a readable runestone whose pointer is its own OP_RETURN sends every unallocated balance there.', ['6a5d021600', '51'], counted, refused('RUNESTONE', 'ALLOCATION_BURNS_BALANCE')),
  runeCase('pointer-to-its-own-op-return-burns-exact', 'P-R08 with exact balances: the whole balance of 840000:1 lands on the OP_RETURN.', ['6a5d021600', '51'], held(['840000:1', '1000']), refused('RUNESTONE', 'ALLOCATION_BURNS_BALANCE')),
  runeCase('duplicate-flags-is-a-cenotaph', 'Flags are taken once. A second flags value stays behind as tag 2.', [runestoneScript([2, 1, 2, 1]), RUNE_SPEND_1], counted, cenotaph('UNRECOGNIZED_EVEN_TAG')),
  runeCase('duplicate-mint-is-a-cenotaph', 'Two complete mint pairs: one is consumed, the other stays behind. The cenotaph still names the mint.', [runestoneScript([20, 840000, 20, 1, 20, 840000, 20, 1]), RUNE_SPEND_1], counted, cenotaph('UNRECOGNIZED_EVEN_TAG')),
  runeCase('mint-with-zero-block-and-nonzero-tx', 'RuneId::new refuses block 0 with a nonzero tx, so the mint is never consumed.', [runestoneScript([20, 0, 20, 1]), RUNE_SPEND_1], counted, cenotaph('UNRECOGNIZED_EVEN_TAG')),
  runeCase('mint-tx-beyond-u32', 'A mint tx that does not fit a u32 is never consumed.', [runestoneScript([20, 840000, 20, 2n ** 32n]), RUNE_SPEND_1], counted, cenotaph('UNRECOGNIZED_EVEN_TAG')),
  runeCase('mint-block-beyond-u64', 'A mint block that does not fit a u64 is never consumed.', [runestoneScript([20, 2n ** 64n, 20, 1]), RUNE_SPEND_1], counted, cenotaph('UNRECOGNIZED_EVEN_TAG')),
  runeCase('valid-mint', 'A complete mint is consumed and the runestone is readable.', [runestoneScript([20, 840000, 20, 3]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('etching-flag-alone', 'An etching with no fields is readable.', [runestoneScript([2, 1]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('etching-with-every-field', 'Every etching, terms and turbo field consumed together with a pointer, a mint and an edict.', [runestoneScript([2, 7, 4, 4, 1, 1, 3, 5, 5, 97, 18, 2, 10, 3, 6, 8, 8, 9, 22, 1, 20, 1, 20, 1, 0, 1, 1, 2, 1]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('turbo-flag-without-etching', 'Turbo is read only inside an etching. Alone it is an unrecognized flag.', [runestoneScript([2, 4]), RUNE_SPEND_1], counted, cenotaph('UNRECOGNIZED_FLAG')),
  runeCase('unknown-flag-bit', 'Bit 3 is no flag the protocol consumes.', [runestoneScript([2, 8]), RUNE_SPEND_1], counted, cenotaph('UNRECOGNIZED_FLAG')),
  runeCase('cenotaph-flag-bit-127', 'The reserved cenotaph flag, bit 127, carried by a 19-byte varint.', [runestoneScript([2, 2n ** 127n]), RUNE_SPEND_1], counted, cenotaph('UNRECOGNIZED_FLAG')),
  runeCase('cap-without-terms-flag', 'Cap is consumed only when Terms is set.', [runestoneScript([2, 1, 8, 0]), RUNE_SPEND_1], counted, cenotaph('UNRECOGNIZED_EVEN_TAG')),
  runeCase('offset-end-beyond-u64', 'A term that does not fit a u64 is never consumed.', [runestoneScript([2, 3, 18, 2n ** 64n]), RUNE_SPEND_1], counted, cenotaph('UNRECOGNIZED_EVEN_TAG')),
  runeCase('supply-at-u128-max-is-readable', 'cap 1 times amount u128::MAX fits exactly.', [runestoneScript([2, 3, 8, 1, 10, U128_MAX]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('supply-overflow-cap-times-amount', 'cap 2 times amount u128::MAX overflows the supply.', [runestoneScript([2, 3, 8, 2, 10, U128_MAX]), RUNE_SPEND_1], counted, cenotaph('SUPPLY_OVERFLOW')),
  runeCase('supply-overflow-premine-plus-terms', 'premine 1 plus cap 1 times u128::MAX overflows the supply.', [runestoneScript([2, 3, 6, 1, 8, 1, 10, U128_MAX]), RUNE_SPEND_1], counted, cenotaph('SUPPLY_OVERFLOW')),
  runeCase('divisibility-above-max-is-ignored', 'Divisibility 39 is refused by Tag::take, and tag 1 is odd, so it is simply ignored.', [runestoneScript([2, 1, 1, 39]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('invalid-odd-fields-without-etching-are-ignored', 'Odd tags left unconsumed never make a cenotaph.', [runestoneScript([1, U128_MAX, 3, U128_MAX, 5, U128_MAX]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('symbol-surrogate-is-ignored', 'A surrogate code point is no char, so the symbol is left unconsumed.', [runestoneScript([2, 1, 5, 0xd800]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('symbol-above-max-is-ignored', 'A value above char::MAX is no symbol.', [runestoneScript([2, 1, 5, 0x110000]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('spacers-above-max-are-ignored', 'Spacers above Etching::MAX_SPACERS are left unconsumed.', [runestoneScript([2, 1, 3, 0x0800_0000]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('max-rune-name', 'Rune u128::MAX is a readable 19-byte varint.', [runestoneScript([2, 1, 4, U128_MAX]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('pointer-u128-max-is-a-cenotaph', 'A pointer that fits no u32 is never consumed.', [runestoneScript([22, U128_MAX]), RUNE_SPEND_1], counted, cenotaph('UNRECOGNIZED_EVEN_TAG')),
  runeCase('tag-values-are-not-read-as-tags', 'A value of 0 after tag 1 is a divisibility, not the body.', [runestoneScript([2, 1, 1, 0, 0, 1, 1, 2, 1]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('multiple-edicts-delta-encoded', 'A block delta of 0 continues the tx counter: 840000:1 then 840000:4.', [runestoneScript([0, 840000, 1, 2, 1, 0, 3, 5, 1]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('edict-output-beyond-u32', 'An edict output that does not fit a u32.', [runestoneScript([0, 1, 1, 1, 2n ** 32n]), RUNE_SPEND_1], counted, cenotaph('EDICT_OUTPUT')),
  runeCase('edict-block-u128-max', 'A block delta of u128::MAX cannot be a rune id.', [runestoneScript([0, 1, 1, 2, 1, U128_MAX, 1, 0, 0]), RUNE_SPEND_1], counted, cenotaph('EDICT_RUNE_ID')),
  runeCase('tag-without-value', 'The second flags tag has no value.', [runestoneScript([2, 1, 2]), RUNE_SPEND_1], counted, cenotaph('TRUNCATED_FIELD')),
  runeCase('pushdata1-missing-length', 'OP_PUSHDATA1 with no length byte.', ['6a5d4c', RUNE_SPEND_1], counted, cenotaph('INVALID_SCRIPT')),
  runeCase('pushdata2-truncated-length', 'OP_PUSHDATA2 with one length byte.', ['6a5d4d01', RUNE_SPEND_1], counted, cenotaph('INVALID_SCRIPT')),
  runeCase('pushdata4-length-past-end', 'OP_PUSHDATA4 claiming five bytes with one present.', ['6a5d4e0500000001', RUNE_SPEND_1], counted, cenotaph('INVALID_SCRIPT')),
  runeCase('non-minimal-pushdata1-is-a-push', 'A non-minimal push is still a push: one zero byte, the empty body.', ['6a5d4c0100', RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('op-1negate-is-an-opcode', 'OP_1NEGATE is an opcode, not a push.', ['6a5d4f', RUNE_SPEND_1], counted, cenotaph('OPCODE')),
  runeCase('op-reserved-is-an-opcode', 'OP_RESERVED is an opcode, not a push.', ['6a5d50', RUNE_SPEND_1], counted, cenotaph('OPCODE')),
  runeCase('empty-runestone', 'OP_RETURN OP_13 alone is an empty, readable runestone.', ['6a5d', RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('truncated-push-before-magic-is-skipped', 'An OP_RETURN whose second instruction fails to parse is not a runestone, so the next output is read.', ['6a095d04', runestoneScript([20, 840000, 20, 1]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('runestone-after-plain-op-return', 'A plain OP_RETURN before the runestone is skipped.', ['6a03464f4f', runestoneScript([0, 840000, 1, 5, 2]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
  runeCase('truncated-push-after-magic', 'A push after the magic number that runs past the script.', ['6a5d04', RUNE_SPEND_1], counted, cenotaph('INVALID_SCRIPT')),
  runeCase('bare-op-return-is-not-a-runestone', 'OP_RETURN with no magic number carries no runestone.', ['6a', RUNE_SPEND_1], counted, accepted('NONE')),
  runeCase('odd-tag-127-is-ignored', 'The Nop tag is odd and ignored.', [runestoneScript([127, 100, 0, 840000, 1, 2, 1]), RUNE_SPEND_1], counted, accepted('RUNESTONE')),
];

const runeAllocationCases = [
  runeCase('edict-to-op-return-burns', 'An edict sends 400 of 840000:1 to the runestone output itself; the rest falls to output 1.', [runestoneScript([0, 840000, 1, 400, 0]), RUNE_SPEND_1], held(['840000:1', '1000']), refused('RUNESTONE', 'ALLOCATION_BURNS_BALANCE')),
  runeCase('edict-zero-amount-to-op-return-burns-all', 'Amount 0 means the whole balance, here sent to the OP_RETURN.', [runestoneScript([0, 840000, 1, 0, 0]), RUNE_SPEND_1], held(['840000:1', '1000']), refused('RUNESTONE', 'ALLOCATION_BURNS_BALANCE')),
  runeCase('edict-for-unheld-rune-is-skipped', 'An edict to the OP_RETURN for a rune no input carries allocates nothing, so nothing burns.', [runestoneScript([0, 840000, 2, 400, 0]), RUNE_SPEND_1], held(['840000:1', '1000']), accepted('RUNESTONE')),
  runeCase('split-zero-amount-across-spendable-outputs', 'Output count with amount 0 divides the balance, remainder to the first outputs: 334, 333, 333.', [runestoneScript([0, 840000, 1, 0, 4]), RUNE_SPEND_1, RUNE_SPEND_2, RUNE_SPEND_3], held(['840000:1', '1000']), accepted('RUNESTONE')),
  runeCase('split-fixed-amount-until-exhausted', 'Output count with amount 400 gives 400, 400, then the 200 left.', [runestoneScript([0, 840000, 1, 400, 4]), RUNE_SPEND_1, RUNE_SPEND_2, RUNE_SPEND_3], held(['840000:1', '1000']), accepted('RUNESTONE')),
  runeCase('no-runestone-and-no-spendable-output-burns', 'Without a runestone the balance falls to the first non-OP_RETURN output, and there is none.', ['6a0401020304', '6a'], held(['840000:1', '1000']), refused('NONE', 'ALLOCATION_BURNS_BALANCE')),
  runeCase('no-spendable-output-burns-counted', 'The same loss is certain from a count alone, because nothing is allocated elsewhere.', ['6a0401020304', '6a'], counted, refused('NONE', 'ALLOCATION_BURNS_BALANCE')),
  runeCase('pointer-takes-the-leftover', 'An edict sends 300 to output 1 and the pointer sends the other 700 to output 2.', [runestoneScript([22, 2, 0, 840000, 1, 300, 1]), RUNE_SPEND_1, RUNE_SPEND_2], held(['840000:1', '1000']), accepted('RUNESTONE')),
  runeCase('cenotaph-burns-exact-balances', 'A cenotaph burns the exact balances listed.', [runestoneScript([126, 1]), RUNE_SPEND_1], held(['840000:1', '1000']), cenotaph('UNRECOGNIZED_EVEN_TAG')),
  runeCase('mint-of-held-rune-needs-the-mint-result', 'The runestone mints a rune the input also carries and its pointer is the OP_RETURN, so the burn depends on the minted amount.', [runestoneScript([20, 840000, 20, 1, 22, 0, 0, 840000, 1, 500, 1]), RUNE_SPEND_1], held(['840000:1', '1000']), refused('RUNESTONE', 'RUNE_MINT_UNRESOLVED'), { mint: { runeId: '840000:1', amount: '0' } }),
  runeCase('two-runes-one-left-for-an-op-return-pointer', 'Two inputs carry 840000:1 and 840000:2. The edict moves all of 840000:1; 840000:2 falls to the OP_RETURN pointer.', [runestoneScript([22, 0, 0, 840000, 1, 1000, 1]), RUNE_SPEND_1], [{ indexed: true, balances: [{ runeId: '840000:1', amount: '600' }] }, { indexed: true, balances: [{ runeId: '840000:1', amount: '400' }, { runeId: '840000:2', amount: '50' }] }], refused('RUNESTONE', 'ALLOCATION_BURNS_BALANCE')),
  runeCase('edicts-cover-everything-before-an-op-return-pointer', 'The edict moves the whole balance, so the OP_RETURN pointer receives nothing.', [runestoneScript([22, 0, 0, 840000, 1, 1000, 1]), RUNE_SPEND_1], held(['840000:1', '1000']), accepted('RUNESTONE')),
  runeCase('op-return-pointer-with-edicts-needs-balances', 'From counts alone it cannot be known whether the edicts leave anything for the OP_RETURN pointer.', [runestoneScript([22, 0, 0, 840000, 1, 1000, 1]), RUNE_SPEND_1], counted, refused('RUNESTONE', 'RUNE_BALANCES_REQUIRED')),
  runeCase('unindexed-input-with-a-burn-path', 'The pointer is the OP_RETURN and an input was never examined.', [runestoneScript([22, 0]), RUNE_SPEND_1], [{ indexed: false, runes: 0 }], refused('RUNESTONE', 'BURN_PATH_WITH_UNPROVEN_INPUT')),
  runeCase('unindexed-input-without-a-burn-path', 'Every allocation lands on a spendable output, so an unexamined input cannot lose a balance to a burn.', [runestoneScript([0, 840000, 1, 5, 1]), RUNE_SPEND_1], [{ indexed: false, runes: 0 }], accepted('RUNESTONE')),
  runeCase('counted-edict-to-op-return-needs-balances', 'An edict names the OP_RETURN, and a count does not say which runes an input holds.', [runestoneScript([0, 840000, 1, 5, 0]), RUNE_SPEND_1], counted, refused('RUNESTONE', 'RUNE_BALANCES_REQUIRED')),
  runeCase('outputs-incomplete', 'Only one of three outputs was supplied, so the runestone and its allocation cannot be read.', [RUNE_SPEND_1], counted, refused('NONE', 'RUNE_OUTPUTS_INCOMPLETE'), { outputCount: 3 }),
  runeCase('contradictory-count-and-balances', 'An input claims no runes while listing one.', [RUNE_SPEND_1], [{ indexed: true, runes: 0, balances: [{ runeId: '840000:1', amount: '5' }] }], refused('NONE', 'MALFORMED_RUNE_BALANCE')),
];

const runeCases = [...LEGACY_RUNE_CASES, ...runeParityCases, ...runeAllocationCases];

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

writeVectors('../conformance/rune-burn-vectors.json', {
  version: 1,
  description:
    'Conformance vectors for the Ordex rune burn rule. Each case names the output scripts of a final transaction, what the rune index reports about each input being spent, and the exact verdict a compatible verifier must reach. Deciphered fields and allocations match ord 0.29.0 (commit 7e37a3bd), checked by conformance/ord-differential. The rules verified here are stated in spec/runes.md.',
  cases: runeCases,
});

console.log('conformance vectors regenerated');
