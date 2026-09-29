// OX-S09: every refusal code the reference verifiers can return, with the exact source site
// (file, line, enclosing function) and the branch's own reason text. Codes built from a
// template, such as `${label}_UNASSIGNED`, are expanded from the literal labels passed to the
// function that builds them, so no reachable code is missed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERIFIER_DIR = path.join(ROOT, 'verifier');

const STRING = String.raw`(?:\x60((?:[^\x60\\]|\\.)*)\x60|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")`;
const REFUSE_CALL = new RegExp(String.raw`\b(?:refuse|termsRefuse|acceptanceRefuse|recoveryRefuse)\s*\(\s*(?:'([A-Z0-9_-]+)'|"([A-Z0-9_-]+)"|\x60\$\{(\w+)\}_([A-Z0-9_]+)\x60)(?:\s*,\s*${STRING})?`, 'g');
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

/** code -> { code, sites: [{ family, file, line, symbol, reason }] }, sorted by code. */
export function scanRefusalSources(dir = VERIFIER_DIR) {
  const codes = new Map();
  const add = (code, site) => {
    if (!codes.has(code)) codes.set(code, { code, sites: [] });
    codes.get(code).sites.push(site);
  };
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js')).sort()) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    const family = file.replace(/\.js$/, '');
    for (const m of text.matchAll(REFUSE_CALL)) {
      const line = lineOf(text, m.index);
      const reason = readable(m[5] ?? m[6] ?? m[7] ?? '');
      const site = { family, file: `verifier/${file}`, line, symbol: enclosingSymbol(lines, line), reason };
      if (m[3]) for (const label of templateLabels(text, m[3])) add(`${label}_${m[4]}`, site);
      else add(m[1] || m[2], site);
    }
    for (const m of text.matchAll(CODE_FIELD)) {
      const line = lineOf(text, m.index);
      const r = text.slice(m.index, m.index + 400).match(REASON_FIELD);
      add(m[1], { family, file: `verifier/${file}`, line, symbol: enclosingSymbol(lines, line), reason: r ? readable(r[1] ?? r[2] ?? r[3] ?? '') : '' });
    }
  }
  return new Map([...codes.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
