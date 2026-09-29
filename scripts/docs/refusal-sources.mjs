// OX-S09: every refusal code the reference verifiers can return, with the exact source site
// (file, line, enclosing function) and the branch's own reason text. Codes built from a
// template, such as `${label}_UNASSIGNED`, are expanded from the literal labels passed to the
// function that builds them, so no reachable code is missed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILY_REGISTRY } from '../../site/src/lib/conformance-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERIFIER_DIR = path.join(ROOT, 'verifier');

const STRING = String.raw`(?:\x60((?:[^\x60\\]|\\.)*)\x60|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")`;
const REFUSE_CALL = new RegExp(String.raw`\b(?:refuse|termsRefuse|acceptanceRefuse|recoveryRefuse)\s*\(\s*(?:'([A-Z0-9_-]+)'|"([A-Z0-9_-]+)"|\x60\$\{(\w+)\}_([A-Z0-9_]+)\x60)(?:\s*,\s*(?:${STRING}|(\w+(?:\.\w+)*)\s*\)))?`, 'g');
// refuse(cond ? 'A' : 'B', cond ? `reason A` : `reason B`): both codes, each with its reason.
const REFUSE_TERNARY = new RegExp(String.raw`\b(?:refuse|termsRefuse|acceptanceRefuse|recoveryRefuse)\s*\(\s*[^,()?]*\?\s*'([A-Z0-9_]+)'\s*:\s*'([A-Z0-9_]+)'`, 'g');
const STRING_G = new RegExp(STRING, 'g');
const CODE_FIELD = new RegExp(String.raw`\bcode:\s*'([A-Z0-9_-]+)'`, 'g');
const REASON_FIELD = new RegExp(String.raw`\breason:\s*${STRING}`);

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const readable = (raw) => raw.replace(/\$\{([^}]+)\}/g, '<$1>').replace(/\s+/g, ' ').trim();

function enclosingSymbol(lines, lineNo) {
  for (let i = lineNo - 1; i >= 0; i--) {
    const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/) || lines[i].match(/^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
    if (m) return m[1];
  }
  return null;
}

/**
 * A branch that passes on another call's reason, as refuse('X', parsed.reason): names the
 * call that produced it (const parsed = parseTransaction(...) just above), so the rule says
 * where the words come from.
 */
function passedOnReason(lines, lineNo, expr) {
  const [id] = expr.split('.');
  for (let i = lineNo - 1; i >= Math.max(0, lineNo - 6); i--) {
    const m = lines[i].match(new RegExp(String.raw`\b(?:const|let)\s+${id}\s*=\s*(\w+)\(`)) || lines[i].match(new RegExp(String.raw`\b${id}\s*=\s*(\w+)\(`));
    if (m) return `${m[1]} refused the input: <${expr}>`;
  }
  return `<${expr}>`;
}

/** Literal labels passed as the parameter `param` of any arrow function that declares it. */
function templateLabels(text, param) {
  const labels = new Set();
  const decl = new RegExp(String.raw`const\s+(\w+)\s*=\s*\(([^)]*\b${param}\b[^)]*)\)\s*=>`, 'g');
  for (const d of text.matchAll(decl)) {
    const position = d[2].split(',').map((s) => s.trim()).indexOf(param);
    for (const call of text.matchAll(new RegExp(String.raw`\b${d[1]}\(([^()]*(?:\([^()]*\)[^()]*)*)\)`, 'g'))) {
      const args = call[1].split(',').map((s) => s.trim());
      const lit = args[position]?.match(/^'([A-Z0-9_]+)'$/);
      if (lit) labels.add(lit[1]);
    }
  }
  return [...labels];
}

/**
 * Families whose verifier reaches each helper module (a verifier file that is no family's own,
 * such as asset-flow.js or bitcoin-tx.js), following imports transitively.
 */
export function helperFamilies(dir = VERIFIER_DIR) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
  const imports = Object.fromEntries(files.map((f) => [f, [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/from '\.\/([\w.-]+\.js)'/g)].map((m) => m[1])]));
  const reach = (f, seen = new Set()) => {
    for (const d of imports[f] || []) {
      if (seen.has(d)) continue;
      seen.add(d);
      reach(d, seen);
    }
    return seen;
  };
  const out = {};
  for (const [family, spec] of Object.entries(FAMILY_REGISTRY)) for (const d of reach(spec.verifier)) (out[d] ||= []).push(family);
  return out;
}

/**
 * code -> { code, sites: [{ family, file, line, symbol, reason, via? }] }, sorted by code. A site in
 * a helper module is named after the module and lists in `via` the families whose verifier
 * reaches it; a reproducer through any of them covers it.
 */
export function scanRefusalSources(dir = VERIFIER_DIR) {
  const codes = new Map();
  const add = (code, site) => {
    if (!codes.has(code)) codes.set(code, { code, sites: [] });
    codes.get(code).sites.push(site);
  };
  const ownFiles = new Set(Object.values(FAMILY_REGISTRY).map((f) => f.verifier));
  const helpers = helperFamilies(dir);
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).sort()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const own = Object.keys(FAMILY_REGISTRY).find((k) => FAMILY_REGISTRY[k].verifier === file);
    const family = own || file.replace(/\.js$/, '');
    // Families other than the file's own whose verifier also reaches this file.
    const reachedBy = (helpers[file] || []).filter((f) => f !== own).sort();
    const via = reachedBy.length || !own ? reachedBy : null;
    for (const m of text.matchAll(REFUSE_CALL)) {
      const line = lineOf(text, m.index);
      const reason = m[8] ? passedOnReason(lines, line, m[8]) : readable(m[5] ?? m[6] ?? m[7] ?? '');
      const site = { family, file: `verifier/${file}`, line, symbol: enclosingSymbol(lines, line), reason, ...(via ? { via } : {}) };
      if (m[3]) for (const label of templateLabels(text, m[3])) add(`${label}_${m[4]}`, site);
      else add(m[1] || m[2], site);
    }
    for (const m of text.matchAll(REFUSE_TERNARY)) {
      const line = lineOf(text, m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 800);
      const reasons = [...after.matchAll(STRING_G)].slice(0, 2).map((r) => readable(r[1] ?? r[2] ?? r[3] ?? ''));
      [m[1], m[2]].forEach((code, k) => add(code, { family, file: `verifier/${file}`, line, symbol: enclosingSymbol(lines, line), reason: reasons[k] || reasons[0] || '', ...(via ? { via } : {}) }));
    }
    for (const m of text.matchAll(CODE_FIELD)) {
      const line = lineOf(text, m.index);
      const r = text.slice(m.index, m.index + 400).match(REASON_FIELD);
      add(m[1], { family, file: `verifier/${file}`, line, symbol: enclosingSymbol(lines, line), reason: r ? readable(r[1] ?? r[2] ?? r[3] ?? '') : '', ...(via ? { via } : {}) });
    }
  }
  return new Map([...codes.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
