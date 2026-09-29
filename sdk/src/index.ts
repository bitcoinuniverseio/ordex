/**
 * Typed client for the Ordex gateway API.
 *
 * Every method mirrors one route in ../spec/openapi.json, and every type
 * comes from schema.ts, which is generated from that contract. Amounts are
 * atomic integers carried as decimal strings, exactly as the wire carries
 * them; nothing here converts them through JavaScript numbers.
 */

import type { components, operations } from './schema.js';

export type { components, operations, paths } from './schema.js';
export {
  parseSats,
  verifyPublicAskCompletion,
  type PurchaseOrderTerms,
  type PurchaseRefusalCode,
  type PurchaseTransaction,
  type PurchaseVerdict,
} from './purchase.js';
export {
  decipherRunestone,
  parseScriptHex,
  verifyRuneBurnSafety,
  type RuneEdict,
  type RuneId,
  type RuneInputObservation,
  type RuneRefusalCode,
  type RuneSafetyVerdict,
  type Runestone,
  type RunestoneFlaw,
} from './runes.js';
export {
  OFFER_TERMS_SCHEMA,
  offerTermsHash,
  sortedJson,
  verifyOfferAcceptance,
  verifyOfferRecovery,
  verifyOfferTerms,
  type OfferAcceptanceContext,
  type OfferAcceptanceRefusalCode,
  type OfferAcceptanceTransaction,
  type OfferAcceptanceVerdict,
  type OfferKind,
  type OfferRecoveryRefusalCode,
  type OfferRecoveryTransaction,
  type OfferRecoveryVerdict,
  type OfferTerms,
  type OfferTermsRefusalCode,
  type OfferTermsVerdict,
} from './offers.js';
export {
  SAFEOPS_PLAN_SCHEMA,
  SAFEOPS_PROTOCOL_MIN,
  SAFEOPS_SIGNED_RESULT_SCHEMA,
  safeopsPlanDigest,
  verifySafeOpsPlan,
  verifySafeOpsSignedResult,
  type SafeOpsAssetTransition,
  type SafeOpsCheckpoint,
  type SafeOpsFee,
  type SafeOpsInput,
  type SafeOpsInventory,
  type SafeOpsOutput,
  type SafeOpsOutpoint,
  type SafeOpsPlan,
  type SafeOpsPlanRefusalCode,
  type SafeOpsPlanVerdict,
  type SafeOpsSignedResult,
  type SafeOpsSignedResultRefusalCode,
  type SafeOpsSignedResultVerdict,
  type SafeOpsSigning,
} from './safeops.js';
export {
  SWAP_ACCEPTANCE_SCHEMA,
  SWAP_INTENT_SCHEMA,
  swapIntentDigest,
  verifySwapAcceptance,
  verifySwapIntent,
  type SwapAcceptance,
  type SwapAcceptanceInput,
  type SwapAcceptanceOutput,
  type SwapAcceptanceRefusalCode,
  type SwapAcceptanceVerdict,
  type SwapGive,
  type SwapIntent,
  type SwapIntentRefusalCode,
  type SwapIntentVerdict,
  type SwapOutpoint,
  type SwapRequirement,
} from './swaps.js';
export {
  ORDEX_EVENT_SCHEMA,
  WEBHOOK_DELIVERY_SCHEMA,
  WEBHOOK_SUBSCRIPTION_SCHEMA,
  eventSortKey,
  signWebhookDelivery,
  validateOrdexEvent,
  verifyWebhookSignature,
  type OrdexEvent,
  type OrdexEventRefusalCode,
  type OrdexEventSortFields,
  type OrdexEventVerdict,
  type WebhookRefusalCode,
  type WebhookSigningInput,
  type WebhookVerdict,
  type WebhookVerificationInput,
} from './events.js';
export {
  COLLECTION_MANIFEST_REVOCATION_SCHEMA,
  COLLECTION_MANIFEST_SCHEMA,
  buildMembershipProof,
  collectionManifestDigest,
  collectionRevocationDigest,
  memberLeafHash,
  membershipRoot,
  verifyCollectionManifest,
  verifyManifestRevocation,
  verifyMembershipProof,
  type CollectionManifest,
  type CollectionManifestRefusalCode,
  type CollectionManifestRevocation,
  type CollectionManifestVerdict,
  type CollectionRevocationRefusalCode,
  type CollectionRevocationVerdict,
  type MembershipProofStep,
  type MembershipRefusalCode,
  type MembershipVerdict,
} from './collection-manifest.js';
export {
  COUNTERPARTY_UTXO_ASSET_SCHEMA,
  counterpartyRecordDigest,
  verifyAttachmentFollows,
  verifyCounterpartyUtxoAsset,
  type CounterpartyRefusalCode,
  type CounterpartyRecordVerdict,
  type CounterpartySpendTransaction,
  type CounterpartyUtxoAssetRecord,
} from './counterparty.js';
export {
  EXPECTED_TRANSACTION_MANIFEST_SCHEMA,
  OFFLINE_SIGNING_SESSION_SCHEMA,
  compareSignedResultToManifest,
  expectedTransactionDigest,
  verifyExpectedTransactionManifest,
  type ExpectedAsset,
  type ExpectedTransactionInput,
  type ExpectedTransactionManifest,
  type ExpectedTransactionManifestVerdict,
  type ExpectedTransactionOutput,
  type OfflineSigningRefusalCode,
  type OfflineSigningResult,
} from './offline-signing.js';

