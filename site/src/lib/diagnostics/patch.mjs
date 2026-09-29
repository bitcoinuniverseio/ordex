// OX-S09: the small JSON Patch subset (RFC 6902 remove, replace, add) that turns a checked-in
// conformance case into a refusal reproducer. Pure and browser-safe; the input is never
// modified. A path that does not exist throws, so a stale reproducer fails loudly.

const unescape = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~');
export const pointerEscape = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');

function parent(doc, path) {
  if (!path.startsWith('/')) throw new Error(`Invalid JSON pointer: ${path}`);
  const parts = path.slice(1).split('/').map(unescape);
  const last = parts.pop();
  let node = doc;
  for (const p of parts) {
    if (node === null || typeof node !== 'object' || !(p in node)) throw new Error(`Path ${path} does not exist`);
    node = node[p];
  }
  if (node === null || typeof node !== 'object') throw new Error(`Path ${path} does not exist`);
  return { node, key: Array.isArray(node) ? (last === '-' ? node.length : Number(last)) : last };
}

export function applyPatch(doc, ops) {
  const out = structuredClone(doc);
  for (const op of ops) {
    const { node, key } = parent(out, op.path);
    if (op.op === 'remove') {
      if (!(key in node)) throw new Error(`Path ${op.path} does not exist`);
      if (Array.isArray(node)) node.splice(key, 1);
      else delete node[key];
    } else if (op.op === 'replace') {
      if (!(key in node)) throw new Error(`Path ${op.path} does not exist`);
      node[key] = structuredClone(op.value);
    } else if (op.op === 'add') {
      if (Array.isArray(node)) node.splice(key, 0, structuredClone(op.value));
      else node[key] = structuredClone(op.value);
    } else {
      throw new Error(`Unsupported patch operation ${op.op}`);
    }
  }
  return out;
}
