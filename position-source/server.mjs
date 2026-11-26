import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { sortedJson } from '../verifier/counterparty-asset.js';
import { bitcoinCore } from './bitcoin.mjs';
import { loadConfig } from './config.mjs';
import { counterpartyAuthority, sameSnapshot } from './counterparty.mjs';
import { mapAttachments } from './positions.mjs';
import { ATOMIC, HASH, MAX_BODY, PositionError } from './upstream.mjs';

const SOURCE = 'ordex-position-source-v1';
const PREFIXES = ['/v1/marketplace/positions', '/v1/marketplace/protocols/ordex/position-source'];
const OUTPOINT = /^([0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/;

function send(response, status, data, ledgerHash) {
  const body = JSON.stringify(data);
  if (Buffer.byteLength(body) > MAX_BODY) throw new PositionError('position_inventory_too_large', 413);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...(ledgerHash === undefined ? {} : { 'ordex-ledger-hash': ledgerHash }),
    ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
    ...(status === 405 ? { allow: 'GET' } : {}),
  });
  response.end(body);
}

function parseOutpoint(encoded) {
  let outpoint;
  try {
    outpoint = decodeURIComponent(encoded);
  } catch {
    throw new PositionError('invalid_outpoint', 422);
  }
  const match = OUTPOINT.exec(outpoint);
  if (!match || match[0] !== outpoint || Number(match[2]) > 0xffffffff) {
    throw new PositionError('invalid_outpoint', 422);
  }
  return { outpoint, txid: match[1], vout: Number(match[2]) };
}

export function createPositionServer(config) {
  const bitcoin = bitcoinCore(config);
  const counterparty = counterpartyAuthority(config);
  const common = {
    schemaVersion: 'universe-marketplace-protocol-position-v1',
    protocolId: 'ordex',
    network: `bitcoin:${config.network}`,
    ...(config.chainIdentity ? { chainIdentity: config.chainIdentity } : {}),
  };

  async function current(signal, ending = false) {
    // The outer reads come from Core, bracketing the Counterparty reads.
    const core = ending ? null : await bitcoin.tip(signal);
    const snapshot = await counterparty.tip(signal);
    const tip = core ?? await bitcoin.tip(signal);
    if (tip.height !== snapshot.height) throw new PositionError('counterparty_height_mismatch');
    if (tip.blockHash !== snapshot.blockHash) throw new PositionError('counterparty_block_mismatch');
    return snapshot;
  }

  async function stable(before, signal) {
    const after = await current(signal, true);
    if (!sameSnapshot(before, after)) throw new PositionError('authority_checkpoint_changed');
    return after;
  }

  function checkpoint(snapshot, observedAt) {
    return {
      network: common.network,
      heightAtomic: String(snapshot.height),
      blockHash: snapshot.blockHash,
      observedAt,
      ...(config.chainIdentity ? { canonical: true } : { authoritative: true }),
      reorgDetected: false,
      source: SOURCE,
    };
  }

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const prefix = PREFIXES.find((candidate) => url.pathname.startsWith(`${candidate}/`));
      const route = prefix && url.pathname.slice(prefix.length);
      const isReady = route === '/ready';
      const match = route && /^\/outpoints\/([^/]+)$/.exec(route);
      if (!isReady && !match) throw new PositionError('route_not_found', 404);
      const provided = createHash('sha256').update(request.headers.authorization ?? '').digest();
      if (!timingSafeEqual(provided, config.bearerDigest)) throw new PositionError('unauthorized', 401);
      if (request.method !== 'GET') throw new PositionError('method_not_allowed', 405);
      const signal = AbortSignal.timeout(5_000);

      if (isReady) {
        if (url.searchParams.size) throw new PositionError('invalid_query', 422);
        let snapshot;
        let reason = null;
        try {
          snapshot = await stable(await current(signal), signal);
        } catch (error) {
          reason = error instanceof PositionError ? error.message : 'position_source_unavailable';
        }
        const observedAt = new Date().toISOString();
        send(response, snapshot ? 200 : 503, {
          ...common,
          ready: Boolean(snapshot),
          checkpoint: snapshot ? checkpoint(snapshot, observedAt) : null,
          // This source reads live state and keeps no local index or reorg epoch.
          reorgEpochAtomic: '0',
          observedAt,
          reason,
        }, snapshot?.ledgerHash);
        return;
      }

      const parsed = parseOutpoint(match[1]);
      const height = url.searchParams.get('heightAtomic');
      const hash = url.searchParams.get('blockHash');
      if (url.searchParams.size !== 2 || height === null || hash === null || !ATOMIC.test(height) || !HASH.test(hash)) {
        throw new PositionError('invalid_checkpoint', 422);
      }
      const before = await current(signal);
      if (String(before.height) !== height || before.blockHash !== hash) {
        throw new PositionError('checkpoint_not_current', 409);
      }
      const output = await bitcoin.output(parsed.txid, parsed.vout, before.blockHash, signal);
      const records = await counterparty.attachments(parsed.outpoint, before, signal);
      const { positions, recordDigests } = mapAttachments(records, {
        ...parsed, network: config.network, snapshot: before, output,
      });
      await stable(before, signal);
      const observedAt = new Date().toISOString();
      const stateVersion = createHash('sha256').update(sortedJson({
        ...common, snapshot: before, outpoint: parsed.outpoint, output, positions, recordDigests,
      })).digest('hex');
      send(response, 200, {
        ...common,
        outpoint: parsed.outpoint,
        checkpoint: checkpoint(before, observedAt),
        indexed: true,
        complete: true,
        positions,
        observedAt,
        source: SOURCE,
        stateVersion,
      }, before.ledgerHash);
    } catch (error) {
      const problem = error instanceof PositionError ? error : new PositionError('position_source_unavailable');
      send(response, problem.status, { error: problem.message });
    }
  });
}

if (import.meta.main) {
  const config = loadConfig();
  createPositionServer(config).listen(config.port, config.host);
}
