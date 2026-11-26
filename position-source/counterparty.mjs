import { HASH, isRecord, PositionError, readJson } from './upstream.mjs';

// TODO: Pin the native endpoints and response mapping for the deployed
// Counterparty Core release when the repository specifies them. Until then,
// accept only explicitly configured local endpoints with the proof envelopes
// documented in README.md. Native responses of unknown shape fail closed.
function endpoint(base, path) {
  if (!base || typeof path !== 'string' ||
      !/^\/v2\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path)) return null;
  return new URL(path, base);
}

export function counterpartyAuthority(config) {
  const checkpointUrl = endpoint(config.counterpartyUrl, config.counterpartyCheckpointPath);
  const outpointsUrl = endpoint(config.counterpartyUrl, config.counterpartyOutpointsPath);

  async function result(url, signal) {
    const body = await readJson(url, { signal }, 'counterparty_unavailable');
    if (!isRecord(body?.result) || Object.hasOwn(body, 'error') && body.error !== null) {
      throw new PositionError('counterparty_proof_malformed');
    }
    return body.result;
  }

  function checkpoint(row) {
    if (!isRecord(row) || row.ready !== true) throw new PositionError('counterparty_not_ready');
    if (row.network !== config.network ||
        (config.chainIdentity && row.signetChallenge !== config.chainIdentity.signetChallenge)) {
      throw new PositionError('counterparty_network_mismatch');
    }
    if (!Number.isSafeInteger(row.height) || row.height < 0 ||
        ![row.blockHash, row.ledgerHash, row.txlistHash, row.messagesHash].every(
          (hash) => typeof hash === 'string' && HASH.test(hash),
        )) {
      throw new PositionError('counterparty_proof_malformed');
    }
    const { height, blockHash, ledgerHash, txlistHash, messagesHash } = row;
    return { height, blockHash, ledgerHash, txlistHash, messagesHash };
  }

  return {
    async tip(signal) {
      if (!checkpointUrl || !outpointsUrl) throw new PositionError('counterparty_adapter_unconfigured');
      return checkpoint(await result(checkpointUrl, signal));
    },
    async attachments(outpoint, expected, signal) {
      const url = new URL(`${outpointsUrl.pathname}/${encodeURIComponent(outpoint)}`, outpointsUrl);
      url.search = new URLSearchParams({
        heightAtomic: String(expected.height),
        blockHash: expected.blockHash,
      });
      const row = await result(url, signal);
      if (row.outpoint !== outpoint || row.complete !== true ||
          !Array.isArray(row.records) || row.records.length > 10_000 ||
          Object.keys(row).length !== 4 ||
          !sameSnapshot(checkpoint(row.checkpoint), expected)) {
        throw new PositionError('counterparty_outpoint_unproven');
      }
      return row.records;
    },
  };
}

export function sameSnapshot(left, right) {
  return left.height === right.height && left.blockHash === right.blockHash &&
    left.ledgerHash === right.ledgerHash && left.txlistHash === right.txlistHash &&
    left.messagesHash === right.messagesHash;
}
