// Reference verifier for the Ordex realtime event contract and signed
// webhook deliveries.
//
// This file restates spec/events.md as executable checks. validateOrdexEvent
// decides whether an event envelope may be published or replayed.
// verifyWebhookSignature decides whether a delivery really came from a
// subscription holder, within its allowed clock skew. Producing the events
// themselves from the transactional outbox, and delivering the webhooks, is
// the platform's job; nothing here reads or writes chain state.
//
// Timestamps are unix seconds, digests are lowercase hex, and comparisons
// that answer a security question are constant time.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_TYPE = /^ordex\.[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export const ORDEX_EVENT_SCHEMA = 'ordex-event/v1';
export const WEBHOOK_SUBSCRIPTION_SCHEMA = 'ordex.webhook-subscription/v1';
export const WEBHOOK_DELIVERY_SCHEMA = 'ordex.webhook-delivery/v1';

const refuse = (code, reason) => ({ ok: false, code, reason });

/** Serialize any JSON value with object keys sorted recursively. */
export function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Verify an ordex-event/v1 envelope.
 *
 * event:
 *   id (uuid), type (ordex.<family>.<name>), schemaVersion ('1'), network,
 *   sequence (monotonic per network), aggregate { type, id, version },
 *   observedAt (ISO-8601 Z), checkpoint { height, blockHash },
 *   status ('canonical'|'reverted'), revertedEventId? (required when
 *   reverted), payload (object), artifactDigests? (hex64 strings),
 *   traceId
 */
export function validateOrdexEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return refuse('MALFORMED_EVENT', 'Expected an event object.');
  }
  if (event.schemaVersion !== '1') {
    return refuse('SCHEMA_UNSUPPORTED', 'The event schema version is not 1.');
  }
  if (typeof event.id !== 'string' || !EVENT_ID.test(event.id)) {
    return refuse('EVENT_ID_INVALID', 'The event id must be a lowercase uuid.');
  }
  if (typeof event.type !== 'string' || !EVENT_TYPE.test(event.type)) {
    return refuse('EVENT_TYPE_INVALID', 'The event type must look like ordex.<family>.<name>.');
  }
  if (typeof event.network !== 'string' || !NETWORKS.includes(event.network)) {
    return refuse('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 1) {
    return refuse('SEQUENCE_INVALID', 'The sequence must be a positive integer that never decreases.');
  }
  const aggregate = event.aggregate;
  if (
    !aggregate ||
    typeof aggregate.type !== 'string' ||
    aggregate.type.length === 0 ||
    typeof aggregate.id !== 'string' ||
    aggregate.id.length === 0 ||
    !Number.isInteger(aggregate.version) ||
    aggregate.version < 1
  ) {
    return refuse('AGGREGATE_INVALID', 'The event must name an aggregate type, id, and version.');
  }
  if (typeof event.observedAt !== 'string' || !ISO_TIME.test(event.observedAt)) {
    return refuse('OBSERVED_AT_INVALID', 'observedAt must be an ISO-8601 timestamp ending in Z.');
  }
  if (
    !event.checkpoint ||
    !Number.isInteger(event.checkpoint.height) ||
    event.checkpoint.height < 0 ||
    typeof event.checkpoint.blockHash !== 'string' ||
    !HEX64.test(event.checkpoint.blockHash)
  ) {
    return refuse('CHECKPOINT_INVALID', 'The event must carry the chain checkpoint it was observed at.');
  }
  if (event.status !== 'canonical' && event.status !== 'reverted') {
    return refuse('STATUS_INVALID', 'The status must be canonical or reverted.');
  }
  if (event.status === 'reverted') {
    if (typeof event.revertedEventId !== 'string' || !EVENT_ID.test(event.revertedEventId)) {
      return refuse('REVERTED_EVENT_REQUIRED', 'A reverted event must name the event id it reverses.');
    }
    if (event.revertedEventId === event.id) {
      return refuse('REVERTED_EVENT_REQUIRED', 'An event cannot reverse itself.');
    }
  } else if (event.revertedEventId !== undefined) {
    return refuse('STATUS_INVALID', 'Only a reverted event may name a revertedEventId.');
  }
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return refuse('PAYLOAD_INVALID', 'The payload must be an object.');
  }
  if (event.artifactDigests !== undefined) {
    if (
      !Array.isArray(event.artifactDigests) ||
      !event.artifactDigests.every((digest) => typeof digest === 'string' && HEX64.test(digest))
    ) {
      return refuse('ARTIFACT_DIGEST_INVALID', 'Every artifact digest must be 64 lowercase hex characters.');
    }
  }
  if (typeof event.traceId !== 'string' || event.traceId.length === 0 || event.traceId.length > 128) {
    return refuse('TRACE_ID_INVALID', 'The event must carry a trace id of at most 128 characters.');
  }
  return { ok: true };
}

