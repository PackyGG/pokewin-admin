import "server-only";

import { creatorsApi, type CreatorListItem } from "@/lib/backend-api";
import { getCodeAndWagerByUser } from "./code-and-wager-by-user";

/**
 * Heavy-path fetcher for the "sort by lifetime PnL" view on /creators.
 *
 * Strategy:
 *   1. Page through the backend's /admin/creators in 100-row chunks
 *      until either `total` is reached or SORT_FETCH_CAP is hit.
 *      Same pagination pattern as `creators-stats.ts` so the helpers
 *      share the perf envelope.
 *   2. Pass the full creator-ID list to `getCodeAndWagerByUser` —
 *      that's already batched (one round-trip across every creator)
 *      and returns the lifetime PnL we need for sorting.
 *   3. Apply optional search filter client-side (the backend's
 *      `search` is fuzzy on username; reproducing it 1:1 client-side
 *      is fine — `String.includes` on lowercased username/email).
 *   4. Sort by `lifetimePnl.pnl` in the requested direction. Creators
 *      with NO lifetimePnl (query failure on their row) are sorted
 *      LAST so they don't squat the top of either view.
 *   5. Return ALL sorted rows; the caller paginates in memory using
 *      the user's `page` / `perPage`. We hand back `total` as the
 *      pre-pagination length so the existing DataTablePagination
 *      renders the right page count.
 *
 * Cost notes:
 *   • At 100 creators / call and SORT_FETCH_CAP=500, this is at most
 *     5 backend round-trips + one batched main-DB call (with N
 *     creator IDs). Well under a second in practice for current scale.
 *   • Skipped entirely for the default sortBy=recent path — that
 *     keeps using the cheap 20-row backend pagination.
 */
const PAGE_SIZE = 100;
const SORT_FETCH_CAP = 500; // ~ 25 pages of 20 rows.

export type CreatorWithLifetimePnl = CreatorListItem & {
  lifetimePnl: number | null;
};

export async function fetchAllCreatorsSortedByLifetimePnl(opts: {
  direction: "asc" | "desc";
  search?: string;
}): Promise<{
  data: CreatorWithLifetimePnl[];
  total: number;
}> {
  // Walk the backend until we hit `total` (or the cap). First page
  // also tells us the absolute total; the rest go in parallel.
  const firstPage = await creatorsApi.list({
    offset: 0,
    limit: PAGE_SIZE,
  });
  const totalBackend = firstPage.total;
  const pagesNeeded = Math.min(
    Math.ceil(SORT_FETCH_CAP / PAGE_SIZE),
    Math.ceil(totalBackend / PAGE_SIZE),
  );
  const remainingPagePromises: Promise<typeof firstPage>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    remainingPagePromises.push(
      creatorsApi.list({ offset: p * PAGE_SIZE, limit: PAGE_SIZE }),
    );
  }
  const remainingPages = await Promise.all(remainingPagePromises);
  const allCreators: CreatorListItem[] = [
    ...firstPage.data,
    ...remainingPages.flatMap((p) => p.data),
  ];

  // Search filter — apply client-side over the full pool. Username +
  // email substring match, case-insensitive. Matches what the backend
  // would do for the trivial-case search.
  const q = opts.search?.trim().toLowerCase();
  const filtered = q
    ? allCreators.filter((c) => {
        const u = (c.username ?? "").toLowerCase();
        const e = (c.email ?? "").toLowerCase();
        return u.includes(q) || e.includes(q);
      })
    : allCreators;

  // Batched lifetime PnL fetch for the filtered set.
  const pnlMap = await getCodeAndWagerByUser(filtered.map((c) => c.id));

  // Decorate + sort. Creators whose row failed the PnL batch query
  // (or who have a literal 0 lifetime PnL) get null and are pushed
  // to the bottom of either direction so they don't squat the top.
  const enriched: CreatorWithLifetimePnl[] = filtered.map((c) => ({
    ...c,
    lifetimePnl: pnlMap.get(c.id)?.lifetimePnl?.pnl ?? null,
  }));

  enriched.sort((a, b) => {
    const av = a.lifetimePnl;
    const bv = b.lifetimePnl;
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls last
    if (bv == null) return -1;
    return opts.direction === "desc" ? bv - av : av - bv;
  });

  return {
    data: enriched,
    total: enriched.length,
  };
}
