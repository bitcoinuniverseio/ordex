// Regenerates the v1.2 conformance vector files. Run from the repo root:
//   node scripts/make-vectors.mjs
// The vector files are committed; this script exists so fixture digests and
// Merkle roots are recomputed by the same code the verifiers use instead of
// being maintained by hand.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { bytesToHex, hexToBytes, serializeTransaction } from '../verifier/bitcoin-tx.js';
import {
  OFFER_ACCEPTANCE_SCHEMA,
  OFFER_RECOVERY_SCHEMA,
  OFFER_TERMS_SCHEMA,
  buildTraitMemberProof,
  offerCriteriaHash,
  offerOutputTree,
  offerTermsHash,
} from '../verifier/offers.js';
import { publicKeyXFromScalar } from '../verifier/secp256k1.js';
import {
  SAFEOPS_PLAN_SCHEMA,
  SAFEOPS_SIGNED_RESULT_SCHEMA,
  safeopsPlanDigest,
  safeopsUnsignedTransaction,
} from '../verifier/safeops.js';
import {
  encodePsbt,
  p2trKeyPath,
  p2wpkhScript,
  signP2wpkh,
  signTaprootKeyPath,
  signTaprootScriptPath,
  testKey,
} from './vector-signer.mjs';
import { SWAP_INTENT_SCHEMA, SWAP_ACCEPTANCE_SCHEMA, SWAP_SIGNED_TRANSACTION_SCHEMA, swapAcceptanceDigest, swapIntentDigest, swapUnsignedTransaction } from '../verifier/swaps.js';
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
  manifestUnsignedTransaction,
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

// OX-P03: cold signing v2 fixtures carry real signatures over the exact
// presented transaction, as a raw transaction or as a PSBT v0 or v2.
const COLD_USER_KEY = testKey('cold-user-taproot');
const COLD_USER_TR = p2trKeyPath(COLD_USER_KEY).scriptHex;
const COLD_SEGWIT_KEY = testKey('cold-user-segwit');
const COLD_USER_WPKH = p2wpkhScript(COLD_SEGWIT_KEY);
const COLD_SELLER_KEY = testKey('cold-seller-taproot');
const COLD_SELLER_TR = p2trKeyPath(COLD_SELLER_KEY).scriptHex;
const COLD_KEYS = { [COLD_USER_TR]: COLD_USER_KEY, [COLD_USER_WPKH]: COLD_SEGWIT_KEY, [COLD_SELLER_TR]: COLD_SELLER_KEY };
const COLD_OBSERVED = [{ assetType: 'ORDINAL', assetId: INSCRIPTION, quantity: '1', outputIndex: 0 }];

const coldInput = (outpoint, valueSats, scriptPubKeyHex, sighashType, explanation, extra = {}) => ({
  txid: outpoint.txid,
  vout: outpoint.vout,
  sequence: 0xfffffffd,
  valueSats,
  scriptPubKeyHex,
  controlledByUser: true,
  sighashType,
  explanation,
  ...extra,
});

function signingManifest(overrides = {}) {
  const manifest = {
    schema: EXPECTED_TRANSACTION_MANIFEST_SCHEMA,
    network: 'mainnet',
    purpose: 'Transfer one inscription and pay one recipient.',
    watchOnly: false,
    unsignedTx: {
      version: 2,
      lockTime: 0,
      inputs: [
        coldInput(OUTPOINT_A, '50000', COLD_USER_TR, 'DEFAULT', 'Your sealed inscription output, spent whole.'),
        coldInput(OUTPOINT_B, '30000', COLD_USER_WPKH, 'ALL', 'Cardinal change funding the fee.'),
      ],
      outputs: [
        {
          scriptHex: SCRIPT_P2TR,
          valueSats: '10000',
          role: 'recipient',
          explanation: 'The buyer receives the inscription here.',
          expectedAssets: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, quantity: '1' }],
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

/**
 * A purchase: buyer padding first, then the seller input already signed
 * SINGLE|ANYONECANPAY for its payout at the same index, then the payment.
 */
function purchaseManifest(overrides = {}) {
  const tx = {
    version: 2,
    lockTime: 0,
    inputs: [
      { txid: OUTPOINT_A.txid, vout: OUTPOINT_A.vout, scriptSigHex: '', sequence: 0xfffffffd, witness: [] },
      { txid: OUTPOINT_C.txid, vout: OUTPOINT_C.vout, scriptSigHex: '', sequence: 0xffffffff, witness: [] },
      { txid: OUTPOINT_B.txid, vout: OUTPOINT_B.vout, scriptSigHex: '', sequence: 0xfffffffd, witness: [] },
    ],
    outputs: [
      { valueSats: '10600', scriptHex: SCRIPT_P2TR },
      { valueSats: '40000', scriptHex: SCRIPT_P2WPKH },
    ],
  };
  const prevouts = [
    { valueSats: '600', scriptHex: COLD_USER_WPKH },
    { valueSats: '10000', scriptHex: COLD_SELLER_TR },
    { valueSats: '40600', scriptHex: COLD_USER_WPKH },
  ];
  const sellerSignature = signTaprootKeyPath(tx, 1, prevouts, COLD_SELLER_KEY, 0x83);
  const manifest = {
    schema: EXPECTED_TRANSACTION_MANIFEST_SCHEMA,
    network: 'mainnet',
    purpose: 'Buy one inscription from a signed ask.',
    watchOnly: false,
    unsignedTx: {
      version: 2,
      lockTime: 0,
      inputs: [
        coldInput(OUTPOINT_A, '600', COLD_USER_WPKH, 'ALL', 'Your padding, which carries the inscription into your output.'),
        {
          txid: OUTPOINT_C.txid,
          vout: OUTPOINT_C.vout,
          sequence: 0xffffffff,
          valueSats: '10000',
          scriptPubKeyHex: COLD_SELLER_TR,
          controlledByUser: false,
          explanation: 'The seller spends the inscription output, already signed.',
          preservedSignature: { scriptSigHex: '', witness: [sellerSignature] },
        },
        coldInput(OUTPOINT_B, '40600', COLD_USER_WPKH, 'ALL', 'Your payment.'),
      ],
      outputs: [
        {
          scriptHex: SCRIPT_P2TR,
          valueSats: '10600',
          role: 'recipient',
          explanation: 'You receive the inscription here.',
          expectedAssets: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, quantity: '1' }],
        },
        { scriptHex: SCRIPT_P2WPKH, valueSats: '40000', role: 'payout', explanation: 'The seller is paid here.' },
      ],
    },
    fee: { feeSats: '600', maxFeeSats: '1000' },
    ...overrides,
  };
  manifest.digest = expectedTransactionDigest(manifest);
  return manifest;
}

function signedFor(manifest, { form = 'tx', beforeSign, afterSign, hashTypes = {}, skip = [], observedAssets = COLD_OBSERVED, extra = {} } = {}) {
  const tx = manifestUnsignedTransaction(manifest);
  if (beforeSign) beforeSign(tx);
  const prevouts = manifest.unsignedTx.inputs.map((input) => ({ valueSats: input.valueSats, scriptHex: input.scriptPubKeyHex }));
  const psbtInputs = prevouts.map((prevout) => ({ witnessUtxo: prevout }));
  manifest.unsignedTx.inputs.forEach((input, i) => {
    if (!input.controlledByUser) {
      if (input.preservedSignature) {
        tx.inputs[i].witness = input.preservedSignature.witness.slice();
        psbtInputs[i].finalWitness = input.preservedSignature.witness.slice();
      }
      return;
    }
    if (skip.includes(i)) return;
    const key = COLD_KEYS[input.scriptPubKeyHex];
    if (input.scriptPubKeyHex.startsWith('5120')) {
      const signature = signTaprootKeyPath(tx, i, prevouts, key, hashTypes[i] ?? 0x00);
      tx.inputs[i].witness = [signature];
      psbtInputs[i].tapKeySig = signature;
    } else {
      const [signature, pubkey] = signP2wpkh(tx, i, prevouts, key, hashTypes[i] ?? 0x01);
      tx.inputs[i].witness = [signature, pubkey];
      psbtInputs[i].partialSigs = [{ pubkey, sig: signature }];
    }
  });
  if (afterSign) afterSign(tx, psbtInputs);
  const result = {
    schema: OFFLINE_SIGNING_SESSION_SCHEMA,
    manifestDigest: manifest.digest,
    ...(form === 'tx'
      ? { signedTxHex: bytesToHex(serializeTransaction(tx)) }
      : { psbt: encodePsbt({ version: form === 'psbt2' ? 2 : 0, tx, inputs: psbtInputs }) }),
    ...(observedAssets ? { observedAssets } : {}),
    ...extra,
  };
  return result;
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

// OX-P02: swap acceptance v2 fixtures. Inventories are what the authorities
// report for each input; the verifier derives every movement from them.
const SWAP_MAKER_KEY = testKey('swap-maker');
const SWAP_MAKER_TR = p2trKeyPath(SWAP_MAKER_KEY).scriptHex;
const SWAP_TAKER_KEY = testKey('swap-taker');
const SWAP_TAKER_WPKH = p2wpkhScript(SWAP_TAKER_KEY);
const SWAP_TAKER_RECEIVE = '5120' + '7'.repeat(64);
const SWAP_TAKER_CHANGE = '0014' + '8'.repeat(40);
const SWAP_STRANGER = '0014' + '9'.repeat(40);
const RARE_RANGE = 'uncommon-938263';
const SWAP_ADAPTERS = [
  { protocol: 'ordinals', version: '1.2' },
  { protocol: 'runes', version: '1.2' },
];

function swapIntent(gives, requires, overrides = {}) {
  return baseIntent({ gives, requires, adapterVersions: SWAP_ADAPTERS, ...overrides });
}

const swapInput = (outpoint, party, valueSats, scriptPubKeyHex, inventory = { examined: true }) => ({
  outpoint,
  party,
  valueSats,
  scriptPubKeyHex,
  sequence: 0xfffffffd,
  inventory,
});

function acceptanceV2(intent, { inputs, outputs, transitions = [], makerFeeSats, takerFeeSats, feeSats, overrides = {} }) {
  const acceptance = {
    schema: SWAP_ACCEPTANCE_SCHEMA,
    intentDigest: intent.digest,
    network: intent.network,
    checkpoint: { height: 900005, blockHash: BLOCK_HASH },
    taker: { receiveScriptHex: SWAP_TAKER_RECEIVE, changeScriptHex: SWAP_TAKER_CHANGE },
    transaction: { version: 2, lockTime: 0 },
    tx: { inputs, outputs },
    assetTransitions: transitions,
    fee: { feeSats, makerFeeSats, takerFeeSats },
    signing: { sighashPolicy: 'ALL' },
    ...overrides,
  };
  acceptance.digest = swapAcceptanceDigest(acceptance);
  return acceptance;
}

// BTC for an inscription: the maker pays 100000 and the whole fee.
const btcForOrdinalIntent = () =>
  swapIntent(
    [{ assetType: 'BTC', outpoint: OUTPOINT_A, quantitySats: '100000' }],
    [{ assetType: 'ORDINAL', assetId: INSCRIPTION, minQuantitySats: '1' }],
  );
function btcForOrdinal(mutate) {
  const intent = btcForOrdinalIntent();
  const parts = {
    inputs: [
      swapInput(OUTPOINT_B, 'taker', '10000', SWAP_TAKER_WPKH, { examined: true, inscriptions: [{ inscriptionId: INSCRIPTION, offset: '0' }] }),
      swapInput(OUTPOINT_A, 'maker', '101000', SWAP_MAKER_TR),
    ],
    outputs: [
      { scriptHex: intent.makerReceiveScriptHex, valueSats: '10000' },
      { scriptHex: SWAP_TAKER_RECEIVE, valueSats: '100000' },
      { scriptHex: intent.makerReceiveScriptHex, valueSats: '400' },
    ],
    transitions: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput: 0, quantity: '1' }],
    feeSats: '600',
    makerFeeSats: '600',
    takerFeeSats: '0',
  };
  if (mutate) mutate(parts, intent);
  return { intent, acceptance: acceptanceV2(intent, parts) };
}

