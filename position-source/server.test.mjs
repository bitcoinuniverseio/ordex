import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Duplex } from 'node:stream';
import { test } from 'node:test';
import { positionClient } from './client-validation.fixture.mjs';
import { loadConfig } from './config.mjs';
import { createPositionServer } from './server.mjs';

const TOKEN = 't'.repeat(32);
const TXID = 'c'.repeat(64);
const OUTPOINT = `${TXID}:2`;
const BLOCK = 'b'.repeat(64);
const LEDGER = 'a'.repeat(64);
const GENESIS = '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6';
const PREFIX = '/v1/marketplace/positions';
const OUTPUT_PATH = `${PREFIX}/outpoints/${encodeURIComponent(OUTPOINT)}?heightAtomic=100&blockHash=${BLOCK}`;

// Exercise Node's HTTP parser and server handlers without binding sockets.
async function exchange(server, path, { headers, method = 'GET', body = '' } = {}) {
  const raw = [];
  const socket = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      raw.push(chunk);
      callback();
    },
  });
  const finished = once(socket, 'finish');
  server.emit('connection', socket);
  const fields = new Headers(headers);
  fields.set('host', '127.0.0.1');
  fields.set('connection', 'close');
  fields.set('content-length', String(Buffer.byteLength(body)));
  const wireHeaders = [...fields].map(([key, value]) => `${key}: ${value}\r\n`).join('');
  socket.push(`${method} ${path} HTTP/1.1\r\n${wireHeaders}\r\n${body}`);
  await finished;
  socket.destroy();
  const wire = Buffer.concat(raw).toString();
  const boundary = wire.indexOf('\r\n\r\n');
  const [statusLine, ...responseHeaders] = wire.slice(0, boundary).split('\r\n');
  return new Response(wire.slice(boundary + 4), {
    status: Number(statusLine.split(' ')[1]),
    headers: responseHeaders.map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
  });
}

function reply(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function fixture(t, network = 'mainnet', overrides = {}) {
  const chainIdentity = network === 'signet' ? { genesisBlockHash: GENESIS, signetChallenge: '51' } : null;
  const state = {
    core: {
      chain: network === 'signet' ? 'signet' : 'main',
      signet_challenge: chainIdentity?.signetChallenge,
      blocks: 100,
      bestblockhash: BLOCK,
      initialblockdownload: false,
    },
    genesis: GENESIS,
    checkpoint: {
      ready: true, network, signetChallenge: chainIdentity?.signetChallenge,
      height: 100, blockHash: BLOCK, ledgerHash: LEDGER,
      txlistHash: 'd'.repeat(64), messagesHash: 'e'.repeat(64),
    },
    records: [],
    complete: true,
    checks: 0,
    coreChecks: 0,
    checkpointChecks: 0,
    onAttachmentRead: () => {},
    onCheckpointRead: () => {},
    output: { bestblock: BLOCK, value: 0.0002, scriptPubKey: { address: 'test-owner' } },
  };

  const bitcoin = createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, `Basic ${Buffer.from('local:fixture').toString('base64')}`);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    let result;
    switch (rpc.method) {
      case 'getblockchaininfo':
        state.coreChecks++;
        result = state.core;
        break;
      case 'getblockhash':
        assert.deepEqual(rpc.params, [0]);
        result = state.genesis;
        break;
      case 'gettxout':
        assert.deepEqual(rpc.params, [TXID, 2, false]);
        result = state.output;
        break;
      default:
        assert.fail(`unexpected RPC ${rpc.method}`);
    }
    reply(response, { id: rpc.id, result });
  });

  const counterparty = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/v2/proofs/checkpoint') {
      state.checkpointChecks++;
      reply(response, { result: state.checkpoint });
      state.onCheckpointRead();
      return;
    }
    assert.equal(url.pathname, `/v2/proofs/outpoints/${encodeURIComponent(OUTPOINT)}`);
    assert.equal(url.searchParams.get('heightAtomic'), '100');
    assert.equal(url.searchParams.get('blockHash'), BLOCK);
    state.checks++;
    reply(response, { result: {
      outpoint: OUTPOINT, complete: state.complete, records: state.records, checkpoint: state.checkpoint,
    } });
    state.onAttachmentRead();
  });

  const config = loadConfig({
    ORDEX_POSITIONS_NETWORK: network,
    ORDEX_POSITIONS_SIGNET_CHALLENGE: chainIdentity?.signetChallenge,
    ORDEX_POSITIONS_BEARER: TOKEN,
    BITCOIN_RPC_URL: 'http://127.0.0.1:8332',
    BITCOIN_RPC_USER: 'local',
    BITCOIN_RPC_PASSWORD: 'fixture',
    COUNTERPARTY_API_URL: 'http://127.0.0.1:4000/v2',
    COUNTERPARTY_API_CHECKPOINT_PATH: '/v2/proofs/checkpoint',
    COUNTERPARTY_API_OUTPOINTS_PATH: '/v2/proofs/outpoints',
    ...overrides,
  });
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const url = new URL(input);
    assert.equal(options.redirect, 'error');
    const upstream = { '8332': bitcoin, '4000': counterparty }[url.port];
    assert.ok(upstream, 'request must stay on a configured loopback upstream');
    return exchange(upstream, url.pathname + url.search, options);
  });
  const server = createPositionServer(config);
  const request = (path, options = { headers: { authorization: `Bearer ${TOKEN}` } }) =>
    exchange(server, path, options);
  return { state, request, client: positionClient(request, TOKEN, `bitcoin:${network}`, chainIdentity) };
}

