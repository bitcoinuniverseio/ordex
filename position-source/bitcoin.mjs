import { HASH, PositionError, readJson } from './upstream.mjs';

export function bitcoinCore(config) {
  async function rpc(method, params, signal) {
    if (!config.bitcoinUrl || !config.bitcoinUser || !config.bitcoinPassword) {
      throw new PositionError('bitcoin_core_unconfigured');
    }
    const credentials = Buffer.from(`${config.bitcoinUser}:${config.bitcoinPassword}`).toString('base64');
    const body = await readJson(config.bitcoinUrl, {
      method: 'POST',
      headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
      signal,
    }, 'bitcoin_core_unavailable');
    if (body?.id !== method || body.error != null || !Object.hasOwn(body, 'result')) {
      throw new PositionError('bitcoin_core_proof_malformed');
    }
    return body.result;
  }

  return {
    async tip(signal) {
      const info = await rpc('getblockchaininfo', [], signal);
      const chain = config.network === 'mainnet' ? 'main' : 'signet';
      if (info?.chain !== chain) throw new PositionError('bitcoin_core_network_mismatch');
      if (config.chainIdentity) {
        if (info.signet_challenge !== config.chainIdentity.signetChallenge ||
            await rpc('getblockhash', [0], signal) !== config.chainIdentity.genesisBlockHash) {
          throw new PositionError('bitcoin_core_signet_mismatch');
        }
      }
      if (info.initialblockdownload !== false) throw new PositionError('bitcoin_core_syncing');
      if (!Number.isSafeInteger(info.blocks) || info.blocks < 0 ||
          typeof info.bestblockhash !== 'string' || !HASH.test(info.bestblockhash)) {
        throw new PositionError('bitcoin_core_proof_malformed');
      }
      return { height: info.blocks, blockHash: info.bestblockhash };
    },

    async output(txid, vout, blockHash, signal) {
      const row = await rpc('gettxout', [txid, vout, false], signal);
      if (row === null) throw new PositionError('output_spent_or_unknown', 409);
      if (row?.bestblock !== blockHash) throw new PositionError('checkpoint_not_current', 409);
      // All Bitcoin amounts in satoshis fit in a safe JS integer.
      const sats = Math.round(row.value * 100_000_000);
      if (typeof row.value !== 'number' || !Number.isSafeInteger(sats) ||
          sats < 0 || sats > 2_100_000_000_000_000 || row.value !== sats / 100_000_000) {
        throw new PositionError('bitcoin_core_proof_malformed');
      }
      return { valueSats: String(sats), address: row.scriptPubKey?.address };
    },
  };
}
