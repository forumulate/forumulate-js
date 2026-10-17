/**
 * Auto-pagination for every cursor-paged list.
 *
 * A list call returns a `PagePromise`: `await` it for the first page exactly
 * as the API answered it, or `for await` it for every row across every page.
 *
 * ```ts
 * const first = await forumulate.blog.list({ orgId, spaceId });   // one page
 * for await (const post of forumulate.blog.list({ orgId, spaceId })) { … } // all rows
 * for await (const page of forumulate.blog.list({ orgId, spaceId }).pages()) { … }
 * ```
 *
 * The walk follows the envelope the API documents (`page.nextCursor`, rows
 * under `data`). Rankings answer `nextCursor: null` with `hasMore: true` and
 * continue by `?page=` — the walk does that too, so a caller never needs to
 * know which kind of list it is holding.
 */

export type PagePromise<P, R> = Promise<P> &
  AsyncIterable<R> & {
    /** Every page, as answered, starting with the first. */
    pages(): AsyncIterable<P>;
  };

type PageInfoLike = {
  nextCursor?: string | null;
  next_cursor?: string | null;
  hasMore?: boolean;
  has_more?: boolean;
};

/** The rows of one page: `data`, else the one array the answer carries. */
export function rowsOf(page: unknown): unknown[] {
  if (Array.isArray(page)) return page;
  if (!page || typeof page !== 'object') return [];
  const o = page as Record<string, unknown>;
  if (Array.isArray(o.data)) return o.data;
  const arrays = Object.entries(o).filter(([k, v]) => Array.isArray(v) && k !== 'warnings');
  return arrays.length === 1 ? (arrays[0]![1] as unknown[]) : [];
}

/** The query for the page after `page`, or `null` when this was the last. */
export function nextQuery(
  page: unknown,
  query: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!page || typeof page !== 'object') return null;
  const o = page as Record<string, unknown> & PageInfoLike & { page?: PageInfoLike };
  const info: PageInfoLike = o.page && typeof o.page === 'object' ? o.page : o;
  const cursor = info.nextCursor ?? info.next_cursor;
  if (typeof cursor === 'string' && cursor !== '') {
    if (cursor === query.cursor) return null; // a cursor that does not move would loop forever
    const { page: _drop, ...rest } = query;
    return { ...rest, cursor };
  }
  if (info.hasMore ?? info.has_more) {
    const n = Number(query.page ?? 1);
    return { ...query, page: (Number.isFinite(n) ? n : 1) + 1 };
  }
  return null;
}

export function pagePromise<P, R>(
  fetchPage: (query: Record<string, unknown>) => Promise<P>,
  query: Record<string, unknown> = {},
): PagePromise<P, R> {
  const first = fetchPage(query);
  // Iterating without awaiting must not leave the first page's failure "unhandled";
  // an `await` of the promise itself still sees the rejection.
  first.catch(() => undefined);
  async function* pages(): AsyncGenerator<P> {
    let page = await first;
    let q: Record<string, unknown> | null = query;
    for (;;) {
      yield page;
      q = nextQuery(page, q);
      if (!q || rowsOf(page).length === 0) return;
      page = await fetchPage(q);
    }
  }
  async function* rows(): AsyncGenerator<R> {
    for await (const page of pages()) yield* rowsOf(page) as R[];
  }
  return Object.assign(first, {
    pages: () => ({ [Symbol.asyncIterator]: pages }),
    [Symbol.asyncIterator]: rows,
  }) as PagePromise<P, R>;
}
