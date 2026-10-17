import { describe, expect, it } from 'vitest';
import { ForumulateClient } from './index';

/** A fetch that answers from `routes` (`METHOD path` → body) and records each call. */
function fake(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api/, '') + u.search;
    calls.push({ method: init.method!, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[`${init.method} ${path}`];
    return new Response(JSON.stringify(hit ?? {}), { status: hit === undefined && init.method === 'GET' ? 404 : 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, client: new ForumulateClient({ baseUrl: 'https://x.test/api', token: 't', fetch }) };
}

const SP = '/orgs/o1/spaces/s1';

describe('client.translations', () => {
  it('lists a space’s and a library’s languages in one shape', async () => {
    const { client } = fake({
      [`GET ${SP}/docs/locales`]: { locales: [{ code: 'default', label: 'Original', isDefault: true }, { code: 'es', label: 'Español', isDefault: false }] },
      'GET /orgs/o1/content/libraries/l1/locales': { sourceLocale: 'en', locales: [{ code: 'en', label: 'English', source: true }, { code: 'de', label: 'Deutsch', source: false }] },
    });
    expect(await client.translations.locales.list('o1', { spaceId: 's1' })).toEqual([
      { code: 'default', label: 'Original', isSource: true },
      { code: 'es', label: 'Español', isSource: false },
    ]);
    expect((await client.translations.locales.list('o1', { libraryId: 'l1' }))[0]).toEqual({ code: 'en', label: 'English', isSource: true });
  });

  it('`locales.set` adds and relabels, and removes only with prune', async () => {
    const list = { locales: [{ code: 'default', label: 'Original', isDefault: true }, { code: 'es', label: 'Spanish', isDefault: false }, { code: 'it', label: 'Italiano', isDefault: false }] };
    const { calls, client } = fake({ [`GET ${SP}/docs/locales`]: list, [`POST ${SP}/docs/locales`]: list, [`PATCH ${SP}/docs/locales/es`]: list, [`DELETE ${SP}/docs/locales/it`]: list });
    const res = await client.translations.locales.set('o1', { spaceId: 's1' }, [{ code: 'es', label: 'Español' }, { code: 'fr', label: 'Français' }]);
    expect(res.added).toEqual(['fr']);
    expect(res.relabeled).toEqual(['es']);
    expect(res.removed).toEqual([]);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await client.translations.locales.set('o1', { spaceId: 's1' }, [{ code: 'es', label: 'Spanish' }], { prune: true });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: `${SP}/docs/locales/it` });
  });

  it('routes one piece’s translation by the space’s type', async () => {
    const { calls, client } = fake({
      [`GET ${SP}`]: { space: { type: 'CHANGELOG' } },
      [`GET ${SP}/changelog/r1/translations/es`]: { translation: { code: 'es', title: 'Hola', excerpt: '', markdown: 'Cuerpo', exists: true, published: false, stale: false, origin: 'human' } },
    });
    const tr = await client.translations.get('o1', 's1', 'r1', 'es');
    expect(tr).toMatchObject({ door: 'changelog', state: 'draft', title: 'Hola', markdown: 'Cuerpo' });
    await client.translations.auto('o1', 's1', 'r1', 'es', { door: 'changelog', force: true });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `${SP}/changelog/r1/translations/es/auto`, body: { force: true } });
  });

  it('reads and writes a docs page’s translation through its twin', async () => {
    const rows = { translations: [{ code: 'es', label: 'Español', state: 'draft', id: 't1', origin: 'human', updatedAt: null }] };
    const { calls, client } = fake({
      [`GET ${SP}/pages/p1/translations`]: rows,
      [`GET ${SP}/items/t1`]: { item: { title: 'Inicio', markdown: '# Hola' } },
    });
    expect(await client.translations.get('o1', 's1', 'p1', 'es', { door: 'page' })).toMatchObject({ id: 't1', title: 'Inicio', markdown: '# Hola' });
    await client.translations.put('o1', 's1', 'p1', 'es', { markdown: '# Hola mundo', published: true }, { door: 'page' });
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
    expect(writes).toEqual([`PUT ${SP}/items/t1/content`, `POST ${SP}/items/t1/publish`]);
    await client.translations.auto('o1', 's1', 'p1', 'es', { door: 'page', published: true });
    expect(calls.at(-1)).toMatchObject({ path: `${SP}/pages/p1/translations/es/auto`, body: { published: true } });
  });

  it('never sends `published` to an incident (it has no draft) and uses the canonical auto address', async () => {
    const { calls, client } = fake({});
    await client.translations.auto('o1', 's1', 'i1', 'es', { door: 'incident', published: true });
    expect(calls.at(-1)).toMatchObject({ path: `${SP}/status/incidents/i1/translations/es/auto`, body: {} });
  });

  it('labels, overrides and coverage hit their own routes', async () => {
    const { calls, client } = fake({ [`GET ${SP}/translations`]: { items: [] } });
    await client.translations.status('o1', 's1');
    await client.translations.labels.merge('o1', { siteId: 'x1' }, { es: { Docs: 'Documentos' } });
    await client.translations.overrides.remove('o1', { locale: 'es', key: 'reader.search' });
    await client.translations.autoEntry('o1', 'l1', 'e1', 'de');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${SP}/translations`,
      'PATCH /orgs/o1/sites/x1/i18n/labels',
      'DELETE /orgs/o1/translation-overrides?locale=es&key=reader.search',
      'POST /orgs/o1/content/libraries/l1/entries/e1/translations/de/auto',
    ]);
  });
});
