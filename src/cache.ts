/**
 * `client.cache.purge()` — drop cached copies, delete nothing (FMU-B04).
 *
 * The generated `cache.purgeSpace / purgePage / purgeOrg` are the three
 * operations; this is the one call a deploy script wants: name the space (and
 * a page, or neither for the whole org) and get back which addresses went and
 * which CDN took them. The old `privacy.consent.purgeSpace()` still works and
 * runs the same purge. Destroying a trashed page or space is
 * `pages.destroy()` / `spaces.destroy()` — a different word on purpose.
 */
export interface CachePurgeResult {
  /** `page`, `space` or `org`. */
  purged: string;
  urls: string[];
  urlCount: number;
  /** The CDN that took it (`cloudflare`, `fastly`, …), `multiple`, or `none` when none fronts it. */
  edge: string;
  edges: { name: string; account: 'platform' | 'org'; urls: number; ok: boolean; error?: string }[];
  /** Our own web tier was refreshed. */
  webTier: boolean;
}

export interface CachePurgeArgs {
  orgId: string;
  /** Space id (or slug where the API accepts one). Omit for the whole organization. */
  space?: string;
  /** Page id within `space`: just that page. */
  page?: string;
}

type Http = <T>(method: string, path: string) => Promise<T>;

export function cacheApi(http: Http) {
  const space = (orgId: string, spaceId: string) =>
    `/orgs/${encodeURIComponent(orgId)}/spaces/${encodeURIComponent(spaceId)}`;
  return {
    /** `Cache_purgePage`: one page's every address. */
    purgePage(args: { orgId: string; spaceId: string; pageId: string }): Promise<CachePurgeResult> {
      return http('POST', `${space(args.orgId, args.spaceId)}/pages/${encodeURIComponent(args.pageId)}/cache/purge`);
    },
    /** `Cache_purgeSpace`: everything under the space. */
    purgeSpace(args: { orgId: string; spaceId: string }): Promise<CachePurgeResult> {
      return http('POST', `${space(args.orgId, args.spaceId)}/cache/purge`);
    },
    /** `Cache_purgeOrg`: every space in the organization. */
    purgeOrg(args: { orgId: string }): Promise<CachePurgeResult> {
      return http('POST', `/orgs/${encodeURIComponent(args.orgId)}/cache/purge`);
    },
    /** Purge one page, one space, or (no `space`) every space in the org. */
    purge(args: CachePurgeArgs): Promise<CachePurgeResult> {
      const org = encodeURIComponent(args.orgId);
      if (!args.space) {
        if (args.page) throw new Error('cache.purge: `page` needs `space`.');
        return http<CachePurgeResult>('POST', `/orgs/${org}/cache/purge`);
      }
      const space = `/orgs/${org}/spaces/${encodeURIComponent(args.space)}`;
      return http<CachePurgeResult>(
        'POST',
        args.page
          ? `${space}/pages/${encodeURIComponent(args.page)}/cache/purge`
          : `${space}/cache/purge`,
      );
    },
  };
}
