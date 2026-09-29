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
  decodePublicKey,
  liftX,
  parseDerSignature,
  publicKeyXFromScalar,
  taggedHash,
  taprootTweak,
  verifyEcdsa,
  verifySchnorr,
  type AffinePoint,
} from './secp256k1.js';
export {
  DUST_RELAY_FEE_SATS_PER_KVB,
  MAX_OP_RETURN_RELAY_BYTES,
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  SIGHASH_DEFAULT,
  SIGHASH_NONE,
  SIGHASH_SINGLE,
  bytesToHex,
  dustThresholdSats,
  extractPsbtTransaction,
  hexToBytes,
  legacySighash,
  parsePsbt,
  parseTransaction,
  scriptInstructions,
  scriptType,
  segwitV0Sighash,
  serializeTransaction,
  sighashName,
  tapBranchHash,
  tapLeafHash,
  taprootSighash,
  transactionId,
  unsignedCopy,
  verifyInputSignature,
  verifyPsbtPartialSignatures,
  verifyTaprootCommitment,
  witnessTransactionId,
  type InputSignatureVerdict,
  type ParsedPsbt,
  type ParsedTransaction,
  type Prevout,
  type Psbt,
  type PsbtInput,
  type PsbtKeyValue,
  type PsbtMap,
  type PsbtSignatureCheck,
  type ScriptInstruction,
  type ScriptType,
  type SignatureStatus,
  type TaprootCommitment,
  type Transaction,
  type TxInput,
  type TxOutput,
} from './bitcoin-tx.js';
export {
  allocateRunes,
  decipherRunestone,
  parseScriptHex,
  verifyRuneAllocation,
  verifyRuneBurnSafety,
  type RuneAllocation,
  type RuneAllocationRefusalCode,
  type RuneAllocationResult,
  type RuneAllocationVerdict,
  type RuneBalance,
  type RuneBurn,
  type RuneBurnCause,
  type RuneEdict,
  type RuneEtching,
  type RuneId,
  type RuneInputObservation,
  type RuneMintResult,
  type RuneRefusalCode,
  type RuneSafetyVerdict,
  type RuneTerms,
  type Runestone,
  type RunestoneFlaw,
} from './runes.js';
export {
  OFFER_ACCEPTANCE_SCHEMA,
  OFFER_EXPIRY_HEIGHT_MAX,
  OFFER_INTERNAL_KEY_HEX,
  OFFER_RECOVERY_SCHEMA,
  OFFER_TERMS_SCHEMA,
  buildTraitMemberProof,
  offerCriteriaHash,
  offerOutputTree,
  offerPolicySighash,
  offerTermsHash,
  sortedJson,
  verifyOfferAcceptance,
  verifyOfferRecovery,
  verifyOfferTerms,
  type FundedOffer,
  type OfferAcceptanceContext,
  type OfferAcceptanceInput,
  type OfferAcceptanceRefusalCode,
  type OfferAcceptanceTransaction,
  type OfferAcceptanceVerdict,
  type OfferKind,
  type OfferOutpoint,
  type OfferOutputTree,
  type OfferPolicySighashVerdict,
  type OfferProofStep,
  type OfferScope,
  type OfferTreeVerdict,
  type OfferRecoveryRefusalCode,
  type OfferRecoveryTransaction,
  type OfferRecoveryVerdict,
  type OfferTerms,
  type OfferTermsRefusalCode,
  type OfferTermsVerdict,
} from './offers.js';
export {
  SAFEOPS_PLAN_SCHEMA,
  SAFEOPS_POSTAGE_FLOOR_SATS,
  SAFEOPS_PROTOCOL_MIN,
  SAFEOPS_SIGNED_RESULT_SCHEMA,
  safeopsPlanDigest,
  safeopsUnsignedTransaction,
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
  type SafeOpsTransaction,
} from './safeops.js';
export {
  SWAP_ACCEPTANCE_SCHEMA,
  SWAP_INTENT_SCHEMA,
  SWAP_SIGNED_TRANSACTION_SCHEMA,
  swapAcceptanceDigest,
  swapIntentDigest,
  swapUnsignedTransaction,
  verifySwapAcceptance,
  verifySwapIntent,
  verifySwapSignedTransaction,
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
  type SwapSettlementRefusalCode,
  type SwapSettlementVerdict,
  type SwapSignedTransaction,
  type SwapTaker,
} from './swaps.js';
export {
  checkTransitionShapes,
  deriveAssetFlow,
  matchTransitions,
  readInventory,
  type AssetFlowRefusal,
  type AssetInventory,
  type AssetMovement,
  type FlowInput,
  type InventoryAsset,
  type StatedTransition,
} from './asset-flow.js';
export {
  ORDEX_EVENT_SCHEMA,
  WEBHOOK_DELIVERY_SCHEMA,
  WEBHOOK_MAX_SIGNING_SECRETS,
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
  membershipProofRoot,
  membershipRoot,
  verifyCollectionManifest,
  verifyManifestRevocation,
  verifyMembershipProof,
  type CollectionManifest,
  type CollectionManifestRefusalCode,
  type CollectionManifestRevocation,
  type CollectionManifestVerdict,
  type CollectionRevocationRefusalCode,
  type CollectionRevocationScope,
  type CollectionRevocationVerdict,
  type MembershipProofStep,
  type MembershipRefusalCode,
  type MembershipVerdict,
} from './collection-manifest.js';
export {
  COUNTERPARTY_UTXO_ACTIVATION,
  COUNTERPARTY_UTXO_ASSET_SCHEMA,
  counterpartyMoveDestination,
  counterpartyMoveOutcome,
  counterpartyRecordDigest,
  counterpartyUtxoGates,
  verifyAttachmentFollows,
  verifyCounterpartyLedgerEvents,
  verifyCounterpartyUtxoAsset,
  type CounterpartyAttachment,
  type CounterpartyAttachmentVerdict,
  type CounterpartyLedgerEvent,
  type CounterpartyLedgerVerdict,
  type CounterpartyMovedAsset,
  type CounterpartyMoveOutcome,
  type CounterpartyObservedEvent,
  type CounterpartyOperation,
  type CounterpartyRefusalCode,
  type CounterpartyRecordVerdict,
  type CounterpartySpendTransaction,
  type CounterpartyUtxoAssetRecord,
  type CounterpartyUtxoGates,
} from './counterparty.js';
export {
  EXPECTED_TRANSACTION_MANIFEST_SCHEMA,
  OFFLINE_SIGNING_SESSION_SCHEMA,
  compareSignedResultToManifest,
  expectedTransactionDigest,
  manifestUnsignedTransaction,
  verifyExpectedTransactionManifest,
  type ExpectedAsset,
  type ExpectedTransactionInput,
  type ExpectedTransactionManifest,
  type ExpectedTransactionManifestVerdict,
  type ExpectedTransactionOutput,
  type ObservedAsset,
  type OfflineSigningRefusalCode,
  type OfflineSigningResult,
  type PreservedSignature,
  type SignedResultVerdict,
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
  /** Deadline of one attempt, in milliseconds. Default 30000. */
  timeoutMs?: number;
  /**
   * Deadline of a whole call, every attempt and every wait included, in
   * milliseconds. Default timeoutMs * (retries + 1).
   */
  deadlineMs?: number;
  /**
   * How many times a failed read is retried, 0 to 10. Only reads: a write is
   * never retried by the client, because the gateway does not deduplicate
   * writes.
   */
  retries?: number;
  /** Base backoff between read retries, 0 to 60000 ms. Doubles per attempt, with jitter. */
  retryDelayMs?: number;
  /** The longest single wait between read retries, 0 to 600000 ms. Default 10000. */
  maxRetryDelayMs?: number;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /**
   * A developer API key for the webhook routes. It is sent as a bearer token
   * to those routes and to no other.
   */
  developerKey?: string;
}

