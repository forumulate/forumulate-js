/**
 * Translations, across every kind of piece: `client.translations`.
 *
 * Each kind grew its own doors — a docs page's language twin, a post's or a
 * release's `…/translations/{locale}`, an incident's — and a script that
 * translated a release had to learn a second vocabulary for a page. These
 * helpers say it once and route by the space's type, exactly as the CLI's
 * `forumulate translations` and the MCP translation tools do:
 *
 *   locales   declare / relabel / remove a space's or a library's languages
 *   status    one space's coverage: every piece × language → missing / draft /
 *             published / outdated (`GET …/spaces/{spaceId}/translations`)
 *   get/put/remove/auto   one piece's translation, whatever the piece is
 *   labels    the site/space chrome dictionary (`…/i18n/labels`, `…/i18n/strings`)
 *   overrides the org's UI string overrides and the public catalog
 *
 * Machine translation always uses the organization's OWN provider (its DeepL
 * key; its AI provider for a library entry). There is no platform key, so a
 * call without one is a 409 `ai.unavailable` — connect one with `deepl.connect`.
 *
 * Hand-written over `request`, like `./content`, because the generated
 * `schema.ts` is refreshed from the DEPLOYED spec.
 */

type Request = <T>(
  method: string,
  path: string,
  opts?: { body?: unknown; query?: Record<string, string | number | boolean | undefined> },
) => Promise<T>;

/** A space or a content library — the two things that declare languages. */
export type LocaleTarget = { spaceId: string } | { libraryId: string };

export interface TranslationLocale {
  code: string;
  label: string;
  /** The original language (`default` in a space; the library's `sourceLocale`). */
  isSource: boolean;
}

export type TranslationState = 'missing' | 'draft' | 'published' | 'outdated';
export type TranslationKind = 'page' | 'topic' | 'incident';
/** Which door a piece's translation is behind (from the space's type). */
export type TranslationDoor = 'page' | 'blog' | 'forum' | 'changelog' | 'incident';

export interface TranslationCell {
  state: TranslationState;
  /** A docs page's language twin id (an item of its own); null for topics and incidents. */
  id: string | null;
  origin: 'human' | 'machine' | null;
  updatedAt: string | null;
}

export interface TranslationCoverage {
  spaceId: string;
  spaceType: string;
  kind: TranslationKind;
  locales: { code: string; label: string }[];
  items: { id: string; title: string; slug: string | null; kind: TranslationKind; locales: Record<string, TranslationCell> }[];
  totals: Record<string, Record<TranslationState, number>>;
  truncated: boolean;
}

/** One piece's translation in one language, the same shape for every kind. */
export interface PieceTranslation {
  door: TranslationDoor;
  locale: string;
  state: TranslationState;
  /** A page twin's own id; null otherwise. */
  id: string | null;
  title: string | null;
  markdown: string | null;
  /** A post's / release's summary line. */
  excerpt?: string | null;
  /** An incident's update texts, by update id. */
  updates?: Record<string, string>;
  origin: 'human' | 'machine' | null;
}

export interface PieceTranslationInput {
  title?: string;
  markdown?: string;
  excerpt?: string;
  updates?: Record<string, string>;
  /** Serve it to readers. A page twin is published; a post's translation flagged. */
  published?: boolean;
}

export interface AutoTranslateOptions {
  /** Replace a translation a person wrote. Unset = 409. */
  force?: boolean;
  /** Publish what the machine wrote at once. Unset = a draft a person reads first. */
  published?: boolean;
}

export type LabelScope = { siteId: string } | { spaceId: string };
/** locale → original text → that language's words (plus `href` per link where set). */
export type LabelDictionary = Record<string, Record<string, unknown>>;

export type NamedTranslations = Record<string, { name?: string; description?: string }>;

export interface TranslationOverride {
  locale: string;
  key: string;
  value: string;
  updatedAt: string;
}

const enc = encodeURIComponent;

