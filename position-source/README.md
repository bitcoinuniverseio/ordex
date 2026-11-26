# Ordex Marketplace position source

Run `node position-source/server.mjs` with Node 24. No package installation is required. The service reads attachments from one self-hosted Counterparty Core deployment, with Bitcoin Core providing the chain checkpoint and confirmed UTXO state. See the [Counterparty attachment spec](../spec/counterparty-utxo-asset.md).

## Configuration

| Environment variable | Value |
| --- | --- |
| `ORDEX_POSITIONS_NETWORK` | `mainnet` (default) or `signet`. |
| `ORDEX_POSITIONS_SIGNET_CHALLENGE` | Required on Signet and forbidden on mainnet. Lowercase script hex equal to Bitcoin Core's `signet_challenge`. |
| `ORDEX_POSITIONS_HOST` | Loopback listener, defaults to `127.0.0.1`. Use `::1` for IPv6. |
| `ORDEX_POSITIONS_PORT` | Listener port, defaults to `3535`. |
| `ORDEX_POSITIONS_BEARER` | Required bearer token of at least 32 characters. |
| `BITCOIN_RPC_URL` | Bitcoin Core HTTP(S) RPC URL on a loopback IP. |
| `BITCOIN_RPC_USER`, `BITCOIN_RPC_PASSWORD` | Bitcoin Core RPC credentials. |
| `COUNTERPARTY_API_URL` | Self-hosted Counterparty Core v2 HTTP(S) origin on a loopback IP. |
| `COUNTERPARTY_API_CHECKPOINT_PATH` | Absolute `/v2/…` path to the deployment's checkpoint proof. |
| `COUNTERPARTY_API_OUTPOINTS_PATH` | Absolute `/v2/…` base path to the deployment's outpoint proofs. |

Both routes require `Authorization: Bearer <ORDEX_POSITIONS_BEARER>`.

- `GET /v1/marketplace/positions/ready`
- `GET /v1/marketplace/positions/outpoints/:outpoint?heightAtomic=&blockHash=`

For `INDEX_ORDINALS_POSITION_SOURCES_JSON`, set `protocolId` to `ordex`, `origin` to the listener's origin, and `bearerToken` to the service token. The same two routes are also available under `/v1/marketplace/protocols/ordex/position-source`, the prefix used by the composite client.

## Counterparty deployment contract

This repo does not pin native Counterparty Core v2 endpoints or response shapes for these proofs. The [adapter](counterparty.mjs) stays unconfigured until both paths are set. Configure them only for a deployment that provides the envelopes below, either directly or through a local projection of that same self-hosted deployment. The projection must obtain the checkpoint and complete attachment inventory from Counterparty Core and preserve the exact atomic strings. A stock API that cannot provide these proofs leaves the source unavailable. Upstream requests never follow redirects or fall back to a public API.

Both endpoints respond with HTTP 200 and JSON in a `result` envelope.

- The checkpoint endpoint returns `{ ready, network, height, blockHash, ledgerHash, txlistHash, messagesHash }` as its result. `ready` must be true, `network` is `mainnet` or `signet`, `height` is a nonnegative integer, and hashes are 64 lowercase hex characters. On Signet the result must also carry `signetChallenge` from the authority's chain.
- The outpoint endpoint receives `/:outpoint?heightAtomic=&blockHash=` appended to its base path. Its result is `{ outpoint, complete, checkpoint, records }`. The echoed outpoint must be canonical `txid:vout`, `complete` must be true, and `checkpoint` must be the checkpoint proof for the same ledger snapshot as `records`. Return one `ordex.counterparty-utxo-asset/v1` record per attached asset, with an explicit `coTravelingAssets` array that declares every other asset on the outpoint. Return `records: []` only after checking that the specified outpoint has no attachments at that snapshot.

## Evidence and failures

Readiness requires Bitcoin Core and Counterparty Core to agree at the exact Bitcoin tip. On Signet, Bitcoin Core must also report the expected genesis and challenge. Each successful request brackets its work with fresh reads of both authorities and requires the ledger, transaction-list, and message hashes to agree across those reads. The source stores no local index, so its readiness reorg epoch is `0`. The service rejects an outpoint request if Core cannot confirm the output is unspent at the requested block or the attachment records cannot be verified at that same checkpoint.

Each position uses the numeric asset ID and exact atomic quantity from the record. The first-sat attachment rule maps to offset `0` and span `1`. Successful responses expose the ledger hash in the `Ordex-Ledger-Hash` header and the checkpoint in the JSON body. The outpoint `stateVersion` also commits to the authority snapshot, output, and verified records.

Readiness returns HTTP 503 with `ready: false` when an upstream is unconfigured, unavailable, lagging, on another chain, or unstable. Outpoint requests only return an inventory after a complete proof at the pinned checkpoint. Failed checks return an HTTP error with no inventory.

Run `node --test position-source/` for the offline conformance and HTTP contract tests.
