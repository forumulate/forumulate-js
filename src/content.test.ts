import { describe, expect, it } from 'vitest';
import { ForumulateClient } from './index';

function recording() {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, client: new ForumulateClient({ baseUrl: 'https://x.test/api', token: 't', fetch }) };
}

describe('content library helpers', () => {
  it('address everything by library, never by the space behind it', async () => {
    const { calls, client } = recording();
    await client.content.libraries.list('o1');
    await client.content.model.export('o1', 'l1', 'payload');
    await client.content.model.import('o1', 'l1', { format: 'json', content: '{}', dryRun: true });
    await client.content.model.schema('o1', 'l1', { audience: 'preview' });
    await client.content.keys.rotate('o1', 'l1', 'k1');
    await client.content.members.remove('o1', 'l1', 'u1');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://x.test/api/orgs/o1/content/libraries',
      'GET https://x.test/api/orgs/o1/content/libraries/l1/model/export?format=payload',
      'POST https://x.test/api/orgs/o1/content/libraries/l1/model/import',
      'GET https://x.test/api/orgs/o1/content/libraries/l1/model/schema.json?audience=preview',
      'POST https://x.test/api/orgs/o1/content/libraries/l1/keys/k1/rotate',
      'DELETE https://x.test/api/orgs/o1/content/libraries/l1/members/u1',
    ]);
    expect(calls[2]!.body).toEqual({ format: 'json', content: '{}', dryRun: true });
  });

  it('leaves out an audience nobody asked for', async () => {
    const { calls, client } = recording();
    await client.content.model.schema('o1', 'l1');
    expect(calls[0]!.url).toBe('https://x.test/api/orgs/o1/content/libraries/l1/model/schema.json');
  });
});
