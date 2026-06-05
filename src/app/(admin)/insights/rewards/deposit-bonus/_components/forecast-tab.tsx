import { Coins } from "lucide-react";

import { safeQuery } from "@/lib/errors/safe-query";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getDepositBonusOverview } from "@/lib/queries/insights-rewards/deposit-bonus/overview";
import { getDepositBonusCapHitRate } from "@/lib/queries/insights-rewards/deposit-bonus/cap-analysis";
import { getDepositBonusROI } from "@/lib/queries/insights-rewards/deposit-bonus/roi";

import { type ForecastBaseline } from "../_forecast";
import { ForecastSimulatorIsland } from "./forecast-simulator";

/**
 * Forecast tab (server) on /insights/rewards/deposit-bonus.
 *
 * Fetches the REAL baseline ONCE here (the canonical deposit-bonus queries),
 * then hands serialized primitives into the `"use client"` simulator island.
 * The island runs the pure engine in `useMemo` on every slider change — no
 * server round-trip per keystroke (mirrors the edge-calc page → ScenarioBuilder
 * pattern).
 *
 * Active-timeframe-only: this query trio runs ONLY when Forecast is the active
 * tab — it lives inside the page's `<Suspense key={tab:period}>` boundary, so
 * switching to Forecast does not eagerly fire the other tabs' queries.
 *
 * The data ANCHORS are always REAL: total cost / claimants / avg bonus /
 * empirical cap / claim probability come from `getDepositBonusOverview`,
 * cap-hit rate from `getDepositBonusCapHitRate`, downstream GGR / ROI from
 * `getDepositBonusROI`. There is NO demo fallback — if the period has no
 * deposit-bonus rows (or the baseline fetch fails), we render a clean empty
 * state instead of synthetic numbers. Only the BEHAVIOURAL assumptions (abuse
 * share, retention uplift, breakage, …) remain tunable what-if levers.
 *
 * House-POV: bonuses are house cost → rose; savings against the house →
 * emerald; abuse → amber. (All applied in the island.)
 */
export async function ForecastTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const [ovRes, capRes, roiRes] = await Promise.all([
    safeQuery(
      () => getDepositBonusOverview(period),
      null,
      "insights-rewards-deposit-bonus.forecast.overview",
    ),
    safeQuery(
      () => getDepositBonusCapHitRate(period),
      null,
      "insights-rewards-deposit-bonus.forecast.cap-hit-rate",
    ),
    safeQuery(
      () => getDepositBonusROI(period),
      null,
      "insights-rewards-deposit-bonus.forecast.roi",
    ),
  ]);

  const ov = ovRes.data;
  const cap = capRes.data;
  const roi = roiRes.data;

  // A real baseline is usable only when the overview query succeeded AND there
  // were actual bonus rows in the window (count > 0). Otherwise the cost / avg
  // anchors are zero and the model has nothing real to stand on → empty state.
  const hasReal = ov != null && ov.count > 0;

  // Day-span the baseline was measured over (lifetime is bounded to the standard
  // lookback). Drives the horizon-scaling of the real claimant count in the
  // engine. Always ≥1.
  const periodDays = Math.max(1, daysForInsightsPeriodCapped(period));

  const realBaseline: ForecastBaseline | null = hasReal
    ? {
        totalCost: ov.totalCost,
        uniqueClaimants: ov.uniqueClaimants,
        periodDays,
        claimProbability: ov.claimProbability,
        avgBonusUsd: ov.avg,
        empiricalCapUsd: ov.max,
        capHitRate: cap?.capHitRate ?? null,
        blendedRoi: roi?.blendedRoi ?? null,
        avgGgrPerClaimant: roi?.avgGgrPerClaimant ?? 0,
      }
    : null;

  // No real deposit-bonus data for this period → clean empty state. We do NOT
  // fall back to synthetic numbers (the page is "always real data").
  if (realBaseline == null) {
    return (
      <div className="rounded-2xl border border-dashed bg-muted/20 p-10 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400">
          <Coins className="size-6" />
        </div>
        <p className="mt-4 text-sm font-semibold">No deposit-bonus data for this period</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          The forecast anchors on real deposit-bonus activity ({insightsRewardsPeriodLabel(period)}).
          There were no completed deposit-bonus rows in this window, so there is nothing to model.
          Pick a wider period above.
        </p>
      </div>
    );
  }

  return (
    <ForecastSimulatorIsland
      realBaseline={realBaseline}
      period={insightsRewardsPeriodLabel(period)}
    />
  );
}
