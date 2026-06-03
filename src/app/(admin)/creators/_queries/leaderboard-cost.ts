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
 * Fetch every APPROVED affiliate leaderboard, first-page-then-parallel.
 * Shared by getLeaderboardCostTotal (global KPI) and
 * getLeaderboard2wkCostByUser (per-creator 14-day cost).
 */
async function fetchAllApprovedLeaderboards(): Promise<LeaderboardAdminRow[]> {
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
  return all;
}

export type LeaderboardCostTotals = {
  /**
   * Full committed prize pool of every APPROVED creator leaderboard,
   * net of refunds, with NO sponsored-% weighting:
   *
   *   totalPrizeUsd = Σ (total_prize_usd − refund_amount_usd)
   *
   * This is the 100% pool — the whole prize that goes out to players.
   * The creator funds the non-sponsored slice off-site; the house only
   * covers `houseCoveredUsd` of it.
   */
  totalPrizeUsd: number;
  /**
   * The house's share of that pool — the same net prize sum, but each
   * board weighted by its admin-set "sponsored %":
   *
   *   houseCoveredUsd = Σ (total_prize_usd − refund) × (sponsored% / 100)
   *
   * This is the actual house cost (rose). With every board at the 100%
   * default, houseCoveredUsd === totalPrizeUsd.
   */
  houseCoveredUsd: number;
};

/**
 * Committed cost of creator (affiliate) leaderboards over APPROVED rows,
 * returned at two scopes from a single fetch walk:
 *
 *   • totalPrizeUsd   — the full 100% prize pool, net of refunds, with
 *                       no sponsored-% weighting (neutral context).
 *   • houseCoveredUsd — that same pool weighted by each board's admin-set
 *                       "sponsored %" — the share the house actually pays
 *                       (a house cost → rose).
 *
 * `total_prize_usd` = creator prize + site bonus — the same figure the
 * /creators/leaderboards table surfaces as the (rose-colored) cost.
 *
 * Approved-only: a rejected leaderboard never runs ($0) and a pending
 * one isn't a committed spend yet. Refunds (cancelled leaderboards)
 * are subtracted so a cancelled-and-refunded board doesn't inflate the
 * figures.
 *
 * The sponsored % is an admin annotation (admin_leaderboard_sponsorship
 * — purely a cost-accounting input, set inline on /creators/leaderboards).
 * Leaderboards with no annotation default to 100% (full cost): when every
 * board is at the default, houseCoveredUsd === totalPrizeUsd.
 */
export async function getLeaderboardCostTotal(): Promise<LeaderboardCostTotals> {
  const all = await fetchAllApprovedLeaderboards();

  // Sponsored % per leaderboard. Resilient: if the admin-DB lookup
  // blips, treat every leaderboard as 100% (house-covered collapses to
  // the un-weighted total) rather than blanking the whole KPI tile.
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

  let totalPrizeUsd = 0;
  let houseCoveredUsd = 0;
  for (const lb of all) {
    const prize = Number(lb.total_prize_usd) || 0;
    const refund = Number(lb.refund_amount_usd) || 0;
    const net = prize - refund;
    // No annotation → 100%. Clamp defensively to the 0–100 range.
    const pct = Math.min(100, Math.max(0, sponsorship.get(lb.id) ?? 100));
    totalPrizeUsd += net;
    houseCoveredUsd += net * (pct / 100);
  }
  return { totalPrizeUsd, houseCoveredUsd };
}

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type Lb2wkInfo = {
  /** Sponsored-weighted leaderboard cost over the next 14 days. */
  costUsd: number;
  /**
   * Blended "% we pay" across the creator's in-window leaderboards:
   * costUsd / (Σ net prize) × 100. For a single leaderboard this is
   * just its sponsored %. 0 when there's no in-window prize.
   */
  effectivePct: number;
};

/**
 * Per-creator leaderboard info over the next 14 days, computed from
 * every APPROVED affiliate leaderboard (owned by the creator as the
 * primary owner) whose run window overlaps [now, now + 14d].
 *
 *   costUsd      = Σ (total_prize_usd − refund) × (sponsored% / 100)
 *   effectivePct = costUsd / Σ (total_prize_usd − refund) × 100
 *
 * Keyed by `creator_user_id` (the primary owner — co-creators don't
 * fund the board). Creators with no leaderboard in the window are
 * absent from the map; callers render "—".
 */
export async function getLeaderboard2wkCostByUser(): Promise<
  Map<string, Lb2wkInfo>
> {
  const all = await fetchAllApprovedLeaderboards();

  const now = Date.now();
  const windowEnd = now + WINDOW_MS;
  // A leaderboard is "in the next 2 weeks" if its run window overlaps
  // [now, now+14d]: it starts on/before the window end AND ends
  // on/after now.
  const inWindow = all.filter((lb) => {
    const start = new Date(lb.start_date).getTime();
    const end = new Date(lb.end_date).getTime();
    return start <= windowEnd && end >= now;
  });

  let sponsorship: Map<string, number>;
  try {
    sponsorship = await getLeaderboardSponsorshipMap(
      inWindow.map((lb) => lb.id),
    );
  } catch (e) {
    console.error(
      "[leaderboard-2wk] sponsorship lookup failed (treating all as 100%):",
      e,
    );
    sponsorship = new Map();
  }

  // Track sponsored-weighted cost AND raw net prize per creator so the
  // blended "% we pay" can be derived (cost / raw prize).
  const costByCreator = new Map<string, number>();
  const rawByCreator = new Map<string, number>();
  for (const lb of inWindow) {
    const prize = Number(lb.total_prize_usd) || 0;
    const refund = Number(lb.refund_amount_usd) || 0;
    const net = prize - refund;
    const pct = Math.min(100, Math.max(0, sponsorship.get(lb.id) ?? 100));
    const cid = lb.creator_user_id;
    costByCreator.set(cid, (costByCreator.get(cid) ?? 0) + net * (pct / 100));
    rawByCreator.set(cid, (rawByCreator.get(cid) ?? 0) + net);
  }

  const out = new Map<string, Lb2wkInfo>();
  for (const [cid, costUsd] of costByCreator) {
    const raw = rawByCreator.get(cid) ?? 0;
    const effectivePct = raw > 0 ? (costUsd / raw) * 100 : 0;
    out.set(cid, { costUsd, effectivePct });
  }
  return out;
}