/** The door a space type keeps its pieces' translations behind. */
export function translationDoorOf(spaceType: string): TranslationDoor {
  switch (spaceType) {
    case 'BLOG':
      return 'blog';
    case 'FORUM':
      return 'forum';
    case 'CHANGELOG':
      return 'changelog';
    case 'STATUS':
      return 'incident';
    default:
      return 'page';
  }
}

export function translationsApi(request: Request) {
  const space = (orgId: string, spaceId: string) => `/orgs/${orgId}/spaces/${spaceId}`;
  const library = (orgId: string, libraryId: string) => `/orgs/${orgId}/content/libraries/${libraryId}`;
  const localesAt = (orgId: string, t: LocaleTarget) =>
    'libraryId' in t ? `${library(orgId, t.libraryId)}/locales` : `${space(orgId, t.spaceId)}/docs/locales`;
  const labelsAt = (orgId: string, s: LabelScope) =>
    'siteId' in s ? `/orgs/${orgId}/sites/${s.siteId}/i18n` : `${space(orgId, s.spaceId)}/i18n`;
  /** Both answers as one list: a space's has `default`, a library's `source`. */
  const normalize = (r: { locales: { code: string; label: string; isDefault?: boolean; source?: boolean }[] }) =>
    r.locales.map((l) => ({ code: l.code, label: l.label, isSource: Boolean(l.isDefault ?? l.source) }));

  const doorOf = async (orgId: string, spaceId: string, door?: TranslationDoor): Promise<TranslationDoor> => {
    if (door) return door;
    const { space: s } = await request<{ space: { type: string } }>('GET', space(orgId, spaceId));
    return translationDoorOf(s.type);
  };
  const collection = (orgId: string, spaceId: string, door: TranslationDoor, pieceId: string) =>
    door === 'incident'
      ? `${space(orgId, spaceId)}/status/incidents/${pieceId}/translations`
      : door === 'page'
        ? `${space(orgId, spaceId)}/pages/${pieceId}/translations`
        : `${space(orgId, spaceId)}/${door}/${pieceId}/translations`;

  type PageRow = TranslationCell & { code: string; label: string };
  const pageRow = async (orgId: string, spaceId: string, pageId: string, locale: string): Promise<PageRow> => {
    const { translations } = await request<{ translations: PageRow[] }>('GET', collection(orgId, spaceId, 'page', pageId));
    const row = translations.find((r) => r.code.toLowerCase() === locale.toLowerCase());
    if (!row) throw Object.assign(new Error(`"${locale}" is not a language of this space.`), { status: 404 });
    return row;
  };
  type TopicRow = { code: string; title: string | null; excerpt: string | null; markdown?: string | null; exists: boolean; published: boolean; stale: boolean; origin: 'human' | 'machine' | null };
  type IncidentRow = { locale: string; title: string | null; markdown?: string | null; updates: Record<string, string>; origin: 'manual' | 'machine'; stale: boolean };
  const topicState = (t: TopicRow): TranslationState =>
    !t.exists ? 'missing' : t.stale ? 'outdated' : t.published ? 'published' : 'draft';

  const api = {
    locales: {
      list: async (orgId: string, target: LocaleTarget): Promise<TranslationLocale[]> =>
        normalize(await request('GET', localesAt(orgId, target))),
      add: async (orgId: string, target: LocaleTarget, input: { code: string; label: string }) =>
        normalize(await request('POST', localesAt(orgId, target), { body: input })),
      /** Rename a language as the reader's switcher shows it. */
      relabel: async (orgId: string, target: LocaleTarget, code: string, label: string) =>
        normalize(await request('PATCH', `${localesAt(orgId, target)}/${enc(code)}`, { body: { label } })),
      remove: async (orgId: string, target: LocaleTarget, code: string) =>
        normalize(await request('DELETE', `${localesAt(orgId, target)}/${enc(code)}`)),
      /**
       * Make the declared languages exactly `want` (the source excluded):
       * adds what is missing, relabels what changed, removes what is not
       * listed only when `prune` — removing a language trashes its
       * translations, so it is never a side effect. Idempotent.
       */
      set: async (
        orgId: string,
        target: LocaleTarget,
        want: { code: string; label: string }[],
        opts: { prune?: boolean } = {},
      ): Promise<{ locales: TranslationLocale[]; added: string[]; relabeled: string[]; removed: string[] }> => {
        let current = await api.locales.list(orgId, target);
        const added: string[] = [];
        const relabeled: string[] = [];
        const removed: string[] = [];
        for (const w of want) {
          const have = current.find((l) => !l.isSource && l.code.toLowerCase() === w.code.toLowerCase());
          if (!have) {
            current = await api.locales.add(orgId, target, w);
            added.push(w.code);
          } else if (have.label !== w.label) {
            current = await api.locales.relabel(orgId, target, have.code, w.label);
            relabeled.push(have.code);
          }
        }
        if (opts.prune)
          for (const l of current.filter((c) => !c.isSource && !want.some((w) => w.code.toLowerCase() === c.code.toLowerCase()))) {
            current = await api.locales.remove(orgId, target, l.code);
            removed.push(l.code);
          }
        return { locales: current, added, relabeled, removed };
      },
    },

    /** Every piece × declared language of a space, in the four states. */
    status: (orgId: string, spaceId: string) =>
      request<TranslationCoverage>('GET', `${space(orgId, spaceId)}/translations`),

    /** Each declared language and one piece's state in it (any kind). */
    list: async (orgId: string, spaceId: string, pieceId: string, opts: { door?: TranslationDoor } = {}) => {
      const door = await doorOf(orgId, spaceId, opts.door);
      return request<{ translations: unknown[] }>('GET', collection(orgId, spaceId, door, pieceId));
    },

    /** One piece's translation, as Markdown, whatever the piece is. */
    get: async (
      orgId: string,
      spaceId: string,
      pieceId: string,
      locale: string,
      opts: { door?: TranslationDoor } = {},
    ): Promise<PieceTranslation> => {
      const door = await doorOf(orgId, spaceId, opts.door);
      if (door === 'page') {
        const row = await pageRow(orgId, spaceId, pieceId, locale);
        if (!row.id) return { door, locale: row.code, state: 'missing', id: null, title: null, markdown: null, origin: null };
        const { item } = await request<{ item: { title: string; markdown: string } }>('GET', `${space(orgId, spaceId)}/items/${row.id}`);
        return { door, locale: row.code, state: row.state, id: row.id, title: item.title, markdown: item.markdown, origin: row.origin };
      }
      if (door === 'incident') {
        const { translations } = await request<{ translations: IncidentRow[] }>('GET', collection(orgId, spaceId, door, pieceId));
        const t = translations.find((x) => x.locale.toLowerCase() === locale.toLowerCase());
        if (!t) return { door, locale, state: 'missing', id: null, title: null, markdown: null, updates: {}, origin: null };
        return {
          door,
          locale: t.locale,
          state: t.stale ? 'outdated' : 'published',
          id: null,
          title: t.title,
          markdown: t.markdown ?? null,
          updates: t.updates,
          origin: t.origin === 'machine' ? 'machine' : 'human',
        };
      }
      const { translation: t } = await request<{ translation: TopicRow }>('GET', `${collection(orgId, spaceId, door, pieceId)}/${enc(locale)}`);
      return { door, locale: t.code, state: topicState(t), id: null, title: t.title, markdown: t.markdown ?? null, excerpt: t.excerpt, origin: t.origin };
    },

    /** Write or correct one piece's translation by hand (it becomes a person's). */
    put: async (
      orgId: string,
      spaceId: string,
      pieceId: string,
      locale: string,
      input: PieceTranslationInput,
      opts: { door?: TranslationDoor } = {},
    ): Promise<PieceTranslation> => {
      const door = await doorOf(orgId, spaceId, opts.door);
      if (door === 'page') {
        const row = await pageRow(orgId, spaceId, pieceId, locale);
        if (!row.id) throw Object.assign(new Error(`This page has no ${locale} twin.`), { status: 404 });
        const item = `${space(orgId, spaceId)}/items/${row.id}`;
        if (input.title) await request('PATCH', item, { body: { title: input.title } });
        if (input.markdown !== undefined) await request('PUT', `${item}/content`, { body: { body: input.markdown } });
        if (input.published) await request('POST', `${item}/publish`, { body: {} });
      } else if (door === 'incident') {
        const { title, markdown, updates } = input;
        await request('PUT', `${collection(orgId, spaceId, door, pieceId)}/${enc(locale)}`, { body: { title, markdown, updates } });
      } else {
        const { title, markdown, excerpt, published } = input;
        await request('PUT', `${collection(orgId, spaceId, door, pieceId)}/${enc(locale)}`, { body: { title, markdown, excerpt, published } });
      }
      return api.get(orgId, spaceId, pieceId, locale, { door });
    },

    /** Remove one piece's translation (a page twin goes to the trash). */
    remove: async (orgId: string, spaceId: string, pieceId: string, locale: string, opts: { door?: TranslationDoor } = {}) => {
      const door = await doorOf(orgId, spaceId, opts.door);
      if (door === 'page') {
        const row = await pageRow(orgId, spaceId, pieceId, locale);
        if (row.id) await request('DELETE', `${space(orgId, spaceId)}/items/${row.id}`);
        return;
      }
      await request('DELETE', `${collection(orgId, spaceId, door, pieceId)}/${enc(locale)}`);
    },

    /** Machine-translate one piece with the org's own provider: `…/translations/{locale}/auto`. */
    auto: async (
      orgId: string,
      spaceId: string,
      pieceId: string,
      locale: string,
      opts: AutoTranslateOptions & { door?: TranslationDoor } = {},
    ) => {
      const door = await doorOf(orgId, spaceId, opts.door);
      const body: AutoTranslateOptions = { force: opts.force };
      if (door !== 'incident') body.published = opts.published;
      return request<{ translation: unknown }>('POST', `${collection(orgId, spaceId, door, pieceId)}/${enc(locale)}/auto`, { body });
    },

    /** A content library entry's machine translation (always a draft twin). */
    autoEntry: (orgId: string, libraryId: string, entryId: string, locale: string, opts: { force?: boolean } = {}) =>
      request<{ locale: string; results: { entryId: string; ok: boolean; translationEntryId: string | null; error: string | null }[] }>(
        'POST',
        `${library(orgId, libraryId)}/entries/${entryId}/translations/${enc(locale)}/auto`,
        { body: opts },
      ),

    /** Correct the language a piece is DECLARED to be written in (`PATCH …/items/{id}`). */
    setItemLocale: (orgId: string, spaceId: string, itemId: string, locale: string | null) =>
      request<{ item: { id: string; locale?: string | null } }>('PATCH', `${space(orgId, spaceId)}/items/${itemId}`, { body: { locale } }),

    /**
     * Name translations: a space's (`settings.translations`) and a
     * collection's. The API replaces the whole map on write, so `set` reads
     * it first and changes one language — the other languages survive.
     */
    names: {
      get: async (orgId: string, spaceId: string, opts: { collectionId?: string } = {}): Promise<NamedTranslations> => {
        if (opts.collectionId) {
          const { collection } = await request<{ collection: { translations?: NamedTranslations | null } }>(
            'GET',
            `${space(orgId, spaceId)}/collections/${opts.collectionId}`,
          );
          return collection.translations ?? {};
        }
        const { space: s } = await request<{ space: { settings?: { translations?: NamedTranslations | null } } }>('GET', space(orgId, spaceId));
        return s.settings?.translations ?? {};
      },
      /** One language's name (and description); `null` removes that language. */
      set: async (
        orgId: string,
        spaceId: string,
        locale: string,
        words: { name?: string; description?: string } | null,
        opts: { collectionId?: string } = {},
      ): Promise<NamedTranslations> => {
        const current = { ...(await api.names.get(orgId, spaceId, opts)) };
        if (words === null) delete current[locale];
        else current[locale] = { ...(current[locale] ?? {}), ...words };
        const at = opts.collectionId ? `${space(orgId, spaceId)}/collections/${opts.collectionId}` : space(orgId, spaceId);
        await request('PATCH', at, { body: { translations: Object.keys(current).length ? current : null } });
        return current;
      },
    },

    /** A library entry's locale twin: its localized fields in one language. */
    entryLocale: {
      get: (orgId: string, libraryId: string, entryId: string, locale: string) =>
        request<{ entryId: string; locale: string; fields: Record<string, unknown> }>(
          'GET',
          `${library(orgId, libraryId)}/entries/${entryId}/locales`,
          { query: { locale } },
        ),
      /** Write the twin's DRAFT (made from the source when missing). */
      put: (orgId: string, libraryId: string, entryId: string, locale: string, fields: Record<string, unknown>) =>
        request<{ locale: string; sourceEntryId: string; entryId: string; created: boolean }>(
          'PUT',
          `${library(orgId, libraryId)}/entries/${entryId}/locales/${enc(locale)}`,
          { body: { fields } },
        ),
    },

    /** The site/space chrome dictionary: every owner-written word, per language. */
    labels: {
      strings: (orgId: string, scope: LabelScope) => request<{ languages: string[]; labels: LabelDictionary; strings: unknown[]; coverage: Record<string, { translated: number; total: number }> }>('GET', `${labelsAt(orgId, scope)}/strings`),
      /** Replace the whole dictionary. */
      replace: (orgId: string, scope: LabelScope, labels: LabelDictionary) =>
        request<{ labels: LabelDictionary }>('PUT', `${labelsAt(orgId, scope)}/labels`, { body: { labels } }),
      /** Merge word by word; `null` removes a word or a language. */
      merge: (orgId: string, scope: LabelScope, labels: Record<string, Record<string, unknown> | null>) =>
        request<{ labels: LabelDictionary }>('PATCH', `${labelsAt(orgId, scope)}/labels`, { body: { labels } }),
    },

    /** The organization's own wording for our interface strings, per locale. */
    overrides: {
      list: (orgId: string, locale?: string) =>
        request<{ overrides: TranslationOverride[] }>('GET', `/orgs/${orgId}/translation-overrides`, { query: { locale } }),
      set: (orgId: string, input: { locale: string; key: string; value: string }) =>
        request<{ override: TranslationOverride }>('PUT', `/orgs/${orgId}/translation-overrides`, { body: input }),
      remove: (orgId: string, input: { locale: string; key: string }) =>
        request<{ ok: true }>('DELETE', `/orgs/${orgId}/translation-overrides`, { query: input }),
      /** Every key a reader page can show and the English it replaces (public). */
      catalog: (orgId: string) => request<{ catalog: Record<string, string> }>('GET', `/public/orgs/${orgId}/i18n/catalog`),
      /** The overrides readers in one locale are served (public). */
      forLocale: (orgId: string, locale: string) =>
        request<{ overrides: Record<string, string> }>('GET', `/public/orgs/${orgId}/i18n/${enc(locale)}`),
    },

    /** The org-wide default for the reader's language switcher. */
    switcher: {
      get: (orgId: string) => request<Record<string, unknown>>('GET', `/orgs/${orgId}/language-switcher`),
      set: (orgId: string, config: Record<string, unknown>) =>
        request<Record<string, unknown>>('PUT', `/orgs/${orgId}/language-switcher`, { body: config }),
    },

    /** The org's own DeepL key — what every `auto` uses. */
    deepl: {
      status: (orgId: string) => request<{ configured: boolean }>('GET', `/orgs/${orgId}/deepl`),
      connect: (orgId: string, apiKey: string) => request<{ ok: true }>('PUT', `/orgs/${orgId}/deepl`, { body: { apiKey } }),
      disconnect: (orgId: string) => request<{ ok: true }>('DELETE', `/orgs/${orgId}/deepl`),
    },
  };
  return api;
}

export type TranslationsApi = ReturnType<typeof translationsApi>;
