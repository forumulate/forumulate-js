import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  ForumulateClient,
  ForumulateError,
  API_VERSION,
  retryDelayMs,
  constructWebhookEvent,
} from './index';
import type { OperationArgs, OperationResult } from './index';

type Scripted =
  { status?: number; body?: unknown; headers?: Record<string, string>; text?: string } | Error;

/** A client over a scripted fetch that answers with real `Response`s and records each request. */
function harness(
  script: Scripted[],
  opts: Partial<ConstructorParameters<typeof ForumulateClient>[0]> = {},
) {
  const calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: BodyInit | null;
  }[] = [];
  let i = 0;
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body,
    });
    const r = script[Math.min(i++, script.length - 1)]!;
    if (r instanceof Error) throw r;
    const text = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return new Response(r.status === 204 ? null : text, {
      status: r.status ?? 200,
      headers: {
        'content-type': r.text !== undefined ? 'text/plain' : 'application/json',
        ...(r.headers ?? {}),
      },
    });
  };
  const client = new ForumulateClient({
    baseUrl: 'http://api.test',
    token: 'pat_t',
    fetch: fetch as unknown as typeof globalThis.fetch,
    ...opts,
  });
  return { client, calls };
}

const page = (rows: unknown[], nextCursor: string | null, hasMore = nextCursor !== null) => ({
  articles: rows,
  data: rows,
  page: { limit: rows.length, hasMore, nextCursor },
});

describe('generated namespaces', () => {
  it('fills path params, nests query, and states the API version', async () => {
    const { client, calls } = harness([{ body: { space: { id: 's1' } } }]);
    await client.spaces.get({ orgId: 'acme', spaceId: 's 1', query: undefined });
    expect(calls[0]!.url).toBe('http://api.test/orgs/acme/spaces/s%201');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['Forumulate-Version']).toBe(API_VERSION);
    expect(calls[0]!.headers.Authorization).toBe('Bearer pat_t');
  });

  it('a pinned apiVersion or header wins over the generated default', async () => {
    const pinned = harness([{ body: {} }], { apiVersion: '2026-09-01' });
    await pinned.client.webhooks.events({ orgId: 'o' });
    expect(pinned.calls[0]!.headers['Forumulate-Version']).toBe('2026-09-01');
    const header = harness([{ body: {} }], { headers: { 'forumulate-version': '2026-11-01' } });
    await header.client.webhooks.events({ orgId: 'o' });
    expect(header.calls[0]!.headers['forumulate-version']).toBe('2026-11-01');
    expect(header.calls[0]!.headers['Forumulate-Version']).toBeUndefined();
  });

  it('leaves the 0.5 positional helpers unversioned', async () => {
    const { client, calls } = harness([{ body: { spaces: [] } }, { body: { spaces: [] } }]);
    await client.spaces.list('acme'); // the 0.5 shape
    expect(calls[0]!.headers['Forumulate-Version']).toBeUndefined();
    await client.spaces.list({ orgId: 'acme' }); // the generated shape, same member
    expect(calls[1]!.headers['Forumulate-Version']).toBe(API_VERSION);
    expect(calls.map((c) => c.url)).toEqual([
      'http://api.test/orgs/acme/spaces',
      'http://api.test/orgs/acme/spaces',
    ]);
  });

  it('refuses an argument that is neither a path param nor an option', async () => {
    const { client, calls } = harness([{ body: {} }]);
    await expect(
      client.spaces.get({
        orgId: 'o',
        spaceId: 's',
        limit: 5,
      } as unknown as OperationArgs<'Space_get'>),
    ).rejects.toThrow(/unknown argument "limit"/);
    await expect(
      client.spaces.get({ orgId: 'o' } as unknown as OperationArgs<'Space_get'>),
    ).rejects.toThrow(/missing path parameter "spaceId"/);
    expect(calls).toHaveLength(0);
  });

  it('exposes the operationId each method calls', () => {
    const { client } = harness([]);
    expect(client.forum.topics.get.operationId).toBe('ForumTopics_get');
    expect(client.spaces.list.operationId).toBe('Space_list');
    expect(client.webhooks.rotate.operationId).toBe('Webhook_rotate');
    // `delete` is the plain-English alias of the API's `remove`.
    expect(client.webhooks.delete.operationId).toBe('Webhook_remove');
  });

  it('keeps hand-written helpers and merges generated methods beside them', async () => {
    const { client, calls } = harness([{ body: {} }, { body: {} }]);
    await client.content.libraries.list('o1'); // 0.5 positional helper
    expect(typeof client.content.libraries.list).toBe('function');
    await client.content.environments.list({ orgId: 'o1', libraryId: 'l1' }); // generated
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/orgs/o1/content/libraries',
      '/orgs/o1/content/libraries/l1/environments',
    ]);
  });

  it('request(operationId) is the same door, typed', async () => {
    const { client, calls } = harness([{ body: { webhook: { id: 'w' } } }]);
    await client.request('Webhook_update', { orgId: 'o', webhookId: 'w', body: { active: false } });
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toBe('http://api.test/orgs/o/webhooks/w');
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ active: false });
    await expect(
      client.request('Nope_nope' as 'Webhook_update', { orgId: 'o', webhookId: 'w' }),
    ).rejects.toThrow(/Unknown operationId/);
  });

  it('returns text and binary answers undecoded', async () => {
    const { client } = harness([{ text: 'a,b\n1,2' }, { body: 'PNG' }]);
    const csv = await client.request('Org_legalEmbedAcceptancesCsv', { orgId: 'o', kind: 'terms' });
    expect(csv).toBe('a,b\n1,2');
    const pdf = await client.public.pagePdf({ orgId: 'o', spaceId: 's', pageId: 'p' });
    expect(pdf).toBeInstanceOf(Response);
    expectTypeOf(pdf).toEqualTypeOf<Response>();
  });

  it('sends multipart bodies as they are', async () => {
    const { client, calls } = harness([{ status: 201, body: {} }]);
    const form = new FormData();
    form.set('file', new Blob(['x']), 'x.txt');
    await client.assets.upload({ orgId: 'o', spaceId: 's', body: form });
    expect(calls[0]!.body).toBe(form);
    expect(calls[0]!.headers['Content-Type']).toBeUndefined();
  });
});

