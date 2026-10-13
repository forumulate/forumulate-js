import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { ForumulateClient, ForumulateError } from './index';
import type { TypedRequestInit, TypedResponse, paths } from './index';

/** Build a client backed by a scripted fetch that records the calls it receives. */
function harness(responses: Array<{ status?: number; body: unknown }>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] =
    [];
  let i = 0;
  const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
    const r = responses[Math.min(i++, responses.length - 1)]!;
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      statusText: 'x',
      text: async () => JSON.stringify(r.body),
      json: async () => r.body,
    } as unknown as Response;
  });
  const client = new ForumulateClient({
    baseUrl: 'http://api.test/',
    token: 'pat_abc',
    fetch: fakeFetch as unknown as typeof fetch,
  });
  return { client, calls };
}

describe('ForumulateClient', () => {
  it('sends bearer auth and parses the response', async () => {
    const { client, calls } = harness([
      { body: { orgs: [{ id: 'o1', name: 'Acme', slug: 'acme' }] } },
    ]);
    const res = await client.orgs.list();
    expect(res.orgs[0]!.slug).toBe('acme');
    expect(calls[0]!.url).toBe('http://api.test/orgs');
    expect(calls[0]!.headers.Authorization).toBe('Bearer pat_abc');
  });

  it('serializes JSON bodies for writes', async () => {
    const { client, calls } = harness([
      {
        body: {
          space: { id: 's1', name: 'Docs', slug: 'docs', type: 'DOCS', visibility: 'PUBLIC' },
        },
      },
    ]);
    const res = await client.spaces.create('o1', {
      name: 'Docs',
      slug: 'docs',
      type: 'DOCS',
      visibility: 'PUBLIC',
    });
    expect(res.space.id).toBe('s1');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      name: 'Docs',
      slug: 'docs',
      type: 'DOCS',
      visibility: 'PUBLIC',
    });
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
  });

  it('builds query strings for public search', async () => {
    const { client, calls } = harness([{ body: { hits: [] } }]);
    await client.public.search('o1', 's1', 'hello world');
    expect(calls[0]!.url).toBe('http://api.test/public/orgs/o1/spaces/s1/search?q=hello+world');
    // Public reader calls still carry no auth requirement, but bearer is harmless.
    expect(calls[0]!.method).toBe('GET');
  });

  it('posts an emoji reaction to a comment', async () => {
    const { client, calls } = harness([
      {
        body: {
          comment: {
            id: 'c1',
            parentId: null,
            authorName: 'A',
            body: 'hi',
            status: 'visible',
            reactions: { '👍': 1 },
            createdAt: 'now',
          },
        },
      },
    ]);
    const res = await client.public.reactToComment('o1', 's1', 'c1', '👍');
    expect(res.comment.reactions['👍']).toBe(1);
    expect(calls[0]!.url).toBe('http://api.test/public/orgs/o1/spaces/s1/comments/c1/react');
    expect(calls[0]!.body).toEqual({ emoji: '👍' });
  });

  it('throws a typed ForumulateError on non-2xx', async () => {
    const { client } = harness([
      { status: 403, body: { error: { code: 'rbac.forbidden', message: 'Nope' } } },
    ]);
    await expect(client.orgs.create({ name: 'x', slug: 'x' })).rejects.toMatchObject({
      name: 'ForumulateError',
      status: 403,
      code: 'rbac.forbidden',
      message: 'Nope',
    });
    await expect(client.orgs.create({ name: 'x', slug: 'x' })).rejects.toBeInstanceOf(
      ForumulateError,
    );
  });

  it('returns the raw Response for binary PDF downloads', async () => {
    const { client } = harness([{ body: {} }]);
    const res = await client.public.pdf('o1', 's1');
    expect(res.ok).toBe(true);
  });
});

