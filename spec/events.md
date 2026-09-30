# Realtime events and signed webhooks v1

Status: active at protocol 1.2. Artifacts: `ordex-event/v1`, `ordex.webhook-subscription/v1`, `ordex.webhook-delivery/v1`. Reference verifier: `verifier/events.js`. Vectors: `conformance/event-vectors.json`. Streaming contract: `spec/asyncapi.json`.

Every public state change in an Ordex gateway becomes one immutable event envelope, produced by the transactional outbox at the exact database commit that changed the aggregate. Streaming workers consume the outbox. Nothing reconstructs authoritative history from websocket or in-memory activity.

## The envelope

An envelope carries: a globally unique id (uuid), the event type (`ordex.<family>.<name>`), schema version `1`, network, a monotonic per-network sequence, the aggregate type, id, and version, the observation time, the chain checkpoint (height and block hash) it was observed at, a status of `current` or `reverted`, the id of the reversed event when status is `reverted`, the public payload, artifact digests, and a trace id that reveals no private user information.

Rules the verifier enforces:

1. A reverted event must name the event it reverses, and an event cannot reverse itself (`REVERTED_EVENT_REQUIRED`).
2. Only a reverted event may carry a reversed id (`STATUS_INVALID`).
3. The sequence is a positive integer that never decreases (`SEQUENCE_INVALID`).
4. The checkpoint is present and well formed (`CHECKPOINT_INVALID`).

Replay order is the sort key `network:sequence:id`. It is deterministic, and consumers resume from it. There is no offset pagination anywhere in the event surface.

## Event families

Orders: published, replaced, withdrawn, stale, conflicted, settled, reorged. Swaps: published, matched, signed, conflicted, settled, expired, reorged. SafeOps: broadcast, replaced, confirmed, dropped, reorged. Counterparty: attachment, detachment, UTXO move, listing, sale, reversal. Provenance: manifest published, superseded, revoked, anchored. Chain: checkpoint advanced and reverted. Authority: readiness changed.

No private wallet data, no xpub, no address the policy does not allow, and no private swap terms appear in a public event or its logs.

## Streaming

Two transports carry the same envelopes:

- Server-sent events at `GET /api/ordex/events/stream`, for resilient browser and server consumption, with heartbeats. Each event's SSE id is `<sequence>:<eventId>`: it names the event and is also its exact resume position, so sending it back as `Last-Event-ID` (or as the `cursor` query) resumes right after that event with no lookup. An event id alone would not do: resuming from it needs an id-to-sequence lookup that fails once the event leaves retention.
- WebSocket at `GET /api/ordex/events/ws`, for multiplexed, high-volume consumers. The client opens each subscription with `{op: subscribe, id, filters, cursor}`, where `id` is its own name for that subscription (up to 16 per connection). The server answers `subscribed`, then wraps every event as `{op: event, id, cursor, event}`, so each subscription keeps its own resume cursor on the shared connection. A refused or failed subscription gets `{op: error, id, code, message}`, and a slow consumer gets `{op: disconnect, cursors}` carrying the cursor of every subscription before the socket closes with code 4008.

Required behavior, both transports: filter by network, protocol, collection, event type, and aggregate; deterministic replay from the acknowledged cursor; bounded buffers; slow-consumer disconnection with a resumable cursor; at-least-once delivery with event-id deduplication; seven-day minimum retention; no silent gaps.

Publication latency target: p95 under two seconds from the authoritative database commit. No event loss during worker restart: an at-least-once consumer that deduplicates by id observes exactly-once effect.

<!-- OX-P11: the earlier text kept only a hash of the signing secret yet signed
every delivery with the secret itself, which a hash cannot do. The delivery key
is now stored encrypted and recoverable for the delivery worker alone, and a
hash is never a signing key. -->

## Signed webhooks

A subscription registers an HTTPS endpoint and the event families it wants. The endpoint answers a challenge before activation.

### The delivery signing key

- Creation generates a random signing secret: `whsec_` followed by 32 random bytes in base64url (43 characters). The creation response returns it exactly once; rotation returns the new one exactly once. No later response, event, log line or error carries it.
- The gateway must sign every future delivery with that secret, so it keeps the secret recoverable but protected. It is stored only as authenticated ciphertext (AES-256-GCM or an equivalent AEAD) under a key encryption key held by an authorized secret provider, and only the delivery worker may use that key. The associated data binds each ciphertext to its subscription id and secret version (`ordex.webhook-secret/v2|<subscriptionId>|<version>`), so a ciphertext copied to another subscription or version does not open. Every decrypt is an audited operation, the key encryption key is least privilege, and neither the secret nor its ciphertext appears in logs.
- Ordinary reads show the secret version and a hint of the last four characters, never the secret, its ciphertext, or which key encryption key sealed it.
- Authentication material is a different thing: developer API keys, signing capabilities and endpoint challenges are stored as hashes and verified against them. A hash is never a delivery signing key, and a signature made with a stored hash verifies for no receiver.
- Rotation creates the next version and retires the current one with a bounded verification overlap, ten minutes by default and never more than twenty four hours. Key encryption keys rotate separately: the previous key stays able to open older ciphertexts until the worker has rewrapped them, and no key is destroyed while a delivery or an overlap still depends on it.

### The signature

Each delivery POSTs one envelope with the header `X-Ordex-Signature: t=<unix>,d=<deliveryId>,v1=<hex>`, where `v1` is HMAC-SHA256 over `<timestamp>.<deliveryId>.<sha256(body)>` under the subscription secret. While a rotation overlap lasts, the header carries one `v1` per unexpired secret, newest first (at most four), so a receiver holding either the new or the retired secret verifies. A receiver accepts a delivery when any `v1` matches any secret it holds, compares in constant time, and enforces a timestamp tolerance of five minutes by default. `verifier/events.js` and the SDK expose the same signer and verifier: `signWebhookDelivery` takes `secret`, or `secrets` during an overlap, and `verifyWebhookSignature` takes the receiver's `secret`, or `secrets` while it holds both sides of a rotation. Both are pure utilities over a key the caller holds.

### Delivery

Delivery is at least once with exponential backoff, bounded retries, dead-letter state, per-attempt history, manual replay, idempotency ids, endpoint health, and secret rotation with the overlap above. A delivery keeps its id and its exact body bytes for every attempt and every replay; each attempt is signed again over those bytes with a fresh timestamp and the secrets current at that moment, so the signed payload never changes meaning, and receivers deduplicate by delivery id. The delivery worker is isolated from internal infrastructure and protected against SSRF, DNS rebinding, private-address destinations, unbounded redirects, oversized responses, and endpoint-induced resource exhaustion.

## Historical APIs

Event history, current orders, order history, public swaps, manifests, Counterparty assets, activity, checkpoints, reorg events, asset-state proofs, market snapshots, and bounded NDJSON or compressed CSV exports are keyset paginated. Every response names its network, checkpoint, freshness, authority, and proof digest. No unqualified number is ever returned where current authoritative state could be assumed.
