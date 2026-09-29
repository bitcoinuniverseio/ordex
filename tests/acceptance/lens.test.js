import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startStaticServer, launch, openPage } from '../e2e/harness.mjs';
import { parsePsbt, parseTransaction } from '../../verifier/bitcoin-tx.js';
import { MUTATION_FIXTURES } from '../../site/src/lib/artifacts/mutation-fixtures.ts';
import { rowRecorder, rowsOf, expect } from './rows.mjs';

// Acceptance rows for Artifact Lens (OX-S-C101..C123). Inputs are the BIP174 and BIP370 test
// vectors (tests/fixtures/psbt/bip-vectors.json) and byte-level edits of them. Counts, txids,
// fees and digests shown on the page are checked against the repository's independent
// verifier parser (verifier/bitcoin-tx.js) and Node's SHA-256.

const fx = JSON.parse(await readFile(new URL('../fixtures/psbt/bip-vectors.json', import.meta.url), 'utf8'));
const byName = (list, prefix) => list.find((v) => v.name.startsWith(prefix)).hex;
const rows = rowsOf('Artifact Lens');
const row = (prefix) => rows.find((r) => r.operation.startsWith(prefix)).id;
const rec = rowRecorder('tests/acceptance/lens.test.js');
const sha = (hex) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');

const V0 = byName(fx.bip174.valid, 'PSBT with one P2PKH input and one P2SH-P2WPKH input both with non-final scriptSigs');
const V2 = byName(fx.bip370.valid, '1 input, 2 output PSBTv2, required fields only');
const LEGACY = fx.bip174.invalid[0].hex;
const SEGWIT = fx.bip174.extractedTransaction;
const UNKNOWN = byName(fx.bip174.valid, 'PSBT with unknown types in the inputs');

let site;
let browser;
before(async () => {
  site = await startStaticServer();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await site?.close();
});

async function decode(page, text) {
  await page.getByRole('tab', { name: 'Summary' }).click().catch(() => {});
  await page.getByLabel(/Artifact A/).fill(text);
  await page.getByRole('button', { name: 'Decode', exact: true }).click();
}
const tile = async (page, label) => (await page.locator(`div:text-is("${label}")`).first().locator('xpath=following-sibling::div[1]').innerText()).trim();
const banner = (page) => page.locator('[role="alert"], [role="status"]').filter({ hasText: /Decoded as|Malformed|Unsupported|exceeds/ }).first();

