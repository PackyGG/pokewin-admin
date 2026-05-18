import "server-only";

import { creatorsApi, type CreatorListItem } from "@/lib/backend-api";
import type { CreatorsSearchParams } from "../_lib/search-params";
import type { CreatorsListPage } from "./list-creators";
import { getCodeAndWagerByUser } from "./code-and-wager-by-user";
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

  // Sort. `recent` keeps the backend walk order (creation order). The
  // pnl_* modes need lifetime PnL — batched in one round-trip across
  // the filtered pool. Creators with no PnL sort last.
  if (params.sortBy === "pnl_desc" || params.sortBy === "pnl_asc") {
    const pnlMap = await getCodeAndWagerByUser(pool.map((c) => c.id));
    const desc = params.sortBy === "pnl_desc";
    pool = [...pool].sort((a, b) => {
      const av = pnlMap.get(a.id)?.lifetimePnl?.pnl ?? null;
      const bv = pnlMap.get(b.id)?.lifetimePnl?.pnl ?? null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return desc ? bv - av : av - bv;
    });
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
