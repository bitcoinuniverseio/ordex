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

- Reads answer `200`, writes answer `201` (updates and deletes `200`), and a
  failed response throws `OrdexApiError` carrying the gateway's exact error
  envelope. A successful answer that is not the JSON the contract states
  throws `OrdexResponseError` (`UNEXPECTED_MEDIA_TYPE`, `MALFORMED_JSON`).
- `retries` (0 to 10) applies to reads only, and only after a network error,
  a timed out attempt, or a `502`, `503` or `504`. A write is never retried by
  the client, because the gateway does not deduplicate writes; routes that
  take an `idempotencyKey` forward it and are still sent once.
- `timeoutMs` (30 seconds by default) bounds one attempt and `deadlineMs` the
  whole call, retries and waits included (`timeoutMs * (retries + 1)` by
  default). Waits double from `retryDelayMs`, never exceed `maxRetryDelayMs`,
  and are not started when they would pass the deadline. Settings out of
  range throw `RangeError`.
- Every method takes an `AbortSignal`. An aborted signal sends nothing; an
  abort during a request or a retry wait ends the call at once, rejects with
  the signal's own reason whatever value it is, and is never retried.
- `iterateOrders` and `iterateActivity` follow the keyset cursor page by
  page, and stop with `OrdexResponseError` on a cursor the gateway already
  returned (`CURSOR_REPEATED`) or an answer that is not a page
  (`MALFORMED_PAGE`). There is no offset paging, because the gateway refuses it.
- `streamOrdexEvents` yields server sent event messages; an `ordex-event`
  message carries an `OrdexEvent` envelope. `timeoutMs` bounds the connection
  only. The stream never reconnects by itself: resume with the last message
  `id` as `lastEventId`.
- The webhook routes are scoped to a developer key. Pass `developerKey` and the
  client sends it as a bearer token to those routes and to no other. Signing
  session routes take the session capability as an argument.
- The client holds no keys, signs nothing, and broadcasts nothing. Signing
  belongs to the customer's own wallet, and broadcasting is the owner's own
  deliberate step after preflight. The two relay routes
  (`broadcastSafeOpsTransaction`, `broadcastSwapSession`) and the funded offer
  routes the gateway does not serve yet are listed with their reasons in
  `SDK_EXCLUDED_OPERATIONS`; every other contract operation is a method named
  after its `operationId`.

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
