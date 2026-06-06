import "server-only";

// Reuse the EXISTING, verified creator query layer from the (admin) route
// group. The (creator-hub) group is a sibling of (admin) on disk, so these
// relative paths cross the route-group boundary to the canonical query
// modules — the same reuse pattern the Hub dashboard's `dashboard-overview.ts`
// already uses. We add NO new MAIN scans: every read below is an existing,
// cached, timeout-guarded query. MAIN/prod game DB is READ-ONLY.
import { getCreatorDetailCached } from "@/lib/queries/creators";
import { getCreatorPnlCached } from "../../../../../(admin)/creators/[userId]/_queries/_pnl-cache";
import { getCreatorLeaderboardCost } from "../../../../../(admin)/creators/[userId]/_queries/leaderboard-cost-by-creator";
import { getCreatorMultiplierCost } from "../../../../../(admin)/creators/[userId]/_queries/multiplier-cost-by-creator";
import { getCreatorFillConversionCost } from "../../../../../(admin)/creators/[userId]/_queries/fill-conversion-cost-by-creator";
import { getCreatorTipsSponsorCost } from "../../../../../(admin)/creators/[userId]/_queries/tips-sponsor-cost-by-creator";
import { safeQuery } from "@/lib/errors/safe-query";

/**
 * Creator Hub — `creators/[id]` Overview tab data.
 *
 * Two independent shapes, each fetched lazily inside its own Suspense
 * boundary on the Overview tab so the banner + tab bar paint immediately
 * (active-timeframe-only / never-preload rule):
 *
 *   1. KPI strip      → `getCreatorDetailCached(id)` (the existing 12-round-
 *                       trip aggregate, cached). Clicks / signups / FTDs /
 *                       wager volume / earned / active referrals.
 *   2. Windowed P&L   → `getCreatorPnlCached(id)` (the existing per-window
 *                       ledger scan). Lifetime + 1d/3d/7d/2w/1m boxes.
 *   3. Creator Net    → the existing creator-net-P&L cost queries
 *                       (leaderboard + multiplier + fill + tips/sponsor)
 *                       netted against the affiliate-cohort P&L.
 *
 * Every figure here maps to a REAL existing query — nothing is fabricated.
 */

/** Resolved Creator-Net P&L numbers (house-POV) for the (i)-hover box. */
export type CreatorNetData = {
  /**
   * What this creator's affiliates earned the house — cohort deposits −
   * card withdrawals (capped 365d). The SAME figure the windowed P&L
   * lifetime box renders, so the two reconcile. null when the cohort scan
   * failed/timed out.
   */
  affiliatesMadeUsUsd: number | null;
  /** Σ of every house-funded cost tied to this creator (rose). */
  houseCostUsd: number;
  /** Leaderboard prize cost (sponsored-% weighted, net of refunds). */
  leaderboardCostUsd: number;
  /** Fill-deal payout vouchers the creator cashed out. */
  fillPayoutUsd: number;
  /** House-funded tips + battle sponsors handed out across sessions. */
  tipsSponsorUsd: number;
  /** Multiplier payout vouchers (multiplier deals only). */
  multiplierPayoutUsd: number;
  /** Net multiplier fill the house funded (multiplier deals only). */
  multiplierFillUsd: number;
  /** Count of approved leaderboards contributing to the cost. */
  leaderboardCount: number;
  /** Gross leaderboard prize committed (pre-sponsor-%) — context. */
  leaderboardGrossUsd: number;
  /** Refunds returned from cancelled leaderboards — context. */
  leaderboardRefundedUsd: number;
  /**
   * True when at least one best-effort cost source failed to load, so the
   * house cost is a LOWER bound and the net an UPPER bound.
   */
  partial: boolean;
};

/**
 * Compute the Creator-Net P&L block. Mirrors the existing
 * `CreatorDealCostPanel` math exactly (net = affiliatesMadeUs − houseCost)
 * but returns a serializable shape so the Hub renders it with its own
 * presentation. Every sub-fetch is best-effort: a failure degrades that
 * line to 0 (the cost) or null (the revenue) rather than blanking the box.
 */
export async function getCreatorNetData(
  creatorUserId: string,
): Promise<CreatorNetData> {
  const [leaderboard, multiplier, fillConversion, tipsSponsorResult, pnl] =
    await Promise.all([
      getCreatorLeaderboardCost(creatorUserId).catch((e) => {
        console.error(
          "[creator-hub.creators.net] leaderboard cost failed (line 0):",
          e,
        );
        return null;
      }),
      getCreatorMultiplierCost(creatorUserId).catch((e) => {
        console.error(
          "[creator-hub.creators.net] multiplier cost failed (lines 0):",
          e,
        );
        return null;
      }),
      getCreatorFillConversionCost(creatorUserId).catch((e) => {
        console.error(
          "[creator-hub.creators.net] fill-conversion cost failed (line 0):",
          e,
        );
        return null;
      }),
      safeQuery(
        () => getCreatorTipsSponsorCost(creatorUserId),
        { costUsd: 0, eventCount: 0 },
        "creator-hub.creators.tipsSponsorCost",
      ),
      getCreatorPnlCached(creatorUserId).catch((e) => {
        console.error(
          "[creator-hub.creators.net] affiliate P&L failed (revenue null):",
          e,
        );
        return null;
      }),
    ]);

  const leaderboardCostUsd = leaderboard?.costUsd ?? 0;
  const fillPayoutUsd = fillConversion?.payoutUsd ?? 0;
  const tipsSponsorUsd = tipsSponsorResult.data.costUsd;
  const multiplierPayoutUsd = multiplier?.payoutUsd ?? 0;
  const multiplierFillUsd = multiplier?.netFillUsd ?? 0;

  const houseCostUsd =
    leaderboardCostUsd +
    fillPayoutUsd +
    tipsSponsorUsd +
    multiplierPayoutUsd +
    multiplierFillUsd;

  const partial =
    leaderboard === null ||
    multiplier === null ||
    fillConversion === null ||
    tipsSponsorResult.error !== null;

  return {
    affiliatesMadeUsUsd: pnl ? pnl.lifetime.pnl : null,
    houseCostUsd,
    leaderboardCostUsd,
    fillPayoutUsd,
    tipsSponsorUsd,
    multiplierPayoutUsd,
    multiplierFillUsd,
    leaderboardCount: leaderboard?.leaderboardCount ?? 0,
    leaderboardGrossUsd: leaderboard?.grossPrizeUsd ?? 0,
    leaderboardRefundedUsd: leaderboard?.refundedUsd ?? 0,
    partial,
  };
}

/** Re-export the existing aggregate + P&L reads under Hub-local names so the
 *  tab components import everything creator-detail from one module. */
export { getCreatorDetailCached, getCreatorPnlCached };
