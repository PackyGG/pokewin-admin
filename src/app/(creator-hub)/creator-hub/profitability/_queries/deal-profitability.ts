import "server-only";

import { unstable_cache } from "next/cache";

import {
  creatorsApi,
  type CreatorListItem,
  type CreatorDealResponse,
} from "@/lib/backend-api";
import {
  HOUSE_EDGE,
  computeDealCost,
  weeklyDealsInFrame,
} from "@/lib/deal-economics";

import { getCodeAndWagerByUser } from "../../../../(admin)/creators/_queries/code-and-wager-by-user";
import {
  getActiveLeaderboardFrameByUser,
  type CreatorLbFrame,
} from "../../../../(admin)/creators/_queries/leaderboard-cost";
import { getFrameWagerByUser, type FrameWindow } from "./frame-wager-by-user";
import { getFrameAffiliatePnlByUser } from "./frame-affiliate-pnl-by-user";

/**
 * Creator Hub — Profitability data.
 *
 * Each creator with a current (active/scheduled) deal is costed over the
 * frame of their CURRENT leaderboard cycle (the owner's model: the active
 * leaderboard window IS the current deal; past boards are past deals). The
 * actual wager is measured strictly INSIDE that frame, so a fixed deal cost
 * is always compared against the wager driven in the same window.
 *
 *   dealCost      = the canonical `@/lib/deal-economics` `computeDealCost`
 *                   over the weekly fill-deals overlapping the current frame:
 *                   Σ ( FULL withdraw cap + (tip + sponsor) × fills_allowed )
 *                   + leaderboard net prize × 50%. A 2-week (bi-weekly) frame
 *                   spanning two weekly deals sums both weeks' cap + tip/
 *                   sponsor legs (per-stream caps recur for every fill, owner
 *                   directive 2026-06-23); the LB is ALWAYS 50% of the net
 *                   prize (owner rule), never the admin sponsored-%.
 *   expectedWager = dealCost / house edge (7.5%).
 *   actualWager   = code-cohort wager inside [frame start, min(now, end)];
 *                   0 for a not-yet-started (upcoming) frame.
 *   conversion    = actualWager / expectedWager (≥1× = deal pays for itself).
 *   affiliatesMadeUs = coverage-attributed cohort deposits − card
 *                   withdrawals − the creator's own affiliate_claim code
 *                   earnings, over the FULL frame [start, end].
 *   actualPnl     = affiliatesMadeUs − dealCost (house-profit convention:
 *                   + = the cohort earned back more than the deal cost).
 *
 * No timespan toggle: the window is the deal frame itself, per creator.
 */

const PAGE_SIZE = 100;
const FETCH_CAP = 500;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Backend cap per deal-history request. */
const BACKEND_PAGE_SIZE = 100;
/** Per-creator deal-history walk cap (deal histories are a small bounded set). */
const DEAL_FETCH_CAP = 1000;

/**
 * Number of whole weeks in a deal frame — the FRAME-LENGTH label only (the
 * cost no longer scales by it; `computeDealCost` sums the actual weekly deals
 * overlapping the frame). Boards run in weekly multiples (weekly / bi-weekly),
 * so the duration is rounded to the nearest week and floored at 1.
 */
function frameWeeks(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 1;
  }
  return Math.max(1, Math.round((endMs - startMs) / MS_PER_WEEK));
}

/** Fetch one creator's FULL deal history, paging the backend (mirrors past-deals.ts). */
async function fetchAllDealsForCreator(
  userId: string,
): Promise<CreatorDealResponse[]> {
  const firstPage = await creatorsApi.listDeals(userId, {
    offset: 0,
    limit: BACKEND_PAGE_SIZE,
  });
  const all: CreatorDealResponse[] = [...firstPage.data];
  const pagesNeeded = Math.min(
    Math.ceil(DEAL_FETCH_CAP / BACKEND_PAGE_SIZE),
    Math.ceil(firstPage.total / BACKEND_PAGE_SIZE),
  );
  const rest: Promise<typeof firstPage>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    rest.push(
      creatorsApi.listDeals(userId, {
        offset: p * BACKEND_PAGE_SIZE,
        limit: BACKEND_PAGE_SIZE,
      }),
    );
  }
  for (const page of await Promise.all(rest)) all.push(...page.data);
  return all;
}