type Schemas = components['schemas'];

export type HealthReport = Schemas['HealthReport'];
export type ProtocolContract = Schemas['ProtocolContract'];
export type ProtocolTemplate = Schemas['ProtocolTemplate'];
export type OrderSummary = Schemas['OrderSummary'];
export type OrderPage = Schemas['OrderPage'];
export type OrderArtifact = Schemas['OrderArtifact'];
export type ActivityEntry = Schemas['ActivityEntry'];
export type ActivityPage = Schemas['ActivityPage'];
export type ImportRequest = Schemas['ImportRequest'];
export type NostrEvent = Schemas['NostrEvent'];
export type NostrEnvelope = Schemas['NostrEnvelope'];
export type BuildAskRequest = Schemas['BuildAskRequest'];
export type BuildAskResult = Schemas['BuildAskResult'];
export type PublishAskRequest = Schemas['PublishAskRequest'];
export type OwnershipChallenge = Schemas['OwnershipChallenge'];
export type OwnershipProof = Schemas['OwnershipProof'];
export type QuoteRequest = Schemas['QuoteRequest'];
export type Quote = Schemas['Quote'];
export type PreflightRequest = Schemas['PreflightRequest'];
export type PreflightResult = Schemas['PreflightResult'];
export type ErrorResponse = Schemas['ErrorResponse'];

export type ListOrdersQuery = NonNullable<operations['listOrders']['parameters']['query']>;
export type ListActivityQuery = NonNullable<operations['listActivity']['parameters']['query']>;

/** A failed gateway response, carrying the envelope the gateway answered with. */
export class OrdexApiError extends Error {
  readonly status: number;
  readonly envelope: ErrorResponse | null;

  constructor(status: number, envelope: ErrorResponse | null, fallback: string) {
    const message =
      envelope === null
        ? fallback
        : Array.isArray(envelope.message)
          ? envelope.message.join('; ')
          : envelope.message;
    super(message || fallback);
    this.name = 'OrdexApiError';
    this.status = status;
    this.envelope = envelope;
  }
}

export interface OrdexClientOptions {
  /** The gateway origin, for example https://bitcoinuniverse.io */
  baseUrl: string;
  /** Bring your own fetch. Defaults to the global one. */
  fetch?: typeof fetch;
  /** Per request deadline. The request aborts when it passes. */
  timeoutMs?: number;
  /**
   * How many times a failed read is retried. Only reads: a write is never
   * retried by the client, because the gateway does not deduplicate writes.
   */
  retries?: number;
  /** Base backoff between read retries. Doubles per attempt, with jitter. */
  retryDelayMs?: number;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
}

