/**
 * Cache-tag bucket every rakeback insight helper writes to. Kept in one
 * place so the `makeCachedPair` calls in `overview.ts` / `roi.ts` stay in
 * lockstep — the same `["rewards-analytics", "insights-rewards-rakeback"]`
 * tags the hand-rolled cache layers used before they were unified onto the
 * shared `_cache` helper. Revalidate either tag to refresh the surface.
 */
export const RAKEBACK_CACHE_TAGS = [
  "rewards-analytics",
  "insights-rewards-rakeback",
] as const;