/** Per call options every method takes. */
export interface RequestOptions {
  signal?: AbortSignal;
}

/** Codes of a response the client refuses to interpret. */
export type OrdexResponseErrorCode =
  | 'UNEXPECTED_MEDIA_TYPE'
  | 'MALFORMED_JSON'
  | 'MALFORMED_PAGE'
  | 'CURSOR_REPEATED'
  | 'MALFORMED_EVENT';

/** A successful HTTP answer whose body does not have the shape the contract states. */
export class OrdexResponseError extends Error {
  readonly code: OrdexResponseErrorCode;
  readonly status: number | null;

  constructor(code: OrdexResponseErrorCode, status: number | null, message: string) {
    super(message);
    this.name = 'OrdexResponseError';
    this.code = code;
    this.status = status;
  }
}

/** One message of the server sent event stream. `ordex-event` carries an OrdexEvent envelope. */
export interface OrdexStreamMessage {
  /** The last event id the stream set; resume from it with lastEventId. */
  id: string;
  /** The event name: ordex-event, ordex-disconnect, or a heartbeat type. */
  event: string;
  data: unknown;
}

type Op<K extends keyof operations> = operations[K];
type JsonBody<K extends keyof operations> = NonNullable<Op<K>['requestBody']> extends { content: { 'application/json': infer B } } ? B : never;
type Ok<K extends keyof operations, S extends number> = Op<K>['responses'] extends Record<S, { content: { 'application/json': infer R } }> ? R : never;
type Query<K extends keyof operations> = NonNullable<Op<K>['parameters']['query']>;

type QueryValue = string | number | boolean | undefined;

interface InternalRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue> | undefined;
  body?: unknown;
  headers?: Record<string, string | undefined>;
  signal?: AbortSignal | undefined;
  /** The route is scoped to a developer key (contract security developerBearer). */
  developer?: boolean;
}

const RETRIABLE_STATUS = new Set([502, 503, 504]);
const MAX_TIMER_MS = 2_147_483_647;

