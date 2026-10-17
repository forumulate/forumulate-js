/**
 * The one place a request leaves the SDK: headers, body encoding, retries,
 * response decoding and the error type. Every surface — the positional
 * helpers, `typed()`, `request(operationId)` and the generated namespaces —
 * goes through `send`, so a retry or a header rule cannot apply to one door
 * and not another.
 */

/** Kept in step with package.json by `coverage.test.ts`. */
export const SDK_VERSION = '0.7.0';

/** The API's error envelope: `{ error: { code, message, details? }, requestId? }`. */
export interface ForumulateErrorInit {
  /** Field-level detail, e.g. `{ title: ['Required'] }` for `validation.failed`. */
  details?: unknown;
  /** The id to quote in a support request; the API puts it on every error. */
  requestId?: string;
  /** Seconds the API asked us to wait (`Retry-After`), when it said. */
  retryAfter?: number;
  /** The parsed body, whole, for anything the fields above do not carry. */
  body?: unknown;
  /** The response headers of the failed request. */
  headers?: Headers;
  cause?: unknown;
}

/**
 * Thrown for any non-2xx API response, and for a network failure that
 * outlived its retries (`status: 0`, `code: 'network.error'`). Mirrors the
 * API's error envelope.
 */
export class ForumulateError extends Error {
  readonly details?: unknown;
  readonly requestId?: string;
  readonly retryAfter?: number;
  readonly body?: unknown;
  readonly headers?: Headers;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    init: ForumulateErrorInit = {},
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ForumulateError';
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
    this.body = init.body;
    this.headers = init.headers;
  }
}

export type Query = Record<
  string,
  string | number | boolean | readonly (string | number)[] | undefined | null
>;

/** Per-call options every surface accepts. */
export interface CallOptions {
  /** Extra headers for this request; they win over the client's. */
  headers?: Record<string, string>;
  /**
   * Makes a write safe to repeat: the API runs the first request with a key
   * and replays its answer to any repeat for 24 hours. POST and PATCH get a
   * generated one by default (reused across this call's own retries); pass
   * yours to dedupe across processes, e.g. a queue message id.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Overrides the client's `maxRetries` for this call. */
  maxRetries?: number;
}

export interface SendInit extends CallOptions {
  method: string;
  path: string;
  query?: Query;
  body?: unknown;
  /** Return the untouched `Response` (binary downloads, streams). */
  raw?: boolean;
  /** How to read a 2xx body when it is not JSON. */
  kind?: 'json' | 'text' | 'binary';
  /** `Forumulate-Version` to send unless the caller already set one. */
  version?: string;
}

export interface Transport {
  baseUrl: string;
  token?: string;
  credentials: boolean;
  headers: Record<string, string>;
  fetch: typeof fetch;
  maxRetries: number;
  autoIdempotencyKey: boolean;
}

