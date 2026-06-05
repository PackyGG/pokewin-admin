import { Trophy } from "lucide-react";

import { safeQuery } from "@/lib/errors/safe-query";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getRaceInsightsOverview } from "@/lib/queries/insights-rewards/race/overview";
import { getRaceInsightsPerType } from "@/lib/queries/insights-rewards/race/per-type";
import { getRaceInsightsROI } from "@/lib/queries/insights-rewards/race/roi";

import { type ForecastBaseline } from "../_forecast";
import { ForecastSimulatorIsland } from "./forecast-simulator";

/**
 * Forecast tab (server) on /insights/rewards/race.
 *
 * Fetches the REAL baseline ONCE here (the canonical race-insights queries),
 * then hands serialized primitives into the `"use client"` simulator island.
 * The island runs the pure engine in `useMemo` on every slider change — no
 * server round-trip per keystroke (mirrors the deposit-bonus reference).
 *
 * Active-timeframe-only: this query trio runs ONLY when Forecast is the active
 * tab — it lives inside the page's `<Suspense key={tab:period}>` boundary (and
 * the hub mounts only the selected reward), so switching to Forecast does not
 * eagerly fire the other tabs'/rewards' queries.
 *
 * The data ANCHORS are always REAL:
 *   • total prize cost / distinct winners / avg prize per winner / empirical cap
 *     (largest single prize) come from `getRaceInsightsOverview`,
 *   • the win probability (distinct winners ÷ distinct entrants) is derived from
 *     `getRaceInsightsPerType` (entrant cohort sizes per race type),
 *   • downstream GGR / ROI come from `getRaceInsightsROI` (forward window).
 * There is NO demo fallback — if the period has no race-prize rows (or the
 * baseline fetch fails), we render a clean empty state instead of synthetic
 * numbers. Only the STRUCTURAL multipliers + BEHAVIOURAL assumptions remain
 * tunable what-if levers.
 *
 * House-POV: race prizes are a house cost → rose; savings against the house →
 * emerald; dead-weight leakage → amber. (All applied in the island.)
 */
export async function ForecastTab({ period }: { period: InsightsRewardsPeriod }) {
  const [ovRes, perTypeRes, roiRes] = await Promise.all([
    safeQuery(
      () => getRaceInsightsOverview(period),
      null,
      "insights-rewards-race.forecast.overview",
    ),
    safeQuery(
      () => getRaceInsightsPerType(period),
      null,
      "insights-rewards-race.forecast.per-type",
    ),
    safeQuery(() => getRaceInsightsROI(period), null, "insights-rewards-race.forecast.roi"),
  ]);

  const ov = ovRes.data;
  const perType = perTypeRes.data;
  const roi = roiRes.data;

  // A real baseline is usable only when the overview query succeeded AND there
  // were actual prize lines in the window (winnerCount > 0). Otherwise the cost /
  // avg anchors are zero and the model has nothing real to stand on → empty state.
  const hasReal = ov != null && ov.winnerCount > 0;

  // Day-span the baseline was measured over (lifetime is bounded to the standard
  // lookback). Drives the horizon-scaling of the real winner count in the engine.
  const periodDays = Math.max(1, daysForInsightsPeriodCapped(period));

  // Real win probability = distinct winners ÷ distinct entrants, aggregated
  // across race types from the per-type entrant cohorts. Null when no entrants
  // (divide-by-zero guard → the engine falls back to the seeded default).
  let claimProbability: number | null = null;
  if (perType != null) {
    const winners = perType.reduce((a, r) => a + r.distinctWinners, 0);
    // distinctEntrants isn't directly summed on the row, but conversionRate ×
    // distinctWinners recovers entrants per type when conversionRate is present;
    // simpler + robust: re-derive entrants from winners ÷ conversionRate per row.
    let entrants = 0;
    for (const r of perType) {
      if (r.conversionRate != null && r.conversionRate > 0) {
        entrants += r.distinctWinners / r.conversionRate;
      }
    }
    if (entrants > 0) {
      claimProbability = Math.min(1, winners / entrants);
    }
  }

  const realBaseline: ForecastBaseline | null = hasReal
    ? {
        totalCost: ov.totalPrizePaid,
        uniqueClaimants: ov.distinctWinners,
        periodDays,
        claimProbability,
        avgBonusUsd: ov.avgPrizePerWinner,
        // Empirical cap = the largest single prize. The overview rollup does not
        // expose a per-row max, so we use the avg prize per RACE (the per-race
        // pool ceiling a single winner could approach) as the closest real proxy;
        // it is strictly ≥ the avg per winner and reads as a sensible "top prize".
        empiricalCapUsd: Math.max(ov.avgPrizePerRace, ov.avgPrizePerWinner),
        // Races have no per-claim cap-hit concept (prizes are tier-fixed, not
        // user-capped) → no real cap-hit rate to surface.
        capHitRate: null,
        blendedRoi: roi?.roi ?? null,
        avgGgrPerClaimant: roi?.avgGgrPerWinner ?? 0,
      }
    : null;

  // No real race data for this period → clean empty state. We do NOT fall back
  // to synthetic numbers (the page is "always real data").
  if (realBaseline == null) {
    return (
      <div className="rounded-2xl border border-dashed bg-muted/20 p-10 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400">
          <Trophy className="size-6" />
        </div>
        <p className="mt-4 text-sm font-semibold">No race-prize data for this period</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          The forecast anchors on real race-prize activity ({insightsRewardsPeriodLabel(period)}).
          There were no prize payouts in this window, so there is nothing to model. Pick a wider
          period above.
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
