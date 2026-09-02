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
