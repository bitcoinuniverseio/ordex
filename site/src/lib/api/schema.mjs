// OX-S07 / OX-S05: a small OpenAPI 3.1 (JSON Schema 2020-12 subset) validator and example
// builder, shared by the data generator and the API Playground. It covers every keyword
// spec/openapi.json uses; a keyword it does not implement is reported, not ignored.

const SUPPORTED = new Set([
  '$ref', 'type', 'enum', 'const', 'pattern', 'format', 'minLength', 'maxLength', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'oneOf', 'anyOf', 'allOf', 'not', 'nullable',
  // annotations with no validation effect
  'description', 'title', 'example', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly', 'discriminator', 'externalDocs', 'xml', '$comment'
]);

function unescapePointer(part) {
  return decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
}

export function resolveRef(ref, doc) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error(`Unsupported $ref: ${ref}`);
  let cur = doc;
  for (const part of ref.slice(2).split('/')) {
    cur = cur?.[unescapePointer(part)];
    if (cur === undefined) throw new Error(`Unresolvable $ref: ${ref}`);
  }
  return cur;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(value, type) {
  const t = typeOf(value);
  if (type === 'number') return t === 'number' || t === 'integer';
  return t === type;
}

const FORMATS = {
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)),
  uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
  uri: (s) => {
    try {
      return Boolean(new URL(s).protocol);
    } catch {
      return false;
    }
  }
};

function equalJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Validate a value. Returns an array of { path, message }; empty means valid.
 */