describe('shapes and items', () => {
  it('asks a space what one of its pieces is made of', async () => {
    const { client, calls } = harness([{ body: { shape: { sections: [] }, jsonSchema: {} } }]);
    await client.shapes.get('o1', 's1');
    expect(calls[0]!.url).toBe('http://api.test/orgs/o1/spaces/s1/shape');
  });

  it('writes a piece from markdown per section', async () => {
    const { client, calls } = harness([
      {
        status: 201,
        body: {
          item: {
            id: 'i1',
            kind: 'topic',
            title: 'Post',
            conformance: { conforms: true, missing: [], extra: [], duplicate: [] },
          },
        },
      },
    ]);
    const { item } = await client.items.create('o1', 's1', {
      title: 'Post',
      sections: { standfirst: 'A line.', body: 'The rest.' },
    });
    expect(item.kind).toBe('topic');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('http://api.test/orgs/o1/spaces/s1/items');
    expect((calls[0]!.body as { sections: Record<string, string> }).sections.standfirst).toBe(
      'A line.',
    );
  });

  it('replaces one section with PUT, so a retry writes it once', async () => {
    const { client, calls } = harness([
      { body: { conformance: { conforms: true, missing: [], extra: [], duplicate: [] } } },
    ]);
    await client.items.setSection('o1', 's1', 'i1', 'summary', 'Written once.');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('http://api.test/orgs/o1/spaces/s1/items/i1/sections/summary');
  });
});

/**
 * Two headers the API expects and the client could not send.
 *
 * `POST /orgs/{orgId}/spaces/{spaceId}/items` REQUIRES `Idempotency-Key`, and
 * `Forumulate-Version` is how a caller pins the API version — so the published
 * SDK advertised 1,225 typed operations and could not call one of them.
 */
describe('headers', () => {
  it('sends client-level headers on every request', async () => {
    const calls: { headers: Record<string, string> }[] = [];
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string> });
      return {
        ok: true,
        status: 200,
        statusText: 'x',
        text: async () => '{}',
      } as unknown as Response;
    });
    const client = new ForumulateClient({
      baseUrl: 'http://api.test',
      token: 'pat_abc',
      headers: { 'Forumulate-Version': '2026-01-01' },
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await client.orgs.list();
    expect(calls[0]!.headers['Forumulate-Version']).toBe('2026-01-01');
    // Still ours as well — a default header must not displace auth.
    expect(calls[0]!.headers.Authorization).toBe('Bearer pat_abc');
  });

  it('sends a per-request header through request()', async () => {
    const { client, calls } = harness([{ body: {} }]);
    await client.request('POST', '/x', { body: { a: 1 }, headers: { 'Idempotency-Key': 'k-1' } });
    expect(calls[0]!.headers['Idempotency-Key']).toBe('k-1');
    expect(calls[0]!.headers['Content-Type']).toBe('application/json');
  });

  it('sends a per-request header through typed()', async () => {
    const { client, calls } = harness([{ status: 201, body: {} }]);
    await client.typed('post', '/orgs/{orgId}/spaces/{spaceId}/items', {
      params: { orgId: 'o1', spaceId: 's1' },
      body: { title: 'A piece' },
      headers: { 'Idempotency-Key': 'k-2' },
    });
    expect(calls[0]!.headers['Idempotency-Key']).toBe('k-2');
  });

  it('lets a per-request header override a client-level one', async () => {
    const calls: { headers: Record<string, string> }[] = [];
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ headers: init.headers as Record<string, string> });
      return {
        ok: true,
        status: 200,
        statusText: 'x',
        text: async () => '{}',
      } as unknown as Response;
    });
    const client = new ForumulateClient({
      baseUrl: 'http://api.test',
      headers: { 'Forumulate-Version': '2026-01-01' },
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await client.request('GET', '/x', { headers: { 'Forumulate-Version': '2026-06-01' } });
    expect(calls[0]!.headers['Forumulate-Version']).toBe('2026-06-01');
  });
});

