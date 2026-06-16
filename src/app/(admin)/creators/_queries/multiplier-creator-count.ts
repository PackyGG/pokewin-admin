import "server-only";

import { unstable_cache } from "next/cache";

import { creatorsApi, multiplierDealsApi } from "@/lib/backend-api";

// The backend exposes multiplier deals only per-creator (no global list
// / count endpoint), so identifying creators who have one is a
// whole-creator-base fan-out. The resolved id set is cross-request
// cached for 5 minutes — it backs both the "Multiplier Creators" KPI
// count and the /creators "Multiplier" tab filter.
const PAGE_SIZE = 100;
// 5,000 creators — well above the current/projected pool; a guard
// against a runaway loop if `total` is ever reported wrong.
const MAX_PAGES = 50;

// Source-of-truth: the id list, cross-request cached via `unstable_cache`
// (5-min revalidate) so spamming the Multiplier / Fill tabs doesn't fan
// into the backend on every flip. Mirrors the sibling fill-creator-count.ts
// (same TTL, same intent). Backend-only, so it resolves to the prod env
// inside the cache scope and needs no env key.
const cachedMultiplierCreatorIds = unstable_cache(
  computeIds,
  ["creators-multiplier-ids"],
  { revalidate: 300, tags: ["creators-multiplier-count"] },
);

/**
 * Set of creator user-ids that have at least one multiplier deal (any
 * status). The single source of truth for the "Multiplier Creators" KPI
 * and the multiplier-tab creator filter.
 *
 * Best-effort: a total backend failure returns null (callers treat that
 * as "unknown" — KPI renders "—", multiplier tab renders empty). A
 * single creator's failed lookup just drops that creator from the set.
 */
export async function getMultiplierCreatorIds(): Promise<Set<string> | null> {
  try {
    const ids = await cachedMultiplierCreatorIds();
    return new Set(ids);
  } catch (e) {
    console.error(
      "[multiplier-creator-count] failed (KPI '—', multiplier tab empty):",
      e,
    );
    return null;
  }
}

/**
 * Count of creators with a multiplier deal — the "Multiplier Creators"
 * KPI value. null when the backend lookup failed (tile renders "—").
 */
export async function getMultiplierCreatorCount(): Promise<number | null> {
  const ids = await getMultiplierCreatorIds();
  return ids === null ? null : ids.size;
}

async function computeIds(): Promise<string[]> {
  // Walk every creator — first page tells us the total, then the rest
  // in parallel (mirrors getCreatorsGlobalStats' pagination).
  const firstPage = await creatorsApi.list({ offset: 0, limit: PAGE_SIZE });
  const creators = [...firstPage.data];

  const pagesNeeded = Math.min(
    MAX_PAGES,
    Math.ceil(firstPage.total / PAGE_SIZE),
  );
  const rest: Promise<typeof firstPage>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    rest.push(creatorsApi.list({ offset: p * PAGE_SIZE, limit: PAGE_SIZE }));
  }
  for (const page of await Promise.all(rest)) creators.push(...page.data);

  // Per-creator: does this creator have ≥1 multiplier deal? allSettled
  // so one creator's failed lookup doesn't blank the whole set.
  const settled = await Promise.allSettled(
    creators.map((c) =>
      multiplierDealsApi
        .list(c.id, { limit: 1 })
        .then((r) => (r.total > 0 ? c.id : null)),
    ),
  );
  // Returned as a plain array (not a Set) so the `unstable_cache` layer
  // can serialize it; callers rebuild the Set.
  const ids: string[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) ids.push(r.value);
  }
  return ids;
}
