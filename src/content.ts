/**
 * Content libraries (headless CMS): the management routes under
 * `/orgs/{orgId}/content/libraries/{libraryId}/…`.
 *
 * Hand-written because the generated `schema.ts` is refreshed from the
 * DEPLOYED spec, and these routes are newer than the last refresh; `typed()`
 * covers them once it catches up. Everything is addressed by `libraryId`,
 * never by the hidden space behind a library: that id is not part of the
 * contract (spec 14).
 */

type Request = <T>(
  method: string,
  path: string,
  opts?: { body?: unknown; query?: Record<string, string | number | boolean | undefined>; headers?: Record<string, string> },
) => Promise<T>;

export interface ContentLibrary {
  id: string;
  name: string;
  slug: string;
  siteId: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type LibraryRole = 'viewer' | 'editor' | 'manager';

export interface LibraryMember {
  userId: string;
  email: string;
  name: string;
  role: LibraryRole | null;
  customRoleId: string | null;
  effect: 'ALLOW' | 'DENY';
}

/** A declared model change a diff cannot infer (a rename), or a removal. */
export type ModelOp =
  | { op: 'renameField'; type?: string; blockType?: string; from: string; to: string }
  | { op: 'removeField'; type?: string; blockType?: string; path: string }
  | { op: 'restoreField'; type?: string; blockType?: string; path: string }
  | { op: 'renameType'; from: string; to: string }
  | { op: 'renameBlockType'; from: string; to: string };

export interface ContentModel {
  shape: Record<string, unknown>;
  types: Record<string, unknown>;
  version: number;
}

export interface ContentModelVersion {
  version: number;
  ops: ModelOp[];
  createdBy: string | null;
  createdAt: string;
  migratedAt: string | null;
}

export type ModelFileFormat = 'json' | 'payload';

export interface ModelFileIssue {
  path: string;
  kind: 'hook' | 'access' | 'component' | 'function' | 'lossy' | 'unsupported' | 'ignored' | 'rewritten';
  message: string;
}

export interface ContentModelExport {
  format: ModelFileFormat;
  filename: string;
  content: string;
  version: number;
  issues: ModelFileIssue[];
}

export interface ModelChangeLine {
  op: 'add' | 'remove' | 'change';
  target: 'type' | 'setting' | 'field' | 'blockType' | 'blockField';
  type?: string;
  blockType?: string;
  path?: string;
  property?: string;
  before?: unknown;
  after?: unknown;
}

export interface ContentModelImportResult {
  changed: boolean;
  applied: boolean;
  diff: ModelChangeLine[];
  storageOnly: boolean;
  ops: ModelOp[];
  issues: ModelFileIssue[];
  version: number;
}

/** An entry as the management API answers a write: enough to address it again. */
export interface ContentEntryRef {
  id: string;
  title: string;
  slug?: string;
  preset?: string | null;
}

export interface ContentAssetSummary {
  id: string;
  url: string;
  filename: string;
  contentType?: string;
  [extra: string]: unknown;
}

export type DeliveryKeyKind = 'delivery' | 'publishable' | 'preview';

export interface DeliveryKeySummary {
  id: string;
  name: string;
  kind: DeliveryKeyKind;
  prefix: string;
  stage: 'published' | 'draft';
  libraryId: string;
  origins: string[] | null;
  contentTypes: string[] | null;
  locales: string[] | null;
  lastUsedAt: string | null;
  [extra: string]: unknown;
}

export interface IssuedDeliveryKey {
  key: DeliveryKeySummary;
  /** Shown once. */
  secret: string;
}

export function contentApi(request: Request) {
  const lib = (orgId: string, libraryId: string) => `/orgs/${orgId}/content/libraries/${libraryId}`;
  return {
    libraries: {
      list: (orgId: string) => request<{ libraries: ContentLibrary[] }>('GET', `/orgs/${orgId}/content/libraries`),
      get: (orgId: string, libraryId: string) => request<{ library: ContentLibrary }>('GET', lib(orgId, libraryId)),
      create: (
        orgId: string,
        input: { name: string; slug?: string; siteId?: string | null; settings?: Record<string, unknown>; template?: string },
      ) => request<{ library: ContentLibrary }>('POST', `/orgs/${orgId}/content/libraries`, { body: input }),
      update: (
        orgId: string,
        libraryId: string,
        input: { name?: string; slug?: string; siteId?: string | null; settings?: Record<string, unknown> },
      ) => request<{ library: ContentLibrary }>('PATCH', lib(orgId, libraryId), { body: input }),
      remove: (orgId: string, libraryId: string) => request<{ ok: true }>('DELETE', lib(orgId, libraryId)),
    },
    members: {
      list: (orgId: string, libraryId: string) =>
        request<{ members: LibraryMember[] }>('GET', `${lib(orgId, libraryId)}/members`),
      put: (
        orgId: string,
        libraryId: string,
        input: { userId: string; role?: LibraryRole; customRoleId?: string; effect?: 'ALLOW' | 'DENY' },
      ) => request<{ member: LibraryMember }>('POST', `${lib(orgId, libraryId)}/members`, { body: input }),
      remove: (orgId: string, libraryId: string, userId: string) =>
        request<{ ok: true }>('DELETE', `${lib(orgId, libraryId)}/members/${userId}`),
    },
    model: {
      get: (orgId: string, libraryId: string) => request<{ model: ContentModel }>('GET', `${lib(orgId, libraryId)}/model`),
      save: (
        orgId: string,
        libraryId: string,
        input: { shape?: Record<string, unknown>; types?: Record<string, unknown>; ops?: ModelOp[] },
      ) => request<{ model: ContentModel }>('PUT', `${lib(orgId, libraryId)}/model`, { body: input }),
      versions: (orgId: string, libraryId: string) =>
        request<{ versions: ContentModelVersion[] }>('GET', `${lib(orgId, libraryId)}/model/versions`),
      /** The model as a file: `forumulate.content.json`, or a Payload config. */
      export: (orgId: string, libraryId: string, format: ModelFileFormat = 'json') =>
        request<ContentModelExport>('GET', `${lib(orgId, libraryId)}/model/export`, { query: { format } }),
      /** Push a model file: a diff always, a new version unless `dryRun` (or nothing changed). */
      import: (
        orgId: string,
        libraryId: string,
        input: { format: ModelFileFormat; content: string; dryRun?: boolean; baseVersion?: number; force?: boolean; ops?: ModelOp[] },
      ) => request<ContentModelImportResult>('POST', `${lib(orgId, libraryId)}/model/import`, { body: input }),
      /** The library's delivery JSON Schema (what `forumulate content types` generates from). */
      schema: (orgId: string, libraryId: string, opts: { audience?: 'public' | 'preview' } = {}) =>
        request<Record<string, unknown>>('GET', `${lib(orgId, libraryId)}/model/schema.json`, { query: { audience: opts.audience } }),
    },
    /**
     * Entries by their management id. `create` takes an `Idempotency-Key` (the
     * route requires one), so a retried import returns the entry the first call
     * made. Later writes may carry the entry's `contentHash` as `If-Match`; an import is the only writer, so it sends none.
     */
    entries: {
      create: (
        orgId: string,
        libraryId: string,
        input: { title: string; slug?: string; preset: string; params?: Record<string, unknown> },
        idempotencyKey: string,
      ) =>
        request<{ item: ContentEntryRef; warnings?: string[] }>('POST', `${lib(orgId, libraryId)}/items`, {
          body: input,
          headers: { 'Idempotency-Key': idempotencyKey },
        }),
      /** Which of these `Idempotency-Key`s already made an entry, as key → entry id (an import's dry-run and its update path). */
      lookup: (orgId: string, libraryId: string, keys: string[]) =>
        request<{ found: Record<string, string> }>('POST', `${lib(orgId, libraryId)}/items/lookup`, { body: { keys } }),
      /** Rename, re-address or patch the fields (`params`) of an entry. */
      update: (orgId: string, libraryId: string, entryId: string, input: { title?: string; slug?: string; params?: Record<string, unknown> }) =>
        request<{ item: ContentEntryRef; warnings?: string[] }>('PATCH', `${lib(orgId, libraryId)}/items/${entryId}`, { body: input }),
      /** Write an entry's localized fields into the DRAFT of one locale's twin, making the twin first when needed. */
      writeLocale: (orgId: string, libraryId: string, entryId: string, locale: string, fields: Record<string, unknown>) =>
        request<{ locale: string; sourceEntryId: string; entryId: string; created: boolean }>(
          'PUT',
          `${lib(orgId, libraryId)}/entries/${entryId}/locales/${encodeURIComponent(locale)}`,
          { body: { fields } },
        ),
      read: (orgId: string, libraryId: string, entryId: string) =>
        request<{ item: ContentEntryRef & { contentHash: string } }>('GET', `${lib(orgId, libraryId)}/items/${entryId}`),
      setFields: (orgId: string, libraryId: string, entryId: string, fields: Record<string, unknown>, ifMatch?: string) =>
        request<{ fields: Record<string, unknown>; warnings?: string[] }>('PATCH', `${lib(orgId, libraryId)}/items/${entryId}/fields`, {
          body: { fields },
          headers: ifMatch ? { 'If-Match': `"${ifMatch}"` } : undefined,
        }),
      publish: (orgId: string, libraryId: string, entryId: string, ifMatch?: string) =>
        request<{ published: boolean; note?: string }>('POST', `${lib(orgId, libraryId)}/items/${entryId}/publish`, {
          headers: ifMatch ? { 'If-Match': `"${ifMatch}"` } : undefined,
        }),
    },
    locales: {
      list: (orgId: string, libraryId: string) =>
        request<{ sourceLocale: string; locales: { code: string; label: string }[] }>('GET', `${lib(orgId, libraryId)}/locales`),
      add: (orgId: string, libraryId: string, input: { code: string; label: string }) =>
        request<{ sourceLocale: string; locales: { code: string; label: string }[] }>('POST', `${lib(orgId, libraryId)}/locales`, { body: input }),
    },
    assets: {
      list: (orgId: string, libraryId: string, query: { search?: string; limit?: number } = {}) =>
        request<{ assets: ContentAssetSummary[] }>('GET', `${lib(orgId, libraryId)}/assets`, { query }),
    },
    keys: {
      list: (orgId: string, libraryId: string) => request<{ keys: DeliveryKeySummary[] }>('GET', `${lib(orgId, libraryId)}/keys`),
      create: (
        orgId: string,
        libraryId: string,
        input: { name: string; kind: DeliveryKeyKind; origins?: string[]; contentTypes?: string[]; locales?: string[]; expiresInDays?: number },
      ) => request<IssuedDeliveryKey>('POST', `${lib(orgId, libraryId)}/keys`, { body: input }),
      update: (
        orgId: string,
        libraryId: string,
        keyId: string,
        input: { name?: string; origins?: string[] | null; contentTypes?: string[] | null; locales?: string[] | null },
      ) => request<{ key: DeliveryKeySummary }>('PATCH', `${lib(orgId, libraryId)}/keys/${keyId}`, { body: input }),
      rotate: (orgId: string, libraryId: string, keyId: string, input: { graceMinutes?: number } = {}) =>
        request<IssuedDeliveryKey>('POST', `${lib(orgId, libraryId)}/keys/${keyId}/rotate`, { body: input }),
      revoke: (orgId: string, libraryId: string, keyId: string) =>
        request<{ ok: true }>('DELETE', `${lib(orgId, libraryId)}/keys/${keyId}`),
    },
  };
}

export type ContentApi = ReturnType<typeof contentApi>;