test('Artifact Lens rows', { timeout: 300000 }, async () => {
  const { page, context, errors } = await openPage(browser, site.url('/inspect/'));

  await rec.check(row('Load initial sample'), '/inspect opens on its sample artifact', async () => {
    await page.getByText(/Decoded as PSBT_V0/).waitFor();
    expect((await page.getByRole('alert').count()) === 0, 'an alert is shown on load');
    return { format: 'PSBT_V0', status: await tile(page, 'Status') };
  });

  await rec.check(row('Parse PSBTv0'), 'BIP174 valid vector: input and output map counts', async () => {
    await decode(page, V0);
    await page.getByText(/Decoded as PSBT_V0/).waitFor();
    const p = parsePsbt(V0);
    expect(p.ok, 'verifier parser refuses the vector');
    const io = await tile(page, 'Inputs / outputs');
    expect(io === `${p.psbt.inputs.length} in / ${p.psbt.outputs.length} out`, `page ${io}`);
    await page.getByRole('tab', { name: 'Structure' }).click();
    const text = await page.getByRole('tabpanel').innerText();
    expect((text.match(/Input map \d+/g) || []).length === p.psbt.inputs.length && (text.match(/Output map \d+/g) || []).length === p.psbt.outputs.length, 'map headings differ from the counts');
    return { inputs: p.psbt.inputs.length, outputs: p.psbt.outputs.length };
  });

  await rec.check(row('Parse PSBTv2'), 'BIP370 valid vector: global version and counts', async () => {
    await decode(page, V2);
    await page.getByText(/Decoded as PSBT_V2/).waitFor();
    const p = parsePsbt(V2);
    expect(p.ok && p.psbt.version === 2, 'verifier parser');
    const io = await tile(page, 'Inputs / outputs');
    expect(io === `${p.psbt.inputs.length} in / ${p.psbt.outputs.length} out`, `page ${io}`);
    expect((await tile(page, 'Transaction version')) === String(p.psbt.tx.version), 'tx version');
    return { psbtVersion: 2, txVersion: p.psbt.tx.version, inputs: p.psbt.inputs.length, outputs: p.psbt.outputs.length };
  });

  for (const [id, hex, kind] of [[row('Decode raw legacy'), LEGACY, 'legacy'], [row('Decode raw SegWit'), SEGWIT, 'segwit']]) {
    await rec.check(id, `raw ${kind} transaction`, async () => {
      await decode(page, hex);
      await page.getByText(/Decoded as RAW_BITCOIN_TX/).waitFor();
      const t = parseTransaction(hex);
      expect(t.ok && t.hasWitness === (kind === 'segwit'), 'verifier parser');
      const text = await page.getByRole('tabpanel').innerText();
      expect(text.includes(`txid: ${t.txid}`), `txid ${t.txid} not shown`);
      return { txid: t.txid, witness: t.hasWitness };
    });
  }

  await rec.check(row('Hex/Base64'), 'the same PSBT in hex and in Base64', async () => {
    await decode(page, V0);
    await page.getByText(/Decoded as PSBT_V0/).waitFor();
    const fromHex = (await page.getByRole('tabpanel').innerText()).match(/[0-9a-f]{64}/)[0];
    await decode(page, Buffer.from(V0, 'hex').toString('base64'));
    await page.getByText(/Decoded as PSBT_V0/).waitFor();
    const fromB64 = (await page.getByRole('tabpanel').innerText()).match(/[0-9a-f]{64}/)[0];
    expect(fromHex === fromB64 && fromHex === sha(V0), `digests ${fromHex} ${fromB64}`);
    return { sha256: fromHex };
  });

  const refused = [
    [row('Reject missing v0 unsigned'), byName(fx.bip174.invalid, 'PSBT where inputs and outputs are provided but without an unsigned tx'), /Malformed/],
    [row('Reject duplicate keys'), byName(fx.bip174.invalid, 'PSBT with duplicate keys in an input'), /Malformed/],
    [row('Reject unterminated maps'), V0.slice(0, -2), /Malformed/],
    [row('Reject unterminated maps'), `${V0}00`, /Malformed/],
    [row('Reject unsupported PSBT version'), V2.replace('01fb0402000000', '01fb0403000000'), /Unsupported/],
    [row('Reject unsupported PSBT version'), byName(fx.bip174.invalid, 'PSBT with invalid pubkey length for input partial signature typed key'), /Malformed/]
  ];
  const seenRefusals = new Map();
  for (const [id, hex, want] of refused) {
    await decode(page, hex);
    const text = await banner(page).innerText().catch(() => '');
    const list = seenRefusals.get(id) || [];
    list.push({ ok: want.test(text), shown: text.slice(0, 160) });
    seenRefusals.set(id, list);
  }
  for (const [id, list] of seenRefusals) {
    await rec.check(id, 'malformed and unsupported vectors are refused', async () => {
      for (const r of list) expect(r.ok, `shown: ${r.shown}`);
      return list.map((r) => r.shown);
    });
  }

  await rec.check(row('Reject overlong CompactSize'), 'a non-minimal CompactSize length is refused', async () => {
    // The first global entry is 01 00 <len> <unsigned tx>; write its length as fd <len> 00.
    const len = V0.slice(14, 16);
    const bad = `${V0.slice(0, 14)}fd${len}00${V0.slice(16)}`;
    await decode(page, bad);
    const text = await banner(page).innerText();
    expect(/Malformed/.test(text), text);
    return { shown: text.slice(0, 160) };
  });

  await rec.check(row('Bound two-MiB'), 'a payload over 2 MiB is refused before decoding', async () => {
    await decode(page, `${'00'.repeat(2 * 1024 * 1024 + 1)}`);
    const text = await page.locator('main').innerText();
    expect(/exceeds the 2097152 byte bound/.test(text), 'no bound message');
    return { bytes: 2 * 1024 * 1024 + 1, shown: 'exceeds the 2097152 byte bound' };
  });

  await rec.check(row('Preserve unknown'), 'unknown input fields are kept byte for byte', async () => {
    await decode(page, UNKNOWN);
    await page.getByText(/Decoded as PSBT_V0/).waitFor();
    await page.getByText('Unknown or proprietary fields are present and kept byte for byte.').waitFor();
    await page.getByRole('tab', { name: 'Structure' }).click();
    await page.getByText('(kept as raw bytes)').first().waitFor();
    await page.getByRole('tab', { name: 'Compare' }).click();
    await page.getByLabel('Artifact B').fill(UNKNOWN);
    await page.getByRole('button', { name: 'Compare', exact: true }).click();
    await page.getByText(/Byte-identical/).first().waitFor();
    return { unknownKept: true };
  });

  await rec.check(row('Display coherent'), 'summary, inputs and outputs, structure and byte ranges agree', async () => {
    await decode(page, V0);
    await page.getByText(/Decoded as PSBT_V0/).waitFor();
    const size = Number((await tile(page, 'Size')).replace(' bytes', ''));
    await page.getByRole('tab', { name: 'Inputs & Outputs' }).click();
    const io = await page.getByRole('tabpanel').innerText();
    const p = parsePsbt(V0);
    for (const o of p.psbt.tx.outputs) expect(io.includes(`${o.valueSats} sats`) && io.includes(o.scriptHex), `output ${o.scriptHex}`);
    await page.getByRole('tab', { name: 'Bytes' }).click();
    const ranges = await page.getByRole('button', { name: /^Offset \d+ to \d+:/ }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label').match(/^Offset (\d+) to (\d+)/).slice(1).map(Number)));
    let at = 0;
    for (const [s, e] of ranges) {
      expect(s === at, `gap or overlap at ${at}`);
      at = e;
    }
    expect(at === size, `ranges end at ${at}, size ${size}`);
    await page.getByRole('button', { name: /^Offset \d+ to \d+:/ }).nth(1).click();
    const inspector = await page.getByText('Field inspector').locator('..').innerText();
    expect(new RegExp(`Bytes ${ranges[1][0]} to ${ranges[1][1]}`).test(inspector), inspector);
    return { size, ranges: ranges.length };
  });

  const compare = [
    [row('Compare truly identical'), 'mut-preserve', /Byte-identical/],
    [row('Detect equal-size output amount'), 'mut-amount-plus-one', /Dangerous change/],
    [row('Detect output script'), 'mut-script-byte', /Dangerous change/],
    [row('Detect output reordering'), 'mut-reorder-output', /Dangerous change/],
    [row('Detect sighash downgrade'), 'mut-sighash', /Dangerous change/],
    [row('Detect input outpoint'), 'mut-outpoint', /Dangerous change/],
    [row('Detect input outpoint'), 'mut-sequence', /Dangerous change/],
    [row('Detect input outpoint'), 'mut-version', /Dangerous change/],
    [row('Detect input outpoint'), 'mut-locktime', /Dangerous change/],
    [row('Detect replaced/dropped unknown'), 'mut-strip-unknown', /Review required/]
  ];
  const results = new Map();
  await decode(page, V0);
  await page.getByRole('tab', { name: 'Compare' }).click();
  for (const [id, fid, want] of compare) {
    const f = MUTATION_FIXTURES.find((m) => m.id === fid);
    await page.getByRole('button', { name: `Example: ${f.name}` }).click();
    const text = await page.getByRole('tabpanel').innerText();
    const ok = want.test(text) && (fid === 'mut-preserve' || !/Byte-identical/.test(text));
    const list = results.get(id) || [];
    list.push({ fixture: fid, ok, verdict: (text.match(/Dangerous change|Review required|Byte-identical|Only signatures[^\n]*/) || ['none'])[0] });
    results.set(id, list);
  }
  for (const [id, list] of results) {
    await rec.check(id, 'mutation examples compared against the unchanged artifact', async () => {
      for (const r of list) expect(r.ok, `${r.fixture}: ${r.verdict}`);
      return list.map(({ fixture, verdict }) => ({ fixture, verdict }));
    });
  }

  await rec.check(row('Derive miner fee'), 'the fee is shown only when every prevout amount is carried', async () => {
    await page.getByRole('tab', { name: 'Summary' }).click();
    await decode(page, V0);
    await page.getByText(/Decoded as PSBT_V0/).waitFor();
    const p = parsePsbt(V0);
    const prevouts = p.psbt.inputs.map((i) => i.prevout?.valueSats);
    expect(prevouts.every((v) => v !== undefined && v !== null), 'fixture lacks prevouts');
    const want = prevouts.reduce((a, v) => a + BigInt(v), 0n) - p.psbt.tx.outputs.reduce((a, o) => a + BigInt(o.valueSats), 0n);
    const shown = await tile(page, 'Fee');
    expect(shown.startsWith(`${want} sats`), `page fee ${shown}, expected ${want}`);
    await decode(page, V2);
    await page.getByText(/Decoded as PSBT_V2/).waitFor();
    const none = await tile(page, 'Fee');
    expect(none.startsWith('Not derivable'), `fee without prevouts: ${none}`);
    return { withPrevouts: `${want} sats`, withoutPrevouts: 'Not derivable' };
  });

  await rec.check(row('Generate actual SHA-256'), 'the SHA-256 shown equals Node over the same bytes', async () => {
    const out = [];
    for (const hex of [V0, V2, LEGACY]) {
      await decode(page, hex);
      await page.getByText(/Decoded as/).first().waitFor();
      const shown = (await page.getByRole('tabpanel').innerText()).match(/[0-9a-f]{64}/)[0];
      expect(shown === sha(hex), `page ${shown}, node ${sha(hex)}`);
      out.push(shown);
    }
    return out;
  });

  assert.deepEqual(errors, []);
  await context.close();
  assert.deepEqual(rec.failures(), []);
});
