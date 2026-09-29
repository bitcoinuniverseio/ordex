// OX-S11: operational recipes. Each step is one contract operation with its arguments; a value
// written { from: 'var.path' } is taken from an earlier step's response, so IDs carry between
// steps. The SDK (TypeScript), fetch and cURL snippets are all generated from this one
// definition, and tests/unit/recipe-snippets.test.js checks the arguments against the OpenAPI
// schemas, compiles the TypeScript against the SDK types and runs the read recipe.

export const RECIPES = [
  {
    id: 'read-the-catalog',
    title: 'Read a gateway catalog',
    summary: 'Check the gateway, confirm its network, list open orders and read one of them. Reads only.',
    steps: [
      { var: 'health', operationId: 'getHealth', title: 'Check the gateway is ready', why: 'A gateway that is not ready, or not configured, cannot answer the rest truthfully.', sdk: 'client.getHealth()' },
      { var: 'protocol', operationId: 'getProtocol', title: 'Confirm the network and protocol', why: 'Refuse to continue when the gateway serves a network you did not expect.', sdk: 'client.getProtocol()' },
      { var: 'page', operationId: 'listOrders', title: 'List open orders', why: 'Pages use a keyset cursor; amounts are decimal strings.', args: { query: { limit: '20', sort: 'newest' } }, sdk: "client.listOrders({ limit: '20', sort: 'newest' })" },
      { var: 'order', operationId: 'getOrder', title: 'Read one order', why: 'The summary carries the validation state and the verification record.', args: { path: { id: { from: 'page.orders[0].id' } } }, sdk: 'client.getOrder(page.orders[0]!.id)', needs: 'page.orders.length > 0' }
    ]
  },
  {
    id: 'publish-and-purchase',
    title: 'Publish a public ask, then check a purchase',
    summary: 'Build the seller half, sign it in the seller wallet, publish it, then preflight the buyer transaction before broadcast. Writes: use a Signet gateway in write mode; the docs never sign or broadcast.',
    steps: [
      { var: 'catalog', operationId: 'getCatalog', title: 'Pick a protocol template', why: 'protocolId and token must be ones the gateway offers.', sdk: 'client.getCatalog()' },
      {
        var: 'built',
        operationId: 'buildAsk',
        title: 'Build the unsigned seller half',
        why: 'The gateway returns a PSBT committing the seller payment output. Sign it in the seller wallet, never here.',
        args: {
          body: {
            protocolId: { from: 'catalog[0].id' },
            token: 'inscription',
            quotedPriceSats: '150000',
            sellerPaymentAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
            asset: {
              inscriptionId: '7b28f7a932b13c19e830e2f5b84c8a20984ef11320498a102938472910384729i0',
              outpoint: { txid: '7b28f7a932b13c19e830e2f5b84c8a20984ef11320498a102938472910384729', vout: 0 }
            }
          }
        },
        sdk: "client.buildAsk({ protocolId: catalog[0]!.id, token: 'inscription', quotedPriceSats: '150000', sellerPaymentAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', asset: { inscriptionId: '7b28f7a932b13c19e830e2f5b84c8a20984ef11320498a102938472910384729i0', outpoint: { txid: '7b28f7a932b13c19e830e2f5b84c8a20984ef11320498a102938472910384729', vout: 0 } } })"
      },
      {
        var: 'published',
        operationId: 'publishAsk',
        title: 'Publish the signed seller half',
        why: 'sellerSignedPsbt is the PSBT from the previous step after the seller wallet signed it.',
        args: {
          body: {
            protocolId: { from: 'catalog[0].id' },
            token: 'inscription',
            quotedPriceSats: '150000',
            sellerPaymentAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
            psbt: { from: 'sellerSignedPsbt' }
          }
        },
        sdk: "client.publishAsk({ protocolId: catalog[0]!.id, token: 'inscription', quotedPriceSats: '150000', sellerPaymentAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', psbt: sellerSignedPsbt })"
      },
      {
        var: 'quote',
        operationId: 'quoteOrder',
        title: 'Quote the purchase for the buyer',
        why: 'The gateway stores the reviewed purchase under quoteId and returns the unsigned buyer half. The buyer wallet signs exactly that PSBT.',
        args: {
          path: { id: { from: 'published.id' } },
          body: {
            assetReceiveAddress: 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
            paymentAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'
          }
        },
        sdk: "client.quoteOrder(published.id, { assetReceiveAddress: 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', paymentAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' })"
      },
      {
        var: 'preflight',
        operationId: 'preflightOrder',
        title: 'Preflight the buyer transaction',
        why: 'buyerSignedPsbt is the quoted PSBT after the buyer wallet signed it. Preflight binds it to quoteId; broadcast only when the verdict accepts it.',
        args: { path: { id: { from: 'published.id' } }, body: { quoteId: { from: 'quote.quoteId' }, signedPsbt: { from: 'buyerSignedPsbt' } } },
        sdk: 'client.preflightOrder(published.id, { quoteId: quote.quoteId, signedPsbt: buyerSignedPsbt })'
      }
    ],
    inputs: {
      sellerSignedPsbt: 'the PSBT from buildAsk, signed by the seller wallet',
      buyerSignedPsbt: 'the quoted purchase PSBT, signed by the buyer wallet'
    }
  }
];

export const getRecipe = (id) => RECIPES.find((r) => r.id === id);

const isFrom = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.from === 'string' && Object.keys(v).length === 1;
const jsExpr = (from) => from.replace(/\[(\d+)\]/g, '[$1]!');

/** The step's values with every { from } replaced by `pick(from)`. */
export function resolveValues(value, pick) {
  if (isFrom(value)) return pick(value.from);
  if (Array.isArray(value)) return value.map((v) => resolveValues(v, pick));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValues(v, pick)]));
  return value;
}

