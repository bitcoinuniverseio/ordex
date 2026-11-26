import { createHash } from 'node:crypto';
import { validateHeaderValue } from 'node:http';
import { isIP } from 'node:net';

const SIGNET_GENESIS = '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6';

function loopback(host) {
  return host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

function upstream(env, key) {
  if (!env[key]) return null;
  let url;
  try {
    url = new URL(env[key]);
  } catch {
    throw new Error(`${key} must be an HTTP(S) loopback URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) ||
      !loopback(url.hostname.replace(/^\[|\]$/g, '')) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error(`${key} must be an HTTP(S) loopback URL without credentials, query or fragment`);
  }
  return url;
}

export function loadConfig(env = process.env) {
  const network = env.ORDEX_POSITIONS_NETWORK ?? 'mainnet';
  if (network !== 'mainnet' && network !== 'signet') {
    throw new Error('ORDEX_POSITIONS_NETWORK must be mainnet or signet');
  }
  const challenge = env.ORDEX_POSITIONS_SIGNET_CHALLENGE;
  if (network === 'signet' ? !/^(?:[0-9a-f]{2})+$/.test(challenge ?? '') : challenge !== undefined) {
    throw new Error('ORDEX_POSITIONS_SIGNET_CHALLENGE is required as lowercase script hex on signet only');
  }
  const host = env.ORDEX_POSITIONS_HOST ?? '127.0.0.1';
  const port = env.ORDEX_POSITIONS_PORT ?? '3535';
  if (!loopback(host) || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
    throw new Error('ORDEX_POSITIONS_HOST and ORDEX_POSITIONS_PORT must name a loopback listener');
  }
  const bearer = env.ORDEX_POSITIONS_BEARER;
  if (typeof bearer !== 'string' || bearer.length < 32 || bearer.trim() !== bearer) {
    throw new Error('ORDEX_POSITIONS_BEARER must be a bearer token of at least 32 characters');
  }
  try {
    validateHeaderValue('Authorization', bearer);
  } catch {
    throw new Error('ORDEX_POSITIONS_BEARER must be valid in an HTTP header');
  }
  return {
    host,
    port: Number(port),
    network,
    chainIdentity: network === 'signet' ? { genesisBlockHash: SIGNET_GENESIS, signetChallenge: challenge } : null,
    bearerDigest: createHash('sha256').update(`Bearer ${bearer}`).digest(),
    bitcoinUrl: upstream(env, 'BITCOIN_RPC_URL'),
    bitcoinUser: env.BITCOIN_RPC_USER,
    bitcoinPassword: env.BITCOIN_RPC_PASSWORD,
    counterpartyUrl: upstream(env, 'COUNTERPARTY_API_URL'),
    counterpartyCheckpointPath: env.COUNTERPARTY_API_CHECKPOINT_PATH,
    counterpartyOutpointsPath: env.COUNTERPARTY_API_OUTPOINTS_PATH,
  };
}
