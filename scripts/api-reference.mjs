// Renders docs' API reference page from spec/openapi.json at build time.
// The contract is the only source: nothing on the page is written by hand,
// so the page cannot drift from the routes the gateway actually serves.

const escape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const refName = (ref) => ref.split('/').at(-1);

function typeLabel(schema) {
  if (!schema) return 'unknown';
  if (schema.$ref) {
    const name = refName(schema.$ref);
    return `<a href="#schema-${escape(name)}">${escape(name)}</a>`;
  }
  if (schema.oneOf) return schema.oneOf.map(typeLabel).join(' or ');
  if (schema.allOf) return schema.allOf.map(typeLabel).join(' and ');
  if (schema.const !== undefined) return `constant <code>${escape(JSON.stringify(schema.const))}</code>`;
  if (schema.enum) return schema.enum.map((v) => `<code>${escape(v)}</code>`).join(' | ');
  if (Array.isArray(schema.type)) return schema.type.map(escape).join(' or ');
  if (schema.type === 'array') return `array of ${typeLabel(schema.items)}`;
  if (schema.type === 'object' || schema.properties) return 'object';
  return escape(schema.type ?? 'unknown');
}

function propertiesTable(schema) {
  if (!schema.properties) return '';
  const required = new Set(schema.required ?? []);
  const rows = Object.entries(schema.properties)
    .map(([name, property]) => {
      const description = property.description ?? '';
      return `<tr><td><code>${escape(name)}</code>${required.has(name) ? '' : ' <span class="caption">optional</span>'}</td><td>${typeLabel(property)}</td><td>${escape(description)}</td></tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function parametersTable(parameters, document) {
  const resolved = (parameters ?? []).map((parameter) =>
    parameter.$ref
      ? document.components.parameters[refName(parameter.$ref)]
      : parameter,
  );
  if (resolved.length === 0) return '';
  const rows = resolved
    .map(
      (parameter) =>
        `<tr><td><code>${escape(parameter.name)}</code>${parameter.required ? '' : ' <span class="caption">optional</span>'}</td><td>${escape(parameter.in)}</td><td>${typeLabel(parameter.schema)}</td><td>${escape(parameter.description ?? '')}</td></tr>`,
    )
    .join('');
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Parameter</th><th>In</th><th>Type</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function responseRow(status, response, document) {
  const resolved = response.$ref ? document.components.responses[refName(response.$ref)] : response;
  const schema = resolved.content?.['application/json']?.schema;
  return `<tr><td><code>${escape(status)}</code></td><td>${schema ? typeLabel(schema) : ''}</td><td>${escape(resolved.description ?? '')}</td></tr>`;
}

function operationBlock(method, path, operation, document) {
  const body = operation.requestBody?.content?.['application/json']?.schema;
  const responses = Object.entries(operation.responses)
    .map(([status, response]) => responseRow(status, response, document))
    .join('');
  return [
    `<h3 id="${escape(operation.operationId)}"><code>${method.toUpperCase()} ${escape(path)}</code></h3>`,
    `<p><strong>${escape(operation.summary)}.</strong>${operation.description ? ` ${escape(operation.description)}` : ''}</p>`,
    parametersTable(operation.parameters, document),
    body ? `<p>Request body: ${typeLabel(body)}</p>` : '',
    `<div class="table-wrap"><table class="table"><thead><tr><th>Status</th><th>Answers</th><th>Notes</th></tr></thead><tbody>${responses}</tbody></table></div>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function schemaBlock(name, schema) {
  const parts = [`<h3 id="schema-${escape(name)}"><code>${escape(name)}</code></h3>`];
  if (schema.description) parts.push(`<p>${escape(schema.description)}</p>`);
  if (schema.properties) {
    parts.push(propertiesTable(schema));
  } else {
    parts.push(`<p>${typeLabel(schema)}${schema.pattern ? `, matching <code>${escape(schema.pattern)}</code>` : ''}</p>`);
  }
  return parts.join('\n');
}

export function renderApiReference(document) {
  const operationsByTag = new Map(document.tags.map((tag) => [tag.name, []]));
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = item[method];
      if (!operation) continue;
      for (const tag of operation.tags) {
        operationsByTag.get(tag).push({ method, path, operation });
      }
    }
  }

  const toc = [
    ...document.tags.map((tag) => `<a href="#tag-${escape(tag.name)}">${escape(tag.name)}</a>`),
    '<a href="#schemas">schemas</a>',
  ].join('');

  const sections = document.tags
    .map((tag) => {
      const blocks = operationsByTag
        .get(tag.name)
        .map(({ method, path, operation }) => operationBlock(method, path, operation, document))
        .join('\n');
      return `<section id="tag-${escape(tag.name)}"><h2>${escape(tag.name)}</h2><p>${escape(tag.description ?? '')}</p>${blocks}</section>`;
    })
    .join('\n');

  const schemas = Object.entries(document.components.schemas)
    .map(([name, schema]) => schemaBlock(name, schema))
    .join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="The Ordex gateway API, generated from its OpenAPI 3.1 contract."><title>Ordex API reference</title><link rel="stylesheet" href="styles.css"></head><body><main class="shell">
  <nav class="nav"><a class="brand" href="index.html"><span class="mark"></span>Ordex <small>Guide</small></a><div class="navlinks"><a href="index.html">Home</a><a href="quickstart.html">Start</a><a href="protocol-guide.html">How it works</a><a href="troubleshooting.html">Help</a></div></nav>
  <header class="page-hero"><span class="eyebrow">API reference</span><h1>Every route the gateway serves.</h1><p class="lead">Generated from the OpenAPI 3.1 contract, version ${escape(document.info.version)}. Amounts are atomic integers carried as decimal strings. Reads answer 200, writes answer 201, and every write is rate limited.</p></header>
  <div class="layout"><aside class="toc">${toc}</aside><article class="doc">
${sections}
<section id="schemas"><h2>Schemas</h2><p>The shapes the routes above exchange, exactly as the contract states them.</p>
${schemas}
</section>
  </article></div>
  <footer class="footer"><span>Ordex API reference</span><p><a href="protocol-guide.html">How portable orders work →</a></p></footer>
</main></body>
<script src="app.js"></script></html>
`;
}