interface RequestOptions {
  signal?: AbortSignal;
}

interface InternalRequest {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal | undefined;
}

const RETRIABLE_STATUS = new Set([502, 503, 504]);

function toBase64(text: string): string {
  if (typeof btoa === 'function') return btoa(text);
  return Buffer.from(text, 'utf8').toString('base64');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * IMPLEMENTATION-HANDOFF [OX-P06] Preparation only; functional status FAIL, repair NOT IMPLEMENTED.
 * Coverage: OX-P-C058, OX-P-C059, OX-P-C060. Evidence: evidence/sdk-operation-coverage.json,
 * evidence/sdk-worker-observations.json in handoff/evidence.
 * Verified cause: SDK ships 18 HTTP methods against79 contract operations; additional1.1/1.2 typed
 * wrappers are unimplemented integration scope, not inverse proof of README wording. Retry loop
 * recognizes only Error.name AbortError, retries a caller custom abort reason and sleeps through
 * cancellation.
 * Required behavior: Complete deliberate SDK API integration and abort-safe bounded reads. Governing
 * refs: P-S09 (Ordex prepared base bde7d3d; OpenAPI3.1 79operations); P-S10 (Node v24 runtime;
 * installed24.19.0); complete URLs in reports/protocol.md.
 * Prerequisites/order: none; establish strict contracts first. Related files: spec/openapi.json and
 * sdk/test/client.test.js; Core/backend or site consumer named by the work package.
 * 1. Use bundled exact method/path inventory to reconcile each OpenAPI operation with intended SDK
 * responsibility; implement typed missing1.1/1.2 read/plan/explicit-user-action operations after
 * backend exists. Preserve no autonomous sign/fund/broadcast promise and document any explicit relay
 * method honestly.
 * 2. Extend InternalRequest method union for required DELETE/PATCH verbs and response decoding by
 * OpenAPI media/status (JSON,204,streams/exports); forward all path/query/body/request headers with
 * exact generated types.
 * 3. Check request.signal.aborted before every attempt, after fetch errors and during retry waits;
 * abort without retry for any reason value. Use bounded cancellable backoff and total deadline;
 * validate retries/timeout/delay config finite nonnegative safe bounds.
 * 4. Define iterator progress protections (cursor repeat/invalid envelope) and keep writes single
 * attempt unless backend provides verified idempotency semantics. Add operation-table parity and real
 * integration tests; generated schema edits belong to spec generator.
 * Validation (PROPOSED NEW tests, commands unverified until implemented):
 * sdk/test/client-abort.test.js, sdk/test/operation-coverage.test.js. npm --prefix sdk run check; npm
 * --prefix sdk test; node --test sdk/test/client-abort.test.js sdk/test/operation-coverage.test.js.
 * Assertions/evidence: Custom Error abort invokes no later retry; abort during backoff settles
 * promptly without second request; Every included operation has exact method/path/query/media/status
 * tests; intentional SDK exclusions documented against consumer path; No write retries or automatic
 * signing/broadcast; Actual supported client/API journeys verified through Signet gate where
 * transaction effects apply. Offline probes are not end-to-end PASS; require actual Signet transaction
 * and indexed/consumer readback where applicable.
 * Rollback: Public SDK additions require semver and generated-schema compatibility review; retain
 * existing1.0 methods and wire amounts. Roll back package version without altering stored artifacts.
 */
export class OrdexClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #retryDelayMs: number;
  readonly #headers: Record<string, string>;

  constructor(options: OrdexClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#retries = options.retries ?? 0;
    this.#retryDelayMs = options.retryDelayMs ?? 250;
    this.#headers = options.headers ?? {};
  }

  async #once<T>(request: InternalRequest): Promise<T> {
    const url = new URL(`${this.#baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const signals = [AbortSignal.timeout(this.#timeoutMs)];
    if (request.signal) signals.push(request.signal);
    const response = await this.#fetch(url.toString(), {
      method: request.method,
      headers: {
        accept: 'application/json',
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...this.#headers,
        ...request.headers,
      },
      body: request.body === undefined ? null : JSON.stringify(request.body),
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) {
      const envelope = (await response.json().catch(() => null)) as ErrorResponse | null;
      throw new OrdexApiError(response.status, envelope, `Request failed with ${response.status}.`);
    }
    return (await response.json()) as T;
  }

/*
 * IMPLEMENTATION-HANDOFF [OX-P06] Local integration steps; ANNOTATED is not implemented.
 * Coverage: OX-P-C058, OX-P-C059, OX-P-C060.
 * Synthetic custom-reason abort retries4 times; abort during backoff performs another fetch. 1. Check
 * request.signal.aborted before first/each attempt and after rejection, preserving signal.reason
 * regardless of its type. 2. Make backoff signal-aware and bound total retries/delay/deadline;
 * distinguish timeout from explicit abort. 3. Add PROPOSED NEW sdk/test/client-abort.test.js and run
 * node --test sdk/test/client-abort.test.js (unverified); assert no post-abort request and writes
 * remain single-attempt. Evidence evidence/sdk-worker-observations.json; source P-S10 Node24
 * AbortController. Related #once, sleep, SDK iterator consumers. No API wire migration; rollback only
 * SDK release version.
 */
  async #request<T>(request: InternalRequest): Promise<T> {
    const attempts = request.method === 'GET' ? this.#retries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        const backoff = this.#retryDelayMs * 2 ** (attempt - 1);
        await sleep(backoff + Math.floor(Math.random() * this.#retryDelayMs));
      }
      try {
        return await this.#once<T>(request);
      } catch (error) {
        lastError = error;
        const retriable =
          !(error instanceof OrdexApiError) || RETRIABLE_STATUS.has(error.status);
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (!retriable || aborted) throw error;
      }
    }
    throw lastError;
  }

  getHealth(options: RequestOptions = {}): Promise<HealthReport> {
    return this.#request({ method: 'GET', path: '/api/ordex/health', signal: options.signal });
  }

  getProtocol(options: RequestOptions = {}): Promise<ProtocolContract> {
    return this.#request({ method: 'GET', path: '/api/ordex/protocol', signal: options.signal });
  }

  getCatalog(options: RequestOptions = {}): Promise<ProtocolTemplate[]> {
    return this.#request({ method: 'GET', path: '/api/ordex/catalog', signal: options.signal });
  }

  listOrders(query: ListOrdersQuery = {}, options: RequestOptions = {}): Promise<OrderPage> {
    return this.#request({
      method: 'GET',
      path: '/api/ordex/orders',
      query: query as Record<string, string | undefined>,
      signal: options.signal,
    });
  }

  listActivity(query: ListActivityQuery = {}, options: RequestOptions = {}): Promise<ActivityPage> {
    return this.#request({
      method: 'GET',
      path: '/api/ordex/activity',
      query: query as Record<string, string | undefined>,
      signal: options.signal,
    });
  }

  getOrder(id: string, options: RequestOptions = {}): Promise<OrderSummary> {
    return this.#request({
      method: 'GET',
      path: `/api/ordex/orders/${encodeURIComponent(id)}`,
      signal: options.signal,
    });
  }

  getOrderArtifact(id: string, options: RequestOptions = {}): Promise<OrderArtifact> {
    return this.#request({
      method: 'GET',
      path: `/api/ordex/orders/${encodeURIComponent(id)}/artifact`,
      signal: options.signal,
    });
  }

  importOrder(body: ImportRequest, options: RequestOptions = {}): Promise<OrderSummary> {
    return this.#request({
      method: 'POST',
      path: '/api/ordex/orders/import',
      body,
      signal: options.signal,
    });
  }

  importOpenOrdexEvent(body: NostrEvent, options: RequestOptions = {}): Promise<OrderSummary> {
    return this.#request({
      method: 'POST',
      path: '/api/ordex/orders/openordex-event',
      body,
      signal: options.signal,
    });
  }

  buildAsk(body: BuildAskRequest, options: RequestOptions = {}): Promise<BuildAskResult> {
    return this.#request({
      method: 'POST',
      path: '/api/ordex/orders/build',
      body,
      signal: options.signal,
    });
  }

  publishAsk(body: PublishAskRequest, options: RequestOptions = {}): Promise<OrderSummary> {
    return this.#request({
      method: 'POST',
      path: '/api/ordex/orders/publish',
      body,
      signal: options.signal,
    });
  }

  getOwnershipChallenge(id: string, options: RequestOptions = {}): Promise<OwnershipChallenge> {
    return this.#request({
      method: 'GET',
      path: `/api/ordex/orders/${encodeURIComponent(id)}/ownership-challenge`,
      signal: options.signal,
    });
  }

  withdrawOrder(id: string, proof: OwnershipProof, options: RequestOptions = {}): Promise<OrderSummary> {
    return this.#request({
      method: 'POST',
      path: `/api/ordex/orders/${encodeURIComponent(id)}/withdraw`,
      body: proof,
      signal: options.signal,
    });
  }

  adminWithdrawOrder(
    id: string,
    body: { reason?: string },
    credentials: { username: string; password: string },
    options: RequestOptions = {},
  ): Promise<OrderSummary> {
    return this.#request({
      method: 'POST',
      path: `/api/ordex/admin/orders/${encodeURIComponent(id)}/withdraw`,
      body,
      headers: {
        authorization: `Basic ${toBase64(`${credentials.username}:${credentials.password}`)}`,
      },
      signal: options.signal,
    });
  }

  getNostrEnvelope(id: string, options: RequestOptions = {}): Promise<NostrEnvelope> {
    return this.#request({
      method: 'GET',
      path: `/api/ordex/orders/${encodeURIComponent(id)}/nostr-envelope`,
      signal: options.signal,
    });
  }

  revalidateOrder(id: string, options: RequestOptions = {}): Promise<OrderSummary> {
    return this.#request({
      method: 'POST',
      path: `/api/ordex/orders/${encodeURIComponent(id)}/revalidate`,
      signal: options.signal,
    });
  }

  quoteOrder(id: string, body: QuoteRequest, options: RequestOptions = {}): Promise<Quote> {
    return this.#request({
      method: 'POST',
      path: `/api/ordex/orders/${encodeURIComponent(id)}/quote`,
      body,
      signal: options.signal,
    });
  }

  preflightOrder(
    id: string,
    body: PreflightRequest,
    options: RequestOptions = {},
  ): Promise<PreflightResult> {
    return this.#request({
      method: 'POST',
      path: `/api/ordex/orders/${encodeURIComponent(id)}/preflight`,
      body,
      signal: options.signal,
    });
  }

  /**
   * Every order matching the query, page by page, following the keyset
   * cursor until the gateway answers an empty one.
   */
  async *iterateOrders(
    query: ListOrdersQuery = {},
    options: RequestOptions = {},
  ): AsyncGenerator<OrderSummary> {
    let cursor = query.cursor;
    for (;;) {
      const page = await this.listOrders({ ...query, ...(cursor === undefined ? {} : { cursor }) }, options);
      yield* page.orders;
      if (!page.hasMore || page.nextCursor === '') return;
      cursor = page.nextCursor;
    }
  }

  /** Every activity entry matching the query, following the keyset cursor. */
  async *iterateActivity(
    query: ListActivityQuery = {},
    options: RequestOptions = {},
  ): AsyncGenerator<ActivityEntry> {
    let cursor = query.cursor;
    for (;;) {
      const page = await this.listActivity(
        { ...query, ...(cursor === undefined ? {} : { cursor }) },
        options,
      );
      yield* page.entries;
      if (!page.hasMore || page.nextCursor === '') return;
      cursor = page.nextCursor;
    }
  }
}
