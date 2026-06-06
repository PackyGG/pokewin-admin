import "server-only";

// Reuse the EXISTING, verified creator query layer (same cross-route-group
// reuse pattern as overview-data.ts). EVERY read below is an existing, cached,
// timeout-guarded query — the Forecast adds NO new MAIN scan. MAIN/prod game
// DB is READ-ONLY: nothing here writes, and no schema changed.
import { getCreatorPnlCached } from "./overview-data";
import { getCreatorDealData } from "../../../../../(admin)/creators/[userId]/_queries/get-creator-deal-data";
import { getCreatorLeaderboardCost } from "../../../../../(admin)/creators/[userId]/_queries/leaderboard-cost-by-creator";
import { getCreatorTipsSponsorCost } from "../../../../../(admin)/creators/[userId]/_queries/tips-sponsor-cost-by-creator";
import { safeQuery, safeQueryOrNull } from "@/lib/errors/safe-query";
import type { CreatorDealResponse } from "@/lib/backend-api";

/**
 * Creator Hub — `creators/[id]` Forecast tab data.
 *
 * Projects whether THIS creator's deal stays profitable for the HOUSE over
 * 1 week / 2 weeks / 1 month, driven by:
 *   • his CURRENT realized wager RATE + realized PnL (the MAIN read-only
 *     ledger scan, reused + cached), and
 *   • the deal stats — withdraw cap + leaderboard funding × house% +
 *     tip/sponsor allowance.
 *
 * Uses the owner's "Profitable Algo" deal economics (plan
 * iridescent-mixing-lecun.md, lines 381-408):
 *
 *   Generated Value = WAGER × 0.075          (DEAL_VALUE_RATE — the owner's
 *                                             "value generated per $ wagered",
 *                                             DISTINCT from the Risk tool's
 *                                             10.8%/10% gross edge)
 *   Deal Spend      = withdraw cap + LB contribution + tip/sponsor allowance
 *   Rate of Return  = Generated Value / Deal Spend   → profitable when > 1
 *
 * Everything is grounded in REAL data — nothing is fabricated. Where a basis
 * can't be resolved (no deal, no wager history) the band degrades to a clearly
 * labelled "needs more data" state rather than inventing a number.
 *
 * LAZY: this whole module is only imported by the Forecast tab component, which
 * the page renders only when ?tab=forecast — so the heavy reads here fire ONLY
 * when the Forecast tab is opened (active-tab-only / never-preload rule).
 */

/** Value generated per $ wagered for deal economics (owner-chosen, 7.5%). */
export const DEAL_VALUE_RATE = 0.075;

/** Forecast spans the owner asked for. */
export const FORECAST_SPANS = [
  { key: "1w", label: "1 week", days: 7 },
  { key: "2w", label: "2 weeks", days: 14 },
  { key: "1m", label: "1 month", days: 30 },
] as const;

export type ForecastSpanKey = (typeof FORECAST_SPANS)[number]["key"];

/** One projected span row. */
export type ForecastSpan = {
  key: ForecastSpanKey;
  label: string;
  days: number;
  /** Projected wager over the span = dailyWager × days. */
  projectedWagerUsd: number;
  /** Generated value for the HOUSE = projectedWager × 0.075 (emerald). */
  generatedValueUsd: number;
  /** Deal spend over the span = weeklyDealSpend × (days / 7) (rose). */
  dealSpendUsd: number;
  /** Net to the house = generatedValue − dealSpend. */
  netUsd: number;
  /** Rate of return = generatedValue / dealSpend. null when spend = 0. */
  rateOfReturn: number | null;
  /** True when rateOfReturn > 1 (deal is profitable for the house). */
  profitable: boolean;
  /**
   * Projected REALIZED PnL over the span = dailyRealizedPnl × days. The
   * creator's ACTUAL trajectory (cohort deposits − card withdrawals) extended
   * forward — a reality check next to the model. null when no PnL rate basis.
   */
  projectedRealizedPnlUsd: number | null;
};

/** Which realized window the wager / PnL rate was derived from. */
export type RateBasisWindow = "30d" | "14d" | "7d" | "3d" | "24h" | null;

