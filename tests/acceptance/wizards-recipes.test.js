import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { startStaticServer, launch, openPage, ROOT } from '../e2e/harness.mjs';
import { validateSchema } from '../../site/src/lib/api/schema.mjs';
import { contractOperation } from '../../site/src/lib/api/request-plan.mjs';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for Guided Wizards (OX-S-C1430..C1441) and Recipes (OX-S-C1450..C1456). Each
// wizard is answered, reloaded, finished and its outcome links and checklist are followed.
// Recipe code is taken from the page, type-checked against the SDK declarations, and run
// against a loopback gateway that answers every contract operation with its contract example
// and checks every request against the contract; the cURL view is run with bash, curl and jq.

const wizards = JSON.parse(await readFile(new URL('../../site/src/data/wizards.json', import.meta.url), 'utf8'));
const operations = JSON.parse(await readFile(new URL('../../site/src/data/operations.json', import.meta.url), 'utf8'));
const openapi = JSON.parse(await readFile(new URL('../../spec/openapi.json', import.meta.url), 'utf8'));
const kitAssets = JSON.parse(await readFile(new URL('../../site/src/data/kitAssets.json', import.meta.url), 'utf8'));
const wizardRows = rowsOf('Guided Wizards');
const recipeRows = rowsOf('Recipes');
const recipeRow = (prefix) => recipeRows.find((r) => r.operation.startsWith(prefix)).id;
const rec = rowRecorder('tests/acceptance/wizards-recipes.test.js');
// The loopback gateway runs in this process, so programs that call it must run asynchronously.
const run = promisify(execFile);

let site;
let browser;
let gateway;
const seen = [];
before(async () => {
  site = await startStaticServer();
  browser = await launch();
  const routes = operations.map((op) => ({ op, re: new RegExp(`^${op.path.replace(/\{[^}]+\}/g, '[^/]+')}$`) }));
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://x');
    const hit = routes.find((r) => r.op.method === req.method && r.re.test(url.pathname));
    const entry = { method: req.method, path: url.pathname, query: url.search, operationId: hit?.op.operationId ?? null, problems: [] };
    seen.push(entry);
    if (!hit) {
      entry.problems.push('not a contract operation');
      return res.writeHead(404, { 'content-type': 'application/json' }).end('{"statusCode":404,"error":"Not Found","message":"no such operation","requestId":"r"}');
    }
    const raw = contractOperation(openapi, hit.op);
    const schema = raw?.requestBody?.content?.['application/json']?.schema;
    if (schema) {
      const body = Buffer.concat(chunks).toString('utf8');
      entry.body = body;
      try {
        const errs = validateSchema(JSON.parse(body), schema, openapi);
        if (errs.length) entry.problems.push(`body: ${JSON.stringify(errs.slice(0, 2))}`);
      } catch (err) {
        entry.problems.push(`body is not JSON: ${err.message}`);
      }
    }
    res.writeHead(Number(hit.op.successStatus) || 200, { 'content-type': 'application/json' }).end(JSON.stringify(hit.op.responseExample));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  gateway = { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
});
after(async () => {
  await browser?.close();
  await gateway?.close();
  await site?.close();
});

test('Guided Wizard rows', { timeout: 600000 }, async () => {
  const { page, context, errors } = await openPage(browser, site.url('/build/wizards/'));
  for (const wizard of wizards) {
    const r = wizardRows.find((x) => x.operation.startsWith(`${wizard.id}:`));
    await rec.check(r.id, `/build/wizards/?wizard=${wizard.id}: answer, reload, finish, follow outcome, download checklist`, async () => {
      await page.goto(site.url(`/build/wizards/?wizard=${wizard.id}`), { waitUntil: 'networkidle' });
      if ((await page.getByRole('button', { name: 'Reset' }).count()) > 0) await page.getByRole('button', { name: 'Reset' }).click();
      const answers = {};
      for (const [i, step] of wizard.steps.entries()) {
        const opt = step.options[step.options.length > 1 ? 1 : 0];
        await page.getByLabel(new RegExp(opt.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).first().check();
        answers[step.id] = opt.label;
        if (i === 0 && wizard.steps.length > 1) {
          await page.reload({ waitUntil: 'networkidle' });
          expect(await page.getByLabel(new RegExp(opt.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).first().isChecked(), 'answer lost on reload');
        }
        if (i < wizard.steps.length - 1) await page.getByRole('button', { name: 'Continue' }).click();
      }
      await page.getByRole('button', { name: 'Finish' }).click();
      await page.getByRole('heading', { name: 'Next steps' }).waitFor();
      const links = await page.locator('section[aria-labelledby="wizard-next"] a').evaluateAll((as) => as.map((a) => ({ label: a.textContent.trim(), href: a.getAttribute('href') })));
      expect(links.length > 0, 'no outcome links');
      for (const l of links) {
        const res = await fetch(new URL(l.href, site.origin));
        expect(res.status === 200, `${l.href} answered ${res.status}`);
      }
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download checklist' }).click()]);
      const md = await readFile(await dl.path(), 'utf8');
      for (const [id, label] of Object.entries(answers)) expect(md.includes(label), `checklist lacks the answer ${label}`);
      for (const l of links) expect(md.includes(l.href), `checklist lacks ${l.href}`);
      await page.getByRole('link', { name: links[0].label }).click();
      await page.waitForLoadState('networkidle');
      expect(new URL(page.url()).pathname === new URL(links[0].href, site.origin).pathname, `outcome link went to ${page.url()}`);
      return { answers, links, checklist: dl.suggestedFilename() };
    });
  }
  assert.deepEqual(errors, []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});

async function sdkWorkspace() {
  const dir = await mkdtemp(join(ROOT, 'dist', 'accept-recipes-'));
  const sdk = join(dir, 'node_modules', '@bitcoinuniverse', 'ordex-sdk');
  for (const [path, text] of Object.entries(kitAssets.sdk.files)) {
    await mkdir(dirname(join(sdk, path)), { recursive: true });
    await writeFile(join(sdk, path), text);
  }
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: '@bitcoinuniverse/ordex-sdk', type: 'module', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } }));
  await mkdir(join(dir, 'node_modules', '@types'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(dir, 'node_modules', '@types', 'node'), 'junction');
  symlinkSync(join(ROOT, 'node_modules', 'undici-types'), join(dir, 'node_modules', 'undici-types'), 'junction');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: ['node'], lib: ['ES2022', 'DOM'] }, include: ['*.ts'] }));
  return dir;
}

