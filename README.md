# Ordex

Ordex is a decentralized PSBT inventory and routing layer for Bitcoin markets. It indexes independently sourced order artifacts, verifies the relevant UTXOs against Bitcoin Core and inscriptions against `ord`, and uses signed Nostr kind-802 events to make a listing portable across compatible marketplaces.

The market client can use the operator's Ordex gateway by default or a self-hosted gateway selected by the user. Nostr publication uses the user's NIP-07 signer; Ordex never accepts a wallet or Nostr private key.

## Start here

Open [the documentation home](docs/index.html) in a browser, then follow:

1. [Operator guide](docs/operator-guide.html) to connect Core and `ord`.
2. [Market integration guide](docs/market-integration.html) to use the shared inventory and self-hosted gateway option.
3. [Protocol guide](docs/protocol-guide.html) for order states, Nostr events, and settlement boundaries.
4. [Quickstart](docs/quickstart.html) for marketplace, operator, and collector paths.
5. [API reference](docs/api-reference.html) and [troubleshooting](docs/troubleshooting.html) for implementation and operations.

Copy `.env.example` into your deployment configuration. The Core endpoint needs only read methods: `getblockchaininfo`, `gettxout`, and `testmempoolaccept`.