/** Base64 of the UTF-8 bytes of text, as RFC 7617 sends non-ASCII credentials. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bounded(name: string, value: number | undefined, fallback: number, min: number, max: number, integer = false): number {
  const chosen = value ?? fallback;
  if (typeof chosen !== 'number' || !Number.isFinite(chosen) || chosen < min || chosen > max || (integer && !Number.isInteger(chosen))) {
    throw new RangeError(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`);
  }
  return chosen;
}

/** A wait that ends early, rejecting with the signal's own reason, when the caller aborts. */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject((signal as AbortSignal).reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const isJson = (response: Response): boolean => /^application\/([a-z0-9.+-]*\+)?json(\s*;|$)/i.test((response.headers.get('content-type') ?? '').trim());
const segment = (value: string): string => encodeURIComponent(value);

/*
 * OX-P06: every contract operation the gateway serves is wrapped with its exact
 * generated types, except the documented exclusions in SDK_EXCLUDED_OPERATIONS.
 * The client never signs, funds or broadcasts; reads alone retry, inside one
 * bounded deadline, and a caller abort ends a call at once with its own reason.
 */
export class OrdexClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #deadlineMs: number;
  readonly #retries: number;
  readonly #retryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #headers: Record<string, string>;
  readonly #developerKey: string | undefined;

  constructor(options: OrdexClientOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new RangeError('baseUrl must be an http or https origin.');
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = bounded('timeoutMs', options.timeoutMs, 30_000, 1, MAX_TIMER_MS);
    this.#retries = bounded('retries', options.retries, 0, 0, 10, true);
    this.#retryDelayMs = bounded('retryDelayMs', options.retryDelayMs, 250, 0, 60_000);
    this.#maxRetryDelayMs = bounded('maxRetryDelayMs', options.maxRetryDelayMs, 10_000, 0, 600_000);
    this.#deadlineMs = bounded('deadlineMs', options.deadlineMs, Math.min(MAX_TIMER_MS, this.#timeoutMs * (this.#retries + 1)), 1, MAX_TIMER_MS);
    this.#headers = options.headers ?? {};
    this.#developerKey = options.developerKey;
  }

  #url(request: Pick<InternalRequest, 'path' | 'query'>): string {
    const url = new URL(`${this.#baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  #requestHeaders(request: InternalRequest, accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      accept,
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...this.#headers,
    };
    if (request.developer && this.#developerKey !== undefined) headers.authorization = `Bearer ${this.#developerKey}`;
    for (const [key, value] of Object.entries(request.headers ?? {})) {
      if (value !== undefined) headers[key] = value;
    }
    return headers;
  }

  async #failure(response: Response): Promise<never> {
    const envelope = (await response.json().catch(() => null)) as ErrorResponse | null;
    throw new OrdexApiError(response.status, envelope, `Request failed with ${response.status}.`);
  }

  async #once<T>(request: InternalRequest, signal: AbortSignal): Promise<T> {
    const response = await this.#fetch(this.#url(request), {
      method: request.method,
      headers: this.#requestHeaders(request, 'application/json'),
      body: request.body === undefined ? null : JSON.stringify(request.body),
      signal,
    });
    if (!response.ok) return this.#failure(response);
    if (response.status === 204) return undefined as T;
    if (!isJson(response)) {
      throw new OrdexResponseError('UNEXPECTED_MEDIA_TYPE', response.status, `Expected JSON, got ${response.headers.get('content-type') ?? 'no content type'}.`);
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new OrdexResponseError('MALFORMED_JSON', response.status, 'The response body is not valid JSON.');
    }
  }

  async #request<T>(request: InternalRequest): Promise<T> {
    const caller = request.signal;
    caller?.throwIfAborted();
    const attempts = request.method === 'GET' ? this.#retries + 1 : 1;
    const deadline = Date.now() + this.#deadlineMs;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        const jitter = Math.floor(Math.random() * Math.min(this.#retryDelayMs, this.#maxRetryDelayMs));
        const wait = Math.min(this.#maxRetryDelayMs, this.#retryDelayMs * 2 ** (attempt - 1) + jitter);
        if (Date.now() + wait >= deadline) break;
        await abortableDelay(wait, caller);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      caller?.throwIfAborted();
      const timeout = AbortSignal.timeout(Math.min(this.#timeoutMs, remaining));
      try {
        return await this.#once<T>(request, caller ? AbortSignal.any([caller, timeout]) : timeout);
      } catch (error) {
        if (caller?.aborted) throw caller.reason;
        lastError = error;
        const retriable = error instanceof OrdexApiError ? RETRIABLE_STATUS.has(error.status) : !(error instanceof OrdexResponseError);
        if (!retriable) throw error;
      }
    }
    throw lastError ?? new DOMException('The call deadline passed before an attempt could start.', 'TimeoutError');
  }

  /** Follow a keyset cursor, refusing an envelope that is not a page or a cursor that repeats. */
  async *#pages<P, E>(
    fetchPage: (cursor: string | undefined) => Promise<P>,
    items: (page: P) => unknown,
    start: string | undefined,
  ): AsyncGenerator<E> {
    const seen = new Set<string>();
    let cursor = start;
    if (cursor !== undefined) seen.add(cursor);
    for (;;) {
      const page = await fetchPage(cursor);
      const list = items(page);
      const envelope = page as { hasMore?: unknown; nextCursor?: unknown };
      if (!Array.isArray(list) || typeof envelope.hasMore !== 'boolean' || (envelope.nextCursor !== undefined && typeof envelope.nextCursor !== 'string')) {
        throw new OrdexResponseError('MALFORMED_PAGE', 200, 'The gateway answered something that is not a page.');
      }
      yield* list as E[];
      if (!envelope.hasMore || envelope.nextCursor === '' || envelope.nextCursor === undefined) return;
      if (seen.has(envelope.nextCursor)) {
        throw new OrdexResponseError('CURSOR_REPEATED', 200, 'The gateway returned a cursor it already returned, so paging would never end.');
      }
      seen.add(envelope.nextCursor);
      cursor = envelope.nextCursor;
    }
  }

  // Health, protocol and catalog.

  getHealth(options: RequestOptions = {}): Promise<HealthReport> {
    return this.#request({ method: 'GET', path: '/api/ordex/health', signal: options.signal });
  }

  getProtocol(options: RequestOptions = {}): Promise<ProtocolContract> {
    return this.#request({ method: 'GET', path: '/api/ordex/protocol', signal: options.signal });
  }

  getCatalog(options: RequestOptions = {}): Promise<ProtocolTemplate[]> {
    return this.#request({ method: 'GET', path: '/api/ordex/catalog', signal: options.signal });
  }

  getOperation(operationId: string, options: RequestOptions = {}): Promise<Ok<'getOperation', 200>> {
    return this.#request({ method: 'GET', path: `/api/ordex/operations/${segment(operationId)}`, signal: options.signal });
  }

  // Orders.

  listOrders(query: ListOrdersQuery = {}, options: RequestOptions = {}): Promise<OrderPage> {
    return this.#request({ method: 'GET', path: '/api/ordex/orders', query, signal: options.signal });
  }

  listActivity(query: ListActivityQuery = {}, options: RequestOptions = {}): Promise<ActivityPage> {
    return this.#request({ method: 'GET', path: '/api/ordex/activity', query, signal: options.signal });
  }

  getOrder(id: string, options: RequestOptions = {}): Promise<OrderSummary> {
    return this.#request({ method: 'GET', path: `/api/ordex/orders/${segment(id)}`, signal: options.signal });
  }

  getOrderArtifact(id: string, options: RequestOptions = {}): Promise<OrderArtifact> {
    return this.#request({ method: 'GET', path: `/api/ordex/orders/${segment(id)}/artifact`, signal: options.signal });
  }

  importOrder(body: ImportRequest, options: RequestOptions = {}): Promise<OrderSummary> {
    return this.#request({ method: 'POST', path: '/api/ordex/orders/import', body, signal: options.signal });
  }

  importOpenOrdexEvent(body: NostrEvent, options: RequestOptions = {}): Promise<OrderSummary> {
    return this.#request({ method: 'POST', path: '/api/ordex/orders/openordex-event', body, signal: options.signal });
  }

  buildAsk(body: BuildAskRequest, options: RequestOptions = {}): Promise<BuildAskResult> {
    return this.#request({ method: 'POST', path: '/api/ordex/orders/build', body, signal: options.signal });
  }

  /** idempotencyKey names this mutation so the gateway can replay its receipt; the client still sends it once. */
  publishAsk(body: PublishAskRequest, options: RequestOptions & { idempotencyKey?: string } = {}): Promise<OrderSummary> {
    return this.#request({
      method: 'POST',
      path: '/api/ordex/orders/publish',
      body,
      headers: { 'idempotency-key': options.idempotencyKey },
      signal: options.signal,
    });
  }

  getOwnershipChallenge(id: string, options: RequestOptions = {}): Promise<OwnershipChallenge> {
    return this.#request({ method: 'GET', path: `/api/ordex/orders/${segment(id)}/ownership-challenge`, signal: options.signal });
  }

  withdrawOrder(id: string, proof: OwnershipProof, options: RequestOptions & { idempotencyKey?: string } = {}): Promise<OrderSummary> {
    return this.#request({
      method: 'POST',
      path: `/api/ordex/orders/${segment(id)}/withdraw`,
      body: proof,
      headers: { 'idempotency-key': options.idempotencyKey },
      signal: options.signal,
    });
  }

  /**
   * Replace an ask with a successor. idempotencyKey names this mutation; the
   * gateway replays its receipt for the same key and request. The client
   * still sends it once.
   */
  replaceOrder(
    id: string,
    body: JsonBody<'replaceOrder'>,
    options: RequestOptions & { idempotencyKey?: string } = {},
  ): Promise<Ok<'replaceOrder', 201>> {
    return this.#request({
      method: 'POST',
      path: `/api/ordex/orders/${segment(id)}/replace`,
      body,
      headers: { 'idempotency-key': options.idempotencyKey },
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
      path: `/api/ordex/admin/orders/${segment(id)}/withdraw`,
      body,
      headers: { authorization: `Basic ${toBase64(`${credentials.username}:${credentials.password}`)}` },
      signal: options.signal,
    });
  }

  getNostrEnvelope(id: string, options: RequestOptions = {}): Promise<NostrEnvelope> {
    return this.#request({ method: 'GET', path: `/api/ordex/orders/${segment(id)}/nostr-envelope`, signal: options.signal });
  }

  revalidateOrder(id: string, options: RequestOptions = {}): Promise<OrderSummary> {
    return this.#request({ method: 'POST', path: `/api/ordex/orders/${segment(id)}/revalidate`, signal: options.signal });
  }

  quoteOrder(id: string, body: QuoteRequest, options: RequestOptions = {}): Promise<Quote> {
    return this.#request({ method: 'POST', path: `/api/ordex/orders/${segment(id)}/quote`, body, signal: options.signal });
  }

  preflightOrder(id: string, body: PreflightRequest, options: RequestOptions = {}): Promise<PreflightResult> {
    return this.#request({ method: 'POST', path: `/api/ordex/orders/${segment(id)}/preflight`, body, signal: options.signal });
  }

  composeBatchPurchase(body: JsonBody<'composeBatchPurchase'>, options: RequestOptions = {}): Promise<Ok<'composeBatchPurchase', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/orders/batch-purchase', body, signal: options.signal });
  }

  preflightBatchPurchase(body: JsonBody<'preflightBatchPurchase'>, options: RequestOptions = {}): Promise<Ok<'preflightBatchPurchase', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/orders/batch-preflight', body, signal: options.signal });
  }

  /**
   * Every order matching the query, page by page, following the keyset
   * cursor until the gateway answers an empty one. A cursor that repeats or
   * an envelope that is not a page ends the iteration with OrdexResponseError.
   */
  iterateOrders(query: ListOrdersQuery = {}, options: RequestOptions = {}): AsyncGenerator<OrderSummary> {
    return this.#pages<OrderPage, OrderSummary>(
      (cursor) => this.listOrders({ ...query, ...(cursor === undefined ? {} : { cursor }) }, options),
      (page) => page.orders,
      query.cursor,
    );
  }

  /** Every activity entry matching the query, following the keyset cursor with the same protections. */
  iterateActivity(query: ListActivityQuery = {}, options: RequestOptions = {}): AsyncGenerator<ActivityEntry> {
    return this.#pages<ActivityPage, ActivityEntry>(
      (cursor) => this.listActivity({ ...query, ...(cursor === undefined ? {} : { cursor }) }, options),
      (page) => page.entries,
      query.cursor,
    );
  }

  // SafeOps. Plans and fee plans only; the client never broadcasts.

  createSafeOpsPlan(body: JsonBody<'createSafeOpsPlan'>, options: RequestOptions = {}): Promise<Ok<'createSafeOpsPlan', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/safeops/plans', body, signal: options.signal });
  }

  getSafeOpsPlan(planId: string, options: RequestOptions = {}): Promise<Ok<'getSafeOpsPlan', 200>> {
    return this.#request({ method: 'GET', path: `/api/ordex/safeops/plans/${segment(planId)}`, signal: options.signal });
  }

  refreshExecutionShield(planId: string, body?: JsonBody<'refreshExecutionShield'>, options: RequestOptions = {}): Promise<Ok<'refreshExecutionShield', 201>> {
    return this.#request({ method: 'POST', path: `/api/ordex/safeops/plans/${segment(planId)}/shield`, body, signal: options.signal });
  }

  getSafeOpsOperation(txid: string, options: RequestOptions = {}): Promise<Ok<'getSafeOpsOperation', 200>> {
    return this.#request({ method: 'GET', path: `/api/ordex/safeops/operations/${segment(txid)}`, signal: options.signal });
  }

  planSafeOpsRbf(body: JsonBody<'planSafeOpsRbf'>, options: RequestOptions = {}): Promise<Ok<'planSafeOpsRbf', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/safeops/rbf', body, signal: options.signal });
  }

  planSafeOpsCpfp(body: JsonBody<'planSafeOpsCpfp'>, options: RequestOptions = {}): Promise<Ok<'planSafeOpsCpfp', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/safeops/cpfp', body, signal: options.signal });
  }

  // Swaps. Intents, plans, sessions and private envelopes; the client never broadcasts.

  publishSwapIntent(body: JsonBody<'publishSwapIntent'>, options: RequestOptions = {}): Promise<Ok<'publishSwapIntent', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/swaps/intents', body, signal: options.signal });
  }

  listSwapIntents(query: Query<'listSwapIntents'> = {}, options: RequestOptions = {}): Promise<Ok<'listSwapIntents', 200>> {
    return this.#request({ method: 'GET', path: '/api/ordex/swaps/intents', query, signal: options.signal });
  }

  getSwapIntent(intentId: string, options: RequestOptions = {}): Promise<Ok<'getSwapIntent', 200>> {
    return this.#request({ method: 'GET', path: `/api/ordex/swaps/intents/${segment(intentId)}`, signal: options.signal });
  }

  withdrawSwapIntent(intentId: string, body: JsonBody<'withdrawSwapIntent'>, options: RequestOptions = {}): Promise<Ok<'withdrawSwapIntent', 201>> {
    return this.#request({ method: 'POST', path: `/api/ordex/swaps/intents/${segment(intentId)}/withdraw`, body, signal: options.signal });
  }

  buildSwapAcceptancePlan(intentId: string, body: JsonBody<'buildSwapAcceptancePlan'>, options: RequestOptions = {}): Promise<Ok<'buildSwapAcceptancePlan', 201>> {
    return this.#request({ method: 'POST', path: `/api/ordex/swaps/intents/${segment(intentId)}/acceptance-plan`, body, signal: options.signal });
  }

  getSwapSession(sessionId: string, options: RequestOptions = {}): Promise<Ok<'getSwapSession', 200>> {
    return this.#request({ method: 'GET', path: `/api/ordex/swaps/sessions/${segment(sessionId)}`, signal: options.signal });
  }

  submitSwapSignature(sessionId: string, body: JsonBody<'submitSwapSignature'>, options: RequestOptions = {}): Promise<Ok<'submitSwapSignature', 201>> {
    return this.#request({ method: 'POST', path: `/api/ordex/swaps/sessions/${segment(sessionId)}/signatures`, body, signal: options.signal });
  }

  preflightSwapSession(sessionId: string, options: RequestOptions = {}): Promise<Ok<'preflightSwapSession', 201>> {
    return this.#request({ method: 'POST', path: `/api/ordex/swaps/sessions/${segment(sessionId)}/preflight`, signal: options.signal });
  }

  storePrivateSwap(body: JsonBody<'storePrivateSwap'>, options: RequestOptions = {}): Promise<Ok<'storePrivateSwap', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/swaps/private', body, signal: options.signal });
  }

  listPrivateSwaps(options: RequestOptions = {}): Promise<Ok<'listPrivateSwaps', 200>> {
    return this.#request({ method: 'GET', path: '/api/ordex/swaps/private', signal: options.signal });
  }

  getPrivateSwap(privateId: string, options: RequestOptions = {}): Promise<Ok<'getPrivateSwap', 200>> {
    return this.#request({ method: 'GET', path: `/api/ordex/swaps/private/${segment(privateId)}`, signal: options.signal });
  }

  destroyPrivateSwap(privateId: string, body: JsonBody<'destroyPrivateSwap'>, options: RequestOptions = {}): Promise<Ok<'destroyPrivateSwap', 200>> {
    return this.#request({ method: 'DELETE', path: `/api/ordex/swaps/private/${segment(privateId)}`, body, signal: options.signal });
  }

  // Events.

  listOrdexEvents(query: Query<'listOrdexEvents'> = {}, options: RequestOptions = {}): Promise<Ok<'listOrdexEvents', 200>> {
    return this.#request({ method: 'GET', path: '/api/ordex/events', query, signal: options.signal });
  }

  getEventStreamCheckpoint(query: Query<'getEventStreamCheckpoint'> = {}, options: RequestOptions = {}): Promise<Ok<'getEventStreamCheckpoint', 200>> {
    return this.#request({ method: 'GET', path: '/api/ordex/events/checkpoint', query, signal: options.signal });
  }

  /**
   * The live event stream, parsed message by message. timeoutMs bounds the
   * connection only; once connected the stream lasts until the gateway ends
   * it, the caller stops iterating, or the signal aborts. It never
   * reconnects by itself: resume with the last message id as lastEventId.
   */
  async *streamOrdexEvents(
    query: Query<'streamOrdexEvents'> = {},
    options: RequestOptions & { lastEventId?: string } = {},
  ): AsyncGenerator<OrdexStreamMessage> {
    const caller = options.signal;
    caller?.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort((caller as AbortSignal).reason);
    caller?.addEventListener('abort', onAbort, { once: true });
    const connectTimer = setTimeout(
      () => controller.abort(new DOMException('The event stream did not connect in time.', 'TimeoutError')),
      this.#timeoutMs,
    );
    try {
      let response: Response;
      try {
        response = await this.#fetch(this.#url({ path: '/api/ordex/events/stream', query }), {
          method: 'GET',
          headers: this.#requestHeaders({ method: 'GET', path: '', headers: { 'last-event-id': options.lastEventId } }, 'text/event-stream'),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(connectTimer);
      }
      if (!response.ok) await this.#failure(response);
      if (!/^text\/event-stream(\s*;|$)/i.test((response.headers.get('content-type') ?? '').trim()) || !response.body) {
        throw new OrdexResponseError('UNEXPECTED_MEDIA_TYPE', response.status, 'Expected a text/event-stream body.');
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      controller.signal.addEventListener('abort', () => void reader.cancel().catch(() => undefined), { once: true });
      let buffer = '';
      let lastId = options.lastEventId ?? '';
      let eventName = '';
      let data: string[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          if (controller.signal.aborted) throw controller.signal.reason;
          return;
        }
        buffer += value;
        // A CR at the end of a chunk may be the first half of a CRLF.
        const cut = buffer.endsWith('\r') ? buffer.length - 1 : buffer.length;
        const lines = buffer.slice(0, cut).split(/\r\n|\r|\n/);
        buffer = (lines.pop() ?? '') + buffer.slice(cut);
        for (const line of lines) {
          if (line === '') {
            if (data.length > 0) {
              let parsed: unknown;
              try {
                parsed = JSON.parse(data.join('\n'));
              } catch {
                throw new OrdexResponseError('MALFORMED_EVENT', response.status, `A ${eventName || 'message'} event carried data that is not JSON.`);
              }
              yield { id: lastId, event: eventName || 'message', data: parsed };
            }
            eventName = '';
            data = [];
            continue;
          }
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const fieldValue = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') eventName = fieldValue;
          else if (field === 'data') data.push(fieldValue);
          else if (field === 'id' && !fieldValue.includes('\0')) lastId = fieldValue;
        }
      }
    } catch (error) {
      if (caller?.aborted) throw caller.reason;
      throw error;
    } finally {
      caller?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  // Webhooks. Every route is scoped to the developerKey the client was given.

  createWebhookSubscription(body: JsonBody<'createWebhookSubscription'>, options: RequestOptions = {}): Promise<Ok<'createWebhookSubscription', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/webhooks/subscriptions', body, developer: true, signal: options.signal });
  }

  listWebhookSubscriptions(options: RequestOptions = {}): Promise<Ok<'listWebhookSubscriptions', 200>> {
    return this.#request({ method: 'GET', path: '/api/ordex/webhooks/subscriptions', developer: true, signal: options.signal });
  }

  getWebhookSubscription(subscriptionId: string, options: RequestOptions = {}): Promise<Ok<'getWebhookSubscription', 200>> {
    return this.#request({ method: 'GET', path: `/api/ordex/webhooks/subscriptions/${segment(subscriptionId)}`, developer: true, signal: options.signal });
  }

  updateWebhookSubscription(
    subscriptionId: string,
    body: JsonBody<'updateWebhookSubscription'>,
    options: RequestOptions = {},
  ): Promise<Ok<'updateWebhookSubscription', 200>> {
    return this.#request({ method: 'PATCH', path: `/api/ordex/webhooks/subscriptions/${segment(subscriptionId)}`, body, developer: true, signal: options.signal });
  }

  deleteWebhookSubscription(subscriptionId: string, options: RequestOptions = {}): Promise<Ok<'deleteWebhookSubscription', 200>> {
    return this.#request({ method: 'DELETE', path: `/api/ordex/webhooks/subscriptions/${segment(subscriptionId)}`, developer: true, signal: options.signal });
  }

  rotateWebhookSecret(subscriptionId: string, options: RequestOptions = {}): Promise<Ok<'rotateWebhookSecret', 201>> {
    return this.#request({ method: 'POST', path: `/api/ordex/webhooks/subscriptions/${segment(subscriptionId)}/rotate-secret`, developer: true, signal: options.signal });
  }

  verifyWebhookEndpoint(
    subscriptionId: string,
    body?: JsonBody<'verifyWebhookEndpoint'>,
    options: RequestOptions = {},
  ): Promise<Ok<'verifyWebhookEndpoint', 201>> {
    return this.#request({ method: 'POST', path: `/api/ordex/webhooks/subscriptions/${segment(subscriptionId)}/verify`, body, developer: true, signal: options.signal });
  }

  testWebhookSubscription(subscriptionId: string, options: RequestOptions = {}): Promise<Ok<'testWebhookSubscription', 201>> {
    return this.#request({ method: 'POST', path: `/api/ordex/webhooks/subscriptions/${segment(subscriptionId)}/test`, developer: true, signal: options.signal });
  }

  listWebhookDeliveries(query: Query<'listWebhookDeliveries'> = {}, options: RequestOptions = {}): Promise<Ok<'listWebhookDeliveries', 200>> {
    return this.#request({ method: 'GET', path: '/api/ordex/webhooks/deliveries', query, developer: true, signal: options.signal });
  }

  replayWebhookDelivery(deliveryId: string, options: RequestOptions = {}): Promise<Ok<'replayWebhookDelivery', 201>> {
    return this.#request({ method: 'POST', path: `/api/ordex/webhooks/deliveries/${segment(deliveryId)}/replay`, developer: true, signal: options.signal });
  }

  // Collection provenance.

  publishCollectionManifest(body: JsonBody<'publishCollectionManifest'>, options: RequestOptions = {}): Promise<Ok<'publishCollectionManifest', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/collections/manifests', body, signal: options.signal });
  }

  listCollectionManifests(query: Query<'listCollectionManifests'> = {}, options: RequestOptions = {}): Promise<Ok<'listCollectionManifests', 200>> {
    return this.#request({ method: 'GET', path: '/api/ordex/collections/manifests', query, signal: options.signal });
  }

  getCollectionManifest(manifestId: string, options: RequestOptions = {}): Promise<Ok<'getCollectionManifest', 200>> {
    return this.#request({ method: 'GET', path: `/api/ordex/collections/manifests/${segment(manifestId)}`, signal: options.signal });
  }

  getCollectionMembershipProof(manifestId: string, memberIdentity: string, options: RequestOptions = {}): Promise<Ok<'getCollectionMembershipProof', 200>> {
    return this.#request({
      method: 'GET',
      path: `/api/ordex/collections/manifests/${segment(manifestId)}/proofs/${segment(memberIdentity)}`,
      signal: options.signal,
    });
  }

  reviseCollectionManifest(manifestId: string, body: JsonBody<'reviseCollectionManifest'>, options: RequestOptions = {}): Promise<Ok<'reviseCollectionManifest', 201>> {
    return this.#request({ method: 'POST', path: `/api/ordex/collections/manifests/${segment(manifestId)}/revisions`, body, signal: options.signal });
  }

  getCollectionProvenance(collectionId: string, query: Query<'getCollectionProvenance'> = {}, options: RequestOptions = {}): Promise<Ok<'getCollectionProvenance', 200>> {
    return this.#request({ method: 'GET', path: `/api/ordex/collections/${segment(collectionId)}/provenance`, query, signal: options.signal });
  }

  // Counterparty heritage.

  getHeritageReadiness(options: RequestOptions = {}): Promise<Ok<'getHeritageReadiness', 200>> {
    return this.#request({ method: 'GET', path: '/api/ordex/heritage/readiness', signal: options.signal });
  }

  getHeritageAsset(assetId: string, query: Query<'getHeritageAsset'> = {}, options: RequestOptions = {}): Promise<Ok<'getHeritageAsset', 200>> {
    return this.#request({ method: 'GET', path: `/api/ordex/heritage/assets/${segment(assetId)}`, query, signal: options.signal });
  }

  listHeritageAssetUtxos(assetId: string, query: Query<'listHeritageAssetUtxos'> = {}, options: RequestOptions = {}): Promise<Ok<'listHeritageAssetUtxos', 200>> {
    return this.#request({ method: 'GET', path: `/api/ordex/heritage/assets/${segment(assetId)}/utxos`, query, signal: options.signal });
  }

  listHeritageAddressAssets(address: string, options: RequestOptions = {}): Promise<Ok<'listHeritageAddressAssets', 200>> {
    return this.#request({ method: 'GET', path: `/api/ordex/heritage/addresses/${segment(address)}/assets`, signal: options.signal });
  }

  buildHeritageAttach(body: JsonBody<'buildHeritageAttach'>, options: RequestOptions = {}): Promise<Ok<'buildHeritageAttach', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/heritage/attach', body, signal: options.signal });
  }

  buildHeritageDetach(body: JsonBody<'buildHeritageDetach'>, options: RequestOptions = {}): Promise<Ok<'buildHeritageDetach', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/heritage/detach', body, signal: options.signal });
  }

  // Offline signing sessions. Capabilities are returned once, at opening.

  openSigningSession(body: JsonBody<'openSigningSession'>, options: RequestOptions = {}): Promise<Ok<'openSigningSession', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/signing/sessions', body, signal: options.signal });
  }

  listSigningSessions(
    capabilities: readonly string[],
    query: Query<'listSigningSessions'> = {},
    options: RequestOptions = {},
  ): Promise<Ok<'listSigningSessions', 200>> {
    return this.#request({
      method: 'GET',
      path: '/api/ordex/signing/sessions',
      query,
      headers: { 'x-ordex-signing-capability': capabilities.join(',') },
      signal: options.signal,
    });
  }

  getSigningSession(sessionId: string, capability: string, options: RequestOptions = {}): Promise<Ok<'getSigningSession', 200>> {
    return this.#request({
      method: 'GET',
      path: `/api/ordex/signing/sessions/${segment(sessionId)}`,
      headers: { 'x-ordex-signing-capability': capability },
      signal: options.signal,
    });
  }

  submitSignedResult(
    sessionId: string,
    capability: string,
    body: JsonBody<'submitSignedResult'>,
    options: RequestOptions = {},
  ): Promise<Ok<'submitSignedResult', 201>> {
    return this.#request({
      method: 'POST',
      path: `/api/ordex/signing/sessions/${segment(sessionId)}/signed-result`,
      body,
      headers: { 'x-ordex-signing-capability': capability },
      signal: options.signal,
    });
  }

  verifySigningArtifacts(body: JsonBody<'verifySigningArtifacts'>, options: RequestOptions = {}): Promise<Ok<'verifySigningArtifacts', 201>> {
    return this.#request({ method: 'POST', path: '/api/ordex/signing/verify', body, signal: options.signal });
  }
}

/**
 * Contract operations the client deliberately does not wrap, with the reason.
 * Every other operation in spec/openapi.json has a method of the same name.
 */
export const SDK_EXCLUDED_OPERATIONS: Readonly<Record<string, string>> = Object.freeze({
  broadcastSafeOpsTransaction:
    'Relays signed bytes to the network. The client broadcasts nothing; broadcasting is a deliberate step of the owner, through its own node or wallet.',
  broadcastSwapSession:
    'Relays a signed swap settlement. The client broadcasts nothing; broadcasting is a deliberate step of a party that owns the money that moves.',
  listOffers: 'Funded offers are not served by the gateway yet (Core OX-B01); the client wraps a route once the gateway serves it.',
  publishOffer: 'Funded offers are not served by the gateway yet (Core OX-B01).',
  getOffer: 'Funded offers are not served by the gateway yet (Core OX-B01).',
  revalidateOffer: 'Funded offers are not served by the gateway yet (Core OX-B01).',
  withdrawOffer: 'Funded offers are not served by the gateway yet (Core OX-B01).',
  planOfferAcceptance: 'Funded offers are not served by the gateway yet (Core OX-B01).',
  preflightOfferAcceptance: 'Funded offers are not served by the gateway yet (Core OX-B01).',
});
