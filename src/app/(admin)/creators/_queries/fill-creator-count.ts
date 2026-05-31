import "server-only";

import { unstable_cache } from "next/cache";

import { creatorsApi } from "@/lib/backend-api";

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
const PAGE_SIZE = 100;
// 5,000 creators — well above the current/projected pool; a guard
// against a runaway loop if `total` is ever reported wrong.
const MAX_PAGES = 50;

async function computeFillCreatorIds(): Promise<string[]> {
  // First page tells us the total — then fan out the rest in parallel.
  const firstPage = await creatorsApi.list({ offset: 0, limit: PAGE_SIZE });
  const ids: string[] = [];
  for (const c of firstPage.data) {
    if (c.total_deals_count > 0) ids.push(c.id);
  }

  const pagesNeeded = Math.min(
    MAX_PAGES,
    Math.ceil(firstPage.total / PAGE_SIZE),
  );
  const rest: Promise<typeof firstPage>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    rest.push(creatorsApi.list({ offset: p * PAGE_SIZE, limit: PAGE_SIZE }));
  }
  for (const page of await Promise.all(rest)) {
    for (const c of page.data) {
      if (c.total_deals_count > 0) ids.push(c.id);
    }
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
