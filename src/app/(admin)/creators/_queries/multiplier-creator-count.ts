import "server-only";

import { unstable_cache } from "next/cache";

import { multiplierDealsApi } from "@/lib/backend-api";
import { getCachedCreatorRoster } from "@/lib/cache/creator-backend-cache";

// The backend exposes multiplier deals only per-creator (no global list
// / count endpoint), so identifying creators who have one is a
// whole-creator-base fan-out. The resolved id set is cross-request
// cached for 5 minutes — it backs both the "Multiplier Creators" KPI
// count and the /creators "Multiplier" tab filter.

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
  // Roster comes from the SHARED cached walk rather than a private
  // `creatorsApi.list` pagination of its own (2026-08-12). One /creators
  // render previously paged the identical roster here, in
  // fill-creator-count.ts, in creators-stats.ts AND in the shared cache —
  // four walks of one list. This is also the resilient source: six-hour
  // last-known-good retention plus a read-only PostgreSQL fallback, so a
  // backend blip no longer empties the Multiplier tab.
  //
  // Scope note: the shared roster caps at CREATOR_LIST_CAP (500) vs the old
  // private 5,000 — identical below 500, and at/above it the id set now
  // agrees with the tab list that consumes it.
  const creators = await getCachedCreatorRoster();

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
