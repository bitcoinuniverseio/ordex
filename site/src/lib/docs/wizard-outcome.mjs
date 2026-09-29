// OX-S11: what a finished wizard leads to, derived from its answers: the Playground operation,
// the Protocol Lab family or Gateway Doctor, the matching recipe and a starter kit with the
// chosen runtime and capabilities. Every link is a real route of the site.

import { FAMILY_REGISTRY } from '../conformance-registry.mjs';

const KIT_CAPABILITY = {
  'publish-ask': 'asks',
  'purchase-ask': 'asks',
  'replace-ask': 'asks',
  'offers-v1': 'offers',
  safeops: 'safeops',
  'atomic-swaps': 'swaps',
  'events-webhooks': 'events',
  'collection-provenance': 'provenance'
};
const RECIPE = { 'integration-path': 'read-the-catalog', 'publish-ask': 'publish-and-purchase', 'purchase-ask': 'publish-and-purchase' };

/** Step ids that still need an answer. */
export function missingAnswers(wizard, answers) {
  return wizard.steps.filter((s) => (s.isMulti ? !(answers[s.id] || []).length : !answers[s.id])).map((s) => s.id);
}

/** Links for a wizard: { label, href } with site-relative hrefs, plus the kit options if any. */
export function wizardOutcome(wizard, answers, operations) {
  const links = [];
  const o = wizard.outcome || {};
  if (o.apiOperation && operations.some((op) => op.operationId === o.apiOperation)) {
    links.push({ label: `Try ${o.apiOperation} in the API Playground`, href: `/build/playground/?operation=${encodeURIComponent(o.apiOperation)}` });
  }
  if (o.verifierFamily === 'doctor') links.push({ label: 'Run Gateway Doctor', href: '/verify/' });
  else if (o.verifierFamily && FAMILY_REGISTRY[o.verifierFamily]) links.push({ label: `Open the ${FAMILY_REGISTRY[o.verifierFamily].label} verifier in Protocol Lab`, href: `/lab/?family=${encodeURIComponent(o.verifierFamily)}` });
  if (RECIPE[wizard.id]) links.push({ label: 'Follow the recipe', href: `/build/recipes/?recipe=${RECIPE[wizard.id]}` });

  let kit = null;
  if (wizard.id === 'integration-path') {
    const runtime = answers.runtime === 'offline' ? 'node' : answers.runtime;
    const capabilities = answers.features || [];
    if (runtime && capabilities.length) kit = { runtime, capabilities, mode: answers.runtime === 'offline' ? 'offline' : 'gateway' };
  } else if (KIT_CAPABILITY[wizard.id]) {
    kit = { runtime: 'node', capabilities: [KIT_CAPABILITY[wizard.id]], mode: 'offline' };
  }
  if (kit) {
    const q = new URLSearchParams({ runtime: kit.runtime, capabilities: kit.capabilities.join(','), mode: kit.mode });
    links.push({ label: `Generate a ${kit.runtime} starter kit (${kit.capabilities.join(', ')})`, href: `/kits/?${q}` });
  }
  return { links, kit };
}
