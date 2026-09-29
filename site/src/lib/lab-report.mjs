// OX-S07: Protocol Lab helpers kept free of UI code so Node tests exercise the exact logic
// the page uses: stable input digests, candidate validation, A/B input differences and the
// exported report shape.

import { createHash } from './browser/node-crypto.mjs';
import { FAMILY_REGISTRY, variantArguments } from './conformance-registry.mjs';

export const LAB_REPORT_SCHEMA = 'ordex.lab-report/v1';

/** JSON with object keys sorted at every level, so equal inputs digest identically. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function inputDigest(args) {
  return sha256Hex(stableJson(args));
}

/** The variant's arguments taken from a source vector case, in their original shape. */
export function argsFromCase(family, variant, source) {
  const need = variantArguments(family, variant);
  if (!need || !source) return null;
  const args = {};
  for (const key of [...need.required, ...need.optional]) {
    if (source[key] !== undefined) args[key] = source[key];
  }
  return args;
}

/** Check a parsed candidate against the variant contract before it reaches a verifier. */
export function validateCandidate(family, variant, args) {
  const need = variantArguments(family, variant);
  if (!need) return { ok: false, error: `Unknown ${family} variant: ${variant}` };
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: 'The input must be a JSON object whose keys are the variant arguments.' };
  }
  const missing = need.required.filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length) return { ok: false, error: `Missing required arguments: ${missing.join(', ')}.` };
  const allowed = new Set([...need.required, ...need.optional]);
  const unknown = Object.keys(args).filter((k) => !allowed.has(k));
  if (unknown.length) return { ok: false, error: `Arguments this variant does not take: ${unknown.join(', ')}.` };
  return { ok: true };
}

/** Top-level and nested JSON paths whose values differ between two inputs. */
export function diffPaths(a, b, prefix = '', out = []) {
  if (out.length >= 200) return out;
  const isObj = (v) => v && typeof v === 'object';
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const p = Array.isArray(a) ? `${prefix}[${k}]` : prefix ? `${prefix}.${k}` : k;
      if (!(k in a)) out.push({ path: p, change: 'added' });
      else if (!(k in b)) out.push({ path: p, change: 'removed' });
      else diffPaths(a[k], b[k], p, out);
    }
    return out;
  }
  if (stableJson(a) !== stableJson(b)) out.push({ path: prefix || '(root)', change: 'changed' });
  return out;
}

/** The exported Lab report. It carries a digest of the input, never the input itself. */
export function buildLabReport({ run, sourceBuild, vectorDigest, context }) {
  return {
    schema: LAB_REPORT_SCHEMA,
    family: run.family,
    familyLabel: FAMILY_REGISTRY[run.family]?.label || run.family,
    variant: run.variant,
    inputSha256: run.inputSha256,
    context: {
      network: context?.network ?? null,
      gateway: context?.gateway ?? null,
      execution: 'Local reference verifier in a dedicated browser Worker'
    },
    sourceBuild: sourceBuild || 'unknown',
    vectorDigest: vectorDigest || null,
    ranAt: run.ranAt,
    verdict: run.verdict,
    conformance: run.conformance
      ? { vectorId: run.vectorId, matched: run.conformance.passed, mismatches: run.conformance.mismatches }
      : null,
    limits:
      'A local verifier verdict. It is not a signed transaction, a broadcast or chain confirmation.'
  };
}

export function labReportMarkdown(report) {
  const v = report.verdict || {};
  const lines = [
    '# Ordex Protocol Lab report',
    '',
    `- Schema: \`${report.schema}\``,
    `- Family: \`${report.family}\` (${report.familyLabel})`,
    `- Variant: \`${report.variant}\``,
    `- Input SHA-256: \`${report.inputSha256}\``,
    `- Verdict: **${String(v.state || 'unknown').toUpperCase()}**${v.code ? ` (\`${v.code}\`)` : ''}`,
    `- Reason: ${v.reason || 'None given'}`,
    `- Network: ${report.context.network || 'Not applicable'}`,
    `- Source build: \`${report.sourceBuild}\``,
    `- Vector set digest: \`${report.vectorDigest || 'unknown'}\``,
    `- Ran at: ${report.ranAt}`
  ];
  if (report.conformance) {
    lines.push(`- Conformance vector \`${report.conformance.vectorId}\`: ${report.conformance.matched ? 'expected verdict matched' : 'MISMATCH'}`);
  }
  lines.push('', `> ${report.limits}`, '');
  return lines.join('\n');
}

function toSats(v) {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

/**
 * First-in first-out sat flow (the ordinal theory rule): the offered input's first sat
 * lands in the output whose cumulative value range contains that offset. Every value must
 * parse as integer sats, otherwise no asset output is claimed (-1).
 */
export function assetOutputIndex(inputs, outputs, offeredIndex) {
  if (!Array.isArray(inputs) || !Array.isArray(outputs) || offeredIndex < 0 || offeredIndex >= inputs.length) return -1;
  let offset = 0n;
  for (let i = 0; i < offeredIndex; i++) {
    const v = toSats(inputs[i]?.valueSats);
    if (v === null) return -1;
    offset += v;
  }
  let start = 0n;
  for (let j = 0; j < outputs.length; j++) {
    const v = toSats(outputs[j]?.valueSats);
    if (v === null) return -1;
    if (offset < start + v) return j;
    start += v;
  }
  return -1;
}
