import "server-only";

import { unstable_cache } from "next/cache";

import { getCachedCreatorRoster } from "@/lib/cache/creator-backend-cache";

// Fill (weekly) deal creator count — backs the tab-aware KPI tile on
// /creators when the Fill tab is active. The backend's
// /admin/creators row carries `total_deals_count` (lifetime fill-deal
// count), so the global "Fill Creators" count is a full creator-pool
// walk that tallies `total_deals_count > 0`.
//
// The full walk is identical to what getCreatorsGlobalStats already
// does for the broader strip — extracted into its own thin cached
// helper here so the tab-aware KPI tile can read the count without
// pulling in the heavier deal-cap / live-session fan-outs that the
// global stats does.
//
// `unstable_cache` (5-min revalidate) so spamming the Fill / Multiplier
// tabs doesn't fan into the backend on every flip. Mirrors the in-memory
// 5-min cache on multiplier-creator-count.ts (same TTL, same intent).
//
// ─── 2026-08-12: walks the SHARED roster, not its own ─────────────────
//
// This used to page `creatorsApi.list` itself, so one /creators render fired
// this walk AND the identical walk inside `getCachedCreatorRoster()` (which
// `getCreatorsListForTab` uses to build the Fill tab's rows from the very
// same `total_deals_count > 0` predicate). Two full roster walks, one
// predicate, one screen.
//
// Reading the shared roster instead collapses them to one and — more
// importantly for the "Couldn't load this section" tiles — inherits that
// cache's resilience: a six-hour last-known-good retention plus a read-only
// PostgreSQL fallback (`pageCreatorRosterFromPostgres`). A backend blip used
// to blank this tile to "—"; now it keeps serving.
//
// Scope note: the shared roster is capped at CREATOR_LIST_CAP (500) where the
// old private walk capped at 5,000. Nothing changes below 500 creators, and
// at/above it the count now MATCHES the Fill tab list it labels (which was
// already reading the 500-capped roster) instead of silently exceeding it.
async function computeFillCreatorIds(): Promise<string[]> {
  const roster = await getCachedCreatorRoster();
  const ids: string[] = [];
  for (const c of roster) {
    if (c.total_deals_count > 0) ids.push(c.id);
  }
  return ids;
}

// Source-of-truth: the id list. Count is derived from it so the
// count tile and any tab-scoped aggregate (e.g. the global PnL tile)
// share an identical set — if a creator is counted, they're also
// included in the aggregate, no drift.
const cachedFillCreatorIds = unstable_cache(
  computeFillCreatorIds,
  ["creators-fill-ids"],
  { revalidate: 300, tags: ["creators-fill-count"] },
);

/**
 * Cached set of creator user-ids that have at least one fill (weekly)
 * deal. Backs both the "Fill Creators" KPI count and the tab-scoped
 * Global PnL aggregate on /creators. Best-effort — a backend failure
 * returns null so callers fall back to "—".
 */
export async function getFillCreatorIds(): Promise<Set<string> | null> {
  try {
    const ids = await cachedFillCreatorIds();
    return new Set(ids);
  } catch (err) {
    console.error(
      "[fill-creator-count] id fetch failed (downstream renders '—'):",
      err,
    );
    return null;
  }
}

/**
 * Cached count of creators with at least one fill (weekly) deal. Backs
 * the tab-aware "Fill Creators" KPI tile on /creators. Best-effort —
 * a backend failure returns null so the tile renders "—" rather than
 * crashing the page.
 */
export async function getFillCreatorCount(): Promise<number | null> {
  const ids = await getFillCreatorIds();
  return ids === null ? null : ids.size;
}
