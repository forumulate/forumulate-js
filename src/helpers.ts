/**
 * The positional helpers from 0.5 — `forumulate.spaces.create(orgId, input)`.
 *
 * They predate the generated namespaces and keep their signatures because
 * code in the wild calls them. Each one wins its name inside its namespace
 * (see `Merged` in resources.ts); every operation they do not cover is
 * generated beside them. `coverage.test.ts` records which operation each one
 * calls, so a helper cannot silently hide a different route.
 */
import type { Query } from './http';
import { constructWebhookEvent, verifyWebhookSignature } from './webhooks';
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

export type HelperRequest = <T>(
  method: string,
  path: string,
  opts?: { body?: unknown; query?: Query; raw?: boolean; headers?: Record<string, string> },
) => Promise<T>;

export function positionalHelpers(request: HelperRequest) {
  return {
    // ── Identity ──────────────────────────────────────────────────────────────
    auth: {
      // `register` and `login` were removed in 0.6: the Atlas cutover removed `/auth/register`
      // and `/auth/login`, so both failed for every caller. Sign-in is Atlas (a browser
      // flow); an integration authenticates with a Personal Access Token.
      me: () => request<{ user: { id: string; email: string; name: string } }>('GET', '/auth/me'),
      /** Mint a Personal Access Token (requires an authenticated session). */
      createToken: (input: { name: string; scopes?: string[] }) =>
        request<{ token: string; pat: { id: string; name: string } }>('POST', '/pats', {
          body: input,
        }),
    },

    // ── Organizations ─────────────────────────────────────────────────────────
    orgs: {
      list: () => request<{ orgs: Organization[] }>('GET', '/orgs'),
      create: (input: { name: string; slug: string }) =>
        request<{ organization: Organization }>('POST', '/orgs', { body: input }),
    },

    // ── Spaces & content ───────────────────────────────────────────────────────
    spaces: {
      list: (orgId: string) => request<{ spaces: Space[] }>('GET', `/orgs/${orgId}/spaces`),
      create: (
        orgId: string,
        input: { name: string; slug: string; type: SpaceType; visibility: SpaceVisibility },
      ) => request<{ space: Space }>('POST', `/orgs/${orgId}/spaces`, { body: input }),
      createCollection: (orgId: string, spaceId: string, input: { name: string; slug: string }) =>
        request<{ collection: Collection }>(
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
        request<{ page: Page }>(
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
        request<{ page: Page }>('PUT', `/orgs/${orgId}/spaces/${spaceId}/pages/${pageId}/content`, {
          body: input,
        }),
      publishPage: (orgId: string, spaceId: string, pageId: string) =>
        request<{ page: Page }>(
          'POST',
          `/orgs/${orgId}/spaces/${spaceId}/pages/${pageId}/publish`,
          { body: {} },
        ),
    },

    /**
     * Shapes and pieces — the surface an agent works through.
     *
     * `shape` says what one piece of a space is made of and hands back JSON
     * Schema; `items` writes one, whatever a piece happens to be in that space:
     * a documentation page, a blog post, a release, an incident. The reply says
     * which required sections are still empty, so an agent can create a piece,
     * ask what it forgot, and close the gap.
     */
    shapes: {
      get: (orgId: string, spaceId: string) =>
        request<{
          shape: EffectiveShape;
          base: EffectiveShape;
          presets: { name: string; label: string; description: string }[];
          jsonSchema: Record<string, unknown>;
        }>('GET', `/orgs/${orgId}/spaces/${spaceId}/shape`),
      set: (orgId: string, spaceId: string, patch: ShapeOverride) =>
        request<{ shape: EffectiveShape }>('PUT', `/orgs/${orgId}/spaces/${spaceId}/shape`, {
          body: patch,
        }),
      applyPreset: (orgId: string, spaceId: string, name: string) =>
        request<{ shape: EffectiveShape }>(
          'POST',
          `/orgs/${orgId}/spaces/${spaceId}/shape/presets/${name}`,
          {
            body: {},
          },
        ),
    },

    items: {
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
        request<{ item: Item }>('POST', `/orgs/${orgId}/spaces/${spaceId}/items`, {
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
        return request<{ items: Item[]; page?: PageInfo; sync?: { checkpoint: string } }>(
          'GET',
          `/orgs/${orgId}/spaces/${spaceId}/items`,
          { query },
        );
      },
      get: (orgId: string, spaceId: string, itemId: string) =>
        request<{ item: Item & { sections: Record<string, string> } }>(
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
        request<{ published: boolean; note?: string; conformance: Conformance }>(
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
        request<{ conformance: Conformance }>(
          'PUT',
          `/orgs/${orgId}/spaces/${spaceId}/items/${itemId}/content`,
          { body: input },
        ),
      /** Replace one named section. Idempotent — sending it twice writes it once. */
      setSection: (orgId: string, spaceId: string, itemId: string, key: string, markdown: string) =>
        request<{ conformance: Conformance }>(
          'PUT',
          `/orgs/${orgId}/spaces/${spaceId}/items/${itemId}/sections/${key}`,
          { body: { markdown } },
        ),
    },

    /**
     * The addresses a space answers at.
     *
     * Published because the question a customer asks about a custom domain —
     * "why is it not live yet" — is answerable only from `verified`, `active` and
     * the setup records, and the SDK could not reach any of them (DX-2). A failed
     * verification is a 200 with `verified: false`: read the body, not the status.
     */
    domains: {
      list: (orgId: string, spaceId: string) =>
        request<{ domains: DomainSummary[] }>('GET', `/orgs/${orgId}/spaces/${spaceId}/domains`),
      add: (orgId: string, spaceId: string, input: { hostname: string; basePath?: string }) =>
        request<{ domain: DomainSummary }>('POST', `/orgs/${orgId}/spaces/${spaceId}/domains`, {
          body: input,
        }),
      /** Re-run the ownership check. `activate: false` proves it without switching traffic. */
      verify: (orgId: string, spaceId: string, domainId: string, activate = true) =>
        request<{ domain: DomainSummary }>(
          'POST',
          `/orgs/${orgId}/spaces/${spaceId}/domains/${domainId}/verify`,
          { body: { activate } },
        ),
      /** Switch traffic to an address whose ownership is already proven. */
      activate: (orgId: string, spaceId: string, domainId: string) =>
        request<{ domain: DomainSummary }>(
          'POST',
          `/orgs/${orgId}/spaces/${spaceId}/domains/${domainId}/activate`,
          { body: {} },
        ),
      /** What to configure, and what is still missing. */
      setup: (orgId: string, spaceId: string, domainId: string) =>
        request<DomainSetup>('GET', `/orgs/${orgId}/spaces/${spaceId}/domains/${domainId}/setup`),
    },

    // ── Webhooks ───────────────────────────────────────────────────────────────
    webhooks: {
      list: (orgId: string) => request<{ webhooks: Webhook[] }>('GET', `/orgs/${orgId}/webhooks`),
      create: (orgId: string, input: { url: string; events: string[]; format?: WebhookFormat }) =>
        request<{ webhook: Webhook }>('POST', `/orgs/${orgId}/webhooks`, { body: input }),
      /** Check a delivery's `X-Forumulate-Signature`; see {@link verifyWebhookSignature}. */
      verifySignature: verifyWebhookSignature,
      /** Verify a delivery and parse it; throws when the signature does not hold. */
      constructEvent: constructWebhookEvent,
    },

    // ── Space snapshots (version history) ───────────────────────────────────────
    snapshots: {
      list: (orgId: string, spaceId: string) =>
        request<{ snapshots: unknown[] }>('GET', `/orgs/${orgId}/spaces/${spaceId}/snapshots`),
      create: (orgId: string, spaceId: string, label: string) =>
        request<{ snapshot: unknown }>('POST', `/orgs/${orgId}/spaces/${spaceId}/snapshots`, {
          body: { label },
        }),
      restore: (orgId: string, spaceId: string, id: string) =>
        request<{ restored: number; skipped: number }>(
          'POST',
          `/orgs/${orgId}/spaces/${spaceId}/snapshots/${id}/restore`,
          { body: {} },
        ),
    },

    // ── Community (forum topics) ────────────────────────────────────────────────
    forum: {
      listTopics: (
        orgId: string,
        spaceId: string,
        query: { sort?: string; category?: string; page?: number } = {},
      ) =>
        request<{ topics: unknown[]; hasMore?: boolean }>(
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
        request<{ topic: unknown }>('POST', `/orgs/${orgId}/spaces/${spaceId}/forum`, {
          body: input,
        }),
      reply: (orgId: string, spaceId: string, topicId: string, content: BlockDoc) =>
        request<{ post: unknown }>(
          'POST',
          `/orgs/${orgId}/spaces/${spaceId}/forum/${topicId}/replies`,
          { body: { content } },
        ),
    },

    // ── Search & analytics (org-level) ──────────────────────────────────────────
    search: {
      unified: (orgId: string, q: string, opts: { type?: string; limit?: number } = {}) =>
        request<{ hits: UnifiedHit[] }>('GET', `/orgs/${orgId}/search`, {
          query: { q, ...opts },
        }),
    },
    analytics: {
      orgEvents: (orgId: string, days?: number) =>
        request<unknown>('GET', `/orgs/${orgId}/analytics/events`, {
          query: days ? { days } : {},
        }),
    },

    // ── Public reader (no auth required) ────────────────────────────────────────
    public: {
      getPage: (orgId: string, spaceId: string, pageId: string) =>
        request<PublicPage>('GET', `/public/orgs/${orgId}/spaces/${spaceId}/pages/${pageId}`),
      search: (orgId: string, spaceId: string, query: string) =>
        request<{ hits: SearchHit[] }>('GET', `/public/orgs/${orgId}/spaces/${spaceId}/search`, {
          query: { q: query },
        }),
      listComments: (orgId: string, spaceId: string, pageId: string) =>
        request<{ comments: Comment[] }>(
          'GET',
          `/public/orgs/${orgId}/spaces/${spaceId}/pages/${pageId}/comments`,
        ),
      postComment: (
        orgId: string,
        spaceId: string,
        pageId: string,
        input: { authorName: string; body: string; parentId?: string | null },
      ) =>
        request<{ comment: Comment }>(
          'POST',
          `/public/orgs/${orgId}/spaces/${spaceId}/pages/${pageId}/comments`,
          { body: input },
        ),
      reactToComment: (orgId: string, spaceId: string, commentId: string, emoji: string) =>
        request<{ comment: Comment }>(
          'POST',
          `/public/orgs/${orgId}/spaces/${spaceId}/comments/${commentId}/react`,
          { body: { emoji } },
        ),
      /** Download the whole space as a PDF. Returns the raw `Response` (read `.blob()` / `.arrayBuffer()`). */
      pdf: (orgId: string, spaceId: string) =>
        request<Response>('GET', `/public/orgs/${orgId}/spaces/${spaceId}/pdf`, { raw: true }),
    },
  };
}

export type PositionalHelpers = ReturnType<typeof positionalHelpers>;
