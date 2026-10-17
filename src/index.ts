export * from './types';
export { verifyWebhookSignature, constructWebhookEvent, type VerifyWebhookInput } from './webhooks';
export * from './content';
export * from './translations';
export type { paths, operations } from './schema';
export type { HttpMethod, MethodsOf, OperationOf, TypedRequestInit, TypedResponse } from './typed';
export {
  ForumulateError,
  SDK_VERSION,
  retryDelayMs,
  type CallOptions,
  type ForumulateErrorInit,
} from './http';
export { rowsOf, type PagePromise } from './pagination';
export type {
  Namespace,
  NamespaceName,
  OperationArgs,
  OperationFn,
  OperationId,
  OperationResult,
  OperationRow,
  PagedOperationId,
  Resources,
} from './resources';
export { API_VERSION } from './operations.gen';
import type { paths } from './schema';
import type { HttpMethod, TypedRequestInit, TypedResponse } from './typed';
import { contentApi } from './content';
import { translationsApi } from './translations';
import { send, SDK_VERSION, type Query, type Transport } from './http';
import { pagePromise } from './pagination';
import { positionalHelpers, type PositionalHelpers } from './helpers';
import { API_VERSION } from './operations.gen';
import {
  buildNamespace,
  mergeNamespace,
  namespaceNames,
  resolveArgs,
  routeTable,
  type Merged,
  type Namespace,
  type NamespaceName,
  type OperationArgs,
  type OptionalArgsOperationId,
  type OperationId,
  type OperationReturn,
  type OperationRow,
  type PagedOperationId,
  type Resources,
  type Route,
} from './resources';

export interface ForumulateClientOptions {
  /** API base, `https://forumulate.com/api` for the hosted product (see `fromEnv`). */
  baseUrl: string;
  /** Personal Access Token for `Authorization: Bearer` auth. */
  token?: string;
  /** Send the session cookie (browser same-origin usage). Default false. */
  credentials?: boolean;
  /** Injectable fetch (for tests / non-global-fetch runtimes). Defaults to global fetch. */
  fetch?: typeof fetch;
  /**
   * Headers sent on EVERY request — `Forumulate-Version` is the one that
   * matters here, because pinning the API version is a per-client decision and
   * there was no way to express it at all.
   *
   * The client could send exactly two headers it chose itself, `Authorization`
   * and `Content-Type`, and nothing else: so a caller could not pin a version
   * and could not send `Idempotency-Key`, which `POST …/items` REQUIRES. The
   * typed surface covered 1,225 operations and one of them was unreachable
   * from the SDK that advertised it.
   */
  headers?: Record<string, string>;
  /**
   * The `Forumulate-Version` to state. The namespace methods and
   * `request(operationId)` always state one — this, or {@link API_VERSION}
   * (the version the SDK was generated against) — because auto-pagination reads
   * the envelope only a versioned answer carries. The 0.5 positional helpers,
   * `typed()` and `request(method, path)` send it only when you set it here,
   * so code written against them sees exactly the answers it always saw.
   */
  apiVersion?: string;
  /**
   * Retries for 408/429/502/503/504 and network failures. Default 2. Only
   * requests that are safe to repeat are retried: GET/PUT/DELETE, and writes
   * carrying an `Idempotency-Key`. `Retry-After` is honoured.
   */
  maxRetries?: number;
  /**
   * Give every POST and PATCH a generated `Idempotency-Key` (the same one on
   * each of its retries), so a write that timed out can be retried without
   * running twice. Default true; a key you pass always wins.
   */
  autoIdempotencyKey?: boolean;
  /**
   * The `User-Agent` outside a browser. Default `forumulate-sdk-js/<version>`:
   * the edge challenges default library agents, which reads as an outage to a
   * first-time integration. Ignored where the runtime forbids the header.
   */
  userAgent?: string;
}

type HandWritten = keyof PositionalHelpers | 'content';

/**
 * Typed client for the Forumulate REST API.
 *
 * ```ts
 * const forumulate = new ForumulateClient({ baseUrl: 'https://forumulate.com/api', token: pat });
 *
 * for await (const post of forumulate.blog.list({ orgId, spaceId })) console.log(post);
 * await forumulate.webhooks.rotate({ orgId, webhookId });
 * await forumulate.request('Space_get', { orgId, spaceId });
 *
 * // or, from FORUMULATE_TOKEN / FORUMULATE_URL:
 * const fromEnv = ForumulateClient.fromEnv();
 * ```
 *
 * Every operation in the API is a method: `client.<namespace>[.<sub>].<method>`,
 * named after its operationId (`ForumTopics_list` → `forum.topics.list`).
 */