// An inscription for BTC: the taker pays 50000 and the fee.
const ordinalForBtcIntent = () =>
  swapIntent(
    [{ assetType: 'ORDINAL', assetId: INSCRIPTION, outpoint: OUTPOINT_C, quantitySats: '1' }],
    [{ assetType: 'BTC', minQuantitySats: '50000' }],
  );
function ordinalForBtc(mutate) {
  const intent = ordinalForBtcIntent();
  const parts = {
    inputs: [
      swapInput(OUTPOINT_C, 'maker', '10000', SWAP_MAKER_TR, { examined: true, inscriptions: [{ inscriptionId: INSCRIPTION, offset: '0' }] }),
      swapInput(OUTPOINT_B, 'taker', '60000', SWAP_TAKER_WPKH),
    ],
    outputs: [
      { scriptHex: SWAP_TAKER_RECEIVE, valueSats: '10000' },
      { scriptHex: intent.makerReceiveScriptHex, valueSats: '50000' },
      { scriptHex: SWAP_TAKER_CHANGE, valueSats: '9400' },
    ],
    transitions: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput: 0, quantity: '1' }],
    feeSats: '600',
    makerFeeSats: '0',
    takerFeeSats: '600',
  };
  if (mutate) mutate(parts, intent);
  return { intent, acceptance: acceptanceV2(intent, parts) };
}

// BTC for 500 of rune 840000:1. The taker holds 800 and keeps 300 by pointer.
const RUNESTONE_500_TO_MAKER = '6a5d0a1602' + '00c0a23301f40301';
const btcForRuneIntent = (runeId = '840000:1') =>
  swapIntent(
    [{ assetType: 'BTC', outpoint: OUTPOINT_A, quantitySats: '20000' }],
    [{ assetType: 'RUNE', assetId: runeId, minQuantitySats: '500' }],
  );