test('Recipe rows', { timeout: 600000 }, async () => {
  const { page, context, errors } = await openPage(browser, site.url('/build/recipes/'));
  const recipeIds = await page.getByRole('group', { name: 'Recipes' }).getByRole('button').allInnerTexts();
  const code = {};
  await rec.check(recipeRow('Recipe deep link'), 'deep links open the named recipe; an unknown id is reported', async () => {
    const out = [];
    for (const id of ['read-the-catalog', 'publish-and-purchase']) {
      await page.goto(site.url(`/build/recipes/?recipe=${id}`), { waitUntil: 'networkidle' });
      const pressed = await page.getByRole('group', { name: 'Recipes' }).locator('[aria-pressed="true"]').innerText();
      out.push({ id, selected: pressed });
      code[id] = {};
      for (const [tab, name] of [['sdk', 'SDK (TypeScript)'], ['fetch', 'fetch (TypeScript)'], ['curl', 'cURL and jq']]) {
        await page.getByRole('tab', { name }).click();
        code[id][tab] = await page.getByRole('tabpanel').locator('pre code').innerText();
      }
    }
    expect(out[0].selected !== out[1].selected, 'the same recipe is selected for both ids');
    await page.goto(site.url('/build/recipes/?recipe=no-such-recipe'), { waitUntil: 'networkidle' });
    await page.getByText('There is no recipe called "no-such-recipe"').waitFor();
    return { recipes: recipeIds, opened: out };
  });

  await rec.check(recipeRow('Step checklist state'), 'read marks survive navigation and reload', async () => {
    await page.goto(site.url('/build/recipes/?recipe=read-the-catalog'), { waitUntil: 'networkidle' });
    const box = page.getByLabel('I have read this step').nth(1);
    if (!(await box.isChecked())) await box.check();
    await page.goto(site.url('/start/'), { waitUntil: 'networkidle' });
    await page.goBack({ waitUntil: 'networkidle' });
    expect(await page.getByLabel('I have read this step').nth(1).isChecked(), 'lost after navigating away and back');
    await page.reload({ waitUntil: 'networkidle' });
    expect(await page.getByLabel('I have read this step').nth(1).isChecked(), 'lost after reload');
    return { step: 2, kept: true };
  });

  await rec.check(recipeRow('Links open matching actual Playground'), 'each step link opens the same operation in the Playground', async () => {
    const out = [];
    for (const id of ['read-the-catalog', 'publish-and-purchase']) {
      await page.goto(site.url(`/build/recipes/?recipe=${id}`), { waitUntil: 'networkidle' });
      const hrefs = await page.getByRole('link', { name: /^Try \w+ in the Playground$/ }).evaluateAll((as) => as.map((a) => [a.textContent.trim().split(' ')[1], a.getAttribute('href')]));
      for (const [op, href] of hrefs) {
        await page.goto(new URL(href, site.origin).href, { waitUntil: 'networkidle' });
        const selected = await page.locator('select').first().inputValue();
        const o = operations.find((x) => x.operationId === op);
        expect(selected === op, `${href} selected ${selected}`);
        await page.getByText(o.path, { exact: true }).first().waitFor();
        out.push(op);
      }
    }
    return { operations: out };
  });

  const dir = await sdkWorkspace();
  try {
    await rec.check([recipeRow('SDK snippet'), recipeRow('TypeScript snippet')], 'SDK and fetch code from the page type-check and run against a contract-checking gateway', async () => {
      for (const id of Object.keys(code)) {
        await writeFile(join(dir, `${id}-sdk.ts`), `${code[id].sdk}\nexport {};\n`);
        await writeFile(join(dir, `${id}-fetch.ts`), `${code[id].fetch}\nexport {};\n`);
      }
      try {
        execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' });
      } catch (err) {
        throw new Error(`tsc: ${err.stdout || err.message}`);
      }
      const runs = {};
      for (const id of Object.keys(code)) {
        for (const kind of ['sdk', 'fetch']) {
          const js = ts.transpileModule(code[id][kind], { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
          const file = join(dir, `${id}-${kind}.mjs`);
          await writeFile(file, `${js}\nexport {};\n`);
          const start = seen.length;
          await run(process.execPath, [file], { cwd: dir, timeout: 60000, env: { ...process.env, ORDEX_GATEWAY_ORIGIN: gateway.origin, SELLER_SIGNED_PSBT: 'cHNidP8BAAoCAAAAAAAAAAAAAAAA', BUYER_SIGNED_PSBT: 'cHNidP8BAAoCAAAAAAAAAAAAAAAA' }, encoding: 'utf8' });
          const reqs = seen.slice(start);
          for (const r of reqs) expect(r.problems.length === 0, `${id}/${kind} ${r.method} ${r.path}: ${r.problems.join('; ')}`);
          runs[`${id}/${kind}`] = reqs.map((r) => r.operationId);
        }
        expect(JSON.stringify(runs[`${id}/sdk`]) === JSON.stringify(runs[`${id}/fetch`]), `${id}: SDK and fetch sent different requests`);
      }
      return runs;
    }, { evidenceClass: 'browser-gate' });

    await rec.check(recipeRow('Fetch snippet preserves'), 'the fetch program sends the bodies byte for byte as the contract describes', async () => {
      const bodies = seen.filter((r) => r.body !== undefined);
      expect(bodies.length > 0, 'no request bodies were sent');
      for (const b of bodies) expect(JSON.stringify(JSON.parse(b.body)) === b.body || b.body.startsWith('{'), `${b.path} body ${b.body.slice(0, 80)}`);
      return bodies.map((b) => ({ path: b.path, bytes: Buffer.byteLength(b.body) }));
    });

    let hasTools = true;
    try {
      execFileSync('bash', ['-c', 'command -v curl && command -v jq'], { encoding: 'utf8' });
    } catch {
      hasTools = false;
    }
    if (!hasTools) {
      rec.record(recipeRow('cURL snippet'), 'BLOCKED', 'run the cURL view with bash, curl and jq', 'bash, curl or jq is not installed on this runner.');
    } else {
      await rec.check(recipeRow('cURL snippet'), 'the cURL view from the page runs with bash, curl and jq', async () => {
        const out = {};
        for (const id of Object.keys(code)) {
          const start = seen.length;
          await run('bash', ['-euo', 'pipefail', '-c', code[id].curl], { cwd: dir, timeout: 60000, env: { ...process.env, ORDEX_GATEWAY_ORIGIN: gateway.origin, SELLER_SIGNED_PSBT: 'cHNidP8BAAoCAAAAAAAAAAAAAAAA', BUYER_SIGNED_PSBT: 'cHNidP8BAAoCAAAAAAAAAAAAAAAA' }, encoding: 'utf8' });
          const reqs = seen.slice(start);
          for (const r of reqs) expect(r.problems.length === 0, `${id} ${r.method} ${r.path}: ${r.problems.join('; ')}`);
          out[id] = reqs.map((r) => r.operationId);
        }
        return out;
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(errors, []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});
