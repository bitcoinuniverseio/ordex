// OX-S09: turns a diagnostic rule's reproducer (a checked-in conformance case plus a JSON
// Patch) into the exact verifier arguments, and into a self-contained script that calls the
// reference verifier from a checkout of the pinned revision and asserts the code. Pure and
// browser-safe; the page runs the same arguments in the bounded verifier Worker.

import { argsFromCase } from '../lab-report.mjs';
import { applyPatch } from './patch.mjs';

export const REPOSITORY = 'https://github.com/bitcoinuniverseio/ordex';

/** The verifier arguments for a reproducer, given its base vector case. */
export function reproducerArgs(reproducer, baseCase) {
  return argsFromCase(reproducer.family, reproducer.variant, applyPatch(baseCase, reproducer.patch));
}

// How each variant calls its reference verifier, as in site/src/lib/conformance-engine.mjs.
const CALLS = {
  'purchase:completion': { file: 'purchase.js', imports: ['verifyPublicAskCompletion'], call: 'verifyPublicAskCompletion(args.transaction, args.order)' },
  'offers:terms': { file: 'offers.js', imports: ['verifyOfferTerms'], call: 'verifyOfferTerms(args.terms)' },
  'offers:acceptance': { file: 'offers.js', imports: ['verifyOfferAcceptance'], call: 'verifyOfferAcceptance(args.acceptance, args.offer)' },
  'offers:recovery': { file: 'offers.js', imports: ['verifyOfferRecovery'], call: 'verifyOfferRecovery(args.recovery, args.offer)' },
  'runes:burn-safety': { file: 'runes.js', imports: ['verifyRuneBurnSafety'], call: 'verifyRuneBurnSafety(args.outputScriptsHex, args.inputs, args.outputCount)', flag: 'safe' },
  'safeops:plan': { file: 'safeops.js', imports: ['verifySafeOpsPlan'], call: 'verifySafeOpsPlan(args.plan)' },
  'safeops:signed': { file: 'safeops.js', imports: ['verifySafeOpsSignedResult'], call: 'verifySafeOpsSignedResult(args.signed, args.plan)' },
  'swaps:intent': { file: 'swaps.js', imports: ['verifySwapIntent'], call: 'verifySwapIntent(args.intent)' },
  'swaps:acceptance': { file: 'swaps.js', imports: ['verifySwapAcceptance'], call: 'verifySwapAcceptance(args.acceptance, args.intent)' },
  'events:event': { file: 'events.js', imports: ['validateOrdexEvent'], call: 'validateOrdexEvent(args.event)' },
  'events:webhook': {
    file: 'events.js',
    imports: ['signWebhookDelivery', 'verifyWebhookSignature'],
    call: "verifyWebhookSignature({ header: typeof args.verifying.headerOverride === 'string' ? args.verifying.headerOverride : signWebhookDelivery(args.signing), ...withoutOverride(args.verifying) })",
    helper: 'const withoutOverride = ({ headerOverride, ...rest }) => rest;'
  },
  'collection-manifest:manifest': { file: 'collection-manifest.js', imports: ['verifyCollectionManifest'], call: 'verifyCollectionManifest(args.manifest)' },
  'collection-manifest:membership': {
    file: 'collection-manifest.js',
    imports: ['verifyMembershipProof'],
    call: 'verifyMembershipProof({ manifest: args.manifest, memberIdentity: args.membership?.memberIdentity, proof: args.membership?.proof })'
  },
  'collection-manifest:revocation': { file: 'collection-manifest.js', imports: ['verifyManifestRevocation'], call: 'verifyManifestRevocation(args.revocation, args.manifest)' },
  'counterparty-asset:record': { file: 'counterparty-asset.js', imports: ['verifyCounterpartyUtxoAsset'], call: 'verifyCounterpartyUtxoAsset(args.record)' },
  'counterparty-asset:attachment': { file: 'counterparty-asset.js', imports: ['verifyAttachmentFollows'], call: 'verifyAttachmentFollows(args.record, args.spendTx, args.expectedOutputIndex)' },
  'offline-signing:manifest': { file: 'offline-signing.js', imports: ['verifyExpectedTransactionManifest'], call: 'verifyExpectedTransactionManifest(args.manifest)' },
  'offline-signing:signed': { file: 'offline-signing.js', imports: ['compareSignedResultToManifest'], call: 'compareSignedResultToManifest(args.signed, args.manifest)' }
};

export function verifierCall(family, variant) {
  const c = CALLS[`${family}:${variant}`];
  if (!c) throw new Error(`No verifier call for ${family}:${variant}`);
  return c;
}

/**
 * A runnable Node script: run it from a checkout of the repository at `revision`. It holds
 * only the published conformance data and its patch, never user input.
 */
export function reproducerScript({ code, reproducer, args, revision }) {
  const c = verifierCall(reproducer.family, reproducer.variant);
  const flag = c.flag || 'ok';
  const pinned = /^[0-9a-f]{7,64}$/.test(revision || '');
  return [
    `// Reproduces the Ordex refusal ${code} with the reference verifier (verifier/${c.file}).`,
    `// Source case: ${reproducer.base}${reproducer.patch.length ? ` with ${reproducer.patch.length} change(s): ${reproducer.patch.map((p) => `${p.op} ${p.path}`).join('; ')}` : ''}.`,
    `// Run from a checkout of ${REPOSITORY}${pinned ? ` at ${revision} (git checkout ${revision})` : ''} with Node.js 24:`,
    `//   node reproduce-${code}.mjs`,
    "import assert from 'node:assert/strict';",
    `import { ${c.imports.join(', ')} } from './verifier/${c.file}';`,
    '',
    ...(c.helper ? [c.helper, ''] : []),
    `const args = ${JSON.stringify(args, null, 2)};`,
    '',
    `const result = ${c.call};`,
    `assert.equal(result.${flag}, false, 'the verifier accepted the case');`,
    `assert.equal(result.code, '${code}');`,
    `console.log(\`${code} reproduced: \${result.reason}\`);`,
    ''
  ].join('\n');
}
