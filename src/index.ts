export * from './types';
export { verifyWebhookSignature, type VerifyWebhookInput } from './webhooks';
export * from './content';
export type { paths } from './schema';
export type { HttpMethod, MethodsOf, OperationOf, TypedRequestInit, TypedResponse } from './typed';
import type { paths } from './schema';
import type { HttpMethod, TypedRequestInit, TypedResponse } from './typed';
import { contentApi } from './content';
import type {
  Organization,
  Space,
  SpaceType,
  SpaceVisibility,
  Collection,
  Page,
  BlockDoc,
  SearchHit,
  UnifiedHit,
  Comment,
  Webhook,
  WebhookFormat,
  PublicPage,
  Conformance,
  DomainSetup,
  DomainSummary,
  Item,
  PageInfo,
  EffectiveShape,
  ShapeOverride,
} from './types';

/** Thrown for any non-2xx API response. Mirrors the API's error envelope. */
export class ForumulateError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ForumulateError';
  }
}

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
}

type Query = Record<string, string | number | boolean | undefined>;

/**
 * Typed client for the Forumulate REST API.
 *
 * ```ts
 * const forumulate = new ForumulateClient({ baseUrl: 'https://forumulate.com/api', token: pat });
 * const { orgs } = await forumulate.orgs.list();
 *
 * // or, from FORUMULATE_TOKEN / FORUMULATE_URL:
 * const fromEnv = ForumulateClient.fromEnv();
 * ```
 */