function attachment(network, assetId, name, quantitySats, coTravelingAssets = []) {
  return {
    schema: 'ordex.counterparty-utxo-asset/v1',
    network,
    asset: { assetId, name, quantitySats, divisible: false },
    outpoint: { txid: TXID, vout: 2 },
    address: 'test-owner',
    sourceValueSats: '20000',
    coTravelingAssets,
    checkpoint: { height: 100, blockHash: BLOCK, ledgerHash: LEDGER },
    authority: { kind: 'counterparty-core', ready: true },
    attached: true,
  };
}

for (const network of ['mainnet', 'signet']) {
  test(`${network} readiness and output round-trip through the consumer rules`, async (t) => {
    const { state, request, client } = fixture(t, network);
    const first = { assetId: '137', name: 'RAREPEPE', quantitySats: '1' };
    const second = { assetId: '18446744073709551615', name: 'LONG.NAME', quantitySats: '9007199254740993' };
    state.records = [
      attachment(network, second.assetId, second.name, second.quantitySats, [first]),
      attachment(network, first.assetId, first.name, first.quantitySats, [second]),
    ];
    const ready = await client.readReadiness();
    assert.equal(ready.ready, true);
    assert.equal(state.checkpointChecks, 2);
    assert.equal(state.coreChecks, 2);
    assert.equal((await request(`${PREFIX}/ready`)).headers.get('ordex-ledger-hash'), LEDGER);
    const inventory = await client.readOutput(OUTPOINT, ready.checkpoint);
    assert.deepEqual(inventory.positions, [first, second].map(({ assetId, quantitySats }) => ({
      protocolId: 'ordex', assetId, quantityAtomic: quantitySats, offsetAtomic: '0', spanAtomic: '1',
    })));
    state.records.reverse();
    const alias = await request(OUTPUT_PATH);
    assert.equal(alias.status, 200);
    assert.equal(alias.headers.get('ordex-ledger-hash'), LEDGER);
    assert.equal((await alias.json()).stateVersion, inventory.stateVersion);
  });
}

test('empty inventory requires a ready authority and a complete pinned outpoint proof', async (t) => {
  const { state, request, client } = fixture(t);
  const ready = await client.readReadiness();
  assert.deepEqual((await client.readOutput(OUTPOINT, ready.checkpoint)).positions, []);
  assert.equal(state.checks, 1);

  state.complete = false;
  const incomplete = await request(OUTPUT_PATH);
  assert.equal(incomplete.status, 503);
  assert.deepEqual(await incomplete.json(), { error: 'counterparty_outpoint_unproven' });

  state.complete = true;
  state.checkpoint.height--;
  const lagging = await client.readReadiness();
  assert.equal(lagging.ready, false);
  assert.equal(lagging.reason, 'counterparty_height_mismatch');
  assert.equal((await request(OUTPUT_PATH)).status, 503);
  assert.equal(state.checks, 2);
});

test('missing Counterparty endpoint configuration fails readiness', async (t) => {
  const { client } = fixture(t, 'mainnet', { COUNTERPARTY_API_OUTPOINTS_PATH: undefined });
  assert.equal((await client.readReadiness()).reason, 'counterparty_adapter_unconfigured');
});

test('refuses unknown asset shapes and undeclared co-traveling assets', async (t) => {
  const { state, request } = fixture(t);
  state.records = [attachment('mainnet', '137', 'RAREPEPE', '1')];
  state.records[0].asset.assetId = 137;
  assert.deepEqual(await (await request(OUTPUT_PATH)).json(), { error: 'counterparty_attachment_unproven' });

  state.records = [
    attachment('mainnet', '137', 'RAREPEPE', '1'),
    attachment('mainnet', '138', 'OTHER', '2'),
  ];
  const response = await request(OUTPUT_PATH);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'counterparty_cotravel_unproven' });
});

