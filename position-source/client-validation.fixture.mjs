// JS port of index-ordinals/src/position-source-client.ts for the ordex protocol.
import assert from 'node:assert/strict';

const PREFIX = '/v1/marketplace/protocols/ordex/position-source';
const HASH = /^[0-9a-f]{64}$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;

function exactKeys(row, keys) {
  assert.ok(row !== null && typeof row === 'object' && !Array.isArray(row));
  assert.deepEqual(Object.keys(row).sort(), [...keys].sort());
}

function atomic(value, positive = false) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^(?:0|[1-9][0-9]{0,77})$/);
  if (positive) assert.ok(BigInt(value) > 0n);
  return value;
}

function text(value, maximum) {
  assert.equal(typeof value, 'string');
  assert.ok(value.length && value === value.trim() && Buffer.byteLength(value) <= maximum);
  assert.ok(Array.from(value).every((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127));
}

export function positionClient(request, token, network, chainIdentity = null, now = Date.now, maxAgeMs = 60_000) {
  const headers = { authorization: `Bearer ${token}`, 'cache-control': 'no-store' };
  const common = ['schemaVersion', 'protocolId', 'network', 'checkpoint', 'observedAt'];
  if (chainIdentity) common.push('chainIdentity');

  function fresh(value) {
    assert.equal(typeof value, 'string');
    const parsed = Date.parse(value);
    assert.equal(new Date(parsed).toISOString(), value);
    const current = now();
    assert.ok(Number.isFinite(current) && parsed <= current + 300_000 && current - parsed <= maxAgeMs);
  }

  function validate(row, keys) {
    exactKeys(row, [...common, ...keys]);
    assert.equal(row.schemaVersion, 'universe-marketplace-protocol-position-v1');
    assert.equal(row.protocolId, 'ordex');
    assert.equal(row.network, network);
    fresh(row.observedAt);
    if (chainIdentity) {
      exactKeys(row.chainIdentity, ['genesisBlockHash', 'signetChallenge']);
      assert.deepEqual(row.chainIdentity, chainIdentity);
    }
    if (row.checkpoint !== null) {
      const flag = chainIdentity ? 'canonical' : 'authoritative';
      exactKeys(row.checkpoint, ['network', 'heightAtomic', 'blockHash', 'observedAt', flag, 'reorgDetected', 'source']);
      assert.equal(row.checkpoint.network, network);
      atomic(row.checkpoint.heightAtomic);
      assert.equal(typeof row.checkpoint.blockHash, 'string');
      assert.match(row.checkpoint.blockHash, HASH);
      fresh(row.checkpoint.observedAt);
      assert.equal(row.checkpoint[flag], true);
      assert.equal(row.checkpoint.reorgDetected, false);
      text(row.checkpoint.source, 256);
    }
  }

  async function read(path, statuses) {
    const response = await request(PREFIX + path, { headers });
    assert.ok(statuses.includes(response.status), `unexpected status ${response.status}`);
    const raw = await response.text();
    assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024);
    return { status: response.status, row: JSON.parse(raw) };
  }

  return {
    async readReadiness() {
      const { status, row } = await read('/ready', [200, 503]);
      validate(row, ['ready', 'reorgEpochAtomic', 'reason']);
      assert.equal(typeof row.ready, 'boolean');
      atomic(row.reorgEpochAtomic);
      if (row.ready) {
        assert.equal(status, 200);
        assert.ok(row.checkpoint);
        assert.equal(row.reason, null);
      } else {
        assert.equal(status, 503);
        assert.equal(typeof row.reason, 'string');
        assert.match(row.reason, /^[a-z][a-z0-9_:-]{0,127}$/);
      }
      return row;
    },

    async readOutput(outpoint, checkpoint) {
      assert.equal(typeof outpoint, 'string');
      const match = /^([0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/.exec(outpoint);
      assert.ok(match && BigInt(match[2]) <= 4_294_967_295n);
      const query = new URLSearchParams({ heightAtomic: checkpoint.heightAtomic, blockHash: checkpoint.blockHash });
      const { row } = await read(`/outpoints/${encodeURIComponent(outpoint)}?${query}`, [200]);
      validate(row, ['outpoint', 'indexed', 'complete', 'positions', 'source', 'stateVersion']);
      assert.equal(row.outpoint, outpoint);
      assert.equal(row.indexed, true);
      assert.equal(row.complete, true);
      for (const key of ['network', 'heightAtomic', 'blockHash']) assert.equal(row.checkpoint[key], checkpoint[key]);
      text(row.source, 256);
      assert.equal(typeof row.stateVersion, 'string');
      assert.match(row.stateVersion, HASH);
      assert.ok(Array.isArray(row.positions) && row.positions.length <= 10_000);
      for (const position of row.positions) {
        exactKeys(position, ['protocolId', 'assetId', 'quantityAtomic', 'offsetAtomic', 'spanAtomic']);
        assert.equal(position.protocolId, 'ordex');
        text(position.assetId, 512);
        atomic(position.quantityAtomic, true);
        assert.ok(BigInt(atomic(position.offsetAtomic)) <= UINT64_MAX);
        assert.ok(BigInt(atomic(position.spanAtomic, true)) <= UINT64_MAX);
      }
      assert.equal(new Set(row.positions.map((position) => position.assetId)).size, row.positions.length);
      row.positions.sort((a, b) => a.assetId.localeCompare(b.assetId));
      return row;
    },
  };
}
