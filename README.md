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
const { spaces } = await forumulate.spaces.list(orgId);
console.log(
  user.email,
  spaces.map((s) => `${s.slug} [${s.type}]`),
);
```

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
import { verifyWebhookSignature } from '@forumulate/sdk';

const ok = await verifyWebhookSignature({
  secret: process.env.FORUMULATE_WEBHOOK_SECRET!,
  body: rawBody, // the exact bytes received, before JSON.parse
  signature: req.headers['x-forumulate-signature'] as string,
  timestamp: req.headers['x-forumulate-timestamp'] as string, // deliveries older than 5 min fail
});
```

Create the webhook with `forumulate.webhooks.create(orgId, { url, events })`.

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

## Errors

Every non-2xx response throws a `ForumulateError` carrying `status`, `code` and `message` from the API's error envelope.

```ts
import { ForumulateError } from '@forumulate/sdk';

try {
  await forumulate.orgs.create({ name: '', slug: '' });
} catch (err) {
  if (err instanceof ForumulateError && err.code === 'validation.failed') {
    /* … */
  }
}
```

A `401` means the token is missing or revoked. A `403` means it lacks a scope or capability; see [API tokens and scopes](https://forumulate.com/guides/api-tokens-and-scopes).

## Options

```ts
new ForumulateClient({
  baseUrl: 'https://forumulate.com/api',
  token,
  headers: { 'Forumulate-Version': '2026-09-01' }, // pin the API version for this client
  fetch: customFetch, // any fetch-compatible function
  credentials: true, // browser on the same origin: send the session cookie instead of a token
});
```

Set a descriptive `User-Agent` when you run outside a browser: the edge firewall challenges default library User-Agents.

## Links

- [API reference](https://forumulate.com/reference): every route, with the OpenAPI document at `https://forumulate.com/api/openapi.json`.
- [Guides](https://forumulate.com/guides) · [Community](https://forumulate.com/community)
- [`@forumulate/cli`](https://www.npmjs.com/package/@forumulate/cli): the same API from a terminal or CI.
- [`@forumulate/mcp`](https://www.npmjs.com/package/@forumulate/mcp): connect Claude, Cursor or VS Code to your organization.

## Maintainers: regenerating the types

`src/schema.ts` backs `typed()`. It is generated and types-only; do not hand-edit it. Refresh it from the deployed spec:

```sh
curl -s https://forumulate.com/api/openapi.json -o packages/sdk/openapi.json
pnpm --filter @forumulate/sdk generate-schema   # → src/schema.ts
```

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
