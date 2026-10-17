# @forumulate/sdk

A typed TypeScript client for the [Forumulate](https://forumulate.com) REST API: docs, forum, blog and everything else in an organization. It has no runtime dependencies and runs in Node 18+, Bun, Deno and the browser (global `fetch`).

## Install

```sh
npm install @forumulate/sdk
```

## Authenticate

Mint a Personal Access Token at **Account → Tokens** ([forumulate.com/account/tokens](https://forumulate.com/account/tokens)). A token needs `read` to read and `read` + `write` to change anything. [API tokens and scopes](https://forumulate.com/guides/api-tokens-and-scopes) explains the two gates a token passes.

```ts
import { ForumulateClient } from '@forumulate/sdk';

// Reads FORUMULATE_TOKEN and FORUMULATE_URL (default https://forumulate.com).
const forumulate = ForumulateClient.fromEnv();

// …or explicitly. The API base is the site plus /api.
const explicit = new ForumulateClient({
  baseUrl: 'https://forumulate.com/api',
  token: process.env.FORUMULATE_TOKEN,
});
```

| Variable             | Default                  | Meaning                                                                          |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `FORUMULATE_TOKEN`   | none                     | Personal Access Token, sent as `Authorization: Bearer`.                          |
| `FORUMULATE_URL`     | `https://forumulate.com` | The site. The API is its `/api`. A value already ending in `/api` is used as-is. |
| `FORUMULATE_API_URL` | none                     | Exact API base, for a local API with no `/api` prefix (`http://localhost:4000`). |

The [CLI](https://www.npmjs.com/package/@forumulate/cli) and the [MCP server](https://www.npmjs.com/package/@forumulate/mcp) read the same variables.

## Quickstart

```ts
const { user } = await forumulate.auth.me();
const { orgs } = await forumulate.orgs.list();
const orgId = orgs[0]!.id; // ids and slugs are both accepted wherever an org id is

// Every list is an async iterator over every row, across every page.
for await (const space of forumulate.spaces.list({ orgId })) {
  console.log(space.slug, space.type);
}
```

## Every operation is a method

Each of the API's ~1,800 operations is a method named after its operationId:
`ForumTopics_get` is `forumulate.forum.topics.get`, `Webhook_rotate` is
`forumulate.webhooks.rotate`. Paths, query, body and response are typed from
the OpenAPI spec, and the namespaces are generated from it, so a route in the
[API reference](https://forumulate.com/reference) is a method here.

```ts
// One argument: path params at the top level, `query` and `body` nested.
const { space } = await forumulate.spaces.get({ orgId, spaceId });
await forumulate.blog.create({ orgId, spaceId, body: { title: 'v2 is out', content } });
await forumulate.webhooks.update({ orgId, webhookId, body: { active: false } });
await forumulate.webhooks.delete({ orgId, webhookId }); // `delete` aliases the API's `remove`
await forumulate.tokens.rotate({ id: patId });
await forumulate.forum.taxonomy.listCategories({ orgId, spaceId }); // a sub-namespace per area of a namespace
```

| Area                     | Namespaces                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Organization             | `orgs`, `spaces`, `sites`, `members`, `invites`, `roles`, `grants`, `groups`, `tokens`, `users`, `billing`, `sso`, `scim` |
| Docs                     | `items`, `pages`, `collections`, `shapes`, `snapshots`, `changeRequests`, `docs`, `openapi`, `comments`                   |
| Community and publishing | `blog`, `forum`, `community`, `moderation`, `chat`, `messages`, `changelog`, `roadmap`, `newsletter`                      |
| Space types              | `status`, `events`, `courses`, `faq`, `careers`, `legal`, `forms`, `questions`                                            |
| Platform                 | `webhooks`, `domains`, `themes`, `extensions`, `integrations`, `notifications`, `mail`, `assets`, `embeds`, `privacy`     |
| Search, AI and analytics | `search`, `ai`, `analytics`                                                                                               |
| Headless CMS             | `content` (libraries, entries, model, locales, keys, assets…), `delivery`                                                 |
| Public reader (no token) | `public`, and the `public…` sub-namespace of each area: `forum.publicTopic`, `status.public`, `blog.public`…              |

`method.operationId` tells you which operation a method calls. By id, with the same types:

```ts
const { space } = await forumulate.request('Space_get', { orgId, spaceId });
for await (const hook of forumulate.paginate('Webhook_list', { orgId })) console.log(hook.url);
```

The 0.5 positional helpers (`spaces.list(orgId)`, `items.create(orgId, spaceId, input)`…) still work
unchanged, except `auth.register` and `auth.login`, removed in 0.6: their routes went away when
sign-in moved to Atlas, so they failed for every caller. Authenticate with a Personal Access Token. Where one shares a name with a generated method it is the same operation, and the member
takes either call shape.

### Pagination

A list returns a `PagePromise`: `await` it for the first page as the API answered it, `for await` it for every row.

```ts
const first = await forumulate.blog.list({ orgId, spaceId, query: { limit: 50 } });
first.page.nextCursor; // the envelope: page.{limit, hasMore, nextCursor, total}, rows under data

for await (const post of forumulate.blog.list({ orgId, spaceId })) {
  /* every post */
}
for await (const page of forumulate.blog.list({ orgId, spaceId }).pages()) {
  /* every page */
}
```

The walk follows `page.nextCursor`, and `?page=` for the ranked lists that have no cursor. The
generated methods send `Forumulate-Version` (the version the SDK was generated at, `API_VERSION`,
unless you set `apiVersion`) because only a versioned answer carries the envelope.

## Common tasks

### 1. Write and publish a page from markdown

`items` is the type-agnostic surface: the same calls write a docs page, a blog post or a forum topic.

```ts
const { item } = await forumulate.items.create(orgId, spaceId, {
  title: 'Install',
  slug: 'install',
  body: '# Install\n\nRun `npm i acme`.',
});
await forumulate.items.publish(orgId, spaceId, item.id);

// Later: replace the body and republish.
await forumulate.items.setContent(orgId, spaceId, item.id, { body: '# Install\n\n…' });
await forumulate.items.publish(orgId, spaceId, item.id);
```

### 2. List everything in a space, with content

```ts
const res = await forumulate.items.list(orgId, spaceId, { limit: 100, include: ['body'] });
for (const it of res.items) console.log(it.id, it.title, it.contentIn);
// res.page.nextCursor pages onward; res.sync.checkpoint drives an incremental sync.
```

Ask for `body`. `sections` is filled only for pieces written against a shape, so a space of free-form pages answers `include: ['sections']` alone with empty objects.

### 3. Search

```ts
// Everything you can see in an org: docs, forum, blog.
const { hits } = await forumulate.search.unified(orgId, 'rate limits', { limit: 10 });

// A public docs space, no token needed.
const anon = new ForumulateClient({ baseUrl: 'https://forumulate.com/api' });
const { hits: pub } = await anon.public.search(orgId, spaceId, 'rate limits');
```

### 4. Start a forum topic and reply

```ts
const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const { topic } = await forumulate.forum.createTopic(orgId, forumSpaceId, {
  title: 'v2 is out',
  content: doc('Here is what changed.'),
});
const topicId = (topic as { id: string }).id;
await forumulate.forum.reply(orgId, forumSpaceId, topicId, doc('Upgrade notes are in the docs.'));
```

### 5. Verify a webhook

```ts
import { constructWebhookEvent } from '@forumulate/sdk';

// Verifies the signature and its timestamp, THEN parses; throws if either fails.
const event = await constructWebhookEvent({
  secret: process.env.FORUMULATE_WEBHOOK_SECRET!,
  body: rawBody, // the exact bytes received, before JSON.parse
  signature: req.headers['x-forumulate-signature'] as string,
  timestamp: req.headers['x-forumulate-timestamp'] as string, // deliveries older than 5 min fail
});
```

`verifyWebhookSignature` (also `forumulate.webhooks.verifySignature`) is the same check returning a
boolean. Create the endpoint with `forumulate.webhooks.create({ orgId, body: { url, events } })`;
`webhooks.rotate`, `webhooks.ping`, `webhooks.deliveries` and `webhooks.replay` manage it after.

### 6. Translations, any kind of piece

`client.translations` picks the right route from the space's type: a docs page's language twin, a post's, topic's or release's translation, or an incident's. You only name the original piece and the language. Machine translation uses your organization's own DeepL key or AI provider. See [Translations everywhere](https://forumulate.com/guides/translations-everywhere).

```ts
const cov = await client.translations.status(orgId, spaceId); // piece × language → missing/draft/published/outdated
await client.translations.locales.set(orgId, { spaceId }, [{ code: 'es', label: 'Español' }]);
await client.translations.auto(orgId, spaceId, pageId, 'es');
const es = await client.translations.get(orgId, spaceId, pageId, 'es'); // { title, markdown, state }
await client.translations.put(orgId, spaceId, pageId, 'es', { markdown: '…', published: true });
```

## Every endpoint: `typed()`

The helpers above cover the common paths. `typed(method, path, init)` covers every route in the OpenAPI spec, with the path, params, query, body and response all inferred, and autocomplete on path and method:

```ts
const { spaces } = await forumulate.typed('get', '/orgs/{orgId}/spaces', {
  params: { orgId },
  query: { limit: 50 },
});

await forumulate.typed('post', '/orgs/{orgId}/spaces', {
  params: { orgId },
  body: { name: 'Docs', slug: 'docs', type: 'DOCS', visibility: 'PUBLIC' },
});
```

Pass `raw: true` for the untouched `Response` (binary downloads). For anything else, `request(method, path, { body, query, headers })` is the untyped escape hatch that `typed` and the helpers use.

Operations that answer a file (PDF, PNG, ZIP) or a stream resolve to the `Response`; text answers (CSV, Markdown, iCal) resolve to a `string`.

## Errors

Every non-2xx response throws a `ForumulateError` carrying the API's error envelope: `status`, `code`,
`message`, `details` (field-level, for `validation.failed`), `requestId` (quote it in a support request)
and `retryAfter` (seconds, when the API said).

```ts
import { ForumulateError } from '@forumulate/sdk';

try {
  await forumulate.orgs.create({ body: { name: '', slug: '' } });
} catch (err) {
  if (err instanceof ForumulateError && err.code === 'validation.failed') {
    console.log(err.details); // { name: ['Required'], … }
  }
}
```

A `401` means the token is missing or revoked. A `403` means it lacks a scope or capability; see [API tokens and scopes](https://forumulate.com/guides/api-tokens-and-scopes). A network failure that outlives its retries is a `ForumulateError` with `status: 0` and `code: 'network.error'`.

## Retries and idempotency

Requests that are safe to repeat are retried on `408`, `429`, `502`, `503`, `504` and network
failures: two retries by default, waiting what `Retry-After` says (a wait over a minute is surfaced
rather than slept through), else exponential backoff with jitter. A `500` is not retried.

Every POST and PATCH carries an `Idempotency-Key`, generated once per call and reused by its
retries, so a write that timed out is retried without running twice. Pass your own to dedupe
across processes:

```ts
await forumulate.items.create({ orgId, spaceId, body, idempotencyKey: message.id });
```

Each call also takes `headers`, `signal` (an `AbortSignal`) and `maxRetries`.

## Options

```ts
new ForumulateClient({
  baseUrl: 'https://forumulate.com/api',
  token,
  apiVersion: '2026-12-01', // Forumulate-Version for every request (default: generated methods only)
  maxRetries: 2, // 0 turns retries off
  autoIdempotencyKey: true, // generated Idempotency-Key on POST/PATCH
  userAgent: 'my-app/1.0', // default forumulate-sdk-js/<version> outside a browser
  headers: { 'X-Trace': id }, // sent on every request
  fetch: customFetch, // any fetch-compatible function
  credentials: true, // browser on the same origin: send the session cookie instead of a token
});
```

The default `User-Agent` matters outside a browser: the edge firewall challenges default library User-Agents.

The package has no runtime dependencies and is marked side-effect free; the route table behind the
namespaces is about 100 KB unminified (about 20 KB gzipped) and namespaces are built on first use.

## Links

- [API reference](https://forumulate.com/reference): every route, with the OpenAPI document at `https://forumulate.com/api/openapi.json`.
- [Guides](https://forumulate.com/guides) · [Community](https://forumulate.com/community)
- [`@forumulate/cli`](https://www.npmjs.com/package/@forumulate/cli): the same API from a terminal or CI.
- [`@forumulate/mcp`](https://www.npmjs.com/package/@forumulate/mcp): connect Claude, Cursor or VS Code to your organization.

## Maintainers: regenerating the types

`src/schema.ts` backs `typed()`. It is generated and types-only; do not hand-edit it. Refresh it from the deployed spec:

```sh
curl -s https://forumulate.com/api/openapi.json -o packages/sdk/openapi.json
pnpm --filter @forumulate/sdk generate-schema   # → src/schema.ts, then src/operations.gen.ts
```

`src/operations.gen.ts` is the route table behind the namespaces (`generate-operations` rebuilds it
alone). Placement lives in `scripts/generate-operations.mjs`: a short map from operationId tag
prefixes to namespaces, so a new tag lands somewhere without an edit. `src/coverage.test.ts` fails
when the table is stale, when an operation has no method, or when a 0.5 helper and a generated
method share a name but not an operation.

## License

MIT

---

## About this repository

This repository is a public mirror, refreshed on each Forumulate release
(one commit per release). Pull requests are welcome; accepted changes are
applied upstream and arrive here with the next release.

- API reference: https://forumulate.com/reference
- Guides: https://forumulate.com/guides
- Community and support: https://forumulate.com/community
- Source: https://github.com/forumulate/forumulate-js