// The interface half of the class: one property per generated namespace that
// has no hand-written helpers. Merging is what lets ~60 namespaces exist
// without 60 hand-maintained property declarations that would drift.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-object-type
export interface ForumulateClient extends Omit<Resources, HandWritten> {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ForumulateClient {
  private readonly transport: Transport;
  private readonly apiVersion?: string;

  constructor(opts: ForumulateClientOptions) {
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error('No fetch implementation available — pass one via options.fetch.');
    const headers = { ...(opts.headers ?? {}) };
    const inBrowser = typeof (globalThis as { document?: unknown }).document !== 'undefined';
    if (!inBrowser && !Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
      headers['User-Agent'] = opts.userAgent ?? `forumulate-sdk-js/${SDK_VERSION}`;
    }
    this.transport = {
      baseUrl: opts.baseUrl.replace(/\/$/, ''),
      token: opts.token,
      credentials: opts.credentials ?? false,
      headers,
      fetch: f,
      maxRetries: opts.maxRetries ?? 2,
      autoIdempotencyKey: opts.autoIdempotencyKey ?? true,
    };
    this.apiVersion = opts.apiVersion;
    // Generated namespaces are built on first touch: a client that only ever
    // calls `blog` never allocates the other 1,800 closures.
    for (const name of namespaceNames()) {
      if (Object.prototype.hasOwnProperty.call(this, name)) continue;
      Object.defineProperty(this, name, {
        configurable: true,
        enumerable: true,
        get: () => {
          const value = buildNamespace(name, this.invoke);
          Object.defineProperty(this, name, { value, enumerable: true });
          return value;
        },
      });
    }
  }

  /**
   * A client configured from the environment, by the same names the CLI and
   * `@forumulate/mcp` read — so one `.env` drives all three:
   *
   * - `FORUMULATE_TOKEN`: the Personal Access Token.
   * - `FORUMULATE_URL`: the site, default `https://forumulate.com`; the API is
   *   its `/api` (a value already ending in `/api` is used as-is).
   * - `FORUMULATE_API_URL`: the exact API base, for a local API with no `/api`
   *   prefix (`http://localhost:4000`). Wins over `FORUMULATE_URL`.
   *
   * `env` defaults to `process.env` where there is one (Node, Bun, Deno);
   * anything in `opts` overrides what the environment said.
   */
  static fromEnv(
    env?: Record<string, string | undefined>,
    opts: Partial<ForumulateClientOptions> = {},
  ): ForumulateClient {
    const source =
      env ??
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
      {};
    const read = (k: string) => source[k]?.trim().replace(/\/+$/, '') || undefined;
    const site = read('FORUMULATE_URL') ?? 'https://forumulate.com';
    const baseUrl = read('FORUMULATE_API_URL') ?? (/\/api$/i.test(site) ? site : `${site}/api`);
    return new ForumulateClient({
      baseUrl,
      token: source.FORUMULATE_TOKEN?.trim() || undefined,
      ...opts,
    });
  }

  /**
   * Call any operation by its operationId, fully typed:
   *
   * ```ts
   * const { space } = await forumulate.request('Space_get', { orgId, spaceId });
   * ```
   *
   * The two-string form `request(method, path, opts)` is the untyped escape
   * hatch it has always been.
   */
  // Two generic overloads (argument optional / required) rather than one rest tuple, and
  // `NoInfer`: K must come from the id alone. A rest tuple, or inferring K from the
  // arguments too, made TypeScript resolve the argument type against all 1,800 ids at
  // once and give up (TS2590) on any call with a nested object literal.
  request<K extends OptionalArgsOperationId>(
    operationId: K,
    args?: OperationArgs<NoInfer<K>>,
  ): OperationReturn<K>;
  request<K extends OperationId>(
    operationId: K,
    args: OperationArgs<NoInfer<K>>,
  ): OperationReturn<K>;
  request<T>(
    method: string,
    path: string,
    opts?: { body?: unknown; query?: Query; raw?: boolean; headers?: Record<string, string> },
  ): Promise<T>;
  request(a: string, b?: unknown, c?: unknown): unknown {
    if (typeof b === 'string') {
      return this.http(a, b, (c ?? {}) as Parameters<ForumulateClient['http']>[2]);
    }
    const route = routeTable().byId.get(a);
    if (!route) return Promise.reject(new TypeError(`Unknown operationId "${a}"`));
    return this.invoke(route, b as Record<string, unknown> | undefined);
  }