export type ForecastData = {
  /** Per-span projections (1w / 2w / 1m). */
  spans: ForecastSpan[];

  // ── Realized rate inputs (the "his current PnL + wager rate" half) ──
  /** Daily wager rate ($/day) derived from the chosen realized window. */
  dailyWagerUsd: number;
  /** Daily realized PnL rate ($/day), house-POV. null when no basis. */
  dailyRealizedPnlUsd: number | null;
  /** Which realized window drove the rates (longest with data, for stability). */
  rateWindow: RateBasisWindow;
  /** The window's raw wager total — shown so the rate is auditable. */
  rateWindowWagerUsd: number;
  /** The window's raw realized PnL — shown so the rate is auditable. */
  rateWindowPnlUsd: number | null;

  // ── Deal-stats inputs (the "deal stats" half), all WEEKLY ──
  /** Whether an active/most-recent deal was found to drive the spend side. */
  hasDeal: boolean;
  /** Deal status used (active preferred, else most recent). */
  dealStatus: string | null;
  /** Weekly withdraw cap = deal.total_withdraw_cap_usd (the deal is weekly). */
  weeklyWithdrawCapUsd: number;
  /**
   * Weekly leaderboard funding the HOUSE pays (already × house share %).
   * Derived from the realized lifetime LB cost spread over the creator's
   * active weeks (earliest deal week_start → now), so it reflects this
   * creator's ACTUAL leaderboard cadence rather than a guess. 0 when no LB.
   */
  weeklyLbFundingUsd: number;
  /**
   * Weekly house-funded tip + sponsor allowance. Derived from the realized
   * lifetime tips/sponsor spend spread over the creator's active weeks (real
   * cadence). 0 when none recorded.
   */
  weeklyTipSponsorUsd: number;
  /** Total weekly deal spend = cap + LB + tip/sponsor (rose). */
  weeklyDealSpendUsd: number;
  /** Active weeks used to weekly-ize the lifetime LB + tip/sponsor costs. */
  activeWeeks: number;

  /** Lifetime LB contribution (× house%) — context for the weekly derivation. */
  lifetimeLbFundingUsd: number;
  /** Lifetime tips/sponsor cost — context for the weekly derivation. */
  lifetimeTipSponsorUsd: number;

  /**
   * True when at least one input degraded (a cost source failed, or no wager
   * history / no deal). The projection is then a best-effort estimate, flagged
   * in the UI — never presented as authoritative.
   */
  partial: boolean;
  /** Human notes about which inputs were missing/estimated (UI surfaces them). */
  notes: string[];
};

