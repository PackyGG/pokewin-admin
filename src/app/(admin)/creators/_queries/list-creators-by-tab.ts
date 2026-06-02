import "server-only";

import { creatorsApi, type CreatorListItem } from "@/lib/backend-api";
import type { CreatorsSearchParams } from "../_lib/search-params";
import type { CreatorsListPage } from "./list-creators";
import { getMultiplierCreatorIds } from "./multiplier-creator-count";

/**
 * Tab-aware creator list for /creators.
 *
 * The page's Fill / Multiplier tabs each show only creators of that
 * deal program, so the list MUST be filtered before pagination — and
 * the backend's /admin/creators has no deal-program filter. So this
 * walks the full creator pool, filters by tab, then applies search,
 * sort, and pagination in memory.
 *
 *   • fill       — creators with `total_deals_count > 0` (a fill deal).
 *   • multiplier — creators in the multiplier-creator id set.
 *
 * A full walk on every load is acceptable: getCreatorsGlobalStats
 * already walks the pool for the KPI strip on the same render, and the
 * multiplier id set is itself 5-min cached.
 */
const PAGE_SIZE = 100;
const FETCH_CAP = 500;

async function walkAllCreators(): Promise<CreatorListItem[]> {
  const firstPage = await creatorsApi.list({ offset: 0, limit: PAGE_SIZE });
  const all = [...firstPage.data];
  const pagesNeeded = Math.min(
    Math.ceil(FETCH_CAP / PAGE_SIZE),
    Math.ceil(firstPage.total / PAGE_SIZE),
  );
  const rest: Promise<typeof firstPage>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    rest.push(creatorsApi.list({ offset: p * PAGE_SIZE, limit: PAGE_SIZE }));
  }
  for (const page of await Promise.all(rest)) all.push(...page.data);
  return all;
}

export async function getCreatorsListForTab(
  params: CreatorsSearchParams,
  tab: CreatorsSearchParams["tab"],
  // Optional roster-wide windowed code-user GGR map (creatorUserId →
  // ggr) used ONLY for the `ggr_*` sorts. When supplied, the WHOLE
  // tab/search pool is ordered by GGR before pagination, so page 1
  // carries the genuine top/bottom creators by GGR — not just a
  // re-shuffle of the current page. Sourced from the same cached
  // `getAllCreatorsNetGgr(period)` the page merges onto the rows, so
  // passing it here costs nothing extra. Creators absent from the map
  // (no attributed activity in the window) sort as 0.
  ggrByUser?: Map<string, number>,
): Promise<CreatorsListPage> {
  const all = await walkAllCreators();

  // Tab filter — keep only creators of the selected deal program.
  let pool: CreatorListItem[];
  if (tab === "multiplier") {
    const ids = await getMultiplierCreatorIds();
    // null = backend lookup failed → render the tab empty rather than
    // misleadingly showing every creator.
    pool = ids ? all.filter((c) => ids.has(c.id)) : [];
  } else {
    pool = all.filter((c) => c.total_deals_count > 0);
  }

  // Search filter — username / email substring, case-insensitive.
  // Mirrors the fuzzy backend search for the trivial case (same as
  // fetchAllCreatorsSortedByLifetimePnl does on its full-walk path).
  const q = params.search?.trim().toLowerCase();
  if (q) {
    pool = pool.filter(
      (c) =>
        (c.username ?? "").toLowerCase().includes(q) ||
        (c.email ?? "").toLowerCase().includes(q),
    );
  }

  // Sort.
  //   • ggr_desc / ggr_asc — order the WHOLE pool by the roster-wide
  //     windowed GGR map (when supplied) BEFORE pagination, so page 1
  //     carries the real top/bottom creators by GGR. This is the cheap
  //     global path: the GGR is already computed roster-wide and
  //     cached, so no per-creator fan-out is added.
  //   • ftd_* — NOT globally sorted here. A true roster-wide FTD
  //     ranking would need a full-pool FTD fan-out (the expensive walk
  //     the old pnl_* modes used, dropped for the active-timeframe
  //     rule). Instead the page re-orders the CURRENT page's rows by
  //     their (already-fetched) FTD count — a page-local sort, the same
  //     in-memory model as the `recent` active-deal pin.
  //   • recent — backend walk order (active-deal pin applied by page).
  if (ggrByUser && (params.sortBy === "ggr_desc" || params.sortBy === "ggr_asc")) {
    const dir = params.sortBy === "ggr_desc" ? -1 : 1;
    pool = [...pool].sort(
      (a, b) =>
        dir * ((ggrByUser.get(a.id) ?? 0) - (ggrByUser.get(b.id) ?? 0)),
    );
  }

  // Paginate in memory.
  const total = pool.length;
  const start = (params.page - 1) * params.perPage;
  return {
    data: pool.slice(start, start + params.perPage),
    total,
    page: params.page,
    perPage: params.perPage,
    totalPages: Math.max(1, Math.ceil(total / params.perPage)),
  };
}
