// OX-S07: the one family registry shared by the vector generator, the conformance CLI,
// Protocol Lab, Conformance Studio and the MCP dispatcher. It is plain data with no
// imports so it loads the same way in Node, the browser and a Web Worker. File names map
// to executor names here (offer-vectors.json -> offers), never by string surgery, so a
// renamed file or family fails loudly instead of silently dropping cases.

/**
 * @typedef {'ok' | 'safe'} ResultKind
 * @typedef {{ label: string, args: string[], optional?: string[], match: (c: Record<string, unknown>) => boolean }} VariantSpec
 * @typedef {{ file: string, verifier: string, label: string, spec: string, result: ResultKind,
 *   expectedFields: string[], variants: Record<string, VariantSpec> }} FamilySpec
 */

const has = (key) => (c) => c != null && c[key] !== undefined && c[key] !== null;
const always = () => true;

/** @type {Readonly<Record<string, FamilySpec>>} */
export const FAMILY_REGISTRY = Object.freeze({
  purchase: {
    file: 'purchase-vectors.json',
    verifier: 'purchase.js',
    label: 'Purchase',
    spec: 'spec/purchase.md',
    result: 'ok',
    expectedFields: ['ok', 'code', 'sharedIndex'],
    variants: {
      completion: { label: 'Public ask completion', args: ['transaction', 'order'], match: always }
    }
  },
  offers: {
    file: 'offer-vectors.json',
    verifier: 'offers.js',
    label: 'Offers',
    spec: 'spec/offers.md',
    result: 'ok',
    expectedFields: ['ok', 'code', 'sharedIndex', 'offerTermsHash'],
    variants: {
      terms: { label: 'Offer terms', args: ['terms'], match: (c) => c.kind === 'terms' },
      acceptance: { label: 'Offer acceptance', args: ['acceptance', 'offer'], match: (c) => c.kind === 'acceptance' },
      recovery: { label: 'Offer recovery', args: ['recovery', 'offer'], match: (c) => c.kind === 'recovery' }
    }
  },
  runes: {
    file: 'rune-burn-vectors.json',
    verifier: 'runes.js',
    label: 'Rune burn safety',
    spec: 'spec/runes.md',
    result: 'safe',
    expectedFields: ['safe', 'code', 'runestone', 'flaw'],
    variants: {
      'burn-safety': { label: 'Rune burn safety', args: ['outputScriptsHex', 'inputs'], optional: ['outputCount'], match: always }
    }
  },
  safeops: {
    file: 'safeops-vectors.json',
    verifier: 'safeops.js',
    label: 'SafeOps',
    spec: 'spec/safeops.md',
    result: 'ok',
    expectedFields: ['ok', 'code'],
    variants: {
      signed: { label: 'Signed result against plan', args: ['signed', 'plan'], match: has('signed') },
      plan: { label: 'SafeOps plan', args: ['plan'], match: always }
    }
  },
  swaps: {
    file: 'swap-vectors.json',
    verifier: 'swaps.js',
    label: 'Swaps',
    spec: 'spec/swaps.md',
    result: 'ok',
    expectedFields: ['ok', 'code'],
    variants: {
      acceptance: { label: 'Swap acceptance', args: ['acceptance', 'intent'], match: has('acceptance') },
      intent: { label: 'Swap intent', args: ['intent'], match: always }
    }
  },
  events: {
    file: 'event-vectors.json',
    verifier: 'events.js',
    label: 'Events and webhooks',
    spec: 'spec/events.md',
    result: 'ok',
    expectedFields: ['ok', 'code'],
    variants: {
      webhook: { label: 'Webhook signature', args: ['signing', 'verifying'], match: (c) => c.kind === 'webhook' },
      event: { label: 'Event envelope', args: ['event'], match: always }
    }
  },
  'collection-manifest': {
    file: 'collection-manifest-vectors.json',
    verifier: 'collection-manifest.js',
    label: 'Collection manifest',
    spec: 'spec/collection-manifest.md',
    result: 'ok',
    expectedFields: ['ok', 'code'],
    variants: {
      membership: { label: 'Membership proof', args: ['manifest', 'membership'], match: has('membership') },
      revocation: { label: 'Manifest revocation', args: ['revocation', 'manifest'], match: has('revocation') },
      manifest: { label: 'Collection manifest', args: ['manifest'], match: always }
    }
  },
  'counterparty-asset': {
    file: 'counterparty-asset-vectors.json',
    verifier: 'counterparty-asset.js',
    label: 'Counterparty asset',
    spec: 'spec/counterparty-utxo-asset.md',
    result: 'ok',
    expectedFields: ['ok', 'code', 'carriedToIndex'],
    variants: {
      attachment: { label: 'Attachment follows spend', args: ['record', 'spendTx', 'expectedOutputIndex'], match: has('spendTx') },
      record: { label: 'UTXO asset record', args: ['record'], match: always }
    }
  },
  'offline-signing': {
    file: 'offline-signing-vectors.json',
    verifier: 'offline-signing.js',
    label: 'Offline signing',
    spec: 'spec/cold-signing.md',
    result: 'ok',
    expectedFields: ['ok', 'code'],
    variants: {
      signed: { label: 'Signed result against manifest', args: ['signed', 'manifest'], match: has('signed') },
      manifest: { label: 'Expected transaction manifest', args: ['manifest'], match: always }
    }
  }
});

export const FAMILIES = Object.freeze(Object.keys(FAMILY_REGISTRY));

export function isKnownFamily(family) {
  return typeof family === 'string' && Object.prototype.hasOwnProperty.call(FAMILY_REGISTRY, family);
}

/** Map a conformance/*.json file name to its executor family, or null. */
export function familyForFile(file) {
  for (const [family, spec] of Object.entries(FAMILY_REGISTRY)) {
    if (spec.file === file) return family;
  }
  return null;
}

/**
 * The variant a vector case exercises. Variants are listed in dispatch order, so the
 * first matching predicate is the one the executor will call.
 */
export function variantOf(family, vectorCase) {
  const spec = FAMILY_REGISTRY[family];
  if (!spec || vectorCase == null || typeof vectorCase !== 'object') return null;
  for (const [name, variant] of Object.entries(spec.variants)) {
    if (variant.match(vectorCase)) return name;
  }
  return null;
}

/** Argument names a variant needs, for editors and input validation. */
export function variantArguments(family, variant) {
  const v = FAMILY_REGISTRY[family]?.variants?.[variant];
  if (!v) return null;
  return { required: [...v.args], optional: [...(v.optional || [])] };
}