describe('pagination', () => {
  it('awaits to the first page and iterates every row across cursors', async () => {
    const { client, calls } = harness([
      { body: page([{ id: 1 }, { id: 2 }], 'c2') },
      { body: page([{ id: 3 }], null) },
    ]);
    const first = await client.blog.list({ orgId: 'o', spaceId: 's', query: { limit: 2 } });
    expect(first.page.nextCursor).toBe('c2');

    const again = harness([
      { body: page([{ id: 1 }, { id: 2 }], 'c2') },
      { body: page([{ id: 3 }], null) },
    ]);
    const ids: unknown[] = [];
    for await (const row of again.client.blog.list({
      orgId: 'o',
      spaceId: 's',
      query: { limit: 2 },
    })) {
      ids.push((row as unknown as { id: number }).id);
    }
    expect(ids).toEqual([1, 2, 3]);
    expect(new URL(again.calls[1]!.url).searchParams.get('cursor')).toBe('c2');
    expect(new URL(again.calls[1]!.url).searchParams.get('limit')).toBe('2');
    expect(calls).toHaveLength(1);
  });

  it('continues a ranking by ?page= when there is no cursor', async () => {
    const { client, calls } = harness([
      { body: page([{ id: 1 }], null, true) },
      { body: page([{ id: 2 }], null, false) },
    ]);
    const rows: unknown[] = [];
    for await (const r of client.paginate('Space_list', { orgId: 'o' })) rows.push(r);
    expect(rows).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get('page')).toBe('2');
  });

  it('walks pages() as answered', async () => {
    const { client } = harness([
      { body: page([1], 'a') },
      { body: page([2], 'b') },
      { body: page([3], null) },
    ]);
    let n = 0;
    for await (const p of client.webhooks.list({ orgId: 'o' }).pages()) {
      expect(p).toHaveProperty('page');
      n++;
    }
    expect(n).toBe(3);
  });

  it('stops on a cursor that does not move', async () => {
    const { client, calls } = harness([{ body: page([1], 'same') }, { body: page([2], 'same') }]);
    const rows: unknown[] = [];
    for await (const r of client.webhooks.list({ orgId: 'o' })) rows.push(r);
    expect(rows).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
  });

  it('refuses paginate() on an operation that is not a list', () => {
    const { client } = harness([]);
    expect(() =>
      client.paginate('Space_get' as never, { orgId: 'o', spaceId: 's' } as never),
    ).toThrow(/not a paged/);
  });
});