describe('typed() — generated coverage of the whole API', () => {
  it('fills the path template from params and delegates to request', async () => {
    const { client, calls } = harness([{ body: { spaces: [] } }]);
    await client.typed('get', '/orgs/{orgId}/spaces', {
      params: { orgId: 'o1' },
      // `limit` is a NUMBER and `deleted` a literal union in the published
      // contract now — the API validates query params as strictly as bodies
      // and the spec says so. A snapshot refresh is how that reached here:
      // this test was asserting the looser shape the spec used to publish.
      query: { deleted: 'false', limit: 50, cursor: '' },
    });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('http://api.test/orgs/o1/spaces?deleted=false&limit=50&cursor=');
  });

  it('sends a typed JSON body for a POST route', async () => {
    const { client, calls } = harness([{ status: 201, body: {} }]);
    await client.typed('post', '/orgs/{orgId}/spaces', {
      params: { orgId: 'o1' },
      body: { name: 'Docs', slug: 'docs', type: 'DOCS', visibility: 'PUBLIC' },
    });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('http://api.test/orgs/o1/spaces');
    expect(calls[0]!.body).toEqual({
      name: 'Docs',
      slug: 'docs',
      type: 'DOCS',
      visibility: 'PUBLIC',
    });
  });

  it('infers request-body and param types from the generated schema', () => {
    // Compile-time only: the body of POST /orgs/{orgId}/spaces must accept the
    // spec-declared fields, and its `type` must be the generated enum union.
    type CreateSpace = paths['/orgs/{orgId}/spaces']['post'];
    type Init = TypedRequestInit<CreateSpace>;
    expectTypeOf<Init>().toHaveProperty('params');
    expectTypeOf<Init['params']>().toMatchTypeOf<{ orgId: string }>();
    expectTypeOf<NonNullable<Init['body']>>().toMatchTypeOf<{ name: string; slug: string }>();
    // A route that returns JSON narrows its success payload.
    type Me = TypedResponse<paths['/auth/me']['get']>;
    expectTypeOf<Me>().not.toBeNever();
  });

  it('accepts query params whether the route makes them optional or required', () => {
    /*
     * Compile-time only, and a regression guard with a specific history.
     *
     * openapi-typescript emits `query?: {…}` — an OPTIONAL property — whenever
     * every query parameter on a route is itself optional, and `query: {…}`
     * when at least one is required. `QueryPart` used to match only the
     * required form, so for the all-optional case (the common one) it fell
     * through to `{ query?: undefined }` and `typed()` REFUSED a legal query
     * argument. It surfaced as `Type '{ deleted: string; … }' is not
     * assignable to type 'undefined'` the first time the schema snapshot was
     * refreshed from the deployed spec, which is far too late to find out.
     *
     * So both shapes are pinned here: all-optional stays assignable, and a
     * required one stays REQUIRED (the `toHaveProperty` on a non-optional slot
     * is what would catch over-loosening the fix into `query?:` everywhere).
     */
    type AllOptional = TypedRequestInit<paths['/orgs/{orgId}/spaces']['get']>;
    /*
     * Typed to the contract rather than to `string`: `limit` is a number and
     * `deleted` is the boolean vocabulary the API actually accepts
     * (`true|false|1|0|yes|no|on|off`). Asserting `string` here would pass only
     * while the spec was vague, which is the thing the refresh fixed.
     */
    expectTypeOf<{ deleted: 'false'; limit: number; cursor: string }>().toMatchTypeOf<
      NonNullable<AllOptional['query']>
    >();
    // …and omitting it entirely is still fine, because none of them is required.
    expectTypeOf<{ params: { orgId: string } }>().toMatchTypeOf<AllOptional>();

    // `from` is required on this route, so the slot itself must be required.
    type HasRequired = TypedRequestInit<paths['/orgs/{orgId}/legal/{kind}/diff']['get']>;
    expectTypeOf<HasRequired>().toHaveProperty('query');
    expectTypeOf<NonNullable<HasRequired['query']>>().toMatchTypeOf<{ from: string }>();
  });
});

/*
 * The SDK, the CLI and @forumulate/mcp read one set of variables, so a single
 * `.env` configures all three. FORUMULATE_URL names the site; the API is its
 * `/api`, and the older API-base spelling must not become `/api/api`.
 */
describe('ForumulateClient.fromEnv', () => {
  const firstUrl = async (env: Record<string, string | undefined>) => {
    const seen: { url: string; auth?: string }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      return { ok: true, status: 200, text: async () => '{"orgs":[]}' } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    await ForumulateClient.fromEnv(env, { fetch }).orgs.list();
    return seen[0]!;
  };

  it('defaults to the hosted API and appends /api to a site URL', async () => {
    expect((await firstUrl({})).url).toBe('https://forumulate.com/api/orgs');
    expect((await firstUrl({ FORUMULATE_URL: 'https://docs.acme.dev/' })).url).toBe(
      'https://docs.acme.dev/api/orgs',
    );
    expect((await firstUrl({ FORUMULATE_URL: 'https://forumulate.com/api' })).url).toBe(
      'https://forumulate.com/api/orgs',
    );
    expect((await firstUrl({ FORUMULATE_API_URL: 'http://localhost:4000' })).url).toBe(
      'http://localhost:4000/orgs',
    );
  });

  it('sends FORUMULATE_TOKEN as the bearer', async () => {
    expect((await firstUrl({ FORUMULATE_TOKEN: 'ak_x' })).auth).toBe('Bearer ak_x');
    expect((await firstUrl({ FORUMULATE_TOKEN: ' ' })).auth).toBeUndefined();
  });
});