export type CreatorProfitabilityRow = {
  userId: string;
  username: string | null;
  image: string | null;
  code: string | null;
  /** Current-frame leaderboard id, when the frame is a board (row link). */
  boardId: string | null;
  /** Current-frame leaderboard title, when the frame is a board. */
  boardTitle: string | null;
  frameStartMs: number | null;
  frameEndMs: number | null;
  /** True when the frame is running right now. */
  isLive: boolean;
  /** Per-week withdraw cap from the deal (`total_withdraw_cap_usd`). */
  weeklyCapUsd: number;
  /** Whole weeks in the deal frame (= leaderboard length). */
  dealWeeks: number;
  /** Total withdraw cap over the deal length (`weeklyCapUsd × dealWeeks`). */
  capUsd: number;
  leaderboardUsd: number;
  /**
   * Per-week tip + sponsor allowance from the deal
   * (`(perStreamTip + perStreamSponsor) × fills_allowed`). The per-fill
   * caps recur for every fill the deal grants in the weekly window — this
   * is the weekly ceiling before frame-scaling.
   */
  weeklyTipSponsorUsd: number;
  /**
   * Total tip + sponsor allowance over the deal length
   * (`weeklyTipSponsorUsd × dealWeeks`). Scales by frame weeks the same
   * way `capUsd` does: a 2-week (bi-weekly) board counts the weekly
   * allowance twice (owner directive 2026-06-23).
   */
  tipSponsorUsd: number;
  dealCost: number;
  expectedWager: number;
  actualWager: number;
  /**
   * What this creator's affiliate cohort actually earned the house INSIDE
   * the deal frame — coverage-attributed cohort deposits − card withdrawals
   * − the creator's own affiliate_claim code earnings (windowed to the deal
   * frame). House POV: positive = we kept value.
   */
  affiliatesMadeUs: number;
  /**
   * Actual deal PnL = `affiliatesMadeUs − dealCost`, over the full deal
   * frame `[start, end]`. House-profit convention: positive = the cohort
   * earned back more than the deal cost (house gain, emerald); negative =
   * the deal cost more than the cohort earned us (house loss, rose).
   */
  actualPnl: number;
  /** `expectedWager > 0 ? actualWager / expectedWager : 0`. */
  conversionRate: number;
};

export type ProfitabilityTotals = {
  /** Creators whose current deal status is "active" (excludes scheduled). */
  totalActiveDeals: number;
  totalCost: number;
  /** Σ affiliatesMadeUs across the roster (house POV: + = we kept value). */
  totalAffiliatesMadeUs: number;
  totalActualPnl: number;
  totalExpectedWager: number;
  totalCreatorWager: number;
  avgConversionRate: number;
};

export type ProfitabilityData = {
  rows: CreatorProfitabilityRow[];
  totals: ProfitabilityTotals;
  /** True when the backend creator walk failed (page shows the error state). */
  rosterUnavailable: boolean;
};

const EMPTY_TOTALS: ProfitabilityTotals = {
  totalActiveDeals: 0,
  totalCost: 0,
  totalAffiliatesMadeUs: 0,
  totalActualPnl: 0,
  totalExpectedWager: 0,
  totalCreatorWager: 0,
  avgConversionRate: 0,
};

