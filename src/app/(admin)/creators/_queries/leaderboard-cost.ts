import "server-only";

import {
  affiliateLeaderboardsApi,
  type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";

// The backend caps `limit` per request; 100 mirrors the page size the
// creators-stats walk uses. MAX_PAGES guards against a runaway loop if
// `total` is ever reported wrong.
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * Total committed cost of creator (affiliate) leaderboards.
 *
 *   cost = Σ (total_prize_usd − refund_amount_usd)   over APPROVED rows
 *
 * `total_prize_usd` = creator prize + site bonus — the same figure the
 * /creators/leaderboards table surfaces as the (rose-colored) cost.
 *
 * Approved-only: a rejected leaderboard never runs ($0) and a pending
 * one isn't a committed spend yet. Refunds (cancelled leaderboards)
 * are subtracted so a cancelled-and-refunded board doesn't inflate the
 * figure.
 *
 * Paginates first-page-then-parallel, the same shape getCreatorsGlobal
 * Stats uses, so the round-trips overlap.
 */
export async function getLeaderboardCostTotal(): Promise<number> {
  const sumPage = (rows: LeaderboardAdminRow[]): number => {
    let s = 0;
    for (const lb of rows) {
      const prize = Number(lb.total_prize_usd) || 0;
      const refund = Number(lb.refund_amount_usd) || 0;
      s += prize - refund;
    }
    return s;
  };

  const firstPage = await affiliateLeaderboardsApi.list({
    status: "approved",
    offset: 0,
    limit: PAGE_SIZE,
  });
  let total = sumPage(firstPage.leaderboards);

  const pagesNeeded = Math.min(
    MAX_PAGES,
    Math.ceil(firstPage.total / PAGE_SIZE),
  );
  const rest: Promise<typeof firstPage>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    rest.push(
      affiliateLeaderboardsApi.list({
        status: "approved",
        offset: p * PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    );
  }
  for (const page of await Promise.all(rest)) {
    total += sumPage(page.leaderboards);
  }
  return total;
}