export function validateSchema(value, schema, doc, path = '$', depth = 0) {
  const errors = [];
  if (depth > 64) return [{ path, message: 'Schema nesting is too deep' }];
  if (schema === true || schema === undefined) return errors;
  if (schema === false) return [{ path, message: 'No value is allowed here' }];
  if (schema.$ref) {
    let target;
    try {
      target = resolveRef(schema.$ref, doc);
    } catch (err) {
      return [{ path, message: err.message }];
    }
    errors.push(...validateSchema(value, target, doc, path, depth + 1));
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key) && !key.startsWith('x-')) errors.push({ path, message: `Schema keyword ${key} is not supported by this validator` });
  }
  if (value === null && schema.nullable === true) return errors;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push({ path, message: `Expected ${types.join(' or ')}, got ${typeOf(value)}` });
      return errors;
    }
  }
  if (schema.const !== undefined && !equalJson(value, schema.const)) errors.push({ path, message: `Must equal ${JSON.stringify(schema.const)}` });
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => equalJson(e, value))) {
    errors.push({ path, message: `Must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push({ path, message: `Does not match ${schema.pattern}` });
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push({ path, message: `Shorter than ${schema.minLength}` });
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push({ path, message: `Longer than ${schema.maxLength}` });
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format](value)) errors.push({ path, message: `Not a valid ${schema.format}` });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `Below minimum ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `Above maximum ${schema.maximum}` });
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push({ path, message: `Must exceed ${schema.exclusiveMinimum}` });
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push({ path, message: `Must be below ${schema.exclusiveMaximum}` });
    if (schema.multipleOf !== undefined && value % schema.multipleOf !== 0) errors.push({ path, message: `Not a multiple of ${schema.multipleOf}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: `Fewer than ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: `More than ${schema.maxItems} items` });
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push({ path, message: 'Items must be unique' });
    if (schema.items) value.forEach((item, i) => errors.push(...validateSchema(item, schema.items, doc, `${path}[${i}]`, depth + 1)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, req)) errors.push({ path: `${path}.${req}`, message: 'Required property is missing' });
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k] !== undefined) errors.push(...validateSchema(v, props[k], doc, `${path}.${k}`, depth + 1));
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${k}`, message: 'Property is not allowed' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateSchema(v, schema.additionalProperties, doc, `${path}.${k}`, depth + 1));
      }
    }
  }
  if (Array.isArray(schema.allOf)) for (const sub of schema.allOf) errors.push(...validateSchema(value, sub, doc, path, depth + 1));
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((sub) => validateSchema(value, sub, doc, path, depth + 1).length === 0)) {
    errors.push({ path, message: 'Matches none of the anyOf alternatives' });
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((sub) => validateSchema(value, sub, doc, path, depth + 1).length === 0).length;
    if (matches !== 1) errors.push({ path, message: `Matches ${matches} oneOf alternatives, exactly one is required` });
  }
  if (schema.not && validateSchema(value, schema.not, doc, path, depth + 1).length === 0) errors.push({ path, message: 'Matches a schema it must not match' });
  return errors;
}

const PATTERN_SAMPLES = {
  '^[0-9a-f]{64}$': 'a0b1c2d3e4f5061728394a5b6c7d8e9f0123456789abcdef0123456789abcdef',
  '^[0-9a-f]{40}$': '0123456789abcdef0123456789abcdef01234567',
  '^[0-9a-f]{64}i[0-9]+$': 'a0b1c2d3e4f5061728394a5b6c7d8e9f0123456789abcdef0123456789abcdefi0',
  '^(0|[1-9][0-9]*)$': '10000',
  '^[0-9]{1,6}(\\.[0-9]{1,4})?$': '5.2500',
  '^\\d+\\.\\d+(\\.\\d+)?$': '1.2.1',
  '^[A-Za-z0-9._:-]{1,128}$': 'example-id-1',
  '^[0-9a-f]*$': '0014d85c2b71d0060b09c9886aeb815e50991dda124d',
  '^[0-9a-f]+$': '0014d85c2b71d0060b09c9886aeb815e50991dda124d',
  '^([0-9a-f]{2})+$': '0014d85c2b71d0060b09c9886aeb815e50991dda124d',
  '^(?:[0-9a-f]{2})+$': '0014d85c2b71d0060b09c9886aeb815e50991dda124d',
  '^[0-9a-f]{64}i(0|[1-9][0-9]*)$': 'a0b1c2d3e4f5061728394a5b6c7d8e9f0123456789abcdef0123456789abcdefi0',
  '^(?:[0-9a-f]{2})*$': '',
  '^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$': '840000:1',
  '^swc_[A-Za-z0-9_-]{43}$': 'swc_ExampleSessionCapability0123456789abcdefghi',
  '^[0-9a-f]{128}$': 'a0b1c2d3e4f5061728394a5b6c7d8e9f0123456789abcdef0123456789abcdefa0b1c2d3e4f5061728394a5b6c7d8e9f0123456789abcdef0123456789abcdef'
};

function mergeObjects(parts) {
  const out = {};
  for (const p of parts) if (p && typeof p === 'object' && !Array.isArray(p)) Object.assign(out, p);
  return out;
}

function buildExample(schema, doc, depth, seen, path = '$') {
  if (depth > 24) throw new Error(`Schema too deep for an example at ${path}`);
  if (schema === true || schema === undefined) return null;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) throw new Error(`Recursive schema ${schema.$ref} at ${path}`);
    const next = new Set(seen).add(schema.$ref);
    const { $ref, ...rest } = schema;
    // Sibling keywords of a $ref (description, pattern, ...) apply alongside the target.
    return buildExample({ ...resolveRef($ref, doc), ...rest }, doc, depth + 1, next, path);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.allOf)) {
    const { allOf, ...own } = schema;
    const parts = allOf.map((sub) => buildExample(sub, doc, depth + 1, seen, path));
    if (own.properties || own.type) parts.push(buildExample(own, doc, depth + 1, seen, path));
    const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
    // Object parts merge; a scalar allOf (for example one $ref to an amount string) keeps its value.
    return parts.every(isPlainObject) ? mergeObjects(parts) : parts.find((v) => !isPlainObject(v));
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key])) {
      const { [key]: _alts, ...own } = schema;
      for (const alt of schema[key]) {
        try {
          // An alternative that only names required properties (exactly one of a or b) selects
          // from the object's own properties: build those and keep the required ones.
          const onlyRequired = Array.isArray(alt.required) && !alt.type && !alt.properties && !alt.$ref;
          let candidate;
          if (onlyRequired && own.properties) {
            const full = buildExample(own, doc, depth + 1, seen, path);
            const keep = new Set([...(own.required || []), ...alt.required]);
            candidate = Object.fromEntries(Object.entries(full).filter(([k]) => keep.has(k)));
          } else {
            candidate = buildExample(alt, doc, depth + 1, seen, path);
          }
          if (validateSchema(candidate, schema, doc).length === 0) return candidate;
        } catch {
          // try the next alternative
        }
      }
      throw new Error(`No ${key} alternative yields a valid example at ${path}`);
    }
  }
  const types = Array.isArray(schema.type) ? schema.type.filter((t) => t !== 'null') : schema.type ? [schema.type] : schema.properties ? ['object'] : [];
  const type = types[0];
  switch (type) {
    case 'string': {
      if (schema.format === 'date-time') return '2026-09-29T00:00:00Z';
      if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      if (schema.format === 'uri') return 'https://example.invalid/ordex';
      if (schema.pattern !== undefined) {
        const sample = PATTERN_SAMPLES[schema.pattern];
        if (sample === undefined) throw new Error(`No sample for pattern ${schema.pattern} at ${path}`);
        return sample;
      }
      const min = schema.minLength || 0;
      return 'example'.padEnd(Math.max(min, 7), 'x').slice(0, schema.maxLength ?? 64);
    }
    case 'integer':
    case 'number': {
      if (schema.minimum !== undefined) return schema.minimum;
      if (schema.exclusiveMinimum !== undefined) return schema.exclusiveMinimum + 1;
      return 1;
    }
    case 'boolean':
      return true;
    case 'array': {
      const count = Math.max(schema.minItems || 1, 1);
      const item = buildExample(schema.items || {}, doc, depth + 1, seen, `${path}[0]`);
      return Array.from({ length: Math.min(count, schema.maxItems ?? count) }, () => item);
    }
    case 'object': {
      const obj = {};
      const props = schema.properties || {};
      for (const req of schema.required || []) {
        if (props[req] === undefined && !(schema.additionalProperties && typeof schema.additionalProperties === 'object')) {
          throw new Error(`Required property ${path}.${req} has no schema in the contract`);
        }
      }
      for (const [name, prop] of Object.entries(props)) obj[name] = buildExample(prop, doc, depth + 1, seen, `${path}.${name}`);
      return obj;
    }
    case 'null':
      return null;
    default:
      if (schema.nullable) return null;
      // A schema with no constraining keyword accepts any value; null is the honest example.
      if (!Object.keys(schema).some((k) => !['description', 'title', 'deprecated', 'readOnly', 'writeOnly', '$comment'].includes(k))) return null;
      throw new Error(`The schema at ${path} has no type to build an example from`);
  }
}

/**
 * Build an example that validates against its schema, or report why none could be built.
 * Returns { ok: true, value } or { ok: false, reason, errors? }.
 */
export function exampleForSchema(schema, doc) {
  let value;
  try {
    value = buildExample(schema, doc, 0, new Set());
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const errors = validateSchema(value, schema, doc);
  if (errors.length) return { ok: false, reason: 'The built example does not validate', errors: errors.slice(0, 10) };
  return { ok: true, value };
}