function btcForRune(mutate, runeId) {
  const intent = btcForRuneIntent(runeId);
  const parts = {
    inputs: [
      swapInput(OUTPOINT_A, 'maker', '21000', SWAP_MAKER_TR),
      swapInput(OUTPOINT_B, 'taker', '546', SWAP_TAKER_WPKH, { examined: true, runeAllocations: [{ runeId: '840000:1', amount: '800' }] }),
    ],
    outputs: [
      { scriptHex: RUNESTONE_500_TO_MAKER, valueSats: '0' },
      { scriptHex: intent.makerReceiveScriptHex, valueSats: '546' },
      { scriptHex: SWAP_TAKER_RECEIVE, valueSats: '20000' },
      { scriptHex: intent.makerReceiveScriptHex, valueSats: '400' },
    ],
    transitions: [
      { assetType: 'RUNE', assetId: '840000:1', toOutput: 1, quantity: '500' },
      { assetType: 'RUNE', assetId: '840000:1', toOutput: 2, quantity: '300' },
    ],
    feeSats: '600',
    makerFeeSats: '54',
    takerFeeSats: '546',
  };
  if (mutate) mutate(parts, intent);
  return { intent, acceptance: acceptanceV2(intent, parts) };
}

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
  ...(() => {
    const accepted = (name, built) => ({ name, intent: built.intent, acceptance: built.acceptance, expected: { ok: true } });
    const refused = (name, built, code) => ({ name, intent: built.intent, acceptance: built.acceptance, expected: { ok: false, code } });
    return [
      accepted('BTC for an inscription settles with the inscription at the maker', btcForOrdinal()),
      accepted('an inscription for BTC settles with the inscription at the taker', ordinalForBtc()),
      accepted('BTC for a rune settles with the exact rune amount at the maker', btcForRune()),
      refused(
        'an acceptance plan from a different intent is refused',
        btcForOrdinal((parts) => {
          parts.overrides = { intentDigest: 'f'.repeat(64) };
        }),
        'INTENT_DIGEST_MISMATCH',
      ),
      refused(
        'a v1 acceptance plan is refused rather than reinterpreted',
        btcForOrdinal((parts) => {
          parts.overrides = { schema: 'ordex.swap-acceptance-plan/v1' };
        }),
        'SCHEMA_UNSUPPORTED',
      ),
      refused(
        'a one sided transaction cannot settle atomically',
        btcForOrdinal((parts) => {
          parts.inputs = [parts.inputs[1]];
        }),
        'ATOMICITY_IMPOSSIBLE',
      ),
      refused(
        'a sighash that does not close the transaction is refused',
        btcForOrdinal((parts) => {
          parts.overrides = { signing: { sighashPolicy: 'SINGLE|ANYONECANPAY' } };
        }),
        'UNCLOSED_SIGHASH',
      ),
      refused(
        'an acceptance plan that drops a committed outpoint is refused',
        btcForOrdinal((parts) => {
          parts.inputs[1] = swapInput(OUTPOINT_D, 'maker', '101000', SWAP_MAKER_TR);
        }),
        'MAKER_OUTPOINT_MISSING',
      ),
      refused(
        'a maker input the intent never committed is refused',
        btcForOrdinal((parts) => {
          parts.inputs.push(swapInput(OUTPOINT_D, 'maker', '1000', SWAP_MAKER_TR));
        }),
        'UNEXPECTED_MAKER_INPUT',
      ),
      refused(
        'P-R09: a required rune the taker never supplies is refused',
        btcForRune(undefined, '1:999'),
        'CONSIDERATION_SHORTFALL',
      ),
      refused(
        'a required rune delivered short is refused',
        btcForRune((parts) => {
          parts.outputs[0] = { scriptHex: '6a5d0a1602' + '00c0a23301900301', valueSats: '0' };
          parts.transitions = [
            { assetType: 'RUNE', assetId: '840000:1', toOutput: 1, quantity: '400' },
            { assetType: 'RUNE', assetId: '840000:1', toOutput: 2, quantity: '400' },
          ];
        }),
        'CONSIDERATION_SHORTFALL',
      ),
      refused(
        'P-R10: an inscription the maker gives, paid back to the maker, is refused',
        ordinalForBtc((parts, intent) => {
          parts.outputs[0] = { scriptHex: intent.makerReceiveScriptHex, valueSats: '10000' };
        }),
        'MAKER_ASSET_NOT_DELIVERED',
      ),
      refused(
        'a taker receiving at a maker script is refused',
        ordinalForBtc((parts, intent) => {
          parts.overrides = { taker: { receiveScriptHex: intent.makerReceiveScriptHex } };
        }),
        'PARTY_SCRIPTS_OVERLAP',
      ),
      refused(
        'BTC below the requirement is refused',
        ordinalForBtc((parts) => {
          parts.outputs[1] = { ...parts.outputs[1], valueSats: '48000' };
          parts.outputs[2] = { ...parts.outputs[2], valueSats: '11400' };
          parts.makerFeeSats = '2000';
          parts.takerFeeSats = '0';
        }),
        'CONSIDERATION_SHORTFALL',
      ),
      refused(
        'a maker fee above the intent budget is refused',
        btcForOrdinal((parts, intent) => {
          intent.maxMakerFeeSats = '500';
          intent.digest = swapIntentDigest(intent);
        }),
        'FEE_BUDGET_EXCEEDED',
      ),
      refused(
        'a declared fee split that is not the value flow is refused',
        btcForOrdinal((parts) => {
          parts.makerFeeSats = '0';
          parts.takerFeeSats = '600';
        }),
        'FEE_SPLIT_INVALID',
      ),
      refused(
        'an output to neither party is refused',
        btcForOrdinal((parts) => {
          parts.outputs[2] = { scriptHex: SWAP_STRANGER, valueSats: '400' };
        }),
        'OUTPUT_UNOWNED',
      ),
      refused(
        'a maker outpoint that does not carry what it gives is refused',
        ordinalForBtc((parts) => {
          parts.inputs[0] = swapInput(OUTPOINT_C, 'maker', '10000', SWAP_MAKER_TR);
          parts.transitions = [];
        }),
        'GIVE_NOT_HELD',
      ),
      refused(
        'a taker asset nobody traded, landing with the maker, is refused',
        ordinalForBtc((parts) => {
          parts.inputs[1] = swapInput(OUTPOINT_B, 'taker', '60000', SWAP_TAKER_WPKH, {
            examined: true,
            rareSatRanges: [{ rangeId: RARE_RANGE, offset: '0', count: '1' }],
          });
          parts.transitions.push({ assetType: 'RARE_SAT', assetId: RARE_RANGE, fromInput: 1, toOutput: 1, quantity: '1' });
        }),
        'ASSET_MISDIRECTED',
      ),
      refused(
        'a transition that states the wrong output is refused',
        ordinalForBtc((parts) => {
          parts.transitions = [{ assetType: 'ORDINAL', assetId: INSCRIPTION, fromInput: 0, toOutput: 2, quantity: '1' }];
        }),
        'TRANSITION_MISMATCH',
      ),
      refused(
        'an inscription requirement with a quantity other than 1 is refused',
        btcForOrdinal((parts, intent) => {
          intent.requires = [{ assetType: 'ORDINAL', assetId: INSCRIPTION, minQuantitySats: '80000' }];
          intent.digest = swapIntentDigest(intent);
          parts.overrides = { intentDigest: intent.digest };
        }),
        'QUANTITY_UNSUPPORTED',
      ),
      refused(
        'an intent relying on an adapter this verifier does not run is refused',
        btcForRune((parts, intent) => {
          intent.adapterVersions = [{ protocol: 'ordinals', version: '1.2' }];
          intent.digest = swapIntentDigest(intent);
          parts.overrides = { intentDigest: intent.digest };
        }),
        'ADAPTER_UNSUPPORTED',
      ),
      refused(
        'a plan that could only confirm after the intent expires is refused',
        btcForOrdinal((parts) => {
          parts.overrides = { checkpoint: { height: 900099, blockHash: BLOCK_HASH } };
        }),
        'INTENT_EXPIRED',
      ),
      refused(
        'a taker-bound intent needs that taker identity',
        btcForOrdinal((parts, intent) => {
          intent.visibility = 'PRIVATE';
          intent.takerBinding = { address: 'bc1qboundtaker0000000000000000000000000000' };
          intent.digest = swapIntentDigest(intent);
          parts.overrides = { intentDigest: intent.digest };
        }),
        'TAKER_BINDING_MISMATCH',
      ),
      refused(
        'an acceptance whose digest was edited is refused',
        (() => {
          const built = btcForOrdinal();
          built.acceptance.digest = 'e'.repeat(64);
          return built;
        })(),
        'DIGEST_MISMATCH',
      ),
    ];
  })(),
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
const WEBHOOK_SECRET_NEXT = `whsec_${createHash('sha256').update('ordex-test-webhook-rotation', 'utf8').digest('base64url')}`;
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
  // OX-P11: rotation overlap signs with every unexpired secret, and a stored
  // hash of a secret is never a signing key.
  {
    name: 'a delivery signed during a rotation overlap verifies with the previous secret',
    signing: { secrets: [WEBHOOK_SECRET_NEXT, WEBHOOK_SECRET], timestamp: 1787400000, deliveryId: 'evt_0002', body: '{"ok":true}' },
    verifying: { secret: WEBHOOK_SECRET, body: '{"ok":true}', nowSeconds: 1787400100, toleranceSeconds: 300 },
    expected: { ok: true },
  },
  {
    name: 'a delivery signed during a rotation overlap verifies with the new secret',
    signing: { secrets: [WEBHOOK_SECRET_NEXT, WEBHOOK_SECRET], timestamp: 1787400000, deliveryId: 'evt_0002', body: '{"ok":true}' },
    verifying: { secret: WEBHOOK_SECRET_NEXT, body: '{"ok":true}', nowSeconds: 1787400100, toleranceSeconds: 300 },
    expected: { ok: true },
  },
  {
    name: 'a receiver holding both secrets verifies a delivery signed after the overlap',
    signing: { secret: WEBHOOK_SECRET_NEXT, timestamp: 1787400000, deliveryId: 'evt_0003', body: '{"ok":true}' },
    verifying: { secrets: [WEBHOOK_SECRET, WEBHOOK_SECRET_NEXT], body: '{"ok":true}', nowSeconds: 1787400100, toleranceSeconds: 300 },
    expected: { ok: true },
  },
  {
    name: 'after the overlap the retired secret no longer verifies',
    signing: { secret: WEBHOOK_SECRET_NEXT, timestamp: 1787400000, deliveryId: 'evt_0003', body: '{"ok":true}' },
    verifying: { secret: WEBHOOK_SECRET, body: '{"ok":true}', nowSeconds: 1787400100, toleranceSeconds: 300 },
    expected: { ok: false, code: 'SIGNATURE_INVALID' },
  },
  {
    name: 'a stored hash of the secret is not the signing key',
    signing: { secret: WEBHOOK_SECRET_NEXT, timestamp: 1787400000, deliveryId: 'evt_0004', body: '{"ok":true}' },
    verifying: {
      secret: createHash('sha256').update(WEBHOOK_SECRET_NEXT, 'utf8').digest('hex'),
      body: '{"ok":true}',
      nowSeconds: 1787400100,
      toleranceSeconds: 300,
    },
    expected: { ok: false, code: 'SIGNATURE_INVALID' },
  },
  {
    name: 'a header with two timestamps is refused',
    signing: { secret: WEBHOOK_SECRET, timestamp: 1787400000, deliveryId: 'evt_0001', body: '{"ok":true}' },
    verifying: {
      secret: WEBHOOK_SECRET,
      body: '{"ok":true}',
      nowSeconds: 1787400100,
      toleranceSeconds: 300,
      headerOverride: `t=1787400000,t=1787400050,d=evt_0001,v1=${'0'.repeat(64)}`,
    },
    expected: { ok: false, code: 'HEADER_MALFORMED' },
  },
  {
    name: 'naming both a secret and a secret list is refused',
    signing: { secret: WEBHOOK_SECRET, timestamp: 1787400000, deliveryId: 'evt_0001', body: '{"ok":true}' },
    verifying: { secret: WEBHOOK_SECRET, secrets: [WEBHOOK_SECRET_NEXT], body: '{"ok":true}', nowSeconds: 1787400100, toleranceSeconds: 300 },
    expected: { ok: false, code: 'SECRET_INVALID' },
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
      expected: { ok: true, scope: 'TARGET_BOUND' },
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
    // OX-P09: a revocation binds the exact network and collection of its target.
    {
      name: 'a revocation naming another network is refused',
      manifest,
      revocation: makeRevocation(manifest, { network: 'signet', reason: 'Replayed on another network.' }),
      expected: { ok: false, code: 'REVOCATION_CONTEXT_MISMATCH' },
    },
    {
      name: 'a revocation naming another collection is refused',
      manifest,
      revocation: makeRevocation(manifest, { collectionId: 'unrelated', reason: 'Replayed on another collection.' }),
      expected: { ok: false, code: 'REVOCATION_CONTEXT_MISMATCH' },
    },
    {
      name: 'a revocation checked without its manifest is structure only',
      revocation: makeRevocation(manifest),
      expected: { ok: true, scope: 'STRUCTURE_ONLY' },
    },
    {
      name: 'a revocation without signature material is refused',
      manifest,
      revocation: makeRevocation(manifest, { creatorSignature: { kind: 'bip322', address: manifest.creatorAddress } }),
      expected: { ok: false, code: 'CREATOR_SIGNATURE_INVALID' },
    },
    {
      name: 'a revocation signature that is not base64 is refused',
      manifest,
      revocation: makeRevocation(manifest, { creatorSignature: { kind: 'bip322', address: manifest.creatorAddress, signature: 'not base64!' } }),
      expected: { ok: false, code: 'CREATOR_SIGNATURE_INVALID' },
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
  const purchase = purchaseManifest();
  const tightFeeManifest = signingManifest({ fee: { feeSats: '600', maxFeeSats: '700' } });
  const edit = (mutate) => {
    const m = signingManifest();
    mutate(m);
    m.digest = expectedTransactionDigest(m);
    return m;
  };
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
      manifest: edit((m) => {
        m.unsignedTx.outputs[1] = { ...m.unsignedTx.outputs[1], valueSats: '69401' };
      }),
      expected: { ok: false, code: 'VALUE_NOT_CONSERVED' },
    },
    {
      name: 'a dust recipient output is refused',
      manifest: edit((m) => {
        m.unsignedTx.outputs = [
          { scriptHex: SCRIPT_P2TR, valueSats: '100', role: 'recipient', explanation: 'Too small to send.' },
          { scriptHex: SCRIPT_P2WPKH, valueSats: '79300', role: 'change', explanation: 'Your change.' },
        ];
      }),
      expected: { ok: false, code: 'DUST_OUTPUT' },
    },
    {
      name: 'the same outpoint presented twice is refused',
      manifest: edit((m) => {
        m.unsignedTx.inputs[1] = { ...m.unsignedTx.inputs[1], txid: OUTPOINT_A.txid, vout: OUTPOINT_A.vout };
      }),
      expected: { ok: false, code: 'INPUT_DUPLICATED' },
    },
    {
      name: 'a user input without its approved sighash is refused',
      manifest: edit((m) => {
        delete m.unsignedTx.inputs[0].sighashType;
      }),
      expected: { ok: false, code: 'SIGNING_POLICY_INVALID' },
    },
    {
      name: 'a manifest that does not fix version and locktime is refused',
      manifest: edit((m) => {
        delete m.unsignedTx.lockTime;
      }),
      expected: { ok: false, code: 'TRANSACTION_INVALID' },
    },
    {
      name: 'an expected asset without a quantity is refused',
      manifest: edit((m) => {
        m.unsignedTx.outputs[0].expectedAssets = [{ assetType: 'ORDINAL', assetId: INSCRIPTION }];
      }),
      expected: { ok: false, code: 'ASSET_EXPECTATION_INVALID' },
    },
    {
      name: 'a v1 manifest is refused rather than reinterpreted',
      manifest: edit((m) => {
        m.schema = 'ordex.expected-transaction-manifest/v1';
      }),
      expected: { ok: false, code: 'SCHEMA_UNSUPPORTED' },
    },
    {
      name: 'a signed transaction matching the manifest is accepted',
      manifest,
      signed: signedFor(manifest),
      expected: { ok: true },
    },
    {
      name: 'a signed PSBT v0 matching the manifest is accepted',
      manifest,
      signed: signedFor(manifest, { form: 'psbt0' }),
      expected: { ok: true },
    },
    {
      name: 'a signed PSBT v2 matching the manifest is accepted',
      manifest,
      signed: signedFor(manifest, { form: 'psbt2' }),
      expected: { ok: true },
    },
    {
      name: 'a purchase that preserves the seller signature is accepted',
      manifest: purchase,
      signed: signedFor(purchase),
      expected: { ok: true },
    },
    {
      name: 'a purchase PSBT that preserves the seller signature is accepted',
      manifest: purchase,
      signed: signedFor(purchase, { form: 'psbt0' }),
      expected: { ok: true },
    },
    {
      name: 'a signed result from a different manifest is refused',
      manifest,
      signed: signedFor(tightFeeManifest),
      expected: { ok: false, code: 'MANIFEST_DIGEST_MISMATCH' },
    },
    {
      name: 'a reordered input is refused',
      manifest,
      signed: signedFor(manifest, {
        afterSign: (tx) => {
          tx.inputs = [tx.inputs[1], tx.inputs[0]];
        },
      }),
      expected: { ok: false, code: 'INPUT_REORDERED' },
    },
    {
      name: 'an added output is refused',
      manifest,
      signed: signedFor(manifest, {
        afterSign: (tx) => {
          tx.outputs.push({ scriptHex: SCRIPT_P2TR, valueSats: '330' });
        },
      }),
      expected: { ok: false, code: 'OUTPUT_SET_CHANGED' },
    },
    {
      name: 'a changed output script is refused',
      manifest,
      signed: signedFor(manifest, {
        afterSign: (tx) => {
          tx.outputs[0] = { scriptHex: SCRIPT_P2WPKH, valueSats: '10000' };
        },
      }),
      expected: { ok: false, code: 'SCRIPT_CHANGED' },
    },
    {
      name: 'a fee outside the approved bound is refused',
      manifest: tightFeeManifest,
      signed: signedFor(tightFeeManifest, {
        afterSign: (tx) => {
          tx.outputs[1] = { scriptHex: SCRIPT_P2WPKH, valueSats: '69100' };
        },
      }),
      expected: { ok: false, code: 'FEE_OUT_OF_BOUNDS' },
    },
    {
      name: 'P-R12: a changed sequence is refused',
      manifest,
      signed: signedFor(manifest, {
        afterSign: (tx) => {
          tx.inputs[0].sequence = 0xffffffff;
        },
      }),
      expected: { ok: false, code: 'SEQUENCE_CHANGED' },
    },
    {
      name: 'P-R12: a changed locktime is refused',
      manifest,
      signed: signedFor(manifest, {
        afterSign: (tx) => {
          tx.lockTime = 500000000;
        },
      }),
      expected: { ok: false, code: 'TRANSACTION_CHANGED' },
    },
    {
      name: 'P-R12: a changed version is refused',
      manifest,
      signed: signedFor(manifest, {
        afterSign: (tx) => {
          tx.version = 1;
        },
      }),
      expected: { ok: false, code: 'TRANSACTION_CHANGED' },
    },
    {
      name: 'a missing user signature is refused',
      manifest,
      signed: signedFor(manifest, { skip: [0] }),
      expected: { ok: false, code: 'REQUIRED_SIGNATURE_MISSING' },
    },
    {
      name: 'a signature made over another transaction is refused',
      manifest,
      signed: signedFor(manifest, {
        beforeSign: (tx) => {
          tx.outputs[1].valueSats = '69399';
        },
        afterSign: (tx) => {
          tx.outputs[1].valueSats = '69400';
        },
      }),
      expected: { ok: false, code: 'SIGNATURE_INVALID' },
    },
    {
      name: 'an unapproved sighash is refused',
      manifest,
      signed: signedFor(manifest, { hashTypes: { 0: 0x01 } }),
      expected: { ok: false, code: 'SIGHASH_UNEXPECTED' },
    },
    {
      name: 'a PSBT naming a different spent output is refused',
      manifest,
      signed: signedFor(manifest, {
        form: 'psbt0',
        afterSign: (tx, psbtInputs) => {
          psbtInputs[1].witnessUtxo = { valueSats: '30001', scriptHex: COLD_USER_WPKH };
        },
      }),
      expected: { ok: false, code: 'PREVOUT_MISMATCH' },
    },
    {
      name: 'a protected asset that moved elsewhere is refused',
      manifest,
      signed: signedFor(manifest, { observedAssets: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, quantity: '1', outputIndex: 1 }] }),
      expected: { ok: false, code: 'PROTECTED_ASSET_MISPLACED' },
    },
    {
      name: 'a protected asset observed with another quantity is refused',
      manifest,
      signed: signedFor(manifest, { observedAssets: [{ assetType: 'ORDINAL', assetId: INSCRIPTION, quantity: '2', outputIndex: 0 }] }),
      expected: { ok: false, code: 'PROTECTED_ASSET_MISPLACED' },
    },
    {
      name: 'P-R11: a result without protected asset observations is refused',
      manifest,
      signed: signedFor(manifest, { observedAssets: null }),
      expected: { ok: false, code: 'PROTECTED_ASSET_OBSERVATION_MISSING' },
    },
    {
      name: 'the seller signature changed after it was presented is refused',
      manifest: purchase,
      signed: signedFor(purchase, {
        afterSign: (tx) => {
          tx.inputs[1].witness = [tx.inputs[1].witness[0].slice(0, -2) + '81'];
        },
      }),
      expected: { ok: false, code: 'FOREIGN_SIGNATURE_CHANGED' },
    },
    {
      name: 'a signature on a foreign input is refused',
      manifest: (() => {
        const m = signingManifest();
        m.unsignedTx.inputs[1] = { ...m.unsignedTx.inputs[1], controlledByUser: false };
        delete m.unsignedTx.inputs[1].sighashType;
        m.digest = expectedTransactionDigest(m);
        return m;
      })(),
      signed: (() => {
        const m = signingManifest();
        const tx = manifestUnsignedTransaction(m);
        const prevouts = m.unsignedTx.inputs.map((input) => ({ valueSats: input.valueSats, scriptHex: input.scriptPubKeyHex }));
        tx.inputs[0].witness = [signTaprootKeyPath(tx, 0, prevouts, COLD_USER_KEY)];
        tx.inputs[1].witness = signP2wpkh(tx, 1, prevouts, COLD_SEGWIT_KEY);
        const foreign = { ...m.unsignedTx.inputs[1], controlledByUser: false };
        delete foreign.sighashType;
        m.unsignedTx.inputs[1] = foreign;
        return {
          schema: OFFLINE_SIGNING_SESSION_SCHEMA,
          manifestDigest: expectedTransactionDigest(m),
          signedTxHex: bytesToHex(serializeTransaction(tx)),
          observedAssets: COLD_OBSERVED,
        };
      })(),
      expected: { ok: false, code: 'SIGNATURE_ON_FOREIGN_INPUT' },
    },
    {
      name: 'an unknown critical field is refused',
      manifest,
      signed: signedFor(manifest, { extra: { unknownCriticalFields: ['proprietary.key.mystery'] } }),
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

// ---------------------------------------------------------------------------
// OX-P05: funded offer fixtures. The funded output commits to the exact
// acceptance and recovery leaves, and every signature is made with test keys:
// both policy signers, the seller, and the buyer recovery key.

const OFFER_POLICY_A = testKey('offer-policy-a');
const OFFER_POLICY_B = testKey('offer-policy-b');
const OFFER_RECOVERY_KEY = testKey('offer-buyer-recovery');
const OFFER_SELLER_KEY = testKey('offer-seller');
const xOnlyHex = (scalar) => bytesToHex(publicKeyXFromScalar(scalar).x);
const OFFER_POLICY_KEYS = [xOnlyHex(OFFER_POLICY_A), xOnlyHex(OFFER_POLICY_B)];
const OFFER_SELLER_TR = p2trKeyPath(OFFER_SELLER_KEY).scriptHex;
const OFFER_SELLER_PAY = p2wpkhScript(testKey('offer-seller-pay'));
const OFFER_BUYER_RECEIVE = p2trKeyPath(testKey('offer-buyer')).scriptHex;
const OFFER_STRANGER = '0014' + '9'.repeat(40);
const OFFER_COLLECTION = 'forked-felines';
const felineId = (n) => `${'f'.repeat(63)}${n}i0`;
const OFFER_MEMBERS = [1, 2, 3, 4, 5].map(felineId);
const OFFER_ROOT = membershipRoot(OFFER_COLLECTION, OFFER_MEMBERS);
const OFFER_FELINE = OFFER_MEMBERS[1];
const OFFER_OTHER_INSCRIPTION = `${'c'.repeat(64)}i3`;
const OFFER_TRAIT_MEMBERS = [OFFER_MEMBERS[1], OFFER_MEMBERS[3]];
const OFFER_FUNDED_OUTPOINT = { txid: '1'.repeat(64), vout: 1 };
const OFFER_FELINE_OUTPOINT = { txid: '2'.repeat(64), vout: 0 };
const OFFER_PADDING_OUTPOINT = { txid: '3'.repeat(64), vout: 0 };
const OFFER_HEIGHT = 900000;
const OFFER_EXPIRY = 900100;

function offerTerms(overrides = {}) {
  const terms = {
    schema: OFFER_TERMS_SCHEMA,
    protocolVersion: '1.1',
    network: 'signet',
    offerKind: 'ITEM',
    collectionId: OFFER_COLLECTION,
    collectionRoot: OFFER_ROOT,
    itemInscriptionId: OFFER_FELINE,
    buyerReceiveScriptHex: OFFER_BUYER_RECEIVE,
    priceSats: '90000',
    maxNetworkFeeSats: '2000',
    expiryHeight: OFFER_EXPIRY,
    buyerRecoveryKeyHex: xOnlyHex(OFFER_RECOVERY_KEY),
    ...overrides,
  };
  for (const key of Object.keys(terms)) if (terms[key] === undefined) delete terms[key];
  if (!('criteriaHash' in overrides)) terms.criteriaHash = offerCriteriaHash(terms, OFFER_TRAIT_MEMBERS);
  return terms;
}
const traitTerms = (overrides = {}) =>
  offerTerms({ offerKind: 'TRAIT', itemInscriptionId: undefined, traitName: 'eyes', traitValue: 'laser', ...overrides });

function fundedOffer(terms, { policyKeysHex = OFFER_POLICY_KEYS, valueSats = '93000', currentHeight = OFFER_HEIGHT, treeKeys } = {}) {
  const tree = offerOutputTree(terms, treeKeys || policyKeysHex);
  return {
    terms,
    policyKeysHex,
    fundedOutput: { outpoint: OFFER_FUNDED_OUTPOINT, valueSats, scriptPubKeyHex: tree.scriptPubKeyHex },
    currentHeight,
  };
}

const offerOut = (scriptHex, valueSats) => ({ scriptHex, valueSats });
const felineInput = (valueSats = '546', inscriptions = [{ inscriptionId: OFFER_FELINE, offset: '0' }], extra = {}) => ({
  outpoint: OFFER_FELINE_OUTPOINT,
  party: 'SELLER',
  valueSats,
  scriptPubKeyHex: OFFER_SELLER_TR,
  inventory: { examined: true, inscriptions, ...extra },
  key: OFFER_SELLER_KEY,
});
const fundedInput = (offer) => ({
  outpoint: offer.fundedOutput.outpoint,
  party: 'OFFER',
  valueSats: offer.fundedOutput.valueSats,
  scriptPubKeyHex: offer.fundedOutput.scriptPubKeyHex,
  inventory: { examined: true },
});
const standardOutputs = () => [
  offerOut(OFFER_BUYER_RECEIVE, '546'),
  offerOut(OFFER_SELLER_PAY, '90000'),
  offerOut(OFFER_BUYER_RECEIVE, '1500'),
];

function offerEligibility(terms, inscriptionId) {
  return {
    membershipProof: buildMembershipProof(OFFER_COLLECTION, OFFER_MEMBERS, inscriptionId) || [],
    traitProof: terms.offerKind === 'TRAIT' ? buildTraitMemberProof(terms, OFFER_TRAIT_MEMBERS, inscriptionId) || [] : undefined,
  };
}

function offerAcceptance(offer, options = {}) {
  const {
    inputs = [felineInput(), fundedInput(offer)],
    outputs = standardOutputs(),
    lockTime = OFFER_HEIGHT,
    felineInscription = OFFER_FELINE,
    seller = { paymentScriptHex: OFFER_SELLER_PAY, returnScriptHex: OFFER_SELLER_TR },
    eligibility,
    sign = {},
    overrides = {},
  } = options;
  const tx = {
    version: 2,
    lockTime,
    inputs: inputs.map((input) => ({ txid: input.outpoint.txid, vout: input.outpoint.vout, scriptSigHex: '', sequence: input.sequence ?? 0xfffffffd, witness: [] })),
    outputs,
  };
  const prevouts = inputs.map((input) => ({ valueSats: input.valueSats, scriptHex: input.scriptPubKeyHex }));
  const tree = offerOutputTree(offer.terms, offer.policyKeysHex);
  inputs.forEach((input, i) => {
    if (input.party === 'OFFER') {
      const leafHash = hexToBytes(tree.acceptanceLeafHashHex);
      const hashType = sign.policyHashType ?? 0x00;
      const sigA = sign.omitPolicyA ? '' : signTaprootScriptPath(tx, i, prevouts, sign.policyKeyA ?? OFFER_POLICY_A, leafHash, hashType);
      const sigB = sign.omitPolicyB ? '' : signTaprootScriptPath(tx, i, prevouts, sign.policyKeyB ?? OFFER_POLICY_B, leafHash, hashType);
      tx.inputs[i].witness = [sigB, sigA, sign.leafHex ?? tree.acceptanceLeafHex, sign.controlBlockHex ?? tree.acceptanceControlBlockHex];
    } else if (input.key !== undefined && !sign.unsignedSeller) {
      tx.inputs[i].witness = [signTaprootKeyPath(tx, i, prevouts, input.key, sign.sellerHashType ?? 0x00)];
    }
  });
  return {
    schema: OFFER_ACCEPTANCE_SCHEMA,
    network: offer.terms.network,
    seller,
    feline: { inscriptionId: felineInscription, outpoint: OFFER_FELINE_OUTPOINT },
    eligibility: eligibility || offerEligibility(offer.terms, felineInscription),
    inputs: inputs.map(({ outpoint, party, valueSats, scriptPubKeyHex, inventory }) => ({ outpoint, party, valueSats, scriptPubKeyHex, inventory })),
    transactionHex: bytesToHex(serializeTransaction(tx)),
    ...overrides,
  };
}

const acceptanceCase = (name, offer, acceptance, expected) => ({ name, kind: 'acceptance', acceptance, offer, expected });
const acceptedAs = (offer, extra) => ({
  ok: true,
  offerTermsHash: offerTermsHash(offer.terms),
  offerInputIndex: 1,
  felineInputIndex: 0,
  buyerAssetOutputIndex: 0,
  sellerPaymentIndex: 1,
  feeSats: '1500',
  ...extra,
});

const itemOffer = fundedOffer(offerTerms());
const collectionOffer = fundedOffer(offerTerms({ offerKind: 'COLLECTION', itemInscriptionId: undefined }));
const traitOffer = fundedOffer(traitTerms());
const multiAssetInputs = (offer) => [
  felineInput('10000', [
    { inscriptionId: OFFER_OTHER_INSCRIPTION, offset: '0' },
    { inscriptionId: OFFER_FELINE, offset: '5000' },
  ]),
  fundedInput(offer),
];
const multiAssetOutputs = () => [
  offerOut(OFFER_SELLER_TR, '5000'),
  offerOut(OFFER_BUYER_RECEIVE, '5000'),
  offerOut(OFFER_SELLER_PAY, '90000'),
  offerOut(OFFER_BUYER_RECEIVE, '1500'),
];
const flippedParity = (hex) => (hex.startsWith('c0') ? 'c1' : 'c0') + hex.slice(2);
const legacyAcceptance = {
  inputs: [{ txid: OFFER_FELINE_OUTPOINT.txid, vout: 0, valueSats: '546' }],
  outputs: [{ scriptHex: OFFER_BUYER_RECEIVE, valueSats: '546' }],
  policySignatureCount: 2,
  acceptanceLeafScriptHex: offerOutputTree(offerTerms(), OFFER_POLICY_KEYS).acceptanceLeafHex,
};

const withAcceptance = (offer, options) => offerAcceptance(offer, options);
const offerAcceptanceCases = [
  acceptanceCase('a valid ITEM acceptance settles through both policy signers', itemOffer, withAcceptance(itemOffer), acceptedAs(itemOffer)),
  acceptanceCase('a valid COLLECTION acceptance preserves the seller other inscription', collectionOffer, withAcceptance(collectionOffer, { inputs: multiAssetInputs(collectionOffer), outputs: multiAssetOutputs() }), acceptedAs(collectionOffer, { buyerAssetOutputIndex: 1, sellerPaymentIndex: 2 })),
  acceptanceCase('a valid TRAIT acceptance proves the Feline against the committed trait set', traitOffer, withAcceptance(traitOffer), acceptedAs(traitOffer)),
  acceptanceCase('policy signatures with SIGHASH_ALL pass', itemOffer, withAcceptance(itemOffer, { sign: { policyHashType: 0x01 } }), acceptedAs(itemOffer)),
  acceptanceCase('acceptance at the last height before expiry passes', fundedOffer(offerTerms(), { currentHeight: OFFER_EXPIRY - 1 }), withAcceptance(fundedOffer(offerTerms(), { currentHeight: OFFER_EXPIRY - 1 })), acceptedAs(itemOffer)),
  acceptanceCase(
    'seller runes stay with the seller when a seller output comes first',
    itemOffer,
    withAcceptance(itemOffer, {
      inputs: [felineInput('1092', [{ inscriptionId: OFFER_FELINE, offset: '546' }], { runeAllocations: [{ runeId: '840000:1', amount: '500' }] }), fundedInput(itemOffer)],
      outputs: [offerOut(OFFER_SELLER_TR, '546'), offerOut(OFFER_BUYER_RECEIVE, '546'), offerOut(OFFER_SELLER_PAY, '90000'), offerOut(OFFER_BUYER_RECEIVE, '1500')],
    }),
    acceptedAs(itemOffer, { buyerAssetOutputIndex: 1, sellerPaymentIndex: 2 }),
  ),
  acceptanceCase(
    'a buyer script ahead of the payment that does not receive the Feline is refused',
    itemOffer,
    withAcceptance(itemOffer, {
      inputs: [felineInput('1092'), fundedInput(itemOffer)],
      outputs: [offerOut(OFFER_SELLER_TR, '546'), offerOut(OFFER_BUYER_RECEIVE, '546'), offerOut(OFFER_SELLER_PAY, '90000'), offerOut(OFFER_BUYER_RECEIVE, '1500')],
    }),
    { ok: false, code: 'FELINE_NOT_DELIVERED' },
  ),
  acceptanceCase('one policy signature is not an acceptance', itemOffer, withAcceptance(itemOffer, { sign: { omitPolicyB: true } }), { ok: false, code: 'POLICY_SIGNATURES_MISSING' }),
  acceptanceCase('one signer signing for both policy keys is refused', itemOffer, withAcceptance(itemOffer, { sign: { policyKeyB: OFFER_POLICY_A } }), { ok: false, code: 'POLICY_SIGNATURE_INVALID' }),
  acceptanceCase('a policy signature with SIGHASH_SINGLE is refused', itemOffer, withAcceptance(itemOffer, { sign: { policyHashType: 0x03 } }), { ok: false, code: 'UNCLOSED_SIGHASH' }),
  acceptanceCase(
    'a leaf that commits to different terms is refused',
    itemOffer,
    withAcceptance(itemOffer, { sign: { leafHex: offerOutputTree(offerTerms({ priceSats: '95000' }), OFFER_POLICY_KEYS).acceptanceLeafHex } }),
    { ok: false, code: 'ACCEPTANCE_LEAF_MISMATCH' },
  ),
  acceptanceCase(
    'a control block that does not commit the leaf is refused',
    itemOffer,
    withAcceptance(itemOffer, { sign: { controlBlockHex: flippedParity(offerOutputTree(offerTerms(), OFFER_POLICY_KEYS).acceptanceControlBlockHex) } }),
    { ok: false, code: 'CONTROL_BLOCK_MISMATCH' },
  ),
  acceptanceCase('acceptance at the expiry height is refused', fundedOffer(offerTerms(), { currentHeight: OFFER_EXPIRY }), withAcceptance(itemOffer), { ok: false, code: 'OFFER_EXPIRED' }),
  acceptanceCase(
    'a changed seller payment is refused',
    itemOffer,
    withAcceptance(itemOffer, { outputs: [offerOut(OFFER_BUYER_RECEIVE, '546'), offerOut(OFFER_SELLER_PAY, '89999'), offerOut(OFFER_BUYER_RECEIVE, '1501')] }),
    { ok: false, code: 'SELLER_VALUE_MISMATCH' },
  ),
  acceptanceCase(
    'a fee over the committed maximum is refused',
    itemOffer,
    withAcceptance(itemOffer, { outputs: [offerOut(OFFER_BUYER_RECEIVE, '546'), offerOut(OFFER_SELLER_PAY, '90000')] }),
    { ok: false, code: 'FEE_OVER_MAXIMUM' },
  ),
  acceptanceCase(
    'a buyer padding input is refused because the buyer signs nothing at acceptance',
    itemOffer,
    withAcceptance(itemOffer, {
      inputs: [
        { outpoint: OFFER_PADDING_OUTPOINT, party: 'BUYER', valueSats: '1000', scriptPubKeyHex: OFFER_BUYER_RECEIVE, inventory: { examined: true } },
        felineInput(),
        fundedInput(itemOffer),
      ],
      outputs: [offerOut(OFFER_BUYER_RECEIVE, '1000'), offerOut(OFFER_BUYER_RECEIVE, '546'), offerOut(OFFER_SELLER_PAY, '90000'), offerOut(OFFER_BUYER_RECEIVE, '1500')],
    }),
    { ok: false, code: 'BUYER_INPUT_UNAUTHORIZED' },
  ),
  acceptanceCase(
    'the funded output ahead of the Feline is refused',
    itemOffer,
    withAcceptance(itemOffer, { inputs: [fundedInput(itemOffer), felineInput()] }),
    { ok: false, code: 'OFFER_INPUT_POSITION' },
  ),
  acceptanceCase('an unsigned seller input is refused, never assumed', itemOffer, withAcceptance(itemOffer, { sign: { unsignedSeller: true } }), { ok: false, code: 'SIGNATURE_MISSING' }),
  acceptanceCase('a seller SINGLE|ANYONECANPAY signature is refused', itemOffer, withAcceptance(itemOffer, { sign: { sellerHashType: 0x83 } }), { ok: false, code: 'UNCLOSED_SIGHASH' }),
  acceptanceCase(
    'a seller signature by another key is refused',
    itemOffer,
    withAcceptance(itemOffer, { inputs: [{ ...felineInput(), key: testKey('offer-stranger') }, fundedInput(itemOffer)] }),
    { ok: false, code: 'SIGNATURE_INVALID' },
  ),
  acceptanceCase(
    'an ITEM offer refuses a different Feline',
    itemOffer,
    withAcceptance(itemOffer, { felineInscription: OFFER_MEMBERS[2], inputs: [felineInput('546', [{ inscriptionId: OFFER_MEMBERS[2], offset: '0' }]), fundedInput(itemOffer)] }),
    { ok: false, code: 'SCOPE_MISMATCH' },
  ),
  acceptanceCase(
    'a COLLECTION offer refuses a Feline outside its root',
    fundedOffer(offerTerms({ offerKind: 'COLLECTION', itemInscriptionId: undefined, collectionRoot: membershipRoot(OFFER_COLLECTION, OFFER_MEMBERS.slice(2)) })),
    withAcceptance(fundedOffer(offerTerms({ offerKind: 'COLLECTION', itemInscriptionId: undefined, collectionRoot: membershipRoot(OFFER_COLLECTION, OFFER_MEMBERS.slice(2)) }))),
    { ok: false, code: 'COLLECTION_MEMBERSHIP_NOT_PROVEN' },
  ),
  acceptanceCase(
    'a TRAIT offer refuses a member without the trait',
    traitOffer,
    withAcceptance(traitOffer, {
      felineInscription: OFFER_MEMBERS[2],
      inputs: [felineInput('546', [{ inscriptionId: OFFER_MEMBERS[2], offset: '0' }]), fundedInput(traitOffer)],
      eligibility: {
        membershipProof: buildMembershipProof(OFFER_COLLECTION, OFFER_MEMBERS, OFFER_MEMBERS[2]),
        traitProof: buildTraitMemberProof(traitTerms(), OFFER_TRAIT_MEMBERS, OFFER_MEMBERS[1]),
      },
    }),
    { ok: false, code: 'TRAIT_NOT_PROVEN' },
  ),
  acceptanceCase(
    'another inscription travelling with the Feline to the buyer is refused',
    itemOffer,
    withAcceptance(itemOffer, {
      inputs: [felineInput('546', [{ inscriptionId: OFFER_FELINE, offset: '0' }, { inscriptionId: OFFER_OTHER_INSCRIPTION, offset: '300' }]), fundedInput(itemOffer)],
    }),
    { ok: false, code: 'ASSET_MISDIRECTED' },
  ),
  acceptanceCase(
    'seller runes that would follow the Feline to the buyer are refused',
    itemOffer,
    withAcceptance(itemOffer, { inputs: [felineInput('546', undefined, { runeAllocations: [{ runeId: '840000:1', amount: '500' }] }), fundedInput(itemOffer)] }),
    { ok: false, code: 'ASSET_MISDIRECTED' },
  ),
  acceptanceCase(
    'policy keys in another order are a different funded output',
    { ...itemOffer, policyKeysHex: [OFFER_POLICY_KEYS[1], OFFER_POLICY_KEYS[0]] },
    withAcceptance(itemOffer),
    { ok: false, code: 'OFFER_OUTPUT_MISMATCH' },
  ),
  acceptanceCase(
    'one key named for both policy signers is refused',
    { ...itemOffer, policyKeysHex: [OFFER_POLICY_KEYS[0], OFFER_POLICY_KEYS[0]] },
    withAcceptance(itemOffer),
    { ok: false, code: 'POLICY_KEYS_INVALID' },
  ),
  acceptanceCase('an acceptance for another network is refused', itemOffer, withAcceptance(itemOffer, { overrides: { network: 'mainnet' } }), { ok: false, code: 'NETWORK_MISMATCH' }),
  acceptanceCase('a locktime above the current height is refused', itemOffer, withAcceptance(itemOffer, { lockTime: OFFER_HEIGHT + 1 }), { ok: false, code: 'LOCKTIME_INVALID' }),
  acceptanceCase(
    'a relative timelock on a seller input is refused',
    itemOffer,
    withAcceptance(itemOffer, { inputs: [{ ...felineInput(), sequence: 10 }, fundedInput(itemOffer)] }),
    { ok: false, code: 'SEQUENCE_INVALID' },
  ),
  acceptanceCase(
    'an output to a third party is refused',
    itemOffer,
    withAcceptance(itemOffer, { outputs: [offerOut(OFFER_BUYER_RECEIVE, '546'), offerOut(OFFER_SELLER_PAY, '90000'), offerOut(OFFER_BUYER_RECEIVE, '500'), offerOut(OFFER_STRANGER, '1000')] }),
    { ok: false, code: 'OUTPUT_UNDESCRIBED' },
  ),
  acceptanceCase(
    'asset outputs that take offer sats are refused',
    itemOffer,
    withAcceptance(itemOffer, { outputs: [offerOut(OFFER_BUYER_RECEIVE, '600'), offerOut(OFFER_SELLER_PAY, '90000'), offerOut(OFFER_BUYER_RECEIVE, '1446')] }),
    { ok: false, code: 'ASSET_OUTPUTS_UNBALANCED' },
  ),
  acceptanceCase(
    'a Feline the authorities do not report on the named outpoint is refused',
    itemOffer,
    withAcceptance(itemOffer, { inputs: [felineInput('546', []), fundedInput(itemOffer)] }),
    { ok: false, code: 'FELINE_NOT_HELD' },
  ),
  acceptanceCase('the unversioned v1 acceptance shape is refused', itemOffer, legacyAcceptance, { ok: false, code: 'SCHEMA_UNSUPPORTED' }),
];

function offerRecovery(offer, options = {}) {
  const {
    lockTime = OFFER_EXPIRY,
    sequence = 0xfffffffe,
    outputs = [offerOut(OFFER_BUYER_RECEIVE, '92000')],
    extraInputs = [],
    key = OFFER_RECOVERY_KEY,
    hashType = 0x00,
    leafHex,
    controlBlockHex,
    unsigned = false,
    overrides = {},
  } = options;
  const tree = offerOutputTree(offer.terms, offer.policyKeysHex);
  const tx = {
    version: 2,
    lockTime,
    inputs: [offer.fundedOutput.outpoint, ...extraInputs.map((e) => e.outpoint)].map((o) => ({ txid: o.txid, vout: o.vout, scriptSigHex: '', sequence, witness: [] })),
    outputs,
  };
  const prevouts = [{ valueSats: offer.fundedOutput.valueSats, scriptHex: offer.fundedOutput.scriptPubKeyHex }, ...extraInputs.map((e) => ({ valueSats: e.valueSats, scriptHex: e.scriptPubKeyHex }))];
  if (!unsigned) {
    const sig = signTaprootScriptPath(tx, 0, prevouts, key, hexToBytes(tree.recoveryLeafHashHex), hashType);
    tx.inputs[0].witness = [sig, leafHex ?? tree.recoveryLeafHex, controlBlockHex ?? tree.recoveryControlBlockHex];
  }
  return { schema: OFFER_RECOVERY_SCHEMA, transactionHex: bytesToHex(serializeTransaction(tx)), ...overrides };
}

const recoveryCase = (name, recovery, expected, offer = itemOffer) => ({ name, kind: 'recovery', recovery, offer, expected });
const offerTree = offerOutputTree(offerTerms(), OFFER_POLICY_KEYS);
const offerRecoveryCases = [
  recoveryCase('a valid recovery at the expiry height passes', offerRecovery(itemOffer), { ok: true, feeSats: '1000' }),
  recoveryCase('a recovery signed with SIGHASH_ALL passes', offerRecovery(itemOffer, { hashType: 0x01 }), { ok: true, feeSats: '1000' }),
  recoveryCase('a recovery with no locktime is refused', offerRecovery(itemOffer, { lockTime: 0 }), { ok: false, code: 'RECOVERY_BEFORE_EXPIRY' }),
  recoveryCase('a recovery one block before expiry is refused', offerRecovery(itemOffer, { lockTime: OFFER_EXPIRY - 1 }), { ok: false, code: 'RECOVERY_BEFORE_EXPIRY' }),
  recoveryCase('a timestamp locktime is refused', offerRecovery(itemOffer, { lockTime: 500000000 }), { ok: false, code: 'LOCKTIME_INVALID' }),
  recoveryCase('a final sequence is refused because it disables the locktime', offerRecovery(itemOffer, { sequence: 0xffffffff }), { ok: false, code: 'SEQUENCE_FINAL' }),
  recoveryCase('a recovery paying elsewhere is refused', offerRecovery(itemOffer, { outputs: [offerOut(OFFER_STRANGER, '92000')] }), { ok: false, code: 'RECOVERY_OUTPUT_WRONG' }),
  recoveryCase(
    'key and CHECKLOCKTIMEVERIFY bytes inside pushed data are not a recovery leaf',
    offerRecovery(itemOffer, { leafHex: `24${xOnlyHex(OFFER_RECOVERY_KEY)}b17520ac` }),
    { ok: false, code: 'RECOVERY_LEAF_MISMATCH' },
  ),
  recoveryCase('a control block that does not commit the leaf is refused', offerRecovery(itemOffer, { controlBlockHex: flippedParity(offerTree.recoveryControlBlockHex) }), { ok: false, code: 'CONTROL_BLOCK_MISMATCH' }),
  recoveryCase('a policy key cannot sign the recovery', offerRecovery(itemOffer, { key: OFFER_POLICY_A }), { ok: false, code: 'SIGNATURE_INVALID' }),
  recoveryCase('an unsigned recovery is refused', offerRecovery(itemOffer, { unsigned: true }), { ok: false, code: 'SIGNATURE_MISSING' }),
  recoveryCase('a SIGHASH_NONE recovery is refused', offerRecovery(itemOffer, { hashType: 0x02 }), { ok: false, code: 'UNCLOSED_SIGHASH' }),
  recoveryCase(
    'a recovery spending another input too is refused',
    offerRecovery(itemOffer, { extraInputs: [{ outpoint: OFFER_PADDING_OUTPOINT, valueSats: '1000', scriptPubKeyHex: OFFER_BUYER_RECEIVE }] }),
    { ok: false, code: 'RECOVERY_INPUTS_INVALID' },
  ),
  recoveryCase(
    'the unversioned v1 recovery shape is refused',
    { inputs: [{ ...OFFER_FUNDED_OUTPOINT, valueSats: '93000', sequence: 0xfffffffd }], outputs: [offerOut(OFFER_BUYER_RECEIVE, '92000')], recoveryLeafScriptHex: offerTree.recoveryLeafHex },
    { ok: false, code: 'SCHEMA_UNSUPPORTED' },
  ),
];

const OFFER_BASE_TERMS = offerTerms();
const termsCase = (name, terms, expected) => ({ name, kind: 'terms', terms, expected });
const termsRefused = (code) => ({ ok: false, code });
const termsAccepted = (terms) => ({ ok: true, offerTermsHash: offerTermsHash(terms) });
const offerTermsCases = [
  termsCase('a valid ITEM offer verifies and carries its hash', OFFER_BASE_TERMS, termsAccepted(OFFER_BASE_TERMS)),
  termsCase('a changed price changes the hash', offerTerms({ priceSats: '95000' }), termsAccepted(offerTerms({ priceSats: '95000' }))),
  termsCase('a valid COLLECTION offer verifies', collectionOffer.terms, termsAccepted(collectionOffer.terms)),
  termsCase('a valid TRAIT offer verifies', traitOffer.terms, termsAccepted(traitOffer.terms)),
  termsCase('an unknown field is refused', { ...OFFER_BASE_TERMS, buyerNote: 'hi' }, termsRefused('MALFORMED_TERMS')),
  termsCase('a wrong schema is refused', offerTerms({ schema: 'ordex.offer-terms/v2' }), termsRefused('TERMS_SCHEMA_UNSUPPORTED')),
  termsCase('protocol 1.0 terms are refused', offerTerms({ protocolVersion: '1.0' }), termsRefused('TERMS_PROTOCOL_UNSUPPORTED')),
  termsCase('an ITEM offer without an inscription is refused', offerTerms({ itemInscriptionId: undefined }), termsRefused('TERMS_SCOPE_FIELDS')),
  termsCase('a TRAIT offer without a value is refused', traitTerms({ traitValue: undefined }), termsRefused('TERMS_SCOPE_FIELDS')),
  termsCase('a COLLECTION offer must not scope a trait', offerTerms({ offerKind: 'COLLECTION', itemInscriptionId: undefined, traitName: 'eyes' }), termsRefused('TERMS_SCOPE_FIELDS')),
  termsCase('a malformed root is refused', offerTerms({ collectionRoot: 'ZZ' }), termsRefused('TERMS_ROOT_INVALID')),
  termsCase('a criteria hash that is not the hash of the stated scope is refused', offerTerms({ criteriaHash: 'b'.repeat(64) }), termsRefused('TERMS_CRITERIA_INVALID')),
  termsCase('an OP_RETURN buyer receive script is refused', offerTerms({ buyerReceiveScriptHex: '6a00' }), termsRefused('TERMS_SCRIPT_INVALID')),
  termsCase('a fractional price is refused', offerTerms({ priceSats: '1.5' }), termsRefused('TERMS_AMOUNT_INVALID')),
  termsCase('the last height-domain expiry is accepted', offerTerms({ expiryHeight: 499999999 }), termsAccepted(offerTerms({ expiryHeight: 499999999 }))),
  termsCase('an expiry at the timestamp threshold is refused', offerTerms({ expiryHeight: 500000000 }), termsRefused('TERMS_EXPIRY_INVALID')),
  termsCase('an unrepresentable expiry is refused', offerTerms({ expiryHeight: 2147483648 }), termsRefused('TERMS_EXPIRY_INVALID')),
  termsCase('an expiry written as a string is refused', offerTerms({ expiryHeight: '900100' }), termsRefused('TERMS_EXPIRY_INVALID')),
  termsCase('a malformed recovery key is refused', offerTerms({ buyerRecoveryKeyHex: 'dd' }), termsRefused('TERMS_RECOVERY_KEY_INVALID')),
  termsCase('a recovery key that is not a curve point is refused', offerTerms({ buyerRecoveryKeyHex: 'f'.repeat(64) }), termsRefused('TERMS_RECOVERY_KEY_INVALID')),
];

const offerCases = [...offerTermsCases, ...offerAcceptanceCases, ...offerRecoveryCases];

// OX-S09: verifyRuneAllocation, verifySwapSignedTransaction and
// verifyCounterpartyLedgerEvents had no vector of their own. One vector each, with the
// allocation, signatures and ledger rows stated by hand, so every published entry point runs.
const runePlanCases = [
  runeCase('allocation-matching-the-plan-is-accepted', 'An edict sends 300 of 840000:1 to output 1 and the pointer the other 700 to output 2, exactly as planned.', [runestoneScript([22, 2, 0, 840000, 1, 300, 1]), RUNE_SPEND_1, RUNE_SPEND_2], held(['840000:1', '1000']), { ok: true }, { expectedAllocation: [{ output: 1, runeId: '840000:1', amount: '300' }, { output: 2, runeId: '840000:1', amount: '700' }] }),
  runeCase('allocation-differing-from-the-plan-is-refused', 'The same transaction against a plan that expects all 1000 at output 1.', [runestoneScript([22, 2, 0, 840000, 1, 300, 1]), RUNE_SPEND_1, RUNE_SPEND_2], held(['840000:1', '1000']), { ok: false, code: 'RUNE_ALLOCATION_MISMATCH' }, { expectedAllocation: [{ output: 1, runeId: '840000:1', amount: '1000' }] }),
];

// A settlement both parties signed with their test keys over the exact acceptance plan.
function settledSwapCase() {
  const keys = { [p2trKeyPath(testKey('swap-maker')).scriptHex]: testKey('swap-maker'), [p2wpkhScript(testKey('swap-taker'))]: testKey('swap-taker') };
  const base = swapCases.find((c) => c.acceptance && c.expected.ok === true && c.acceptance.tx.inputs.every((i) => keys[i.scriptPubKeyHex]));
  const tx = swapUnsignedTransaction(base.acceptance);
  const prevouts = base.acceptance.tx.inputs.map((i) => ({ valueSats: i.valueSats, scriptHex: i.scriptPubKeyHex }));
  tx.inputs.forEach((input, i) => {
    const key = keys[prevouts[i].scriptHex];
    input.witness = prevouts[i].scriptHex.startsWith('5120') ? [signTaprootKeyPath(tx, i, prevouts, key, 0x00)] : signP2wpkh(tx, i, prevouts, key, 0x01);
  });
  return {
    name: 'a settlement signed by both parties over the accepted plan is accepted',
    signed: { schema: SWAP_SIGNED_TRANSACTION_SCHEMA, acceptanceDigest: base.acceptance.digest, signedTxHex: bytesToHex(serializeTransaction(tx)) },
    acceptance: base.acceptance,
    intent: base.intent,
    expected: { ok: true },
  };
}
swapCases.push(settledSwapCase());

const LEDGER_TX = 'c'.repeat(64);
counterpartyCases.push({
  name: 'ledger events matching the planned move are accepted',
  expectedEvents: { txHash: LEDGER_TX, events: [{ event: 'UTXO_MOVE', source: `${'a'.repeat(64)}:0`, destination: `${LEDGER_TX}:0`, asset: 'XCP', quantity: '100000000' }] },
  observedEvents: { checkpoint: { height: 900000, blockHash: `${'0'.repeat(63)}1`, ledgerHash: 'd'.repeat(64) }, events: [{ event: 'UTXO_MOVE', txHash: LEDGER_TX, source: `${'a'.repeat(64)}:0`, destination: `${LEDGER_TX}:0`, asset: 'XCP', quantity: '100000000', status: 'valid' }] },
  expected: { ok: true },
});

const runeCases = [...LEGACY_RUNE_CASES, ...runeParityCases, ...runeAllocationCases, ...runePlanCases];

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

writeVectors('../conformance/offer-vectors.json', {
  protocolVersion: '1.1',
  note: 'Shared conformance vectors for funded offers. verifier/offers.js and sdk/src/offers.ts must both answer every case exactly as recorded here. Every signature was made by scripts/vector-signer.mjs with test keys.',
  termsHash: offerTermsHash(OFFER_BASE_TERMS),
  cases: offerCases,
});

writeVectors('../conformance/rune-burn-vectors.json', {
  version: 1,
  description:
    'Conformance vectors for the Ordex rune burn rule. Each case names the output scripts of a final transaction, what the rune index reports about each input being spent, and the exact verdict a compatible verifier must reach. Deciphered fields and allocations match ord 0.29.0 (commit 7e37a3bd), checked by conformance/ord-differential. The rules verified here are stated in spec/runes.md.',
  cases: runeCases,
});

console.log('conformance vectors regenerated');