/**
 * The deterministic replay order: by network sequence, then by id so two
 * events can never tie. Consumers resume from this key, never from an
 * offset.
 */
export function eventSortKey(event) {
  return `${event.network}:${String(event.sequence).padStart(20, '0')}:${event.id}`;
}

/**
 * Sign a webhook delivery.
 *
 * The signed payload binds the unix timestamp, the delivery id, and the
 * SHA-256 digest of the exact body that will be sent:
 *   `${timestamp}.${deliveryId}.${sha256(body)}`
 * signed with HMAC-SHA256 under the subscription secret.
 *
 * Returns the exact value for the X-Ordex-Signature header.
 */
export function signWebhookDelivery({ secret, timestamp, deliveryId, body }) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('secret must be a nonempty string');
  }
  if (!Number.isInteger(timestamp)) {
    throw new TypeError('timestamp must be unix seconds as an integer');
  }
  if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
    throw new TypeError('deliveryId must be a nonempty string');
  }
  if (typeof body !== 'string') {
    throw new TypeError('body must be the exact string that will be sent');
  }
  const bodyDigest = createHash('sha256').update(body, 'utf8').digest('hex');
  const mac = createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${bodyDigest}`, 'utf8').digest('hex');
  return `t=${timestamp},d=${deliveryId},v1=${mac}`;
}

const equalConstantTime = (a, b) => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

/**
 * Verify a webhook delivery signature.
 *
 * Accepts the header value produced by signWebhookDelivery and the exact
 * body that was received. Returns { ok: true } or
 * { ok: false, code, reason }. The timestamp tolerance guards against
 * replay; the digest binds the body so a replayed signature over a changed
 * body fails.
 */
export function verifyWebhookSignature({ header, secret, body, nowSeconds, toleranceSeconds = 300 }) {
  if (typeof header !== 'string' || header.length === 0) {
    return refuse('HEADER_MISSING', 'Expected an X-Ordex-Signature header value.');
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    return refuse('SECRET_INVALID', 'The subscription secret must be a nonempty string.');
  }
  if (typeof body !== 'string') {
    return refuse('BODY_INVALID', 'The body must be the exact string that was received.');
  }
  const parts = new Map();
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) return refuse('HEADER_MALFORMED', 'The header must look like t=<unix>,d=<id>,v1=<hex>.');
    parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  const timestamp = Number(parts.get('t'));
  const deliveryId = parts.get('d');
  const signature = parts.get('v1');
  if (!Number.isInteger(timestamp) || !deliveryId || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) {
    return refuse('HEADER_MALFORMED', 'The header must carry t, d, and a 64 hex v1 signature.');
  }
  const now = Number.isInteger(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  const skew = typeof toleranceSeconds === 'number' && toleranceSeconds >= 0 ? toleranceSeconds : 300;
  if (Math.abs(now - timestamp) > skew) {
    return refuse('TIMESTAMP_OUT_OF_TOLERANCE', 'The delivery timestamp is outside the allowed clock skew.');
  }
  const bodyDigest = createHash('sha256').update(body, 'utf8').digest('hex');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${bodyDigest}`, 'utf8').digest('hex');
  if (!equalConstantTime(expected, signature)) {
    return refuse('SIGNATURE_INVALID', 'The signature does not match this secret, delivery id, and body.');
  }
  return { ok: true };
}