describe('errors', () => {
  it('throws a ForumulateError with code, status, details and requestId', async () => {
    const { client } = harness([
      {
        status: 422,
        body: {
          error: {
            code: 'validation.failed',
            message: 'Validation failed.',
            details: { name: ['Required'] },
          },
          requestId: 'req_1',
        },
      },
    ]);
    const err = await client.spaces
      .create({ orgId: 'o', body: {} as never })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForumulateError);
    const e = err as ForumulateError;
    expect([e.status, e.code, e.message, e.requestId]).toEqual([
      422,
      'validation.failed',
      'Validation failed.',
      'req_1',
    ]);
    expect(e.details).toEqual({ name: ['Required'] });
  });

  it('keeps a non-JSON error body readable', async () => {
    const { client } = harness([{ status: 403, text: 'error code: 1010' }]);
    const e = (await client.orgs.list().catch((x: unknown) => x)) as ForumulateError;
    expect([e.status, e.code]).toEqual([403, 'error']);
  });
});

describe('retries', () => {
  it('retries a 503 after Retry-After and succeeds', async () => {
    const { client, calls } = harness([
      {
        status: 503,
        body: { error: { code: 'unavailable', message: 'x' } },
        headers: { 'retry-after': '0' },
      },
      { body: { space: {} } },
    ]);
    await client.spaces.get({ orgId: 'o', spaceId: 's' });
    expect(calls).toHaveLength(2);
  });

  it('gives up after maxRetries and reports retryAfter', async () => {
    const { client, calls } = harness(
      [
        {
          status: 429,
          body: { error: { code: 'rate_limited', message: 'slow' } },
          headers: { 'retry-after': '0' },
        },
      ],
      { maxRetries: 1 },
    );
    const e = (await client.spaces
      .get({ orgId: 'o', spaceId: 's' })
      .catch((x: unknown) => x)) as ForumulateError;
    expect(calls).toHaveLength(2);
    expect([e.status, e.code, e.retryAfter]).toEqual([429, 'rate_limited', 0]);
  });

  it('does not retry a 500, or a Retry-After beyond a minute', async () => {
    const five = harness([{ status: 500, body: { error: { code: 'internal', message: 'x' } } }]);
    await five.client.spaces.get({ orgId: 'o', spaceId: 's' }).catch(() => undefined);
    expect(five.calls).toHaveLength(1);
    const late = harness([{ status: 429, body: {}, headers: { 'retry-after': '3600' } }]);
    const e = (await late.client.spaces
      .get({ orgId: 'o', spaceId: 's' })
      .catch((x: unknown) => x)) as ForumulateError;
    expect(late.calls).toHaveLength(1);
    expect(e.retryAfter).toBe(3600);
  });

  it('retries a network failure, then surfaces it as status 0', async () => {
    const ok = harness([Object.assign(new TypeError('fetch failed')), { body: {} }], {
      maxRetries: 1,
    });
    await ok.client.spaces.get({ orgId: 'o', spaceId: 's' });
    expect(ok.calls).toHaveLength(2);
    const down = harness([new TypeError('fetch failed')], { maxRetries: 0 });
    const e = (await down.client.spaces
      .get({ orgId: 'o', spaceId: 's' })
      .catch((x: unknown) => x)) as ForumulateError;
    expect([e.status, e.code]).toEqual([0, 'network.error']);
  });

  it('computes backoff from Retry-After seconds, dates, or exponentially', () => {
    expect(retryDelayMs(0, '2')).toBe(2000);
    expect(retryDelayMs(0, new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryDelayMs(0, '120')).toBeNull();
    const d = retryDelayMs(3, null)!;
    expect(d).toBeGreaterThan(3000);
    expect(d).toBeLessThanOrEqual(4000);
  });
});

describe('idempotency keys', () => {
  it('gives each POST one generated key, reused by its retries', async () => {
    const { client, calls } = harness([
      { status: 503, body: {}, headers: { 'retry-after': '0' } },
      { status: 201, body: {} },
    ]);
    await client.webhooks.ping({ orgId: 'o', webhookId: 'w' });
    const k1 = calls[0]!.headers['Idempotency-Key'];
    expect(k1).toMatch(/.{8,}/);
    expect(calls[1]!.headers['Idempotency-Key']).toBe(k1);
  });

  it('uses the caller key, never puts one on a GET, and retries no keyless POST', async () => {
    const { client, calls } = harness([{ status: 201, body: {} }, { body: {} }]);
    await client.webhooks.ping({ orgId: 'o', webhookId: 'w', idempotencyKey: 'job-42' });
    await client.webhooks.list({ orgId: 'o' });
    expect(calls[0]!.headers['Idempotency-Key']).toBe('job-42');
    expect(calls[1]!.headers['Idempotency-Key']).toBeUndefined();

    const off = harness([{ status: 503, body: {}, headers: { 'retry-after': '0' } }], {
      autoIdempotencyKey: false,
    });
    await off.client.webhooks.ping({ orgId: 'o', webhookId: 'w' }).catch(() => undefined);
    expect(off.calls).toHaveLength(1);
    expect(off.calls[0]!.headers['Idempotency-Key']).toBeUndefined();
  });
});

describe('webhooks', () => {
  it('constructEvent verifies before it parses', async () => {
    const secret = 'whsec';
    const body = JSON.stringify({ event: 'page.published', data: { id: 'p' } });
    const timestamp = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const evt = await constructWebhookEvent<{ event: string }>({
      secret,
      body,
      timestamp,
      signature: `v1,sha256=${hex}`,
    });
    expect(evt.event).toBe('page.published');
    await expect(
      constructWebhookEvent({ secret, body: body + ' ', timestamp, signature: `v1,sha256=${hex}` }),
    ).rejects.toThrow(/did not verify/);
    const { client } = harness([]);
    expect(client.webhooks.verifySignature).toBeTypeOf('function');
  });
});

describe('types', () => {
  it('infers args, results and rows from the spec', async () => {
    const { client } = harness([{ body: page([], null) }]);
    expectTypeOf(client.spaces.get)
      .parameter(0)
      .toMatchTypeOf<{ orgId: string; spaceId: string }>();
    expectTypeOf<OperationResult<'Space_get'>>().not.toBeUnknown();
    expectTypeOf<OperationResult<'Webhook_list'>>().toHaveProperty('webhooks');
    const list = client.webhooks.list({ orgId: 'o' });
    expectTypeOf(list).resolves.toHaveProperty('page');
    await list;
    // @ts-expect-error — spaceId is required
    void client.spaces.get({ orgId: 'o' }).catch(() => undefined);
    // @ts-expect-error — an unknown operationId is a type error
    void client.request('Nope_nope', {}).catch?.(() => undefined);
  });
});
