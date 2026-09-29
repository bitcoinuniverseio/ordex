/**
 * Ordex Deterministic Scenarios Registry
 *
 * The 15 offered walkthroughs. OX-S08: every verification step runs a reference verifier on
 * explicit arguments taken from the checked-in conformance vectors (through the OX-S07
 * registry), and every failure injection is a concrete change to those arguments whose
 * refusal comes from the verifier itself. State the sandbox cannot observe (a confirmed
 * spend, a gateway record) is a labelled fixture using a value the contract defines.
 */

import vectorFamilies from '../../data/vectorFamilies.json';
import { argsFromCase, diffPaths } from '../lab-report.mjs';
import type { ScenarioDefinition, ScenarioActor, VerifierCheck } from './types.js';

export const ACTOR_LANES: Array<{ id: ScenarioActor; label: string; roleDescription: string }> = [
  { id: 'seller', label: 'Seller / Owner', roleDescription: 'Holds the asset, creates a public ask, or accepts an offer' },
  { id: 'gateway', label: 'Ordex Gateway', roleDescription: 'Indexes the catalog, composes quotes, and emits events' },
  { id: 'buyer', label: 'Buyer / Signer', roleDescription: 'Inspects the order, funds payment, verifies sat flow, and signs' },
  { id: 'node', label: 'Bitcoin Authority', roleDescription: 'Enforces consensus, UTXO availability, and confirmation' }
];

type Args = Record<string, any>;
type VectorEntry = { id: string; family: string; variant: string; case: Record<string, unknown> };
const families = vectorFamilies as unknown as Record<string, { cases: VectorEntry[] }>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function vectorEntry(id: string): VectorEntry {
  const family = id.split('/')[0];
  const entry = families[family]?.cases.find((c) => c.id === id);
  if (!entry) throw new Error(`Scenario fixture vector ${id} is missing from generated data`);
  return entry;
}

/** A verifier check whose arguments are a vector's exact arguments, optionally transformed. */
export function vectorCheck(id: string, transform?: (args: Args) => Args): VerifierCheck {
  const entry = vectorEntry(id);
  const base = argsFromCase(entry.family, entry.variant, entry.case) as Args;
  return { family: entry.family, variant: entry.variant, args: transform ? transform(clone(base)) : clone(base), vectorId: id };
}

function parsePath(path: string): Array<string | number> {
  const parts: Array<string | number> = [];
  for (const piece of path.split('.')) {
    const m = piece.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) throw new Error(`Unreadable path ${path}`);
    if (m[1]) parts.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) parts.push(Number(idx[1]));
  }
  return parts;
}

function readPath(obj: any, parts: Array<string | number>): any {
  return parts.reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
}

/**
 * The exact field changes that turn one vector's arguments into another's, as a mutation.
 * Applying it to the accepted vector's arguments reproduces the refusal vector field by field.
 */
export function vectorDelta(fromId: string, toId: string): (args: Args) => Args {
  const from = vectorEntry(fromId);
  const to = vectorEntry(toId);
  const target = argsFromCase(to.family, to.variant, to.case) as Args;
  const changes = diffPaths(argsFromCase(from.family, from.variant, from.case), target);
  return (args: Args) => {
    const out = clone(args);
    // Changes and additions first, then removals from the highest array index down, so
    // earlier removals never shift the index of a later one.
    const lastIndex = (path: string) => Number(path.match(/\[(\d+)\]$/)?.[1] ?? -1);
    const ordered = [
      ...changes.filter((c) => c.change !== 'removed'),
      ...changes.filter((c) => c.change === 'removed').sort((x, y) => lastIndex(y.path) - lastIndex(x.path))
    ];
    for (const { path, change } of ordered) {
      const parts = parsePath(path);
      const parent = readPath(out, parts.slice(0, -1));
      const key = parts[parts.length - 1];
      if (change === 'removed') {
        if (Array.isArray(parent)) parent.splice(key as number, 1);
        else delete parent[key];
      } else {
        parent[key] = clone(readPath(target, parts));
      }
    }
    return out;
  };
}

