import { unstable_cache } from "next/cache";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";

/**
 * Shared cache guardrail for every `insights-rewards` query helper.
 *
 * Almost every helper in this folder follows the identical pattern: a
 * `compute*(period, blacklist)` function wrapped in TWO `unstable_cache`
 * layers — a 60s "short" layer for finite windows that move as new
 * activity lands, and a 300s "lifetime" layer for the `all` window that
 * barely moves second-to-second — both keyed on `(period, blacklist)` so
 * the dynamic exclusion list participates in the cache key, and routed by
 * {@link cacheTtlForInsightsPeriod} (≥300 → lifetime layer).
 *
 * This pair was originally hand-rolled in every file (and lived trapped
 * inside `deposit-bonus/impact.ts`). Promoting it here de-duplicates the
 * boilerplate and keeps the 60s/300s split + blacklist-keying consistent
 * across the whole surface. Behaviour is byte-for-byte identical to the
 * per-file pairs it replaces — perf/consistency only, no number change.
 */

/**
 * Resolved exclusion list — the dynamic blacklist (`excluded_users` table)
 * sorted so it forms a stable cache key. (Staff exclusion is applied
 * inside each query's SQL, not here.) Returns the sorted id list so
 * callers participate in the `unstable_cache` key.
 */
export async function getInsightsRewardsBlacklist(): Promise<string[]> {
  const blacklist = await getExcludedUserIds();
  return [...blacklist].sort();
}

/**
 * Wrap a `compute(...keyArgs, blacklist)` function in the canonical
 * 60s/300s cache pair and return `(...keyArgs) => Promise<T>` that resolves
 * the blacklist, picks the right TTL layer (by the FIRST key arg, which is
 * always the {@link InsightsRewardsPeriod}), and delegates.
 *
 * The compute fn's LAST parameter must be the resolved blacklist
 * (`string[]`); every parameter before it is a cache-key dimension and is
 * threaded through verbatim. Most helpers key on `(period, blacklist)`
 * only; a few (e.g. rakeback ROI) carry an extra dimension such as the
 * lookback-day selector, which stays part of the `unstable_cache` key.
 *
 *   - `fn`      — the `compute*` function (read-only, staff+blacklist
 *                 already handled in its SQL).
 *   - `baseKey` — unique cache key prefix; the short layer gets
 *                 `${baseKey}-v1`, the lifetime layer `${baseKey}-lifetime-v1`.
 *   - `tags`    — `unstable_cache` revalidation tags (the surface's cache
 *                 tag bucket).
 */
export function makeCachedPair<KeyArgs extends [InsightsRewardsPeriod, ...unknown[]], T>(
  fn: (...args: [...KeyArgs, string[]]) => Promise<T>,
  baseKey: string,
  tags: readonly string[],
) {
  const tagList = [...tags];
  const short = unstable_cache(fn, [`${baseKey}-v1`], {
    revalidate: 60,
    tags: tagList,
  });
  const lifetime = unstable_cache(fn, [`${baseKey}-lifetime-v1`], {
    revalidate: 300,
    tags: tagList,
  });
  return async (...keyArgs: KeyArgs): Promise<T> => {
    const blacklist = await getInsightsRewardsBlacklist();
    const ttl = cacheTtlForInsightsPeriod(keyArgs[0]);
    const layer = ttl >= 300 ? lifetime : short;
    return layer(...keyArgs, blacklist);
  };
}
