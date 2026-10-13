// Wire types for the Forumulate REST API. Kept intentionally lightweight and
// hand-curated for the stable surface; the full machine-readable schema is
// available from the running API at `/docs-json` (see README → Regenerating).

export type Role = 'OWNER' | 'ADMIN' | 'MAINTAINER' | 'EDITOR' | 'VIEWER';
export type SpaceType = 'DOCS' | 'BLOG' | 'FORUM';
export type SpaceVisibility = 'PRIVATE' | 'PUBLIC';
export type WebhookFormat = 'json' | 'slack' | 'discord';

/** A ProseMirror/TipTap-style document node. */
export interface BlockNode {
  type: string;
  content?: BlockNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}
export interface BlockDoc {
  type: 'doc';
  content: BlockNode[];
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
}

export interface Space {
  id: string;
  name: string;
  slug: string;
  type: SpaceType;
  visibility: SpaceVisibility;
}

export interface Collection {
  id: string;
  name: string;
  slug: string;
}

export interface Page {
  id: string;
  title: string;
  slug: string;
  status?: 'draft' | 'published';
}

export interface SearchHit {
  pageId: string;
  title: string;
  snippet: string;
}

/** A result from the org-wide unified search (docs, forum, blog). */
export interface UnifiedHit {
  sourceType: 'docs' | 'topic' | 'blog';
  id: string;
  spaceId: string;
  spaceName: string;
  title: string;
  snippet: string;
  url: string;
  score: number;
}

export interface Comment {
  id: string;
  parentId: string | null;
  authorName: string;
  body: string;
  status: 'visible' | 'pending' | 'hidden';
  reactions: Record<string, number>;
  createdAt: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  format: WebhookFormat;
  active: boolean;
}

export interface PublicPage {
  title: string;
  content: BlockDoc;
  metadata: { icon?: string; coverUrl?: string; layout?: 'default' | 'wide' };
  variables: Record<string, string>;
  version: string;
  locale: string;
}

/** What a shape says is still missing from a piece. Computed, never enforced. */
export interface Conformance {
  conforms: boolean;
  missing: string[];
  extra: string[];
  duplicate: string[];
}

/** One piece of a space — a page, a topic or an incident, depending on the space. */
export interface Item {
  id: string;
  kind: 'page' | 'topic' | 'incident';
  title: string;
  slug?: string;
  conformance: Conformance;
  /** When it last changed, ISO 8601. What a walk is ordered by. */
  updatedAt?: string;
  /** Markdown per named slot, when `include` asked for `sections`. */
  sections?: Record<string, string>;
  /** The whole piece as markdown, when `include` asked for `body`. */
  markdown?: string;
  /**
   * WHICH of `sections` and `markdown` holds this piece's content.
   *
   * `sections` is populated only for a piece written against a shape, so a
   * free-form piece returns `{}` — indistinguishable, without this, from a
   * piece that is genuinely empty. Asking for `sections` alone and trusting an
   * empty object is how a sync reports success having carried nothing.
   */
  contentIn?: 'sections' | 'markdown';
}

/**
 * Where a walk through a collection continues from.
 *
 * Both spellings, because the API sends both: `has_more`/`next_cursor` were the
 * envelope's original keys and the only snake_case in an otherwise camelCase
 * API, so the camelCase pair was added beside them rather than replacing them.
 * Read `hasMore`/`nextCursor`; the other two are optional here so that code
 * written against either spelling keeps compiling.
 */
export interface PageInfo {
  hasMore?: boolean;
  nextCursor?: string | null;
  /** @deprecated The same value as `hasMore`. */
  has_more?: boolean;
  /** @deprecated The same value as `nextCursor`. */
  next_cursor?: string | null;
  total?: number;
}

/**
 * The shape types, mirrored rather than imported.
 *
 * This package is published on its own, so it cannot depend on the workspace
 * package these are defined in — the same reason `Page` and `Space` are
 * mirrored here. They are structural, so they stay assignable either way.
 */
export interface ShapeSection {
  key: string;
  label: string;
  kind: 'prose' | 'list' | 'steps' | 'table';
  required?: boolean;
  hint?: string;
  example?: string;
  schemaProperty?: string;
  render?: 'labelled' | 'lede' | 'plain';
}

export interface ShapeField {
  key: string;
  label: string;
  type: 'text' | 'select' | 'url' | 'date' | 'boolean';
  options?: readonly string[];
  hint?: string;
  placeholder?: string;
}

/** What a space is: what a reader arrives at, how they move, who may add. */
export interface SpaceArchitecture {
  index: 'landing' | 'list' | 'board' | 'single';
  order: 'manual' | 'chronological' | 'activity' | 'votes' | 'status';
  nav: 'tree' | 'categories' | 'tags' | 'sections' | 'none';
  whoCreates: 'staff' | 'members' | 'anyone';
  summary: readonly string[];
}

export interface EffectiveShape {
  space: SpaceArchitecture;
  params: ShapeField[];
  sections: ShapeSection[];
  /** Keys an override named that no longer exist. Reported, never fatal. */
  unknown: string[];
}

/** A space's own changes, stored as a patch so upstream improvements still land. */
export interface ShapeOverride {
  space?: Partial<SpaceArchitecture>;
  sections?: {
    add?: ShapeSection[];
    omit?: string[];
    order?: string[];
    set?: Record<string, Partial<Omit<ShapeSection, 'key'>>>;
  };
  params?: {
    add?: ShapeField[];
    omit?: string[];
    order?: string[];
    set?: Record<string, Partial<Omit<ShapeField, 'key'>>>;
  };
}

/**
 * A domain attached to a space, and what it is waiting for.
 *
 * `verified` is "we proved you own it"; `active` is "we are answering it". They
 * are two steps on purpose: a customer whose own application still serves
 * `/docs` proves the name first and hands the path across afterwards.
 */
export interface DomainSummary {
  id: string;
  hostname: string;
  /** The path this domain publishes under, or '' for the whole hostname. */
  basePath: string;
  verified: boolean;
  active: boolean;
  verificationRecord: { name: string; value: string };
  verificationFile: { path: string; contents: string };
}

/** What to configure for a domain, and whether traffic reaches us yet. */
export interface DomainSetup {
  mode: 'verified' | 'dns' | 'path' | 'pending' | 'unverified';
  served: boolean;
  message: string;
  /** A CDN in front of the domain is blocking AI crawlers — theirs to change. */
  crawlerBlocked?: boolean;
  forward?: {
    path: string;
    origin: string;
    snippets: { nginx: string; caddy: string; cloudflare: string };
  };
  dns?: { found: string[]; expected: string; reachesUs: boolean };
}