  /**
   * Every row of a paged operation, across every page — the same walk a
   * namespace `list` gives, by operationId.
   *
   * ```ts
   * for await (const space of forumulate.paginate('Space_list', { orgId })) { … }
   * ```
   */
  paginate<K extends PagedOperationId & OptionalArgsOperationId>(
    operationId: K,
    args?: OperationArgs<NoInfer<K>>,
  ): AsyncIterable<OperationRow<K>>;
  paginate<K extends PagedOperationId>(
    operationId: K,
    args: OperationArgs<NoInfer<K>>,
  ): AsyncIterable<OperationRow<K>>;
  paginate(operationId: string, args?: unknown): AsyncIterable<unknown> {
    const route = routeTable().byId.get(operationId);
    if (!route?.flags.includes('p'))
      throw new TypeError(`"${operationId}" is not a paged operation`);
    return this.invoke(
      route,
      args as Record<string, unknown> | undefined,
    ) as AsyncIterable<unknown>;
  }

  /**
   * Fully-typed request against ANY endpoint in the OpenAPI spec, by path.
   *
   * The generated `paths` interface (`src/schema.ts`, produced from
   * `openapi.json`) infers the path params, query params, JSON body and success
   * response for the `(method, path)` you pass. Path templates like
   * `/orgs/{orgId}/spaces` are filled from `init.params`.
   *
   * ```ts
   * const { spaces } = await forumulate.typed('get', '/orgs/{orgId}/spaces', {
   *   params: { orgId }, query: { limit: 50 },
   * });
   * ```
   */
  typed<P extends keyof paths, M extends keyof paths[P] & HttpMethod>(
    method: M,
    path: P,
    init: TypedRequestInit<paths[P][M]>,
  ): Promise<TypedResponse<paths[P][M]>> {
    const opts = (init ?? {}) as unknown as {
      params?: Record<string, string | number | boolean>;
      query?: Query;
      body?: unknown;
      raw?: boolean;
      headers?: Record<string, string>;
    };
    let concrete = path as string;
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        concrete = concrete.replace(`{${k}}`, encodeURIComponent(String(v)));
      }
    }
    return this.http(String(method).toUpperCase(), concrete, {
      body: opts.body,
      query: opts.query,
      raw: opts.raw,
      // Without this the one header `POST …/items` requires could not be sent
      // through the typed surface that declares the route.
      headers: opts.headers,
    }) as Promise<TypedResponse<paths[P][M]>>;
  }

  /** The 0.5 door: no version stated unless the client pins one. */
  private http<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Query; raw?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T> {
    return send<T>(this.transport, { method, path, ...opts, version: this.apiVersion });
  }

  /** The generated door: path filled from the args, version always stated, lists iterable. */
  private readonly invoke = (route: Route, args?: Record<string, unknown>): unknown => {
    let resolved: ReturnType<typeof resolveArgs>;
    try {
      resolved = resolveArgs(route, args);
    } catch (err) {
      return Promise.reject(err);
    }
    const { query, ...rest } = resolved;
    const kind = route.flags.includes('b') ? 'binary' : route.flags.includes('t') ? 'text' : 'json';
    const fetchPage = (q: Record<string, unknown>) =>
      send(this.transport, {
        ...rest,
        method: route.method,
        query: q as Query,
        kind,
        version: this.apiVersion ?? API_VERSION,
      });
    if (route.flags.includes('p')) return pagePromise(fetchPage, query ?? {});
    return fetchPage(query ?? {});
  };

  private ns<N extends NamespaceName, H extends object>(name: N, hw: H): Merged<Namespace<N>, H> {
    return mergeNamespace(
      buildNamespace(name, this.invoke),
      hw as Record<string, unknown>,
    ) as Merged<Namespace<N>, H>;
  }

  private readonly helpers = positionalHelpers((method, path, opts) =>
    this.http(method, path, opts),
  );

  // ── Namespaces with 0.5 helpers laid over the generated methods ─────────────
  readonly auth = this.ns('auth', this.helpers.auth);
  readonly content = this.ns(
    'content',
    contentApi((method, path, opts) => this.http(method, path, opts)),
  );
  /** Translations of every kind of piece, routed by space type — see ./translations. */
  readonly translations = translationsApi((method, path, opts) => this.http(method, path, opts));
  readonly orgs = this.ns('orgs', this.helpers.orgs);
  readonly spaces = this.ns('spaces', this.helpers.spaces);
  readonly shapes = this.ns('shapes', this.helpers.shapes);
  readonly items = this.ns('items', this.helpers.items);
  readonly domains = this.ns('domains', this.helpers.domains);
  readonly webhooks = this.ns('webhooks', this.helpers.webhooks);
  readonly snapshots = this.ns('snapshots', this.helpers.snapshots);
  readonly forum = this.ns('forum', this.helpers.forum);
  readonly search = this.ns('search', this.helpers.search);
  readonly analytics = this.ns('analytics', this.helpers.analytics);
  readonly public = this.ns('public', this.helpers.public);
}