function num(v: string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Days in a realized window key — matches `creators-pnl.ts` PERIODS. */
const WINDOW_DAYS: Record<Exclude<RateBasisWindow, null>, number> = {
  "24h": 1,
  "3d": 3,
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

/** Longest window first → most stable rate basis (less single-day noise). */
const WINDOW_PREFERENCE: Array<Exclude<RateBasisWindow, null>> = [
  "30d",
  "14d",
  "7d",
  "3d",
  "24h",
];

/**
 * Pick the active deal if one exists, else the most recently created — the
 * SAME selection the Overview Deal card uses, so the two reconcile.
 */
function selectDeal(deals: CreatorDealResponse[]): CreatorDealResponse | null {
  return (
    deals.find((d) => d.status === "active") ??
    [...deals].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ??
    null
  );
}

/**
 * Active weeks = (earliest deal week_start → now), floored at 1 so we never
 * divide by zero and a brand-new creator's lifetime cost isn't blown up into a
 * giant weekly figure. Caps at a sane upper bound is unnecessary (older =
 * smaller weekly figure = safe).
 */
function computeActiveWeeks(deals: CreatorDealResponse[]): number {
  if (deals.length === 0) return 1;
  let earliest = Number.POSITIVE_INFINITY;
  for (const d of deals) {
    const t = Date.parse(d.week_start_utc);
    if (Number.isFinite(t) && t < earliest) earliest = t;
  }
  if (!Number.isFinite(earliest)) return 1;
  const ms = Date.now() - earliest;
  const weeks = ms / (7 * 24 * 60 * 60 * 1000);
  return Math.max(1, weeks);
}

/**
 * Compute the Forecast block. Every sub-fetch is best-effort: a failure
 * degrades that input (and flags `partial`) rather than blanking the tab.
 */
export async function getForecastData(
  creatorUserId: string,
): Promise<ForecastData> {
  const notes: string[] = [];

  const [pnlResult, dealResult, lbResult, tipsResult] = await Promise.all([
    // Realized wager + PnL rates. 60s budget mirrors the Overview windowed
    // tiles so the cold populating scan completes + warms the shared cache.
    safeQueryOrNull(
      () => getCreatorPnlCached(creatorUserId),
      "creator-hub.creators.forecast.pnl",
      60_000,
    ),
    // Deal terms (withdraw cap + tip/sponsor allowance + cadence).
    safeQueryOrNull(
      () =>
        getCreatorDealData(creatorUserId, {
          dealsPage: 1,
          dealsPerPage: 25,
          sessionsPage: 1,
          sessionsPerPage: 1,
          pendingStatus: "pending",
        }),
      "creator-hub.creators.forecast.deal",
      20_000,
    ),
    // Leaderboard funding × house% (lifetime, already sponsored-% weighted).
    safeQuery(
      () => getCreatorLeaderboardCost(creatorUserId),
      { costUsd: 0, grossPrizeUsd: 0, refundedUsd: 0, leaderboardCount: 0 },
      "creator-hub.creators.forecast.lbCost",
      20_000,
    ),
    // House-funded tips + sponsor (lifetime, session-derived).
    safeQuery(
      () => getCreatorTipsSponsorCost(creatorUserId),
      { costUsd: 0, eventCount: 0 },
      "creator-hub.creators.forecast.tipsSponsor",
      20_000,
    ),
  ]);

  // ── Realized wager + PnL rate (longest window with wager activity) ──
  const pnl = pnlResult.data;
  let rateWindow: RateBasisWindow = null;
  let rateWindowWagerUsd = 0;
  let rateWindowPnlUsd: number | null = null;
  let dailyWagerUsd = 0;
  let dailyRealizedPnlUsd: number | null = null;

  if (pnl) {
    const byPeriod = new Map(pnl.byPeriod.map((p) => [p.period, p]));
    for (const w of WINDOW_PREFERENCE) {
      const row = byPeriod.get(w);
      if (row && row.wagered > 0) {
        rateWindow = w;
        rateWindowWagerUsd = row.wagered;
        rateWindowPnlUsd = row.pnl;
        const days = WINDOW_DAYS[w];
        dailyWagerUsd = row.wagered / days;
        dailyRealizedPnlUsd = row.pnl / days;
        break;
      }
    }
    if (rateWindow === null) {
      notes.push(
        "No wager recorded in the last 30 days — the wager-rate projection is 0 until this creator's referrals wager again.",
      );
    }
  } else {
    notes.push(
      "The realized wager / PnL scan timed out — projections can't be driven by a current rate right now. Refresh to retry.",
    );
  }

  // ── Deal stats (weekly spend envelope) ──
  const deals: CreatorDealResponse[] = dealResult.data?.deals.data ?? [];
  const deal = selectDeal(deals);
  const hasDeal = deal !== null;
  const dealStatus = deal?.status ?? null;

  if (dealResult.error) {
    notes.push(
      "The deal terms couldn't be loaded — the spend side is incomplete. Refresh to retry.",
    );
  } else if (!hasDeal) {
    notes.push(
      "This creator has no deal yet — there's no spend envelope to forecast against. Set up a deal first.",
    );
  }

  // The deal is a WEEKLY deal (week_start_utc → week_end_utc), so the withdraw
  // cap is the weekly cap. null cap → 0 (uncapped withdraw isn't a committed
  // spend figure we can project; flagged below).
  const weeklyWithdrawCapUsd = deal ? num(deal.total_withdraw_cap_usd) : 0;
  if (deal && deal.total_withdraw_cap_usd == null) {
    notes.push(
      "This deal has no withdraw cap set — the spend side excludes withdraw exposure (treated as 0).",
    );
  }

  // Active weeks → weekly-ize the lifetime LB + tip/sponsor costs so they
  // reflect THIS creator's real cadence rather than a flat guess.
  const activeWeeks = computeActiveWeeks(deals);

  const lifetimeLbFundingUsd = lbResult.data.costUsd;
  const lifetimeTipSponsorUsd = tipsResult.data.costUsd;
  const weeklyLbFundingUsd = lifetimeLbFundingUsd / activeWeeks;
  const weeklyTipSponsorUsd = lifetimeTipSponsorUsd / activeWeeks;

  if (lbResult.error) {
    notes.push(
      "Leaderboard funding couldn't be loaded — the spend side is a lower bound for it.",
    );
  }
  if (tipsResult.error) {
    notes.push(
      "Tip / sponsor cost couldn't be loaded — the spend side is a lower bound for it.",
    );
  }

  const weeklyDealSpendUsd =
    weeklyWithdrawCapUsd + weeklyLbFundingUsd + weeklyTipSponsorUsd;

  // ── Project each span ──
  const spans: ForecastSpan[] = FORECAST_SPANS.map((span) => {
    const projectedWagerUsd = dailyWagerUsd * span.days;
    const generatedValueUsd = projectedWagerUsd * DEAL_VALUE_RATE;
    const dealSpendUsd = weeklyDealSpendUsd * (span.days / 7);
    const netUsd = generatedValueUsd - dealSpendUsd;
    const rateOfReturn = dealSpendUsd > 0 ? generatedValueUsd / dealSpendUsd : null;
    const profitable = rateOfReturn !== null && rateOfReturn > 1;
    const projectedRealizedPnlUsd =
      dailyRealizedPnlUsd !== null ? dailyRealizedPnlUsd * span.days : null;
    return {
      key: span.key,
      label: span.label,
      days: span.days,
      projectedWagerUsd,
      generatedValueUsd,
      dealSpendUsd,
      netUsd,
      rateOfReturn,
      profitable,
      projectedRealizedPnlUsd,
    };
  });

  const partial =
    pnlResult.error !== null ||
    dealResult.error !== null ||
    lbResult.error !== null ||
    tipsResult.error !== null ||
    rateWindow === null ||
    !hasDeal;

  return {
    spans,
    dailyWagerUsd,
    dailyRealizedPnlUsd,
    rateWindow,
    rateWindowWagerUsd,
    rateWindowPnlUsd,
    hasDeal,
    dealStatus,
    weeklyWithdrawCapUsd,
    weeklyLbFundingUsd,
    weeklyTipSponsorUsd,
    weeklyDealSpendUsd,
    activeWeeks,
    lifetimeLbFundingUsd,
    lifetimeTipSponsorUsd,
    partial,
    notes,
  };
}
