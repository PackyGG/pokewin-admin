import "server-only";

import { unstable_cache } from "next/cache";

import {
  affiliateLeaderboardsApi,
  type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import {
  DEFAULT_LB_HOUSE_SHARE_PCT,
  leaderboardHouseCost,
  normalizeLeaderboardHouseSharePct,
  toFiniteNumber,
} from "@/lib/deal-economics";
import { getApprovalRequestIdsByLeaderboardIds } from "@/lib/creator-leaderboard-approval-links";
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
async function computeAllApprovedLeaderboards(): Promise<LeaderboardAdminRow[]> {
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

/**
 * Cross-request cache (5-min revalidate) for the full APPROVED-leaderboard
 * backend walk shared by both the global cost KPI and the per-creator
 * 2-week cost. Backend-only (affiliateLeaderboardsApi), so it resolves to
 * the prod env inside the cache scope (same convention as the sibling
 * fill-creator-count walk) and needs no env key. The sponsorship overlay
 * + the per-call NOW() date partitioning stay OUTSIDE this cache: the
 * admin-DB sponsorship lookup is cheap and the past/active/window math
 * must run against a live clock, not a frozen one.
 */
const fetchAllApprovedLeaderboards = unstable_cache(
  computeAllApprovedLeaderboards,
  ["creators-approved-leaderboards-v1"],
  { revalidate: 300, tags: ["creators-leaderboard-cost"] },
);

/**
 * Per-board cost row — one APPROVED leaderboard's contribution to the
 * totals, exposed so the /creators Leaderboard Spend panel can render a
 * mini-breakdown WITHOUT a second fetch. Derived from the SAME
 * `fetchAllApprovedLeaderboards()` walk + the SAME sponsorship map the
 * totals use, so the rows reconcile to the headline by construction.
 */
export type LeaderboardCostBoard = {
  /** Backend leaderboard id. */
  id: string;
  /** Board title (its display name on /creators/leaderboards). */
  name: string;
  /** Primary owner's user id — the creator who funds the board. */
  creatorUserId: string;
  /** Full prize pool, net of refunds (100%, no weighting). */
  prizeUsd: number;
  /** Refund already netted out of `prizeUsd` (cancelled boards). */
  refundUsd: number;
  /** Stored admin-side house share of this board. */
  sponsoredPct: number;
  /** House's share of this board: net prize × stored share (rose). */
  houseCostUsd: number;
};

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
  /**
   * Count of APPROVED creator leaderboards folded into the totals — the
   * number of boards the headline figures sum across.
   */
  boardCount: number;
  /**
   * Per-board contributions to the totals, sorted by `houseCostUsd`
   * DESCENDING (priciest house cost first) so callers can slice the top
   * N for a mini-breakdown. Same walk + same sponsorship map as the
   * totals above — no extra round-trip.
   */
  boards: LeaderboardCostBoard[];

  // ─── Time-split house cost (PAST vs ACTIVE vs UPCOMING) ──────────────
  // Derived from the SAME approved-board walk above, partitioned by each
  // board's run window relative to NOW — no extra query. Lets the
  // /creators Leaderboard Spend box separate what we've ALREADY committed
  // on finished boards from what we're committed to RIGHT NOW.

  /**
   * House-covered cost of boards whose run has finished (`end_date < now`):
   *
   *   pastHouseCostUsd = Σ (net prize × sponsored% / 100) over ended boards
   *
   * What we already spent on old/finished leaderboards (rose house cost).
   */
  pastHouseCostUsd: number;
  /**
   * House-covered cost of boards running RIGHT NOW (`now` ∈
   * [start_date, end_date]) — what we're committed to at this moment
   * (rose house cost). Same sponsored-% weighting as above.
   */
  activeHouseCostUsd: number;
  /**
   * Gross (100%, un-weighted) net prize pool of the ACTIVE boards — the
   * denominator for the active coverage %. The creator funds the rest
   * off-site; only `activeHouseCostUsd` of this is our cost.
   */
  activeGrossUsd: number;
  /**
   * Blended house share across the ACTIVE boards:
   *
   *   activeCoveragePct = activeHouseCostUsd / activeGrossUsd × 100
   *
   * The "% of the active boards we have to pay". 0 when there's no active
   * gross prize (no boards running, or active pool fully refunded).
   */
  activeCoveragePct: number;
  /** Count of boards running right now (folded into the ACTIVE figures). */
  activeCount: number;
  /** Count of finished boards (folded into the PAST figure). */
  pastCount: number;
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
 *
 * The same approved-board walk is ALSO partitioned by each board's run
 * window relative to NOW — `pastHouseCostUsd` (finished boards),
 * `activeHouseCostUsd` / `activeGrossUsd` / `activeCoveragePct` (running
 * right now) — so the /creators box can split "already spent on old
 * boards" from "committed right now + the % of it we pay". No extra query.
 */
export async function getLeaderboardCostTotal(): Promise<LeaderboardCostTotals> {
  const all = await fetchAllApprovedLeaderboards();
  const sponsorship = await getLeaderboardSponsorshipMap(all.map((lb) => lb.id));

  // NOW once, reused for the past/active partition below so every board
  // is bucketed against a single consistent clock.
  const now = Date.now();

  let totalPrizeUsd = 0;
  let houseCoveredUsd = 0;
  // Time-split house cost accumulators (stored per-board house share).
  let pastHouseCostUsd = 0;
  let activeHouseCostUsd = 0;
  let activeGrossUsd = 0;
  let activeCount = 0;
  let pastCount = 0;
  const boards: LeaderboardCostBoard[] = [];
  for (const lb of all) {
    const prize = toFiniteNumber(lb.total_prize_usd);
    const refund = toFiniteNumber(lb.refund_amount_usd);
    const net = Math.max(0, prize - refund);
    const sponsoredPct = normalizeLeaderboardHouseSharePct(
      sponsorship.get(lb.id),
      DEFAULT_LB_HOUSE_SHARE_PCT,
    );
    const houseCost = leaderboardHouseCost(prize, refund, sponsoredPct);
    totalPrizeUsd += net;
    houseCoveredUsd += houseCost;

    // Bucket by run window relative to NOW (same date math as the
    // per-creator 2-week projection below). ENDED = end_date strictly in
    // the past; ACTIVE = now within [start, end]; everything else is
    // UPCOMING (start in the future) and folds into neither past nor
    // active. Unparseable dates (NaN) fall through to neither bucket
    // rather than poison a total.
    const start = new Date(lb.start_date).getTime();
    const end = new Date(lb.end_date).getTime();
    if (Number.isFinite(end) && end < now) {
      pastHouseCostUsd += houseCost;
      pastCount += 1;
    } else if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start <= now &&
      end >= now
    ) {
      activeHouseCostUsd += houseCost;
      activeGrossUsd += net;
      activeCount += 1;
    }

    boards.push({
      id: lb.id,
      name: lb.title,
      creatorUserId: lb.creator_user_id,
      prizeUsd: net,
      refundUsd: refund,
      sponsoredPct,
      houseCostUsd: houseCost,
    });
  }
  // Priciest house cost first so the panel's mini-breakdown surfaces the
  // boards that move the headline most.
  boards.sort((a, b) => b.houseCostUsd - a.houseCostUsd);
  const activeCoveragePct = activeGrossUsd > 0
    ? (activeHouseCostUsd / activeGrossUsd) * 100
    : 0;
  return {
    totalPrizeUsd,
    houseCoveredUsd,
    boardCount: boards.length,
    boards,
    pastHouseCostUsd,
    activeHouseCostUsd,
    activeGrossUsd,
    activeCoveragePct,
    activeCount,
    pastCount,
  };
}

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type Lb2wkInfo = {
  /** Leaderboard house cost (net prize × stored share) over the next 14 days. */
  costUsd: number;
  /**
   * Blended stored house share across the creator's in-window leaderboards.
   * 0 when there's no in-window prize.
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
  const sponsorship = await getLeaderboardSponsorshipMap(all.map((lb) => lb.id));

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

  const costByCreator = new Map<string, number>();
  const grossByCreator = new Map<string, number>();
  for (const lb of inWindow) {
    const cid = lb.creator_user_id;
    const gross = Math.max(
      0,
      toFiniteNumber(lb.total_prize_usd) - toFiniteNumber(lb.refund_amount_usd),
    );
    const pct = normalizeLeaderboardHouseSharePct(
      sponsorship.get(lb.id),
      DEFAULT_LB_HOUSE_SHARE_PCT,
    );
    costByCreator.set(
      cid,
      (costByCreator.get(cid) ?? 0) +
        leaderboardHouseCost(lb.total_prize_usd, lb.refund_amount_usd, pct),
    );
    grossByCreator.set(cid, (grossByCreator.get(cid) ?? 0) + gross);
  }

  const out = new Map<string, Lb2wkInfo>();
  for (const [cid, costUsd] of costByCreator) {
    const grossUsd = grossByCreator.get(cid) ?? 0;
    out.set(cid, {
      costUsd,
      effectivePct: grossUsd > 0 ? (costUsd / grossUsd) * 100 : 0,
    });
  }
  return out;
}

export type CreatorLbFrame = {
  /** Backend leaderboard id of the current-frame board. */
  boardId: string;
  /** Board title (its display name on /creators/leaderboards). */
  title: string;
  /** Run-window start (epoch ms). */
  startMs: number;
  /** Run-window end (epoch ms). */
  endMs: number;
  /** Net prize pool of this board (`max(0, total_prize − refund)`), pre-house-share. */
  prizeUsd: number;
  /** Refund already netted out of `prizeUsd` (cancelled boards). */
  refundUsd: number;
  /** Stored admin-side percentage of the prize pool funded by the house. */
  sponsoredPct: number;
  /** House cost of this board — net prize × stored share (rose). */
  houseCostUsd: number;
  /** True when now ∈ [start, end] (the frame is running right now). */
  isLive: boolean;
  /** Approval that provisioned both this board and its exact deal periods. */
  approvalRequestId: string | null;
};

/**
 * The CURRENT deal frame per creator, defined by their approved
 * leaderboard's run window (the owner's model: "the leaderboard frame IS
 * the current deal"). Past boards (`end_date < now`) are dropped — those
 * are past deals. For each creator we keep one board:
 *   • a LIVE board (now ∈ [start,end]) wins over an upcoming one, and
 *     among live boards the one starting latest (most current) wins;
 *   • otherwise the soonest UPCOMING board.
 *
 * Reuses the SAME cached approved-board walk + sponsorship map as the cost
 * totals — no extra backend round-trip.
 */
export async function getActiveLeaderboardFrameByUser(): Promise<
  Map<string, CreatorLbFrame>
> {
  const all = await fetchAllApprovedLeaderboards();
  const [sponsorship, approvals] = await Promise.all([
    getLeaderboardSponsorshipMap(all.map((lb) => lb.id)),
    getApprovalRequestIdsByLeaderboardIds(all.map((lb) => lb.id)),
  ]);
  const now = Date.now();

  const byCreator = new Map<string, CreatorLbFrame>();
  for (const lb of all) {
    const startMs = new Date(lb.start_date).getTime();
    const endMs = new Date(lb.end_date).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    // Past boards are past deals — skip; keep live + upcoming only.
    if (endMs < now) continue;

    const refund = toFiniteNumber(lb.refund_amount_usd);
    const net = Math.max(0, toFiniteNumber(lb.total_prize_usd) - refund);
    const sponsoredPct = normalizeLeaderboardHouseSharePct(
      sponsorship.get(lb.id),
      DEFAULT_LB_HOUSE_SHARE_PCT,
    );
    const houseCostUsd = leaderboardHouseCost(
      lb.total_prize_usd,
      refund,
      sponsoredPct,
    );
    const isLive = startMs <= now && endMs >= now;

    const cand: CreatorLbFrame = {
      boardId: lb.id,
      title: lb.title,
      startMs,
      endMs,
      prizeUsd: net,
      refundUsd: refund,
      sponsoredPct,
      houseCostUsd,
      isLive,
      approvalRequestId: approvals.get(lb.id) ?? null,
    };

    const existing = byCreator.get(lb.creator_user_id);
    if (!existing) {
      byCreator.set(lb.creator_user_id, cand);
      continue;
    }
    // Live beats upcoming; tie-break by start date (latest live = most
    // current; soonest upcoming = next to begin).
    let better: CreatorLbFrame;
    if (existing.isLive !== cand.isLive) {
      better = existing.isLive ? existing : cand;
    } else if (existing.isLive) {
      better = cand.startMs > existing.startMs ? cand : existing;
    } else {
      better = cand.startMs < existing.startMs ? cand : existing;
    }
    byCreator.set(lb.creator_user_id, better);
  }

  return byCreator;
}
