/**
 * The realtime event contract and signed webhook rules from
 * spec/events.md, typed.
 *
 * This is the same verifier as verifier/events.js at the repository root,
 * ported to TypeScript for SDK consumers. Both implementations are run
 * against conformance/event-vectors.json, so they cannot drift apart
 * without a test failing.
 *
 * Timestamps are unix seconds, digests are lowercase hex, and comparisons
 * that answer a security question are constant time.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/;
const NETWORKS = ['mainnet', 'testnet', 'signet', 'regtest'];
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_TYPE = /^ordex\.[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const ORDEX_EVENT_SCHEMA = 'ordex-event/v1';
export const WEBHOOK_SUBSCRIPTION_SCHEMA = 'ordex.webhook-subscription/v1';
export const WEBHOOK_DELIVERY_SCHEMA = 'ordex.webhook-delivery/v1';

export interface OrdexEvent {
  id?: unknown;
  type?: unknown;
  schemaVersion?: unknown;
  network?: unknown;
  sequence?: unknown;
  aggregate?: { type?: unknown; id?: unknown; version?: unknown };
  observedAt?: unknown;
  checkpoint?: { height?: unknown; blockHash?: unknown };
  status?: unknown;
  revertedEventId?: unknown;
  payload?: unknown;
  artifactDigests?: unknown;
  traceId?: unknown;
  [key: string]: unknown;
}

export type OrdexEventRefusalCode =
  | 'MALFORMED_EVENT'
  | 'SCHEMA_UNSUPPORTED'
  | 'EVENT_ID_INVALID'
  | 'EVENT_TYPE_INVALID'
  | 'NETWORK_UNKNOWN'
  | 'SEQUENCE_INVALID'
  | 'AGGREGATE_INVALID'
  | 'OBSERVED_AT_INVALID'
  | 'CHECKPOINT_INVALID'
  | 'STATUS_INVALID'
  | 'REVERTED_EVENT_REQUIRED'
  | 'PAYLOAD_INVALID'
  | 'ARTIFACT_DIGEST_INVALID'
  | 'TRACE_ID_INVALID';

export type OrdexEventVerdict =
  | { ok: true }
  | { ok: false; code: OrdexEventRefusalCode; reason: string };

const refuse = (code: OrdexEventRefusalCode, reason: string): OrdexEventVerdict => ({
  ok: false,
  code,
  reason,
});

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
export function validateOrdexEvent(event: unknown): OrdexEventVerdict {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return refuse('MALFORMED_EVENT', 'Expected an event object.');
  }
  const e = event as OrdexEvent;
  if (e.schemaVersion !== '1') {
    return refuse('SCHEMA_UNSUPPORTED', 'The event schema version is not 1.');
  }
  if (typeof e.id !== 'string' || !EVENT_ID.test(e.id)) {
    return refuse('EVENT_ID_INVALID', 'The event id must be a lowercase uuid.');
  }
  if (typeof e.type !== 'string' || !EVENT_TYPE.test(e.type)) {
    return refuse('EVENT_TYPE_INVALID', 'The event type must look like ordex.<family>.<name>.');
  }
  if (typeof e.network !== 'string' || !NETWORKS.includes(e.network)) {
    return refuse('NETWORK_UNKNOWN', 'The network is not one this protocol names.');
  }
  if (!Number.isInteger(e.sequence) || (e.sequence as number) < 1) {
    return refuse('SEQUENCE_INVALID', 'The sequence must be a positive integer that never decreases.');
  }
  const aggregate = e.aggregate;
  if (
    !aggregate ||
    typeof aggregate.type !== 'string' ||
    aggregate.type.length === 0 ||
    typeof aggregate.id !== 'string' ||
    aggregate.id.length === 0 ||
    !Number.isInteger(aggregate.version) ||
    (aggregate.version as number) < 1
  ) {
    return refuse('AGGREGATE_INVALID', 'The event must name an aggregate type, id, and version.');
  }
  if (typeof e.observedAt !== 'string' || !ISO_TIME.test(e.observedAt)) {
    return refuse('OBSERVED_AT_INVALID', 'observedAt must be an ISO-8601 timestamp ending in Z.');
  }
  if (
    !e.checkpoint ||
    !Number.isInteger(e.checkpoint.height) ||
    (e.checkpoint.height as number) < 0 ||
    typeof e.checkpoint.blockHash !== 'string' ||
    !HEX64.test(e.checkpoint.blockHash)
  ) {
    return refuse('CHECKPOINT_INVALID', 'The event must carry the chain checkpoint it was observed at.');
  }
  if (e.status !== 'canonical' && e.status !== 'reverted') {
    return refuse('STATUS_INVALID', 'The status must be canonical or reverted.');
  }
  if (e.status === 'reverted') {
    if (typeof e.revertedEventId !== 'string' || !EVENT_ID.test(e.revertedEventId)) {
      return refuse('REVERTED_EVENT_REQUIRED', 'A reverted event must name the event id it reverses.');
    }
    if (e.revertedEventId === e.id) {
      return refuse('REVERTED_EVENT_REQUIRED', 'An event cannot reverse itself.');
    }
  } else if (e.revertedEventId !== undefined) {
    return refuse('STATUS_INVALID', 'Only a reverted event may name a revertedEventId.');
  }
  if (!e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) {
    return refuse('PAYLOAD_INVALID', 'The payload must be an object.');
  }
  if (e.artifactDigests !== undefined) {
    if (
      !Array.isArray(e.artifactDigests) ||
      !e.artifactDigests.every((digest) => typeof digest === 'string' && HEX64.test(digest))
    ) {
      return refuse('ARTIFACT_DIGEST_INVALID', 'Every artifact digest must be 64 lowercase hex characters.');
    }
  }
  if (typeof e.traceId !== 'string' || e.traceId.length === 0 || e.traceId.length > 128) {
    return refuse('TRACE_ID_INVALID', 'The event must carry a trace id of at most 128 characters.');
  }
  return { ok: true };
}

/** The fields eventSortKey reads from an envelope. */
export interface OrdexEventSortFields {
  network: string;
  sequence: number;
  id: string;
}