/** 408, 429 and the gateway family. A 500 is not here: the API means it ("retrying will not help"). */
const RETRY_STATUS = new Set([408, 429, 502, 503, 504]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
/** A Retry-After longer than this is a "come back later", not a retry; surface it. */
const MAX_RETRY_AFTER_MS = 60_000;

const hasHeader = (h: Record<string, string>, name: string) =>
  Object.keys(h).some((k) => k.toLowerCase() === name.toLowerCase());

const isRawBody = (b: unknown) =>
  (typeof FormData !== 'undefined' && b instanceof FormData) ||
  (typeof Blob !== 'undefined' && b instanceof Blob) ||
  (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams) ||
  (typeof ReadableStream !== 'undefined' && b instanceof ReadableStream) ||
  b instanceof ArrayBuffer ||
  ArrayBuffer.isView(b);

function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'sdk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

/**
 * How long to wait before retry number `attempt` (0-based), or `null` to stop.
 *
 * `Retry-After` wins when present — seconds or an HTTP date — because the
 * API sends it on purpose (a 429's window, a 503's batch interruption). Without
 * it: exponential from 0.5s, capped at 8s, with jitter so a fleet of clients
 * that failed together does not retry together.
 */
export function retryDelayMs(
  attempt: number,
  retryAfter: string | null | undefined,
  now = Date.now(),
): number | null {
  if (retryAfter != null && retryAfter.trim() !== '') {
    const secs = Number(retryAfter);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(ms)) return ms > MAX_RETRY_AFTER_MS ? null : Math.max(0, ms);
  }
  return Math.min(500 * 2 ** attempt, 8000) * (1 - Math.random() * 0.25);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener?.(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function buildUrl(base: string, path: string, query?: Query): string {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    // Lists are comma-joined: `include=sections,body` is how the API reads them.
    url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return url.toString();
}

async function decode(res: Response, init: SendInit): Promise<unknown> {
  if (init.raw || init.kind === 'binary') return res;
  const text = await res.text();
  if (init.kind === 'text') return text;
  if (!text) return undefined;
  const type = res.headers?.get?.('content-type') ?? '';
  // No content type (a test double, an odd proxy) is read as JSON, as it always was.
  if (!type || /json/i.test(type)) return JSON.parse(text);
  return text;
}

async function toError(res: Response): Promise<ForumulateError> {
  let body: unknown;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON body (an edge block page) */
  }
  const env = (body ?? {}) as {
    error?: { code?: string; message?: string; details?: unknown };
    requestId?: string;
  };
  const after = res.headers?.get?.('retry-after');
  const retryAfter = after != null && Number.isFinite(Number(after)) ? Number(after) : undefined;
  return new ForumulateError(
    res.status,
    env.error?.code ?? 'error',
    env.error?.message ?? res.statusText,
    {
      details: env.error?.details,
      requestId: env.requestId ?? res.headers?.get?.('x-request-id') ?? undefined,
      retryAfter,
      body,
      headers: res.headers,
    },
  );
}

export async function send<T>(t: Transport, init: SendInit): Promise<T> {
  const method = init.method.toUpperCase();
  const url = buildUrl(t.baseUrl, init.path, init.query);
  /*
   * Ours first, the caller's last, so a per-request header wins.
   *
   * `Idempotency-Key` has to be per-REQUEST (a key reused across two
   * different writes is worse than none), and `Forumulate-Version` is
   * naturally per-client — so both layers exist and the narrower one
   * overrides. `Content-Type` is set before the caller's so a multipart or
   * ndjson body can correct it rather than be forced to JSON.
   */
  const headers: Record<string, string> = { ...t.headers };
  if (t.token) headers.Authorization = `Bearer ${t.token}`;
  const raw = init.body !== undefined && isRawBody(init.body);
  if (init.body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  if (
    init.version &&
    !hasHeader(headers, 'forumulate-version') &&
    !hasHeader(init.headers ?? {}, 'forumulate-version')
  ) {
    headers['Forumulate-Version'] = init.version;
  }
  Object.assign(headers, init.headers ?? {});
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  else if (
    t.autoIdempotencyKey &&
    (method === 'POST' || method === 'PATCH') &&
    !hasHeader(headers, 'idempotency-key')
  ) {
    // Generated ONCE per call, so every retry of this call carries the same key.
    headers['Idempotency-Key'] = newIdempotencyKey();
  }
  const retryable = SAFE_METHODS.has(method) || hasHeader(headers, 'idempotency-key');
  const maxRetries = retryable ? Math.max(0, init.maxRetries ?? t.maxRetries) : 0;
  const body =
    init.body === undefined ? undefined : raw ? (init.body as BodyInit) : JSON.stringify(init.body);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await t.fetch(url, {
        method,
        headers,
        credentials: t.credentials ? 'include' : 'same-origin',
        body,
        signal: init.signal,
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || init.signal?.aborted) throw err;
      const wait = attempt < maxRetries ? retryDelayMs(attempt, null) : null;
      if (wait === null) {
        throw new ForumulateError(
          0,
          'network.error',
          (err as Error)?.message ?? 'Network request failed',
          { cause: err },
        );
      }
      await sleep(wait, init.signal);
      continue;
    }
    if (res.ok) return (await decode(res, init)) as T;
    if (attempt < maxRetries && RETRY_STATUS.has(res.status)) {
      const wait = retryDelayMs(attempt, res.headers?.get?.('retry-after'));
      if (wait !== null) {
        await res.text?.().catch(() => undefined);
        await sleep(wait, init.signal);
        continue;
      }
    }
    throw await toError(res);
  }
}
