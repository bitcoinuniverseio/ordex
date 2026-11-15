# Ordex

Ordex specifies portable Bitcoin orders based on signed PSBTs. This repository
contains the protocol specifications, reference verifiers, conformance vectors,
typed gateway SDK, and documentation site.

The [documentation site](https://bitcoinuniverseio.github.io/ordex/) includes
protocol guides, an API reference, and interactive verification tools. Ordex is
an evidence and discovery layer, not a wallet. Review transaction inputs,
outputs, destination, and fees in a wallet you trust before signing.

## Repository contents

- [Protocol specifications](spec/), including the [order lifecycle](spec/lifecycle.md),
  [portable orders](spec/interoperability.md), and [purchase flow](spec/purchase.md).
- [Gateway API guide](spec/api.md), [OpenAPI contract](spec/openapi.json), and
  [AsyncAPI contract](spec/asyncapi.json).
- [Reference verifiers](verifier/) and [conformance vectors](conformance/).
- [Typed SDK](sdk/README.md) for the gateway API.
- Documentation site source in [site/](site/) and published files in [docs/](docs/).
- [Security policy](SECURITY.md).

## Local development

Use the Node.js version in `.nvmrc`, then install locked dependencies with
`npm ci`. Run `npm run site:dev` for the documentation development server or
`npm run build` to build the site and regenerate published documentation files.
The build also validates its output and links.

Run `npm test` for the root verifier and unit checks, or `npm run conformance`
for the conformance CLI. The SDK has separate dependencies and commands; see
its [README](sdk/README.md).