/**
 * The deterministic replay order: by network sequence, then by id so two
 * events can never tie. Consumers resume from this key, never from an
 * offset.
 */
export function eventSortKey(event: OrdexEventSortFields): string {
  return `${event.network}:${String(event.sequence).padStart(20, '0')}:${event.id}`;
}

export interface WebhookSigningInput {
  secret: string;
  timestamp: number;
  deliveryId: string;
  body: string;
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
export function signWebhookDelivery({ secret, timestamp, deliveryId, body }: WebhookSigningInput): string {
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

export interface WebhookVerificationInput {
  header?: unknown;
  secret?: unknown;
  body?: unknown;
  nowSeconds?: unknown;
  toleranceSeconds?: unknown;
}

export type WebhookRefusalCode =
  | 'HEADER_MISSING'
  | 'SECRET_INVALID'
  | 'BODY_INVALID'
  | 'HEADER_MALFORMED'
  | 'TIMESTAMP_OUT_OF_TOLERANCE'
  | 'SIGNATURE_INVALID';

export type WebhookVerdict =
  | { ok: true }
  | { ok: false; code: WebhookRefusalCode; reason: string };

const refuseWebhook = (code: WebhookRefusalCode, reason: string): WebhookVerdict => ({
  ok: false,
  code,
  reason,
});

const equalConstantTime = (a: string, b: string): boolean => {
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
export function verifyWebhookSignature({
  header,
  secret,
  body,
  nowSeconds,
  toleranceSeconds = 300,
}: WebhookVerificationInput): WebhookVerdict {
  if (typeof header !== 'string' || header.length === 0) {
    return refuseWebhook('HEADER_MISSING', 'Expected an X-Ordex-Signature header value.');
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    return refuseWebhook('SECRET_INVALID', 'The subscription secret must be a nonempty string.');
  }
  if (typeof body !== 'string') {
    return refuseWebhook('BODY_INVALID', 'The body must be the exact string that was received.');
  }
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) return refuseWebhook('HEADER_MALFORMED', 'The header must look like t=<unix>,d=<id>,v1=<hex>.');
    parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }
  const timestamp = Number(parts.get('t'));
  const deliveryId = parts.get('d');
  const signature = parts.get('v1');
  if (
    !Number.isInteger(timestamp) ||
    !deliveryId ||
    typeof signature !== 'string' ||
    !/^[0-9a-f]{64}$/.test(signature)
  ) {
    return refuseWebhook('HEADER_MALFORMED', 'The header must carry t, d, and a 64 hex v1 signature.');
  }
  const now = Number.isInteger(nowSeconds) ? (nowSeconds as number) : Math.floor(Date.now() / 1000);
  const skew = typeof toleranceSeconds === 'number' && toleranceSeconds >= 0 ? toleranceSeconds : 300;
  if (Math.abs(now - timestamp) > skew) {
    return refuseWebhook('TIMESTAMP_OUT_OF_TOLERANCE', 'The delivery timestamp is outside the allowed clock skew.');
  }
  const bodyDigest = createHash('sha256').update(body, 'utf8').digest('hex');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${bodyDigest}`, 'utf8').digest('hex');
  if (!equalConstantTime(expected, signature)) {
    return refuseWebhook('SIGNATURE_INVALID', 'The signature does not match this secret, delivery id, and body.');
  }
  return { ok: true };
}