export class ForumulateClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly credentials: boolean;
  private readonly defaultHeaders: Record<string, string>;
  private readonly _fetch: typeof fetch;

  constructor(opts: ForumulateClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.credentials = opts.credentials ?? false;
    this.defaultHeaders = { ...(opts.headers ?? {}) };
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error('No fetch implementation available — pass one via options.fetch.');
    this._fetch = f;
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

  /** Low-level request. Exposed so callers can reach endpoints the typed helpers don't cover yet. */
  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Query; raw?: boolean; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    /*
     * Ours first, the caller's last, so a per-request header wins.
     *
     * `Idempotency-Key` has to be per-REQUEST (a key reused across two
     * different writes is worse than none), and `Forumulate-Version` is
     * naturally per-client — so both layers exist and the narrower one
     * overrides. `Content-Type` is set before the caller's so a multipart or
     * ndjson body can correct it rather than be forced to JSON.
     */
    const headers: Record<string, string> = { ...this.defaultHeaders };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    Object.assign(headers, opts.headers ?? {});

    const res = await this._fetch(url.toString(), {
      method,
      headers,
      credentials: this.credentials ? 'include' : 'same-origin',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (opts.raw) {
      if (!res.ok) throw await this.toError(res);
      return res as unknown as T;
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const err = (json?.error ?? {}) as { code?: string; message?: string };
      throw new ForumulateError(res.status, err.code ?? 'error', err.message ?? res.statusText);
    }
    return json as T;
  }

  /**
   * Fully-typed request against ANY endpoint in the OpenAPI spec.
   *
   * Where the ~30 hand-written helpers above cover the stable, ergonomic
   * surface, `typed` covers the *whole* API: the generated `paths` interface
   * (`src/schema.ts`, produced from `openapi.json`) infers the path params,
   * query params, JSON body and success response for the `(method, path)` you
   * pass, so every one of the 600+ routes gets types and autocomplete without a
   * bespoke wrapper. Path templates like `/orgs/{orgId}/spaces` are filled from
   * `init.params`.
   *
   * ```ts
   * // GET a list — path param is required and checked; response is typed.
   * const { spaces } = await forumulate.typed('get', '/orgs/{orgId}/spaces', {
   *   params: { orgId }, query: { deleted: 'false', limit: '50', cursor: '' },
   * });
   *
   * // POST with a body the spec knows the shape of.
   * await forumulate.typed('post', '/orgs/{orgId}/spaces', {
   *   params: { orgId },
   *   body: { name: 'Docs', slug: 'docs', type: 'DOCS', visibility: 'PUBLIC' },
   * });
   * ```
   *
   * Regenerate the types after an API change with
   * `pnpm --filter @forumulate/sdk dump-spec` then
   * `npx openapi-typescript packages/sdk/openapi.json -o src/schema.ts`.
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
    return this.request(String(method).toUpperCase(), concrete, {
      body: opts.body,
      query: opts.query,
      raw: opts.raw,
      // Without this the one header `POST …/items` requires could not be sent
      // through the typed surface that declares the route.
      headers: opts.headers,
    }) as Promise<TypedResponse<paths[P][M]>>;
  }

  private async toError(res: Response): Promise<ForumulateError> {
    let code = 'error';
    let message = res.statusText;
    try {
      const j = await res.json();
      code = j?.error?.code ?? code;
      message = j?.error?.message ?? message;
    } catch {
      /* non-JSON body */
    }
    return new ForumulateError(res.status, code, message);
  }

  // ── Identity ──────────────────────────────────────────────────────────────
  readonly auth = {
    register: (input: { email: string; name: string; password: string }) =>
      this.request<{ user: { id: string; email: string } }>('POST', '/auth/register', {
        body: input,
      }),
    login: (input: { email: string; password: string }) =>
      this.request<{ user: { id: string; email: string } }>('POST', '/auth/login', { body: input }),
    me: () =>
      this.request<{ user: { id: string; email: string; name: string } }>('GET', '/auth/me'),
    /** Mint a Personal Access Token (requires an authenticated session). */
    createToken: (input: { name: string; scopes?: string[] }) =>
      this.request<{ token: string; pat: { id: string; name: string } }>('POST', '/pats', {
        body: input,
      }),
  };

  // ── Content libraries (headless CMS) — see ./content ───────────────────────
  readonly content = contentApi((method, path, opts) => this.request(method, path, opts));

  // ── Organizations ─────────────────────────────────────────────────────────
  readonly orgs = {
    list: () => this.request<{ orgs: Organization[] }>('GET', '/orgs'),
    create: (input: { name: string; slug: string }) =>
      this.request<{ organization: Organization }>('POST', '/orgs', { body: input }),
  };

  // ── Spaces & content ───────────────────────────────────────────────────────
  readonly spaces = {
    list: (orgId: string) => this.request<{ spaces: Space[] }>('GET', `/orgs/${orgId}/spaces`),
    create: (
      orgId: string,
      input: { name: string; slug: string; type: SpaceType; visibility: SpaceVisibility },
    ) => this.request<{ space: Space }>('POST', `/orgs/${orgId}/spaces`, { body: input }),
    createCollection: (orgId: string, spaceId: string, input: { name: string; slug: string }) =>
      this.request<{ collection: Collection }>(
        'POST',
        `/orgs/${orgId}/spaces/${spaceId}/collections`,
        { body: input },
      ),
    createPage: (
      orgId: string,
      spaceId: string,
      collectionId: string,
      input: { title: string; slug: string },
    ) =>
      this.request<{ page: Page }>(
        'POST',
        `/orgs/${orgId}/spaces/${spaceId}/collections/${collectionId}/pages`,
        { body: input },
      ),
    setPageContent: (
      orgId: string,
      spaceId: string,
      pageId: string,
      input: { title: string; content: BlockDoc },
    ) =>
      this.request<{ page: Page }>(
        'PUT',
        `/orgs/${orgId}/spaces/${spaceId}/pages/${pageId}/content`,
        { body: input },
      ),
    publishPage: (orgId: string, spaceId: string, pageId: string) =>
      this.request<{ page: Page }>(
        'POST',
        `/orgs/${orgId}/spaces/${spaceId}/pages/${pageId}/publish`,
        { body: {} },
      ),
  };

  /**
   * Shapes and pieces — the surface an agent works through.
   *
   * `shape` says what one piece of a space is made of and hands back JSON
   * Schema; `items` writes one, whatever a piece happens to be in that space:
   * a documentation page, a blog post, a release, an incident. The reply says
   * which required sections are still empty, so an agent can create a piece,
   * ask what it forgot, and close the gap.
   */
  readonly shapes = {
    get: (orgId: string, spaceId: string) =>
      this.request<{
        shape: EffectiveShape;
        base: EffectiveShape;
        presets: { name: string; label: string; description: string }[];
        jsonSchema: Record<string, unknown>;
      }>('GET', `/orgs/${orgId}/spaces/${spaceId}/shape`),
    set: (orgId: string, spaceId: string, patch: ShapeOverride) =>
      this.request<{ shape: EffectiveShape }>('PUT', `/orgs/${orgId}/spaces/${spaceId}/shape`, {
        body: patch,
      }),
    applyPreset: (orgId: string, spaceId: string, name: string) =>
      this.request<{ shape: EffectiveShape }>(
        'POST',
        `/orgs/${orgId}/spaces/${spaceId}/shape/presets/${name}`,
        {
          body: {},
        },
      ),
  };

  readonly items = {
    create: (
      orgId: string,
      spaceId: string,
      input: {
        title: string;
        slug?: string;
        /** Which kind of piece, where the space holds more than one. */
        preset?: string | null;
        sections?: Record<string, string>;
        body?: string;
        params?: Record<string, unknown>;
      },
    ) =>
      this.request<{ item: Item }>('POST', `/orgs/${orgId}/spaces/${spaceId}/items`, {
        body: input,
      }),
    /**
     * What is in a space: how something finds a piece it has no words for.
     *
     * Pass `include: ['body']` to get content. Asking for `sections` ALONE is
     * the trap: it is populated only for pieces written against a shape, so a
     * space of free-form pages answers with empty objects and a sync carries
     * nothing while reporting success. Every row says which field holds its
     * content in `contentIn`.
     *
     * Any option here puts the response in its paged form, so `page` and
     * `sync` come back — `page.total` is what a walk should check its own
     * count against, and `sync.checkpoint` is what an incremental sync stores.
     */
    list: (
      orgId: string,
      spaceId: string,
      opts:
        | number
        | {
            limit?: number;
            include?: ('sections' | 'body')[];
            cursor?: string;
            /** A `sync.checkpoint` from a previous walk, not a timestamp you made. */
            updatedSince?: string;
            includeDeleted?: boolean;
            fields?: string[];
          } = {},
    ) => {
      // A bare number used to be the whole signature; keep it working.
      const o = typeof opts === 'number' ? { limit: opts } : opts;
      const query: Record<string, string | number> = {};
      if (o.limit) query.limit = o.limit;
      if (o.include?.length) query.include = o.include.join(',');
      if (o.cursor) query.cursor = o.cursor;
      if (o.updatedSince) query.updated_since = o.updatedSince;
      if (o.includeDeleted) query.include_deleted = 'true';
      if (o.fields?.length) query.fields = o.fields.join(',');
      return this.request<{ items: Item[]; page?: PageInfo; sync?: { checkpoint: string } }>(
        'GET',
        `/orgs/${orgId}/spaces/${spaceId}/items`,
        { query },
      );
    },
    get: (orgId: string, spaceId: string, itemId: string) =>
      this.request<{ item: Item & { sections: Record<string, string> } }>(
        'GET',
        `/orgs/${orgId}/spaces/${spaceId}/items/${itemId}`,
      ),
    /**
     * Make it readable. Kinds that are live on creation say so and change nothing.
     *
     * `conformance` describes the piece AFTER publishing — which declared slots
     * are filled and which are still missing — so an agent that has just made
     * its work readable can tell a complete piece from one with holes in it
     * without fetching it again. The server has always sent it and this type
     * omitted it, so a TypeScript caller could not see the field the docs
     * promise (E-11).
     */
    publish: (orgId: string, spaceId: string, itemId: string) =>
      this.request<{ published: boolean; note?: string; conformance: Conformance }>(
        'POST',
        `/orgs/${orgId}/spaces/${spaceId}/items/${itemId}/publish`,
        { body: {} },
      ),
    /**
     * Replace a piece's whole body — as markdown, or as blocks.
     *
     * The create door has always taken markdown and this one took blocks only,
     * so "make it from this file" worked and "update it from the same file" did
     * not. Both now; blocks win if a caller sends both.
     */
    setContent: (
      orgId: string,
      spaceId: string,
      itemId: string,
      input: { body?: string; content?: BlockDoc },
    ) =>
      this.request<{ conformance: Conformance }>(
        'PUT',
        `/orgs/${orgId}/spaces/${spaceId}/items/${itemId}/content`,
        { body: input },
      ),
    /** Replace one named section. Idempotent — sending it twice writes it once. */
    setSection: (orgId: string, spaceId: string, itemId: string, key: string, markdown: string) =>
      this.request<{ conformance: Conformance }>(
        'PUT',
        `/orgs/${orgId}/spaces/${spaceId}/items/${itemId}/sections/${key}`,
        { body: { markdown } },
      ),
  };

  /**
   * The addresses a space answers at.
   *
   * Published because the question a customer asks about a custom domain —
   * "why is it not live yet" — is answerable only from `verified`, `active` and
   * the setup records, and the SDK could not reach any of them (DX-2). A failed
   * verification is a 200 with `verified: false`: read the body, not the status.
   */
  readonly domains = {
    list: (orgId: string, spaceId: string) =>
      this.request<{ domains: DomainSummary[] }>('GET', `/orgs/${orgId}/spaces/${spaceId}/domains`),
    add: (orgId: string, spaceId: string, input: { hostname: string; basePath?: string }) =>
      this.request<{ domain: DomainSummary }>('POST', `/orgs/${orgId}/spaces/${spaceId}/domains`, {
        body: input,
      }),
    /** Re-run the ownership check. `activate: false` proves it without switching traffic. */
    verify: (orgId: string, spaceId: string, domainId: string, activate = true) =>
      this.request<{ domain: DomainSummary }>(
        'POST',
        `/orgs/${orgId}/spaces/${spaceId}/domains/${domainId}/verify`,
        { body: { activate } },
      ),
    /** Switch traffic to an address whose ownership is already proven. */
    activate: (orgId: string, spaceId: string, domainId: string) =>
      this.request<{ domain: DomainSummary }>(
        'POST',
        `/orgs/${orgId}/spaces/${spaceId}/domains/${domainId}/activate`,
        { body: {} },
      ),
    /** What to configure, and what is still missing. */
    setup: (orgId: string, spaceId: string, domainId: string) =>
      this.request<DomainSetup>(
        'GET',
        `/orgs/${orgId}/spaces/${spaceId}/domains/${domainId}/setup`,
      ),
  };

  // ── Webhooks ───────────────────────────────────────────────────────────────
  readonly webhooks = {
    list: (orgId: string) =>
      this.request<{ webhooks: Webhook[] }>('GET', `/orgs/${orgId}/webhooks`),
    create: (orgId: string, input: { url: string; events: string[]; format?: WebhookFormat }) =>
      this.request<{ webhook: Webhook }>('POST', `/orgs/${orgId}/webhooks`, { body: input }),
  };

  // ── Space snapshots (version history) ───────────────────────────────────────
  readonly snapshots = {
    list: (orgId: string, spaceId: string) =>
      this.request<{ snapshots: unknown[] }>('GET', `/orgs/${orgId}/spaces/${spaceId}/snapshots`),
    create: (orgId: string, spaceId: string, label: string) =>
      this.request<{ snapshot: unknown }>('POST', `/orgs/${orgId}/spaces/${spaceId}/snapshots`, {
        body: { label },
      }),
    restore: (orgId: string, spaceId: string, id: string) =>
      this.request<{ restored: number; skipped: number }>(
        'POST',
        `/orgs/${orgId}/spaces/${spaceId}/snapshots/${id}/restore`,
        { body: {} },
      ),
  };

  // ── Community (forum topics) ────────────────────────────────────────────────
  readonly forum = {
    listTopics: (
      orgId: string,
      spaceId: string,
      query: { sort?: string; category?: string; page?: number } = {},
    ) =>
      this.request<{ topics: unknown[]; hasMore?: boolean }>(
        'GET',
        `/orgs/${orgId}/spaces/${spaceId}/forum`,
        { query },
      ),
    createTopic: (
      orgId: string,
      spaceId: string,
      input: {
        title: string;
        content: BlockDoc;
        kind?: string;
        tags?: string[];
        categoryId?: string | null;
      },
    ) =>
      this.request<{ topic: unknown }>('POST', `/orgs/${orgId}/spaces/${spaceId}/forum`, {
        body: input,
      }),
    reply: (orgId: string, spaceId: string, topicId: string, content: BlockDoc) =>
      this.request<{ post: unknown }>(
        'POST',
        `/orgs/${orgId}/spaces/${spaceId}/forum/${topicId}/replies`,
        { body: { content } },
      ),
  };

  // ── Search & analytics (org-level) ──────────────────────────────────────────
  readonly search = {
    unified: (orgId: string, q: string, opts: { type?: string; limit?: number } = {}) =>
      this.request<{ hits: UnifiedHit[] }>('GET', `/orgs/${orgId}/search`, {
        query: { q, ...opts },
      }),
  };
  readonly analytics = {
    orgEvents: (orgId: string, days?: number) =>
      this.request<unknown>('GET', `/orgs/${orgId}/analytics/events`, {
        query: days ? { days } : {},
      }),
  };

  // ── Public reader (no auth required) ────────────────────────────────────────
  readonly public = {
    getPage: (orgId: string, spaceId: string, pageId: string) =>
      this.request<PublicPage>('GET', `/public/orgs/${orgId}/spaces/${spaceId}/pages/${pageId}`),
    search: (orgId: string, spaceId: string, query: string) =>
      this.request<{ hits: SearchHit[] }>('GET', `/public/orgs/${orgId}/spaces/${spaceId}/search`, {
        query: { q: query },
      }),
    listComments: (orgId: string, spaceId: string, pageId: string) =>
      this.request<{ comments: Comment[] }>(
        'GET',
        `/public/orgs/${orgId}/spaces/${spaceId}/pages/${pageId}/comments`,
      ),
    postComment: (
      orgId: string,
      spaceId: string,
      pageId: string,
      input: { authorName: string; body: string; parentId?: string | null },
    ) =>
      this.request<{ comment: Comment }>(
        'POST',
        `/public/orgs/${orgId}/spaces/${spaceId}/pages/${pageId}/comments`,
        { body: input },
      ),
    reactToComment: (orgId: string, spaceId: string, commentId: string, emoji: string) =>
      this.request<{ comment: Comment }>(
        'POST',
        `/public/orgs/${orgId}/spaces/${spaceId}/comments/${commentId}/react`,
        { body: { emoji } },
      ),
    /** Download the whole space as a PDF. Returns the raw `Response` (read `.blob()` / `.arrayBuffer()`). */
    pdf: (orgId: string, spaceId: string) =>
      this.request<Response>('GET', `/public/orgs/${orgId}/spaces/${spaceId}/pdf`, { raw: true }),
  };
}
