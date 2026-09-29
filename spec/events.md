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

- Server-sent events at `GET /api/ordex/events/stream`, for resilient browser and server consumption, with `Last-Event-ID` resumption and heartbeats.
- WebSocket at the streaming gateway, for multiplexed, high-volume consumers: one connection, many filters, cursor resumption.

Required behavior, both transports: filter by network, protocol, collection, event type, and aggregate; deterministic replay from the acknowledged cursor; bounded buffers; slow-consumer disconnection with a resumable cursor; at-least-once delivery with event-id deduplication; seven-day minimum retention; no silent gaps.

Publication latency target: p95 under two seconds from the authoritative database commit. No event loss during worker restart: an at-least-once consumer that deduplicates by id observes exactly-once effect.

<!--
IMPLEMENTATION-HANDOFF [OX-P11] Preparation only; functional status FAIL, repair NOT IMPLEMENTED.
Coverage: OX-P-C038, OX-P-C039. Evidence: spec/events.md Signed webhooks: hash-only storage
conflicts with later encrypted-secret requirement in handoff/evidence.
Verified cause: Spec requires hash-only stored secret then delivery HMAC under original secret and
encrypted-at-rest secrets. Hash-only storage cannot reproduce prescribed HMAC; no executable
key-management contract is chosen.
Required behavior: Resolve webhook signing-key storage contradiction. Governing refs: P-S20 (RFC2104
February1997); P-S21 (Ordex1.2 ordex-event/v1); complete URLs in reports/protocol.md.
Prerequisites/order: none; establish strict contracts first. Related files: verifier/events.js,
sdk/src/events.ts; Core backend/src/ordex-v12/ordex-v12.module.ts and corresponding
registry/heritage/webhook service.
1. Resolve contract to generate a random subscription HMAC key, return it once, persist
envelope-encrypted recoverable key accessible only to delivery worker, and expose only key id/hint
via ordinary reads.
2. Keep authentication verifier hashes separate from delivery signing keys. Store keyVersion and
encryption metadata; use KMS/authorized secret provider, least privilege, audited decrypt, redacted
logs, and bounded current/previous rotation overlap.
3. Sign exact outgoing body bytes with original key per signWebhookDelivery; retain delivery id/body
digest/attempt history and implement retry/replay without changing signed payload semantics.
4. Update spec/events.md and owning Core subscription/delivery worker together; SDK signer remains
pure caller-provided-key utility and must never imply database hash is usable HMAC secret.
Validation (PROPOSED NEW tests, commands unverified until implemented):
tests/integration/webhook-key-lifecycle.test.js. node --test verifier/events.test.js; node --test
tests/integration/webhook-key-lifecycle.test.js.
Assertions/evidence: Restarted worker decrypts and signs exact body; receiver verifies after
creation and rotation; Ordinary reads/logs reveal no secret/ciphertext capability; unauthorized
worker cannot decrypt; Hash substituted as HMAC key fails; historical attempts/replays maintain
idempotency; Actual isolated HTTPS webhook delivery/retry/deadletter/replay works. Offline probes
are not end-to-end PASS; require actual Signet transaction and indexed/consumer readback where
applicable.
Rollback: Preserve encryption keys until dependent deliveries/rotation windows complete; never drop
old encrypted key before accepted migration. Roll back worker/schema compatibly and leave delivery
states resumable.
-->

## Signed webhooks

A subscription registers an HTTPS endpoint and the event families it wants. Creation returns the signing secret exactly once; storage keeps only a hash, and later reads show a hint. The endpoint answers a challenge before activation.

Each delivery POSTs one envelope with the header `X-Ordex-Signature: t=<unix>,d=<deliveryId>,v1=<hex>`, where `v1` is HMAC-SHA256 over `<timestamp>.<deliveryId>.<sha256(body)>` under the subscription secret. Verification is constant time and enforces a timestamp tolerance of five minutes by default. `verifier/events.js` and the SDK expose the same signer and verifier.

Delivery is at least once with exponential backoff, bounded retries, dead-letter state, per-attempt history, manual replay, idempotency ids, endpoint health, and secret rotation with a bounded verification overlap. The delivery worker is isolated from internal infrastructure and protected against SSRF, DNS rebinding, private-address destinations, unbounded redirects, oversized responses, and endpoint-induced resource exhaustion. Secrets are encrypted at rest.

## Historical APIs

Event history, current orders, order history, public swaps, manifests, Counterparty assets, activity, checkpoints, reorg events, asset-state proofs, market snapshots, and bounded NDJSON or compressed CSV exports are keyset paginated. Every response names its network, checkpoint, freshness, authority, and proof digest. No unqualified number is ever returned where current authoritative state could be assumed.
