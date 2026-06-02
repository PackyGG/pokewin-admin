import "server-only";

import {
  affiliateLeaderboardsApi,
  type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { getLeaderboardSponsorshipMap } from "../../_queries/leaderboard-sponsorship";

// Backend caps `limit` per request; 100 mirrors the page size the
// global leaderboard-cost walk uses. A single creator owning >100
// approved leaderboards is implausible, but MAX_PAGES guards a runaway
// loop if `total` is ever reported wrong.
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export type CreatorLeaderboardCost = {
  /**
   * Sponsored-weighted net house cost across this creator's APPROVED
   * leaderboards:
   *
   *   costUsd = Σ (total_prize_usd − refund_amount_usd) × (sponsored% / 100)
   *
   * Same formula + scope the global `getLeaderboardCostTotal` KPI tile on
   * /creators uses, filtered to one `creator_user_id`. House cost → the
   * caller renders it rose.
   */
  costUsd: number;
  /** Raw prize pool committed (creator prize + site bonus), pre-sponsor-%. */
  grossPrizeUsd: number;
  /** Refunds returned from cancelled leaderboards (escrow round-trip out). */
  refundedUsd: number;
  /** Count of APPROVED leaderboards that contributed to the cost. */
  leaderboardCount: number;
};

/**
 * Per-creator leaderboard prize cost — the house-funded
 * `affiliate_leaderboard_prize` outflow, netted against the
 * `affiliate_leaderboard_creation` / `affiliate_leaderboard_refund`
 * escrow lifecycle.
 *
 * Methodology (mirrors the global Leaderboard Cost tile exactly, just
 * scoped to one creator):
 *   - Pull every APPROVED leaderboard owned by this creator as the
 *     PRIMARY owner (`creator_user_id`). Co-creators don't fund the
 *     board, so they're not billed for it — same ownership rule the
 *     global per-creator 14-day cost (`getLeaderboard2wkCostByUser`)
 *     keys on.
 *   - `total_prize_usd` is the committed pool (creator prize + site
 *     bonus) funded by the `affiliate_leaderboard_creation` escrow.
 *   - `refund_amount_usd` is what came back via
 *     `affiliate_leaderboard_refund` when a board was cancelled — so
 *     subtracting it nets the escrow round-trip and leaves only the
 *     prize that actually shipped.
 *   - Each net is weighted by the admin-set sponsored % (default 100%,
 *     read from the admin DB) so the figure matches the rose
 *     Leaderboard Cost KPI on the creators list.
 *
 * Approved-only: a rejected board never ran ($0) and a pending one isn't
 * a committed spend yet — same as the global tile.
 *
 * Best-effort by design: the caller (a Suspense'd panel on the creator
 * detail page) catches failures and renders the metric in its empty
 * state rather than crashing the page.
 */
export async function getCreatorLeaderboardCost(
  creatorUserId: string,
): Promise<CreatorLeaderboardCost> {
  // First page, then fan the rest out in parallel — same shape as the
  // global walk. Scoped to this creator via `creator_user_id`.
  const firstPage = await affiliateLeaderboardsApi.list({
    status: "approved",
    creator_user_id: creatorUserId,
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
        creator_user_id: creatorUserId,
        offset: p * PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
    );
  }
  for (const page of await Promise.all(rest)) {
    all.push(...page.leaderboards);
  }

  if (all.length === 0) {
    return { costUsd: 0, grossPrizeUsd: 0, refundedUsd: 0, leaderboardCount: 0 };
  }

  // Sponsored % per leaderboard. Resilient: a blip in the admin-DB
  // lookup treats every board as 100% (un-weighted) rather than
  // blanking the metric — same fallback the global tile uses.
  let sponsorship: Map<string, number>;
  try {
    sponsorship = await getLeaderboardSponsorshipMap(all.map((lb) => lb.id));
  } catch (e) {
    console.error(
      "[leaderboard-cost-by-creator] sponsorship lookup failed (treating all as 100%):",
      e,
    );
    sponsorship = new Map();
  }

  let costUsd = 0;
  let grossPrizeUsd = 0;
  let refundedUsd = 0;
  for (const lb of all) {
    const prize = Number(lb.total_prize_usd) || 0;
    const refund = Number(lb.refund_amount_usd) || 0;
    // No annotation → 100%. Clamp defensively to the 0–100 range.
    const pct = Math.min(100, Math.max(0, sponsorship.get(lb.id) ?? 100));
    costUsd += (prize - refund) * (pct / 100);
    grossPrizeUsd += prize;
    refundedUsd += refund;
  }

  return {
    costUsd,
    grossPrizeUsd,
    refundedUsd,
    leaderboardCount: all.length,
  };
}
