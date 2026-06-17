import "server-only";

import { unstable_cache } from "next/cache";

import { creatorsApi, type CreatorListItem } from "@/lib/backend-api";

import { getDealValueByUser } from "../../creators/_queries/deal-value-by-user";
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
 *   dealCost      = (per-week withdraw cap × deal-length weeks) + this
 *                   board's sponsored-weighted house cost + tip/sponsor
 *                   allowance (house cost, rose POV). The deal length is
 *                   the leaderboard frame length, so a 2-week (bi-weekly)
 *                   board counts the weekly withdraw cap twice. The LB leg
 *                   is the WHOLE board's cost (already spans the frame), so
 *                   it is not re-multiplied.
 *   expectedWager = dealCost / house edge (7.5%).
 *   actualWager   = code-cohort wager inside [frame start, min(now, end)];
 *                   0 for a not-yet-started (upcoming) frame.
 *   conversion    = actualWager / expectedWager (≥1× = deal pays for itself).
 *   affiliatesMadeUs = coverage-attributed cohort deposits − card
 *                   withdrawals over the FULL frame [start, end] (the same
 *                   methodology as the creator-detail "Creator Net" box).
 *   actualPnl     = dealCost − affiliatesMadeUs (house POV: + = the deal
 *                   cost more than the cohort earned us).
 *
 * No timespan toggle: the window is the deal frame itself, per creator.
 */

const HOUSE_EDGE = 0.075;
const PAGE_SIZE = 100;
const FETCH_CAP = 500;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Number of whole weeks in a deal frame, used to scale the per-week
 * withdraw cap over the deal length (= leaderboard length). Boards run in
 * weekly multiples (weekly / bi-weekly), so the duration is rounded to the
 * nearest week and floored at 1 (a missing / degenerate frame costs one
 * week, never zero).
 */
function frameWeeks(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 1;
  }
  return Math.max(1, Math.round((endMs - startMs) / MS_PER_WEEK));
}

export type CreatorProfitabilityRow = {
  userId: string;
  username: string | null;
  image: string | null;
  code: string | null;
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
  tipSponsorUsd: number;
  dealCost: number;
  expectedWager: number;
  actualWager: number;
  /**
   * What this creator's affiliate cohort actually earned the house INSIDE
   * the deal frame — coverage-attributed cohort deposits − card withdrawals
   * (the SAME methodology as the creator-detail "Creator Net (P&L)" box's
   * "Affiliates made us" leg, windowed to the deal frame). House POV:
   * positive = we kept value.
   */
  affiliatesMadeUs: number;
  /**
   * Actual deal PnL = `dealCost − affiliatesMadeUs`, over the full deal
   * frame `[start, end]`. Positive = the deal cost more than the cohort
   * earned us (house loss, rose); negative = the cohort earned back more
   * than the deal cost (house gain, emerald).
   */
  actualPnl: number;
  /** `expectedWager > 0 ? actualWager / expectedWager : 0`. */
  conversionRate: number;
};

export type ProfitabilityTotals = {
  totalCost: number;
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
  totalCost: 0,
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

  const fill = roster.filter(
    (c) =>
      c.current_deal != null &&
      (c.current_deal.status === "active" ||
        c.current_deal.status === "scheduled"),
  );

  if (fill.length === 0) {
    return { rows: [], totals: EMPTY_TOTALS, rosterUnavailable: false };
  }

  const ids = fill.map((c) => c.id);
  const deals = fill.map((c) => ({ userId: c.id, dealId: c.current_deal!.id }));

  const [frames, dealValues, codeWager] = await Promise.all([
    getActiveLeaderboardFrameByUser().catch((err) => {
      console.error("[profitability] leaderboard frame fetch failed:", err);
      return new Map<string, CreatorLbFrame>();
    }),
    getDealValueByUser(deals).catch((err) => {
      console.error("[profitability] deal-value fetch failed:", err);
      return new Map<string, { capUsd: number; tipSponsorUsd: number }>();
    }),
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
    const dv = dealValues.get(c.id);
    const fr = resolved.get(c.id)!;
    const weeklyCapUsd = dv?.capUsd ?? 0;
    const dealWeeks = frameWeeks(fr.startMs, fr.endMs);
    const capUsd = weeklyCapUsd * dealWeeks;
    const tipSponsorUsd = dv?.tipSponsorUsd ?? 0;
    const leaderboardUsd = fr.board?.houseCostUsd ?? 0;
    const dealCost = capUsd + leaderboardUsd + tipSponsorUsd;
    const expectedWager = dealCost / HOUSE_EDGE;
    const actualWager = wagerByUser.get(c.id) ?? 0;
    const affiliatesMadeUs = affiliatePnlByUser.get(c.id)?.affiliatesMadeUs ?? 0;
    const actualPnl = dealCost - affiliatesMadeUs;
    const conversionRate = expectedWager > 0 ? actualWager / expectedWager : 0;

    return {
      userId: c.id,
      username: c.username,
      image: c.image,
      code: codeWager.get(c.id)?.code ?? null,
      boardTitle: fr.board?.title ?? null,
      frameStartMs: Number.isFinite(fr.startMs) ? fr.startMs : null,
      frameEndMs: Number.isFinite(fr.endMs) ? fr.endMs : null,
      isLive: fr.isLive,
      weeklyCapUsd,
      dealWeeks,
      capUsd,
      leaderboardUsd,
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

  const totalCost = rows.reduce((acc, r) => acc + r.dealCost, 0);
  const totalExpectedWager = rows.reduce((acc, r) => acc + r.expectedWager, 0);
  const totalCreatorWager = rows.reduce((acc, r) => acc + r.actualWager, 0);
  // Σ(dealCost − affiliatesMadeUs): positive = the roster's deals cost more
  // than their affiliates earned us (house loss), negative = net house gain.
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
      totalCost,
      totalActualPnl,
      totalExpectedWager,
      totalCreatorWager,
      avgConversionRate,
    },
    rosterUnavailable: false,
  };
}