test('refuses Bitcoin and Counterparty chain mismatches including Signet identity', async (t) => {
  const { state, request, client } = fixture(t, 'signet');
  state.core.chain = 'main';
  assert.equal((await client.readReadiness()).reason, 'bitcoin_core_network_mismatch');
  state.core.chain = 'signet';
  state.core.signet_challenge = '52';
  assert.equal((await client.readReadiness()).reason, 'bitcoin_core_signet_mismatch');
  assert.equal((await request(OUTPUT_PATH)).status, 503);
  state.core.signet_challenge = '51';
  state.genesis = '0'.repeat(64);
  assert.equal((await client.readReadiness()).reason, 'bitcoin_core_signet_mismatch');
  state.genesis = GENESIS;
  state.checkpoint.signetChallenge = '52';
  assert.equal((await client.readReadiness()).reason, 'counterparty_network_mismatch');
  state.checkpoint.signetChallenge = '51';
  state.checkpoint.network = 'testnet';
  assert.equal((await client.readReadiness()).reason, 'counterparty_network_mismatch');
});

test('refuses wrong bearer and mismatched requested checkpoint before lookup', async (t) => {
  const { state, request } = fixture(t);
  for (const path of [`${PREFIX}/ready`, OUTPUT_PATH]) {
    const denied = await request(path, { headers: { authorization: 'Bearer incorrect' } });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('www-authenticate'), 'Bearer');
  }
  assert.equal(state.coreChecks, 0);
  assert.equal((await request(OUTPUT_PATH.replace('100', '101'))).status, 409);
  assert.equal((await request(OUTPUT_PATH.replace(BLOCK, 'f'.repeat(64)))).status, 409);
  assert.equal(state.checks, 0);
});

test('checks block agreement, live output, and all three Counterparty hashes', async (t) => {
  const { state, request, client } = fixture(t);
  state.checkpoint.blockHash = 'f'.repeat(64);
  assert.equal((await client.readReadiness()).reason, 'counterparty_block_mismatch');
  state.checkpoint.blockHash = BLOCK;
  const output = state.output;
  state.output = null;
  assert.equal((await request(OUTPUT_PATH)).status, 409);
  state.output = output;
  for (const key of ['ledgerHash', 'txlistHash', 'messagesHash']) {
    const old = state.checkpoint[key];
    state.onAttachmentRead = () => { state.checkpoint[key] = 'f'.repeat(64); };
    const changed = await request(OUTPUT_PATH);
    assert.equal(changed.status, 503);
    assert.deepEqual(await changed.json(), { error: 'authority_checkpoint_changed' });
    state.checkpoint[key] = old;
  }
});

test('readiness refuses unstable hashes and an authority that reports unready', async (t) => {
  const { state, client } = fixture(t);
  state.onCheckpointRead = () => { state.checkpoint.ledgerHash = 'f'.repeat(64); };
  assert.equal((await client.readReadiness()).reason, 'authority_checkpoint_changed');
  state.checkpoint.ready = false;
  assert.equal((await client.readReadiness()).reason, 'counterparty_not_ready');
});

test('an empty inventory state version binds the ledger hash', async (t) => {
  const { state, request } = fixture(t);
  const first = await request(OUTPUT_PATH);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  state.checkpoint.ledgerHash = 'f'.repeat(64);
  const second = await request(OUTPUT_PATH);
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.deepEqual(secondBody.positions, []);
  assert.notEqual(firstBody.stateVersion, secondBody.stateVersion);
  assert.equal(second.headers.get('ordex-ledger-hash'), state.checkpoint.ledgerHash);
});

test('config rejects unknown networks and non-loopback upstreams', () => {
  const env = { ORDEX_POSITIONS_BEARER: TOKEN };
  assert.throws(() => loadConfig({ ...env, ORDEX_POSITIONS_NETWORK: 'testnet' }), /ORDEX_POSITIONS_NETWORK/);
  assert.throws(() => loadConfig({ ...env, ORDEX_POSITIONS_NETWORK: 'signet' }), /ORDEX_POSITIONS_SIGNET_CHALLENGE/);
  assert.throws(() => loadConfig({ ...env, BITCOIN_RPC_URL: 'http://example.invalid' }), /loopback/);
  assert.throws(() => loadConfig({ ...env, COUNTERPARTY_API_URL: 'http://example.invalid' }), /loopback/);
  assert.throws(() => loadConfig({ ...env, ORDEX_POSITIONS_BEARER: 'short' }), /at least 32/);
});
