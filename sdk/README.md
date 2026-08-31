# Ordex SDK

A typed client for the Ordex gateway API. Every method mirrors one route in
[the OpenAPI 3.1 contract](../spec/openapi.json), and every type is generated
from that contract, so the SDK cannot describe a gateway that does not exist.

## Install and build

The package is built from this repository:

```bash
npm ci && npm run generate && npm run build && npm test
```

`generate` writes `src/schema.ts` from the contract. The generated file is
committed, and CI regenerates it and fails on any difference, so the types in
your editor are always the types the contract states.

## Use

```ts
import { OrdexClient, OrdexApiError } from '@bitcoinuniverse/ordex-sdk';

const ordex = new OrdexClient({ baseUrl: 'https://bitcoinuniverse.io' });

const health = await ordex.getHealth();
if (!health.readyForBitcoinListings) {
  console.log('Listings cannot be verified right now:', health.listingReadiness.reason);
}

for await (const order of ordex.iterateOrders({ protocol: 'ordinals', sort: 'price_asc' })) {
  console.log(order.id, order.quotedPriceSats, order.actionability);
}
```

Amounts are atomic sats carried as decimal strings, exactly as the wire
carries them. Nothing in this package converts them through JavaScript
numbers; parse them with `BigInt` when you need arithmetic.

## What the client does and refuses to do

- Reads answer `200`, writes answer `201`, and a failed response throws
  `OrdexApiError` carrying the gateway's exact error envelope.
- `retries` applies to reads only. A write is never retried by the client,
  because the gateway does not deduplicate writes.
- Every method takes an `AbortSignal`, and every request has a deadline
  (`timeoutMs`, 30 seconds by default).
- `iterateOrders` and `iterateActivity` follow the keyset cursor page by
  page. There is no offset paging, because the gateway refuses it.
- The client holds no keys, signs nothing, and broadcasts nothing. Signing
  belongs to the customer's own wallet, and broadcasting is the buyer's own
  deliberate step after preflight.

## Verifying a purchase yourself

The purchase rules from [spec/purchase.md](../spec/purchase.md) ship in the
package as `verifyPublicAskCompletion`, with the same machine readable
refusal codes as the repository's reference verifier. Both implementations
run [the same conformance vectors](../conformance/purchase-vectors.json) in
CI, so they cannot drift apart silently.

```ts
import { verifyPublicAskCompletion } from '@bitcoinuniverse/ordex-sdk';

const verdict = verifyPublicAskCompletion(transaction, {
  offeredOutpoint: { txid, vout },
  sellerPaymentScriptHex,
  sellerPaymentValueSats,
});
if (!verdict.ok) throw new Error(`${verdict.code}: ${verdict.reason}`);
```
