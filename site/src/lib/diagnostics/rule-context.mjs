// OX-S09: the authored part of the diagnostic rules, per verifier variant: where in the
// lifecycle the check runs, the exact inputs needed to reproduce a refusal, and what to do
// after one. Everything code-specific (the failed predicate, its source line, the spec
// statement, the reproducer) is derived from the verifiers, specs and vectors by
// scripts/docs/generate-all-data.mjs, which fails when this file and the verifiers disagree.

/**
 * Protocol version that introduced each family: site/src/data/versions.json history
 * (1.0 purchase; 1.1 offers and rune burn protection; 1.2 SafeOps, swaps, collection
 * manifests, Counterparty UTXO assets, cold signing and events). The generator also checks
 * the "Status: active at protocol X" line of each spec that has one.
 */
export const FAMILY_INTRODUCED_IN = Object.freeze({
  purchase: '1.0',
  offers: '1.1',
  runes: '1.1',
  safeops: '1.2',
  swaps: '1.2',
  events: '1.2',
  'collection-manifest': '1.2',
  'counterparty-asset': '1.2',
  'offline-signing': '1.2'
});

/** Per family:variant. `inputs` name the verifier arguments; `recovery` is the first step. */
export const RULE_CONTEXT = Object.freeze({
  'purchase:completion': {
    lifecycle: 'Purchase check, before the buyer signs',
    inputs: ['The purchase transaction: every input with its value, every output with its script and value', 'The order terms: offered outpoint, price and seller payment script'],
    recovery: 'Do not sign. Rebuild the purchase from the order as currently published, then verify it again.'
  },
  'offers:terms': {
    lifecycle: 'Offer publication',
    inputs: ['The offer terms exactly as they will be published'],
    recovery: 'Correct the terms and publish them again. Any change to the terms changes their hash.'
  },
  'offers:acceptance': {
    lifecycle: 'Offer acceptance, before the seller signs',
    inputs: ['The acceptance transaction with every input and output', 'The offer: funded outpoint, Feline outpoint and terms'],
    recovery: 'Do not sign the acceptance. Rebuild it from the offer as published.'
  },
  'offers:recovery': {
    lifecycle: 'Offer recovery, when the buyer reclaims an unaccepted offer',
    inputs: ['The recovery transaction', 'The offer being recovered, with its expiry'],
    recovery: 'Rebuild the recovery so it spends only the funded offer output back to the buyer, after the offer expires.'
  },
  'runes:burn-safety': {
    lifecycle: 'Before signing any transaction that spends rune balances',
    inputs: ['Every output script (hex) of the transaction, including any runestone', 'The rune balances each input carries'],
    recovery: 'Do not sign or broadcast: confirming this transaction would burn runes. Fix or remove the runestone and check again.'
  },
  'safeops:plan': {
    lifecycle: 'SafeOps plan review, before signing',
    inputs: ['The SafeOps plan, including the examined inventory of every input'],
    recovery: 'Regenerate the plan from the wallet as it is now and review it again before signing.'
  },
  'safeops:signed': {
    lifecycle: 'After signing, before broadcast',
    inputs: ['The signed result', 'The plan that was approved'],
    recovery: 'Do not broadcast. The signed transaction is not the approved plan: discard it and sign the approved plan again.'
  },
  'swaps:intent': {
    lifecycle: 'Swap intent publication',
    inputs: ['The swap intent exactly as it will be published'],
    recovery: 'Correct the intent and publish it again.'
  },
  'swaps:acceptance': {
    lifecycle: 'Swap acceptance, before either party signs',
    inputs: ['The acceptance plan: transaction, asset transitions, fee and signing', 'The published intent it accepts'],
    recovery: 'Do not sign. Rebuild the acceptance plan from the published intent.'
  },
  'events:event': {
    lifecycle: 'Consuming an event from the stream or a webhook body',
    inputs: ['The event envelope exactly as received'],
    recovery: 'Reject the event and do not apply it. Fetch it again from the replayable stream from your last checkpoint.'
  },
  'events:webhook': {
    lifecycle: 'Receiving a signed webhook delivery',
    inputs: ['The received signature header, timestamp and delivery id', 'The raw body bytes as received', 'The shared secret for this subscription (kept private, never pasted into a tool)'],
    recovery: 'Reject the delivery. Verify the raw body as received, with the current secret and your timestamp tolerance; the sender retries.'
  },
  'collection-manifest:manifest': {
    lifecycle: 'Collection manifest validation',
    inputs: ['The collection manifest'],
    recovery: 'Treat the collection as unverified and ask the creator for a corrected, re-signed manifest.'
  },
  'collection-manifest:membership': {
    lifecycle: 'Checking that one item belongs to a collection',
    inputs: ['The collection manifest', 'The item identity', 'The membership proof'],
    recovery: 'Treat the item as not proven a member. Request a fresh proof for the current manifest version.'
  },
  'collection-manifest:revocation': {
    lifecycle: 'Applying a manifest revocation',
    inputs: ['The revocation', 'The manifest it names'],
    recovery: 'Ignore the revocation: it does not validly revoke this manifest. Keep the manifest status unchanged.'
  },
  'counterparty-asset:record': {
    lifecycle: 'Counterparty UTXO asset record validation',
    inputs: ['The UTXO asset record'],
    recovery: 'Treat the attachment as unknown until a valid record is obtained again from the Counterparty source.'
  },
  'counterparty-asset:attachment': {
    lifecycle: 'Spending a UTXO that carries a Counterparty asset, before signing',
    inputs: ['The asset record', 'The spending transaction', 'The output index that should receive the asset'],
    recovery: 'Do not sign. Rebuild the spend so the attached asset lands at the intended output.'
  },
  'offline-signing:manifest': {
    lifecycle: 'Preparing an offline signing session',
    inputs: ['The expected-transaction manifest'],
    recovery: 'Rebuild the expected-transaction manifest on the online machine and transfer it to the signer again.'
  },
  'offline-signing:signed': {
    lifecycle: 'After offline signing, before broadcast',
    inputs: ['The signed result from the offline signer', 'The expected-transaction manifest it was signed from'],
    recovery: 'Do not broadcast: the signed transaction is not the manifest. Sign again from a verified manifest.'
  }
});

/** Resolution steps for one refusal: the variant recovery, then re-verification. */
export function resolutionSteps(context, familyLabel) {
  return [
    { step: 1, action: context.recovery },
    { step: 2, action: `Run the ${familyLabel} verifier on the corrected input and continue only when it accepts.` }
  ];
}