async function computeWalk(): Promise<CreatorListItem[]> {
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

// Shares the roster walk's revalidation tag so it stays in lockstep, but is
// its own cache slot (this page only needs identity + current deal id +
// deal window — not the roster's heavy enrichment passes).
const walkCreators = unstable_cache(computeWalk, ["profitability-creator-walk-v1"], {
  revalidate: 180,
  tags: ["creator-hub-roster-walk"],
});

export async function getCreatorProfitability(): Promise<ProfitabilityData> {
  let roster: CreatorListItem[];
  try {
    roster = await walkCreators();
  } catch (err) {
    console.error("[profitability] backend creator walk failed:", err);
    return { rows: [], totals: EMPTY_TOTALS, rosterUnavailable: true };
  }

  // Defensive: a deal whose backend `current_deal.status` still reads
  // "active"/"scheduled" but whose fills are already exhausted
  // (fills_used >= fills_allowed) is functionally ended — exclude it too.
  // Owner report 2026-07-05: right after terminating a creator's deal, the
  // roster endpoint's `current_deal` summary lagged behind the deals-history
  // endpoint (which already showed `status: terminated`), so the exhausted
  // deal kept surfacing on the Active tab with a fallback (non-board) frame.
  // This is a belt-and-suspenders guard on data already fetched — it changes
  // only ROSTER INCLUSION, never a cost figure.
  const fill = roster.filter((c) => {
    if (c.current_deal == null) return false;
    if (
      c.current_deal.status !== "active" &&
      c.current_deal.status !== "scheduled"
    ) {
      return false;
    }
    const { fills_allowed, fills_used } = c.current_deal;
    if (fills_allowed > 0 && fills_used >= fills_allowed) return false;
    return true;
  });

  if (fill.length === 0) {
    return { rows: [], totals: EMPTY_TOTALS, rosterUnavailable: false };
  }

  const ids = fill.map((c) => c.id);

  const [frames, dealsByOwner, codeWager] = await Promise.all([
    getActiveLeaderboardFrameByUser().catch((err) => {
      console.error("[profitability] leaderboard frame fetch failed:", err);
      return new Map<string, CreatorLbFrame>();
    }),
    // Each fill creator's FULL deal history — the canonical cost sums the
    // weekly fill-deals overlapping the current frame (not a single deal).
    // allSettled so one creator's failed lookup can't sink the roster.
    (async () => {
      const settled = await Promise.allSettled(
        ids.map((id) => fetchAllDealsForCreator(id)),
      );
      const map = new Map<string, CreatorDealResponse[]>();
      settled.forEach((outcome, i) => {
        if (outcome.status === "fulfilled") {
          map.set(ids[i], outcome.value);
        } else {
          console.error(
            `[profitability] listDeals failed for creator ${ids[i]} (frame costs only the LB leg):`,
            outcome.reason,
          );
          map.set(ids[i], []);
        }
      });
      return map;
    })(),
    getCodeAndWagerByUser(ids).catch((err) => {
      console.error("[profitability] code fetch failed:", err);
      return new Map<string, { code: string | null }>();
    }),
  ]);

  const now = Date.now();

  // Resolve each creator's frame (leaderboard window preferred, deal week
  // as fallback) and collect the started-frame windows for the wager query.
  const resolved = new Map<
    string,
    { board: CreatorLbFrame | null; startMs: number; endMs: number; isLive: boolean }
  >();
  const frameWindows: FrameWindow[] = [];
  // Affiliate-PnL windows use the FULL deal frame [start, end] (true end,
  // even when it is in the future) — the owner's spec for "how much the
  // affiliates made us from that deal timeframe". Deposits/withdrawals can
  // only land up to now, so a future end never over-counts.
  const pnlFrameWindows: FrameWindow[] = [];
  for (const c of fill) {
    const board = frames.get(c.id) ?? null;
    const startMs = board
      ? board.startMs
      : Date.parse(c.current_deal!.week_start_utc);
    const endMs = board
      ? board.endMs
      : Date.parse(c.current_deal!.week_end_utc);
    const isLive =
      Number.isFinite(startMs) &&
      Number.isFinite(endMs) &&
      startMs <= now &&
      endMs >= now;
    resolved.set(c.id, { board, startMs, endMs, isLive });

    if (Number.isFinite(startMs) && startMs <= now) {
      const endForQuery = Number.isFinite(endMs) ? Math.min(endMs, now) : now;
      frameWindows.push({
        userId: c.id,
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(endForQuery).toISOString(),
      });
    }

    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      pnlFrameWindows.push({
        userId: c.id,
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(endMs).toISOString(),
      });
    }
  }

  const [wagerByUser, affiliatePnlByUser] = await Promise.all([
    getFrameWagerByUser(frameWindows).catch((err) => {
      console.error("[profitability] frame wager fetch failed:", err);
      return new Map<string, number>();
    }),
    getFrameAffiliatePnlByUser(pnlFrameWindows).catch((err) => {
      console.error("[profitability] frame affiliate-pnl fetch failed:", err);
      return new Map<
        string,
        { affiliatesMadeUs: number; deposits: number; cardWithdrawals: number }
      >();
    }),
  ]);

  const rows: CreatorProfitabilityRow[] = fill.map((c) => {
    const fr = resolved.get(c.id)!;
    const dealWeeks = frameWeeks(fr.startMs, fr.endMs);

    // Canonical deal cost — the weekly fill-deals overlapping THIS creator's
    // current frame, each at FULL cap + (tip + sponsor) × fills, plus the
    // frame board's leaderboard net prize × 50% (owner rule). One source of
    // truth via `computeDealCost`.
    const deals = dealsByOwner.get(c.id) ?? [];
    const wds = weeklyDealsInFrame(fr.startMs, fr.endMs, deals);
    const { capUsd, tipSponsorUsd, leaderboardUsd, dealCost } = computeDealCost({
      weeklyDeals: wds,
      // `CreatorLbFrame.prizeUsd` is ALREADY net of refund, so pass refund 0
      // here to avoid double-subtracting it (the raw-board call sites in
      // past-deals / four-week pass gross prize + refund instead).
      lbPrizeUsd: fr.board?.prizeUsd ?? 0,
      lbRefundUsd: 0,
    });

    // DISPLAY-only per-week fields for the "$Y/wk × N" sub-text. `dealWeeks`
    // stays the frame-length label; the "/wk" figures are the average per
    // weekly deal in the frame (coherent for uniform weeks).
    const weeklyDealsCount = wds.length;
    const weeklyCapUsd = weeklyDealsCount ? capUsd / weeklyDealsCount : 0;
    const weeklyTipSponsorUsd = weeklyDealsCount
      ? tipSponsorUsd / weeklyDealsCount
      : 0;

    const expectedWager = dealCost / HOUSE_EDGE;
    const actualWager = wagerByUser.get(c.id) ?? 0;
    const affiliatesMadeUs = affiliatePnlByUser.get(c.id)?.affiliatesMadeUs ?? 0;
    const actualPnl = affiliatesMadeUs - dealCost;
    const conversionRate = expectedWager > 0 ? actualWager / expectedWager : 0;

    return {
      userId: c.id,
      username: c.username,
      image: c.image,
      code: codeWager.get(c.id)?.code ?? null,
      boardId: fr.board?.boardId ?? null,
      boardTitle: fr.board?.title ?? null,
      frameStartMs: Number.isFinite(fr.startMs) ? fr.startMs : null,
      frameEndMs: Number.isFinite(fr.endMs) ? fr.endMs : null,
      isLive: fr.isLive,
      weeklyCapUsd,
      dealWeeks,
      capUsd,
      leaderboardUsd,
      weeklyTipSponsorUsd,
      tipSponsorUsd,
      dealCost,
      expectedWager,
      actualWager,
      affiliatesMadeUs,
      actualPnl,
      conversionRate,
    };
  });

  rows.sort((a, b) => b.dealCost - a.dealCost);

  const totalActiveDeals = fill.filter(
    (c) => c.current_deal!.status === "active",
  ).length;
  const totalCost = rows.reduce((acc, r) => acc + r.dealCost, 0);
  const totalExpectedWager = rows.reduce((acc, r) => acc + r.expectedWager, 0);
  const totalCreatorWager = rows.reduce((acc, r) => acc + r.actualWager, 0);
  // Σ affiliatesMadeUs: positive = the roster's affiliate cohorts net-earned
  // the house value over their deal frames (house gain), negative = net loss.
  const totalAffiliatesMadeUs = rows.reduce(
    (acc, r) => acc + r.affiliatesMadeUs,
    0,
  );
  // Σ(affiliatesMadeUs − dealCost): positive = the roster's affiliates
  // earned back more than the deals cost (house gain), negative = net loss.
  const totalActualPnl = rows.reduce((acc, r) => acc + r.actualPnl, 0);

  const converting = rows.filter((r) => r.expectedWager > 0);
  const avgConversionRate =
    converting.length > 0
      ? converting.reduce((acc, r) => acc + r.conversionRate, 0) /
        converting.length
      : 0;

  return {
    rows,
    totals: {
      totalActiveDeals,
      totalCost,
      totalAffiliatesMadeUs,
      totalActualPnl,
      totalExpectedWager,
      totalCreatorWager,
      avgConversionRate,
    },
    rosterUnavailable: false,
  };
}
