import "server-only";

import { unstable_cache } from "next/cache";

import {
  getRosterSocialsByUser,
  type CreatorSocialSummary,
  CREATOR_LINKED_SOCIALS_CACHE_TAG,
} from "../../../../(admin)/creators/_queries/socials-by-user";

/**
 * Cross-request cached wrapper around the roster social chips
 * ({@link getRosterSocialsByUser}) for the Creator Hub roster grids.
 *
 * `getRosterSocialsByUser` merges a cheap admin-DB `creator_socials` read
 * with the FULL backend approved-socials roster walk (200/page) — the
 * backend walk was being re-paid on EVERY `/creator-hub/creators` render
 * (every tab flip + period switch), uncached, even though the underlying
 * data barely changes. This caches the merged result (180s revalidate),
 * keyed on the sorted creator id list, so repeat roster paints serve the
 * warmed entry instead of re-walking the backend.
 *
 * Admin-DB + backend-API only inside (no `getDb()` / cookies), so caching
 * is env-safe — the backend resolves to the prod env inside the cache
 * scope, matching the sibling cached creator-pool walks. Tagged with
 * {@link CREATOR_LINKED_SOCIALS_CACHE_TAG} so the Hub social-edit / refetch
 * actions (which already `revalidateTag` it) flush the roster cache too —
 * an edit shows up immediately instead of waiting out the TTL (matching the
 * single-creator `getCreatorLinkedSocialsCached` behaviour).
 *
 * Returns serializable entries (an `unstable_cache` callback can't store a
 * `Map`); the public helper rebuilds the Map. The ids are folded into the
 * key parts so each distinct roster lands in its own slot.
 */
const cachedRosterSocialEntries = (sortedIds: string[]) =>
  unstable_cache(
    async (): Promise<[string, CreatorSocialSummary[]][]> => {
      const map = await getRosterSocialsByUser(sortedIds);
      return [...map.entries()];
    },
    ["creator-hub-roster-socials-v1", ...sortedIds],
    { revalidate: 180, tags: [CREATOR_LINKED_SOCIALS_CACHE_TAG] },
  );

/**
 * Cached {@link getRosterSocialsByUser} for the Creator Hub roster grids.
 * Same shape + semantics; only the backend walk is amortized across renders.
 */
export async function getRosterSocialsByUserCached(
  userIds: string[],
): Promise<Map<string, CreatorSocialSummary[]>> {
  if (userIds.length === 0) return new Map();
  // Sort so the cache key is stable regardless of roster order — the result
  // Map is keyed by userId (order-independent), so a sorted key lifts the
  // hit rate without changing any output.
  const sortedIds = [...userIds].sort();
  return new Map(await cachedRosterSocialEntries(sortedIds)());
}