function jsLiteral(value, indent = '') {
  if (isFrom(value)) return jsExpr(value.from);
  if (Array.isArray(value)) return `[${value.map((v) => jsLiteral(v, indent)).join(', ')}]`;
  if (value && typeof value === 'object') {
    const inner = `${indent}  `;
    return `{\n${Object.entries(value).map(([k, v]) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${jsLiteral(v, inner)}`).join(',\n')}\n${indent}}`;
  }
  return typeof value === 'string' ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(value);
}

function pathExpr(operation, step) {
  let path = '`' + operation.path + '`';
  for (const [name, v] of Object.entries(step.args?.path || {})) path = path.replace(`{${name}}`, isFrom(v) ? `\${encodeURIComponent(${jsExpr(v.from)})}` : encodeURIComponent(v));
  const q = new URLSearchParams(step.args?.query || {}).toString();
  return q ? path.replace(/`$/, `?${q}\``) : path;
}

const envName = (name) => name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
const inputDecls = (recipe) =>
  Object.entries(recipe.inputs || {}).map(([name, note]) => `// ${envName(name)}: ${note}.\nconst ${name}: string = process.env.${envName(name)} ?? '';`);

/** The whole recipe as one TypeScript program on the typed SDK client. */
export function sdkProgram(recipe) {
  return [
    "import { OrdexClient } from '@bitcoinuniverse/ordex-sdk';",
    '',
    '// ORDEX_GATEWAY_ORIGIN: your gateway, for example a Signet gateway you run. No credentials are needed for reads.',
    "const client = new OrdexClient({ baseUrl: process.env.ORDEX_GATEWAY_ORIGIN ?? 'http://127.0.0.1:8080' });",
    ...inputDecls(recipe),
    '',
    ...recipe.steps.flatMap((s, i) => [
      `// ${i + 1}. ${s.title}`,
      ...(s.needs ? [`if (!(${s.needs})) throw new Error('Nothing to continue with: ${s.needs} is false.');`] : []),
      `const ${s.var} = await ${s.sdk};`,
      `console.log('${s.operationId}', ${s.var});`,
      ''
    ])
  ].join('\n');
}

/** The whole recipe with fetch only, same steps and values. */
export function fetchProgram(recipe, operations) {
  return [
    "const origin = process.env.ORDEX_GATEWAY_ORIGIN ?? 'http://127.0.0.1:8080';",
    'async function call(method: string, path: string, body?: unknown) {',
    "  const res = await fetch(`${origin}${path}`, { method, headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });",
    '  const data = await res.json();',
    '  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(data)}`);',
    '  return data;',
    '}',
    ...inputDecls(recipe),
    '',
    ...recipe.steps.flatMap((s, i) => {
      const op = operations.find((o) => o.operationId === s.operationId);
      const body = s.args?.body ? `, ${jsLiteral(s.args.body)}` : '';
      return [
        `// ${i + 1}. ${s.title}`,
        ...(s.needs ? [`if (!(${s.needs})) throw new Error('Nothing to continue with: ${s.needs} is false.');`] : []),
        `const ${s.var} = await call('${op.method}', ${pathExpr(op, s)}${body});`,
        `console.log('${s.operationId}', ${s.var});`,
        ''
      ];
    })
  ].join('\n');
}

/** cURL commands; values from earlier responses are shell variables read with jq. */
export function curlCommands(recipe, operations) {
  const lines = ['ORIGIN="${ORDEX_GATEWAY_ORIGIN:-http://127.0.0.1:8080}"'];
  for (const [name, note] of Object.entries(recipe.inputs || {})) lines.push(`# ${envName(name)}: ${note}.`, `: "\${${envName(name)}:?set it first}"`);
  const shellVar = (from) => from.replace(/\[(\d+)\]/g, '_$1').replace(/\./g, '_').toUpperCase();
  recipe.steps.forEach((s, i) => {
    const op = operations.find((o) => o.operationId === s.operationId);
    lines.push('', `# ${i + 1}. ${s.title}`);
    const refs = [];
    const collect = (v) => {
      if (isFrom(v)) refs.push(v.from);
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    collect(s.args || {});
    for (const from of [...new Set(refs)]) {
      if (recipe.inputs?.[from]) continue;
      const head = from.match(/^[A-Za-z_]+/)[0];
      const rest = from.slice(head.length);
      lines.push(`${shellVar(from)}=$(jq -r '${rest.startsWith('[') ? `.${rest}` : rest}' ${head}.json)`);
    }
    let path = op.path;
    for (const [name, v] of Object.entries(s.args?.path || {})) path = path.replace(`{${name}}`, isFrom(v) ? `$${shellVar(v.from)}` : encodeURIComponent(v));
    const q = new URLSearchParams(s.args?.query || {}).toString();
    const url = `"$ORIGIN${path}${q ? `?${q}` : ''}"`;
    if (s.args?.body) {
      const args = [];
      const jqBody = JSON.stringify(
        resolveValues(s.args.body, (from) => {
          const name = recipe.inputs?.[from] ? envName(from) : shellVar(from);
          args.push(`--arg ${name} "$${name}"`);
          return `__${name}__`;
        })
      ).replace(/"__([A-Z0-9_]+)__"/g, '$$$1');
      lines.push(`jq -n ${[...new Set(args)].join(' ')} '${jqBody}' \\`, `  | curl -sS -X ${op.method} ${url} -H 'content-type: application/json' --data-binary @- > ${s.var}.json`);
    } else {
      lines.push(`curl -sS -X ${op.method} ${url} -H 'accept: application/json' > ${s.var}.json`);
    }
  });
  return lines.join('\n');
}