// Batch purchase fixture (spec/batch-purchase.md): two asks, each seller input at the index
// of its payment, each asset range absorbed by the outputs ahead of that payment.
const BATCH_ORDER_A = {
  offeredOutpoint: { txid: 'aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11', vout: 0 },
  sellerPaymentScriptHex: '0014d85c2b71d0060b09c9886aeb815e50991dda124d',
  sellerPaymentValueSats: '20000'
};
const BATCH_ORDER_B = {
  offeredOutpoint: { txid: 'cc22cc22cc22cc22cc22cc22cc22cc22cc22cc22cc22cc22cc22cc22cc22cc22', vout: 1 },
  sellerPaymentScriptHex: '0014eeee0000eeee0000eeee0000eeee0000eeee0000',
  sellerPaymentValueSats: '30000'
};
const BATCH_TX = {
  inputs: [
    { txid: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1', vout: 0, valueSats: '600' },
    { txid: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', vout: 1, valueSats: '600' },
    { txid: BATCH_ORDER_A.offeredOutpoint.txid, vout: 0, valueSats: '546' },
    { txid: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', vout: 0, valueSats: '20000' },
    { txid: 'b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4', vout: 0, valueSats: '1200' },
    { txid: BATCH_ORDER_B.offeredOutpoint.txid, vout: 1, valueSats: '546' },
    { txid: 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1', vout: 1, valueSats: '60000' }
  ],
  outputs: [
    { scriptHex: '0014aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000', valueSats: '1200' },
    { scriptHex: '0014bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000', valueSats: '546' },
    { scriptHex: BATCH_ORDER_A.sellerPaymentScriptHex, valueSats: '20000' },
    { scriptHex: '0014aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000', valueSats: '1200' },
    { scriptHex: '0014bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000', valueSats: '546' },
    { scriptHex: BATCH_ORDER_B.sellerPaymentScriptHex, valueSats: '30000' },
    { scriptHex: '0014aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000', valueSats: '28000' }
  ]
};

const ASK_VECTOR = 'purchase/arrangement-ordex-builds';
const swapOutputs = (i: number, j: number) => (args: Args) => {
  const outs = args.transaction.outputs;
  [outs[i], outs[j]] = [outs[j], outs[i]];
  return args;
};
const addSats = (value: string, delta: bigint) => (BigInt(value) + delta).toString();

// A cardinal consolidation derived from the accepted batch-send plan vector: every input
// into one output, value conserved, digest recomputed with verifier/safeops.js. The unit
// test runs it through the real verifier, so any drift fails loudly.
const CONSOLIDATION_PLAN = vectorCheck('safeops/a-cardinal-batch-send-plan-with-examined-inputs-is-accepted', (args) => {
  args.plan.operationKind = 'CARDINAL_CONSOLIDATION';
  args.plan.outputs = [{ scriptHex: '5120aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', valueSats: '109400', role: 'change' }];
  args.plan.digest = '3afb5ab44f6177f350d9223119d0f187aa6107dd57f640b00e5c20fb37d8e62d';
  return args;
});

const NODE_STATUS_REF = 'spec/openapi.json#/components/schemas/Validation/properties/nodeStatus';

export const SCENARIOS: ScenarioDefinition[] = [
  // 1. ask.publish-and-settle.success
  {
    id: 'ask.publish-and-settle.success',
    title: 'Public Ask: Publish and Settle (Success)',
    summary: 'A seller signs a portable ask with SIGHASH_SINGLE | ANYONECANPAY, and a buyer funds the purchase so the asset and the payment settle in one transaction.',
    protocolVersions: ['1.0', '1.1', '1.2'],
    expectedOutcome: 'success',
    verifierFamily: 'purchase',
    sourceRefs: [
      { title: 'Public Asks Spec', path: 'spec/purchase.md', type: 'spec' },
      { title: 'Reference Verifier', path: 'verifier/purchase.js', type: 'verifier' },
      { title: 'Vector purchase/arrangement-ordex-builds', path: 'conformance/purchase-vectors.json', type: 'vector' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'seller',
        intent: 'List the asset at 250,000 sats',
        operation: 'POST /api/ordex/orders/build',
        inputs: { offeredOutpoint: 'aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11aa11:0', priceSats: '250000' },
        outputArtifact: {
          name: 'order-terms.json',
          type: 'Order terms',
          payload: vectorCheck(ASK_VECTOR).args.order
        },
        stateTransition: { from: 'INITIAL', to: 'ORDER_COMPOSED' },
        whyThisStepExists: 'Fixes the offered outpoint, the payment script and the exact price the seller signs over.',
        whatCouldFail: 'A non-integer price or a malformed outpoint.',
        nextRecommendedAction: 'The seller signs the offered input with SIGHASH_SINGLE | ANYONECANPAY.',
        evidenceClass: 'Publisher claim'
      },
      {
        id: 'step-2',
        stepNumber: 2,
        actor: 'seller',
        intent: 'Sign the offered input, committing to the payment at the same index',
        operation: 'Local signer (SIGHASH_SINGLE | ANYONECANPAY)',
        inputs: { sighash: '0x83' },
        outputArtifact: {
          name: 'signed-ask.illustration.json',
          type: 'Illustration: the sandbox produces no signature bytes',
          payload: { sighash: 'SINGLE|ANYONECANPAY', signature: null },
          illustration: true
        },
        stateTransition: { from: 'ORDER_COMPOSED', to: 'OPEN' },
        whyThisStepExists: 'Lets any buyer add inputs and outputs without invalidating the seller signature.',
        whatCouldFail: 'Any other sighash mode breaks portability.',
        nextRecommendedAction: 'Submit the signed order to the gateway.',
        evidenceClass: 'Deterministic example'
      },
      {
        id: 'step-3',
        stepNumber: 3,
        actor: 'gateway',
        intent: 'Publish the verified ask to the order book',
        operation: 'POST /api/ordex/orders/publish',
        inputs: { order: 'order-terms.json' },
        stateTransition: { from: 'OPEN', to: 'OPEN' },
        whyThisStepExists: 'Makes the listing discoverable to buyers.',
        whatCouldFail: 'The signature check fails or the outpoint is already spent.',
        nextRecommendedAction: 'The buyer composes the settlement.',
        evidenceClass: 'Deterministic example'
      },
      {
        id: 'step-4',
        stepNumber: 4,
        actor: 'buyer',
        intent: 'Compose the settlement: padding, the seller input, funding, then the payment at the shared index',
        operation: 'Local purchase verifier (verifyPublicAskCompletion)',
        inputs: { vector: ASK_VECTOR },
        outputArtifact: {
          name: 'settlement-arrangement.json',
          type: 'Transaction arrangement (inputs and outputs)',
          payload: vectorCheck(ASK_VECTOR).args.transaction
        },
        stateTransition: { from: 'OPEN', to: 'VERIFIED_LOCALLY' },
        whyThisStepExists: 'Proves before any wallet prompt that the seller payment sits at the shared index and the asset range lands with the buyer.',
        whatCouldFail: 'A displaced payment, a changed price, or outputs that let the asset range reach the payment.',
        nextRecommendedAction: 'Sign and broadcast from the buyer wallet.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck(ASK_VECTOR)
      },
      {
        id: 'step-5',
        stepNumber: 5,
        actor: 'node',
        intent: 'Confirmation on chain (not simulated)',
        operation: 'Broadcast and block inclusion',
        inputs: {},
        stateTransition: { from: 'VERIFIED_LOCALLY', to: 'AWAITING_CHAIN_EVIDENCE' },
        whyThisStepExists: 'Only a confirmed transaction settles ownership. The sandbox never broadcasts.',
        whatCouldFail: 'A competing spend, a replacement or a reorg.',
        nextRecommendedAction: 'Confirm settlement on a real Signet or Testnet node, never from this sandbox.',
        evidenceClass: 'Deterministic example'
      }
    ],
    failureInjections: [
      {
        id: 'inject-reorder-output',
        label: 'Swap the seller payment with the change output',
        description: 'Moves the payment from index 2 to index 3, away from the index the seller signed.',
        stepId: 'step-4',
        mutate: swapOutputs(2, 3),
        expectedRefusalCode: 'SELLER_SCRIPT_MISMATCH',
        affectedInvariant: 'The seller payment must sit at the index of the seller input (spec/purchase.md, rule one).'
      },
      {
        id: 'inject-underpay-seller',
        label: 'Underpay the seller by 1 sat',
        description: 'Lowers the payment output from 250,000 to 249,999 sats.',
        stepId: 'step-4',
        mutate: (args) => {
          args.transaction.outputs[2].valueSats = addSats(args.transaction.outputs[2].valueSats, -1n);
          return args;
        },
        expectedRefusalCode: 'SELLER_VALUE_MISMATCH',
        affectedInvariant: 'The payment must carry exactly the asking price.'
      },
      {
        id: 'inject-asset-into-payment',
        label: 'Let one asset sat reach the payment',
        description: 'Shrinks the buyer asset output by 1 sat and adds it to change, so the outputs ahead of the payment no longer absorb the whole asset range.',
        stepId: 'step-4',
        mutate: (args) => {
          args.transaction.outputs[1].valueSats = addSats(args.transaction.outputs[1].valueSats, -1n);
          args.transaction.outputs[3].valueSats = addSats(args.transaction.outputs[3].valueSats, 1n);
          return args;
        },
        expectedRefusalCode: 'SAT_FLOW_SHORTFALL',
        affectedInvariant: 'Outputs ahead of the payment must absorb every sat of the offered range (spec/purchase.md, rule two).'
      }
    ]
  },

  // 2. ask.wallet-output-reorder.refusal
  {
    id: 'ask.wallet-output-reorder.refusal',
    title: 'Public Ask: Wallet Output Reorder (Refusal)',
    summary: 'A buggy or malicious wallet moves the seller payment to a different index, and the verifier refuses before signing.',
    protocolVersions: ['1.0', '1.1', '1.2'],
    expectedOutcome: 'refusal',
    expectedRefusalCode: 'SELLER_SCRIPT_MISMATCH',
    verifierFamily: 'purchase',
    sourceRefs: [
      { title: 'Public Asks Spec', path: 'spec/purchase.md', type: 'spec' },
      { title: 'Reference Verifier', path: 'verifier/purchase.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'seller',
        intent: 'The seller signs the offered input at index 2',
        operation: 'SIGHASH_SINGLE signing',
        inputs: { sharedIndex: 2, priceSats: '250000' },
        stateTransition: { from: 'INITIAL', to: 'OPEN' },
        whyThisStepExists: 'The seller expects payment at output index 2, the index of the signed input.',
        whatCouldFail: 'Nothing at this step.',
        nextRecommendedAction: 'The buyer wallet composes the settlement.',
        evidenceClass: 'Deterministic example'
      },
      {
        id: 'step-2',
        stepNumber: 2,
        actor: 'buyer',
        intent: 'The wallet places change at index 2 and the seller payment at index 3',
        operation: 'Local purchase verifier (verifyPublicAskCompletion)',
        inputs: { vector: ASK_VECTOR, change: 'outputs 2 and 3 swapped' },
        stateTransition: { from: 'OPEN', to: 'PREFLIGHT_REFUSED' },
        whyThisStepExists: 'Shows the verifier catching a displaced payment before any signature is requested.',
        whatCouldFail: 'The verifier refuses the arrangement.',
        nextRecommendedAction: 'Abort signing and report the wallet composition.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck(ASK_VECTOR, swapOutputs(2, 3))
      }
    ]
  },

  // 3. ask.race-lost.refusal
  {
    id: 'ask.race-lost.refusal',
    title: 'Public Ask: Race Lost (Refusal)',
    summary: 'Two buyers settle the same ask. The first spend confirms; the second is refused because the offered outpoint is spent, a fact only chain state can show.',
    protocolVersions: ['1.0', '1.1', '1.2'],
    expectedOutcome: 'refusal',
    expectedRefusalCode: 'OUTPOINT_SPENT',
    verifierFamily: 'purchase',
    sourceRefs: [
      { title: 'Public Asks Spec', path: 'spec/purchase.md', type: 'spec' },
      { title: 'Validation.nodeStatus', path: NODE_STATUS_REF, type: 'contract' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'buyer',
        intent: 'Buyer A composes a valid settlement',
        operation: 'Local purchase verifier (verifyPublicAskCompletion)',
        inputs: { vector: ASK_VECTOR },
        stateTransition: { from: 'OPEN', to: 'VERIFIED_LOCALLY' },
        whyThisStepExists: 'Buyer A holds a correct arrangement.',
        whatCouldFail: 'Nothing in the arrangement itself.',
        nextRecommendedAction: 'Buyer A broadcasts.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck(ASK_VECTOR)
      },
      {
        id: 'step-2',
        stepNumber: 2,
        actor: 'buyer',
        intent: 'Buyer B composes the same arrangement for the same ask',
        operation: 'Local purchase verifier (verifyPublicAskCompletion)',
        inputs: { vector: ASK_VECTOR },
        stateTransition: { from: 'OPEN', to: 'VERIFIED_LOCALLY' },
        whyThisStepExists: 'The local verifier accepts it too: it checks the arrangement and cannot see chain state.',
        whatCouldFail: 'Nothing the local verifier can detect.',
        nextRecommendedAction: 'Revalidate the order against the node before signing.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck(ASK_VECTOR)
      },
      {
        id: 'step-3',
        stepNumber: 3,
        actor: 'gateway',
        intent: "Revalidation reports the offered outpoint spent by buyer A's confirmed transaction",
        operation: 'POST /api/ordex/orders/{orderId}/revalidate',
        inputs: { field: 'validation.nodeStatus' },
        stateTransition: { from: 'VERIFIED_LOCALLY', to: 'WITHDRAWN' },
        whyThisStepExists: 'Only the node knows the outpoint is spent. This value is a deterministic fixture of what the gateway returns, not a live observation.',
        whatCouldFail: 'Buyer B signing anyway would produce a transaction the network rejects.',
        nextRecommendedAction: 'Refuse the quote and show the order as no longer live.',
        evidenceClass: 'Deterministic example',
        observation: {
          label: 'Gateway revalidation (deterministic fixture)',
          field: 'validation.nodeStatus',
          value: 'OUTPOINT_SPENT',
          contractRef: NODE_STATUS_REF
        }
      }
    ]
  },

  // 4. purchase.batch.success
  {
    id: 'purchase.batch.success',
    title: 'Batch Purchase: Two Asks in One Transaction (Success)',
    summary: 'A buyer settles two independent asks in one transaction. Each ask is checked with the single purchase rules, as spec/batch-purchase.md requires.',
    protocolVersions: ['1.1', '1.2'],
    expectedOutcome: 'success',
    verifierFamily: 'purchase',
    sourceRefs: [
      { title: 'Batch Purchase Spec', path: 'spec/batch-purchase.md', type: 'spec' },
      { title: 'Reference Verifier', path: 'verifier/purchase.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'buyer',
        intent: 'Compose ask A (20,000 sats) and ask B (30,000 sats) into one transaction',
        operation: 'POST /api/ordex/orders/batch-purchase',
        inputs: { asks: 2, feeSats: '2000' },
        outputArtifact: { name: 'batch-arrangement.json', type: 'Transaction arrangement (inputs and outputs)', payload: BATCH_TX },
        stateTransition: { from: 'INITIAL', to: 'BATCH_COMPOSED' },
        whyThisStepExists: 'Each seller signed one input and one output, so the halves can sit side by side.',
        whatCouldFail: 'One ask is stale, duplicated, or a payment lands at the wrong index.',
        nextRecommendedAction: 'Verify every ask against the same transaction.',
        evidenceClass: 'Deterministic example'
      },
      {
        id: 'step-2',
        stepNumber: 2,
        actor: 'buyer',
        intent: 'Verify ask A: payment at index 2',
        operation: 'Local purchase verifier (verifyPublicAskCompletion)',
        inputs: { ask: 'A' },
        stateTransition: { from: 'BATCH_COMPOSED', to: 'ASK_A_VERIFIED' },
        whyThisStepExists: 'A batch proves nothing unless every ask passes on its own.',
        whatCouldFail: 'Ask A payment displaced or asset range reaching the payment.',
        nextRecommendedAction: 'Verify ask B.',
        evidenceClass: 'Protocol verification',
        verifierCheck: { family: 'purchase', variant: 'completion', args: { transaction: BATCH_TX, order: BATCH_ORDER_A } }
      },
      {
        id: 'step-3',
        stepNumber: 3,
        actor: 'buyer',
        intent: 'Verify ask B: payment at index 5',
        operation: 'Local purchase verifier (verifyPublicAskCompletion)',
        inputs: { ask: 'B' },
        stateTransition: { from: 'ASK_A_VERIFIED', to: 'BATCH_VERIFIED' },
        whyThisStepExists: 'The outputs ahead of payment B absorb every earlier block and all of asset B.',
        whatCouldFail: 'Asset B landing inside payment A.',
        nextRecommendedAction: 'Sign and broadcast from the buyer wallet.',
        evidenceClass: 'Protocol verification',
        verifierCheck: { family: 'purchase', variant: 'completion', args: { transaction: BATCH_TX, order: BATCH_ORDER_B } }
      }
    ],
    failureInjections: [
      {
        id: 'inject-short-merge',
        label: 'Shrink the second padding merge by 1 sat',
        description: 'Moves 1 sat from the output ahead of payment B into change.',
        stepId: 'step-3',
        mutate: (args) => {
          args.transaction.outputs[3].valueSats = addSats(args.transaction.outputs[3].valueSats, -1n);
          args.transaction.outputs[6].valueSats = addSats(args.transaction.outputs[6].valueSats, 1n);
          return args;
        },
        expectedRefusalCode: 'SAT_FLOW_SHORTFALL',
        affectedInvariant: 'Outputs ahead of each payment absorb every earlier block and that ask\'s whole range.'
      }
    ]
  },

  // 5. purchase.batch-incompatible.refusal
  {
    id: 'purchase.batch-incompatible.refusal',
    title: 'Batch Purchase: Same Ask Twice (Refusal)',
    summary: 'A batch that names the same ask twice cannot be proven ask by ask, so it fails closed with a per-order refusal.',
    protocolVersions: ['1.1', '1.2'],
    expectedOutcome: 'refusal',
    expectedRefusalCode: 'OFFERED_OUTPOINT_DUPLICATED',
    verifierFamily: 'purchase',
    sourceRefs: [
      { title: 'Batch Purchase Spec', path: 'spec/batch-purchase.md', type: 'spec' },
      { title: 'Reference Verifier', path: 'verifier/purchase.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'buyer',
        intent: "Compose a batch whose second block spends ask A's outpoint again",
        operation: 'Local purchase verifier (verifyPublicAskCompletion)',
        inputs: { duplicatedAsk: 'A' },
        stateTransition: { from: 'INITIAL', to: 'REFUSED' },
        whyThisStepExists: 'One seller signature must never answer for two positions.',
        whatCouldFail: 'The verifier refuses the duplicated outpoint.',
        nextRecommendedAction: 'Remove the duplicate and buy the remaining asks.',
        evidenceClass: 'Protocol verification',
        verifierCheck: {
          family: 'purchase',
          variant: 'completion',
          args: {
            transaction: {
              ...BATCH_TX,
              inputs: BATCH_TX.inputs.map((input, i) => (i === 5 ? { ...BATCH_ORDER_A.offeredOutpoint, valueSats: '546' } : input))
            },
            order: BATCH_ORDER_A
          }
        }
      }
    ]
  },

  // 6. offer.accept.success
  {
    id: 'offer.accept.success',
    title: 'Offers v1: Seller Acceptance (Success)',
    summary: 'A seller accepts a funded offer by spending the acceptance leaf together with the asset input.',
    protocolVersions: ['1.1', '1.2'],
    expectedOutcome: 'success',
    verifierFamily: 'offers',
    sourceRefs: [
      { title: 'Offers Spec', path: 'spec/offers.md', type: 'spec' },
      { title: 'Offers Verifier', path: 'verifier/offers.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'seller',
        intent: 'Accept the offer by spending the acceptance leaf',
        operation: 'Local offers verifier (verifyOfferAcceptance)',
        inputs: { vector: 'offers/a-valid-acceptance-passes' },
        stateTransition: { from: 'OFFER_FUNDED', to: 'ACCEPTANCE_VERIFIED' },
        whyThisStepExists: 'Lets a buyer and seller trade without custody.',
        whatCouldFail: 'A terms hash mismatch, an expired offer, or a changed payment.',
        nextRecommendedAction: 'Sign and broadcast the acceptance.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck('offers/a-valid-acceptance-passes')
      }
    ],
    failureInjections: [
      {
        id: 'inject-change-seller-payment',
        label: 'Change the seller payment',
        description: 'Applies the exact change of the refusal vector: the payment output value no longer matches the offer price.',
        stepId: 'step-1',
        mutate: vectorDelta('offers/a-valid-acceptance-passes', 'offers/a-changed-seller-payment-is-refused'),
        expectedRefusalCode: 'SELLER_VALUE_MISMATCH',
        affectedInvariant: 'The payment must carry exactly the committed price.',
        vectorId: 'offers/a-changed-seller-payment-is-refused'
      }
    ]
  },

  // 7. offer.recover-after-expiry.success
  {
    id: 'offer.recover-after-expiry.success',
    title: 'Offers v1: Recovery After Expiry (Success)',
    summary: 'The buyer reclaims locked funds after the expiry height with the recovery leaf.',
    protocolVersions: ['1.1', '1.2'],
    expectedOutcome: 'success',
    verifierFamily: 'offers',
    sourceRefs: [
      { title: 'Offers Spec', path: 'spec/offers.md', type: 'spec' },
      { title: 'Offers Verifier', path: 'verifier/offers.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'buyer',
        intent: 'Reclaim the offer funds with a locktime at or after the expiry height',
        operation: 'Local offers verifier (verifyOfferRecovery)',
        inputs: { vector: 'offers/a-valid-recovery-after-expiry-passes' },
        stateTransition: { from: 'EXPIRED', to: 'RECOVERY_VERIFIED' },
        whyThisStepExists: 'Buyer funds can never stay trapped if the seller never accepts.',
        whatCouldFail: 'A locktime before expiry or a payout to another script.',
        nextRecommendedAction: 'Broadcast the recovery after the expiry height on a real node.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck('offers/a-valid-recovery-after-expiry-passes')
      }
    ],
    failureInjections: [
      {
        id: 'inject-early-locktime',
        label: 'Recover before expiry',
        description: 'Applies the refusal vector change: the recovery locktime is below the expiry height.',
        stepId: 'step-1',
        mutate: vectorDelta('offers/a-valid-recovery-after-expiry-passes', 'offers/a-recovery-before-expiry-is-refused'),
        expectedRefusalCode: 'RECOVERY_BEFORE_EXPIRY',
        affectedInvariant: 'Recovery is valid only from the expiry height on.',
        vectorId: 'offers/a-recovery-before-expiry-is-refused'
      }
    ]
  },

  // 8. ask.replace-and-reprice.success
  {
    id: 'ask.replace-and-reprice.success',
    title: 'Public Ask: Replace and Reprice (Success)',
    summary: 'A seller replaces a 250,000 sat ask with a 200,000 sat successor. Settlement verifies against the successor terms; the predecessor terms no longer match.',
    protocolVersions: ['1.0', '1.1', '1.2'],
    expectedOutcome: 'success',
    verifierFamily: 'purchase',
    sourceRefs: [
      { title: 'Order Lifecycle Spec', path: 'spec/lifecycle.md', type: 'spec' },
      { title: 'Reference Verifier', path: 'verifier/purchase.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'seller',
        intent: 'Replace the ask with a successor priced at 200,000 sats',
        operation: 'POST /api/ordex/orders/{orderId}/replace',
        inputs: { predecessorPriceSats: '250000', successorPriceSats: '200000' },
        stateTransition: { from: 'OPEN', to: 'REPLACED' },
        whyThisStepExists: 'Keeps the provenance link between predecessor and successor.',
        whatCouldFail: 'The predecessor already settled.',
        nextRecommendedAction: 'Settle against the successor terms.',
        evidenceClass: 'Deterministic example'
      },
      {
        id: 'step-2',
        stepNumber: 2,
        actor: 'buyer',
        intent: 'Settle against the successor: payment of 200,000 sats at the shared index',
        operation: 'Local purchase verifier (verifyPublicAskCompletion)',
        inputs: { successorPriceSats: '200000' },
        stateTransition: { from: 'REPLACED', to: 'VERIFIED_LOCALLY' },
        whyThisStepExists: 'The successor terms, not the predecessor, govern the settlement.',
        whatCouldFail: 'A buyer composing against the old price.',
        nextRecommendedAction: 'Sign and broadcast from the buyer wallet.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck(ASK_VECTOR, (args) => {
          args.order.sellerPaymentValueSats = '200000';
          args.transaction.outputs[2].valueSats = '200000';
          args.transaction.outputs[3].valueSats = addSats(args.transaction.outputs[3].valueSats, 50000n);
          return args;
        })
      }
    ],
    failureInjections: [
      {
        id: 'inject-predecessor-terms',
        label: 'Use the predecessor price',
        description: 'Verifies the successor transaction against the replaced 250,000 sat terms.',
        stepId: 'step-2',
        mutate: (args) => {
          args.order.sellerPaymentValueSats = '250000';
          return args;
        },
        expectedRefusalCode: 'SELLER_VALUE_MISMATCH',
        affectedInvariant: 'A settlement must match the exact terms the seller signed.'
      }
    ]
  },

  // 9. safeops.consolidation.success
  {
    id: 'safeops.consolidation.success',
    title: 'SafeOps: UTXO Consolidation (Success)',
    summary: 'Consolidates two examined cardinal inputs into one output while the plan verifier confirms no asset moves and value is conserved.',
    protocolVersions: ['1.2'],
    expectedOutcome: 'success',
    verifierFamily: 'safeops',
    sourceRefs: [
      { title: 'SafeOps Spec', path: 'spec/safeops.md', type: 'spec' },
      { title: 'SafeOps Verifier', path: 'verifier/safeops.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'seller',
        intent: 'Consolidate 110,000 sats of examined cardinal inputs into one 109,400 sat output',
        operation: 'Local SafeOps verifier (verifySafeOpsPlan)',
        inputs: { operationKind: 'CARDINAL_CONSOLIDATION' },
        outputArtifact: { name: 'consolidation-plan.json', type: 'SafeOps plan', payload: CONSOLIDATION_PLAN.args.plan },
        stateTransition: { from: 'INITIAL', to: 'PLAN_VERIFIED' },
        whyThisStepExists: 'Tidies the wallet without risking an inscription.',
        whatCouldFail: 'An input that carries an inscription, or value not conserved.',
        nextRecommendedAction: 'Sign the plan.',
        evidenceClass: 'Protocol verification',
        verifierCheck: CONSOLIDATION_PLAN
      }
    ],
    failureInjections: [
      {
        id: 'inject-inscribed-input',
        label: 'Put an inscription on input 1',
        description: 'Marks the second input as carrying an inscription.',
        stepId: 'step-1',
        mutate: (args) => {
          args.plan.inputs[1].inventory = {
            examined: true,
            inscriptions: [{ inscriptionId: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccci0' }]
          };
          return args;
        },
        expectedRefusalCode: 'ASSET_IN_CARDINAL_OPERATION',
        affectedInvariant: 'A cardinal operation must not spend an input carrying an asset.'
      },
      {
        id: 'inject-value-leak',
        label: 'Overstate the output by 1 sat',
        description: 'Raises the output to 109,401 sats so inputs no longer equal outputs plus fee.',
        stepId: 'step-1',
        mutate: (args) => {
          args.plan.outputs[0].valueSats = addSats(args.plan.outputs[0].valueSats, 1n);
          return args;
        },
        expectedRefusalCode: 'VALUE_NOT_CONSERVED',
        affectedInvariant: 'Inputs must equal outputs plus the declared fee.'
      }
    ]
  },

  // 10. safeops.asset-bearing-input.refusal
  {
    id: 'safeops.asset-bearing-input.refusal',
    title: 'SafeOps: Asset-Bearing Input in a Cardinal Send (Refusal)',
    summary: 'The plan verifier catches an inscription on an input meant for a plain BTC send and refuses before any signature.',
    protocolVersions: ['1.2'],
    expectedOutcome: 'refusal',
    expectedRefusalCode: 'ASSET_IN_CARDINAL_OPERATION',
    verifierFamily: 'safeops',
    sourceRefs: [
      { title: 'SafeOps Spec', path: 'spec/safeops.md', type: 'spec' },
      { title: 'SafeOps Verifier', path: 'verifier/safeops.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'seller',
        intent: 'Attempt a BTC batch send that spends an inscribed input',
        operation: 'Local SafeOps verifier (verifySafeOpsPlan)',
        inputs: { vector: 'safeops/a-cardinal-operation-refuses-an-input-that-carries-an-inscription' },
        stateTransition: { from: 'INITIAL', to: 'PLAN_REFUSED' },
        whyThisStepExists: 'Protects inscriptions from being spent as fee or change.',
        whatCouldFail: 'The verifier refuses the plan.',
        nextRecommendedAction: 'Open the Failure Navigator for this code.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck('safeops/a-cardinal-operation-refuses-an-input-that-carries-an-inscription')
      }
    ]
  },

  // 11. swap.atomic-settlement.success
  {
    id: 'swap.atomic-settlement.success',
    title: 'Atomic Swaps: Bilateral Settlement (Success)',
    summary: 'Maker and taker exchange an inscription for bitcoin in one transaction: both legs move or neither does.',
    protocolVersions: ['1.2'],
    expectedOutcome: 'success',
    verifierFamily: 'swaps',
    sourceRefs: [
      { title: 'Swaps Spec', path: 'spec/swaps.md', type: 'spec' },
      { title: 'Swaps Verifier', path: 'verifier/swaps.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'seller',
        intent: 'Publish a maker intent with exact outpoints and consideration',
        operation: 'Local swaps verifier (verifySwapIntent)',
        inputs: { vector: 'swaps/a-public-intent-with-exact-outpoints-is-accepted' },
        stateTransition: { from: 'INITIAL', to: 'INTENT_OPEN' },
        whyThisStepExists: 'The maker commits to terms with an identity proof and digest.',
        whatCouldFail: 'A missing maker proof or an edited digest.',
        nextRecommendedAction: 'The taker composes the acceptance plan.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck('swaps/a-public-intent-with-exact-outpoints-is-accepted')
      },
      {
        id: 'step-2',
        stepNumber: 2,
        actor: 'buyer',
        intent: 'The taker accepts, providing the consideration and receiving the asset',
        operation: 'Local swaps verifier (verifySwapAcceptance)',
        inputs: { vector: 'swaps/an-acceptance-plan-matching-its-intent-is-accepted' },
        stateTransition: { from: 'INTENT_OPEN', to: 'ACCEPTANCE_VERIFIED' },
        whyThisStepExists: 'Guarantees either both legs move or neither does.',
        whatCouldFail: 'A consideration shortfall or an unclosed sighash.',
        nextRecommendedAction: 'Both parties sign; broadcast on a real node.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck('swaps/an-acceptance-plan-matching-its-intent-is-accepted')
      }
    ],
    failureInjections: [
      {
        id: 'inject-consideration-shortfall',
        label: 'Short the maker consideration',
        description: 'Applies the refusal vector change: the maker receives less than the intent requires.',
        stepId: 'step-2',
        mutate: vectorDelta('swaps/an-acceptance-plan-matching-its-intent-is-accepted', 'swaps/a-consideration-shortfall-is-refused'),
        expectedRefusalCode: 'CONSIDERATION_SHORTFALL',
        affectedInvariant: 'The maker must receive at least the committed consideration.',
        vectorId: 'swaps/a-consideration-shortfall-is-refused'
      }
    ]
  },

  // 12. cold-sign.returned-bytes-mismatch.refusal
  {
    id: 'cold-sign.returned-bytes-mismatch.refusal',
    title: 'Cold Signing: Returned Result Changed (Refusal)',
    summary: 'The offline signer returns a result whose output script differs from the approved manifest, and the comparison refuses it.',
    protocolVersions: ['1.2'],
    expectedOutcome: 'refusal',
    expectedRefusalCode: 'SCRIPT_CHANGED',
    verifierFamily: 'offline-signing',
    sourceRefs: [
      { title: 'Cold-Signing Spec', path: 'spec/cold-signing.md', type: 'spec' },
      { title: 'Offline Signing Verifier', path: 'verifier/offline-signing.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'seller',
        intent: 'Approve the expected transaction manifest',
        operation: 'Local manifest verifier (verifyExpectedTransactionManifest)',
        inputs: { vector: 'offline-signing/a-complete-manifest-is-accepted' },
        stateTransition: { from: 'INITIAL', to: 'MANIFEST_APPROVED' },
        whyThisStepExists: 'The manifest is what the user approved before the device signs.',
        whatCouldFail: 'An incomplete manifest.',
        nextRecommendedAction: 'Send the manifest to the offline signer.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck('offline-signing/a-complete-manifest-is-accepted')
      },
      {
        id: 'step-2',
        stepNumber: 2,
        actor: 'seller',
        intent: 'Compare the returned signed result with the approved manifest',
        operation: 'Local comparison (compareSignedResultToManifest)',
        inputs: { vector: 'offline-signing/a-changed-output-script-is-refused' },
        stateTransition: { from: 'MANIFEST_APPROVED', to: 'RESULT_REFUSED' },
        whyThisStepExists: 'Catches a compromised device or tampering in transit.',
        whatCouldFail: 'The comparison refuses the changed output script.',
        nextRecommendedAction: 'Inspect the returned bytes in Artifact Lens and do not broadcast.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck('offline-signing/a-changed-output-script-is-refused')
      }
    ]
  },

  // 13. collection.membership.success
  {
    id: 'collection.membership.success',
    title: 'Collection Provenance: Membership Proof (Success)',
    summary: 'An item proves membership in a creator-signed collection manifest with a Merkle proof against the published root.',
    protocolVersions: ['1.2'],
    expectedOutcome: 'success',
    verifierFamily: 'collection-manifest',
    sourceRefs: [
      { title: 'Collection Manifest Spec', path: 'spec/collection-manifest.md', type: 'spec' },
      { title: 'Manifest Verifier', path: 'verifier/collection-manifest.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'buyer',
        intent: 'Resolve the membership proof against the manifest root',
        operation: 'Local manifest verifier (verifyMembershipProof)',
        inputs: { vector: 'collection-manifest/a-membership-proof-resolves-for-a-real-member' },
        stateTransition: { from: 'INITIAL', to: 'MEMBERSHIP_PROVEN' },
        whyThisStepExists: 'Verifies membership with no network call.',
        whatCouldFail: 'A forged member or a tampered proof step.',
        nextRecommendedAction: 'Show the item as a proven member of the manifest.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck('collection-manifest/a-membership-proof-resolves-for-a-real-member')
      }
    ],
    failureInjections: [
      {
        id: 'inject-tampered-proof',
        label: 'Tamper with the proof',
        description: 'Applies the refusal vector change: a different member and an altered proof path.',
        stepId: 'step-1',
        mutate: vectorDelta('collection-manifest/a-membership-proof-resolves-for-a-real-member', 'collection-manifest/a-tampered-proof-step-does-not-resolve'),
        expectedRefusalCode: 'MEMBER_NOT_PROVEN',
        affectedInvariant: 'The proof must resolve to the manifest membership root.',
        vectorId: 'collection-manifest/a-tampered-proof-step-does-not-resolve'
      }
    ]
  },

  // 14. counterparty.attachment-mismatch.refusal
  {
    id: 'counterparty.attachment-mismatch.refusal',
    title: 'Counterparty Asset: Attachment Lands Elsewhere (Refusal)',
    summary: 'A spend moves an attached Counterparty asset, but sat flow lands it in a different output than the one planned.',
    protocolVersions: ['1.2'],
    expectedOutcome: 'refusal',
    expectedRefusalCode: 'DESTINATION_MISMATCH',
    verifierFamily: 'counterparty-asset',
    sourceRefs: [
      { title: 'Counterparty UTXO Asset Spec', path: 'spec/counterparty-utxo-asset.md', type: 'spec' },
      { title: 'Counterparty Verifier', path: 'verifier/counterparty-asset.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'seller',
        intent: 'Spend the attached UTXO with the asset planned for output 0',
        operation: 'Local attachment verifier (verifyAttachmentFollows)',
        inputs: { vector: 'counterparty-asset/a-spend-whose-sat-flow-lands-the-asset-elsewhere-is-refused' },
        stateTransition: { from: 'INITIAL', to: 'ATTACHMENT_REFUSED' },
        whyThisStepExists: 'An attached asset follows sat flow, not intent.',
        whatCouldFail: 'The verifier refuses the destination.',
        nextRecommendedAction: 'Re-align output values so the attachment lands where planned.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck('counterparty-asset/a-spend-whose-sat-flow-lands-the-asset-elsewhere-is-refused')
      }
    ]
  },

  // 15. runes.cenotaph.refusal
  {
    id: 'runes.cenotaph.refusal',
    title: 'Runes: Cenotaph Burn Protection (Refusal)',
    summary: 'A runestone carries an unrecognized even tag, making it a cenotaph that would burn every rune balance it spends; the verifier refuses.',
    protocolVersions: ['1.1', '1.2'],
    expectedOutcome: 'refusal',
    expectedRefusalCode: 'CENOTAPH_BURNS_BALANCE',
    verifierFamily: 'runes',
    sourceRefs: [
      { title: 'Runes Spec', path: 'spec/runes.md', type: 'spec' },
      { title: 'Runes Verifier', path: 'verifier/runes.js', type: 'verifier' }
    ],
    steps: [
      {
        id: 'step-1',
        stepNumber: 1,
        actor: 'seller',
        intent: 'Decipher the runestone before spending rune-bearing inputs',
        operation: 'Local runes verifier (verifyRuneBurnSafety)',
        inputs: { vector: 'runes/unrecognized-even-tag' },
        stateTransition: { from: 'INITIAL', to: 'CENOTAPH_REFUSED' },
        whyThisStepExists: 'An unrecognized even tag turns the runestone into a cenotaph, burning all input runes.',
        whatCouldFail: 'The verifier refuses the burn.',
        nextRecommendedAction: 'Remove the unrecognized even tag before signing.',
        evidenceClass: 'Protocol verification',
        verifierCheck: vectorCheck('runes/unrecognized-even-tag')
      }
    ]
  }
];

export function getScenarioById(id: string): ScenarioDefinition | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
