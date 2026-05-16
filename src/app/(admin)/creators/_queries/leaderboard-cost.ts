import "server-only";

import {
  affiliateLeaderboardsApi,
  type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { getLeaderboardSponsorshipMap } from "./leaderboard-sponsorship";

// The backend caps `limit` per request; 100 mirrors the page size the
// creators-stats walk uses. MAX_PAGES guards against a runaway loop if
// `total` is ever reported wrong.
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * Total committed cost of creator (affiliate) leaderboards, weighted
 * by each leaderboard's admin-side "sponsored %".
 *
 *   cost = Σ (total_prize_usd − refund_amount_usd) × (sponsored% / 100)
 *          over APPROVED rows
 *
 * `total_prize_usd` = creator prize + site bonus — the same figure the
 * /creators/leaderboards table surfaces as the (rose-colored) cost.
 *
 * Approved-only: a rejected leaderboard never runs ($0) and a pending
 * one isn't a committed spend yet. Refunds (cancelled leaderboards)
 * are subtracted so a cancelled-and-refunded board doesn't inflate the
 * figure.
 *
 * The sponsored % is an admin annotation (admin_leaderboard_sponsorship
 * — purely a cost-accounting input, set inline on /creators/leaderboards).
 * Leaderboards with no annotation default to 100% (full cost).
 */
export async function getLeaderboardCostTotal(): Promise<number> {
  // Collect every approved leaderboard first — we can't weight + sum
  // until we also have the sponsorship map for the full id set.
  const firstPage = await affiliateLeaderboardsApi.list({
    status: "approved",
    offset: 0,
    limit: PAGE_SIZE,
  });
  const all: LeaderboardAdminRow[] = [...firstPage.leaderboards];

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
    all.push(...page.leaderboards);
  }

  // Sponsored % per leaderboard. Resilient: if the admin-DB lookup
  // blips, treat every leaderboard as 100% (un-weighted total) rather
  // than blanking the whole KPI tile.
  let sponsorship: Map<string, number>;
  try {
    sponsorship = await getLeaderboardSponsorshipMap(all.map((lb) => lb.id));
  } catch (e) {
    console.error(
      "[leaderboard-cost] sponsorship lookup failed (treating all as 100%):",
      e,
    );
    sponsorship = new Map();
  }

  let total = 0;
  for (const lb of all) {
    const prize = Number(lb.total_prize_usd) || 0;
    const refund = Number(lb.refund_amount_usd) || 0;
    // No annotation → 100%. Clamp defensively to the 0–100 range.
    const pct = Math.min(100, Math.max(0, sponsorship.get(lb.id) ?? 100));
    total += (prize - refund) * (pct / 100);
  }
  return total;
}
