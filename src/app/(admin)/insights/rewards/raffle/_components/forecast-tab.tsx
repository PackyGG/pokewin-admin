import { Ticket } from "lucide-react";

import { safeQuery } from "@/lib/errors/safe-query";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getRaffleForecastBaseline } from "@/lib/queries/insights-rewards/raffle/overview";

import { type ForecastBaseline } from "../_forecast";
import { ForecastSimulatorIsland } from "./forecast-simulator";

/**
 * Forecast tab (server) for the RAFFLE reward.
 *
 * Fetches the REAL baseline ONCE here (the raffle baseline query, which
 * RECONSTRUCTS prize cost from each completed raffle's `prizes` JSON valued at
 * pack/card prices — raffles have no ledger cost type), then hands serialized
 * primitives into the `"use client"` simulator island. The island runs the pure
 * engine in `useMemo` on every slider change — no server round-trip per
 * keystroke.
 *
 * Active-timeframe-only: this query runs ONLY when Forecast is the active tab
 * (it lives inside the hub/page's `<Suspense key={tab:period}>` boundary), so
 * switching to Forecast does not eagerly fire other rewards' queries.
 *
 * The data ANCHORS are always REAL: total reconstructed prize cost, winners,
 * avg prize / winner, max single-raffle prize (empirical cap) and the win
 * probability (winners ÷ participants) come from `getRaffleForecastBaseline`.
 * There is NO demo fallback — if the period has no completed raffles (or the
 * baseline fetch fails), we render a clean empty state instead of synthetic
 * numbers. Raffles have no forward-ROI query, so `blendedRoi` / `capHitRate`
 * are surfaced as "—" and only the BEHAVIOURAL assumptions remain tunable.
 *
 * House-POV: raffle prizes are house cost → rose; savings against the house →
 * emerald; farming leakage → amber. (All applied in the island.)
 */
export async function ForecastTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const baseRes = await safeQuery(
    () => getRaffleForecastBaseline(period),
    null,
    "insights-rewards-raffle.forecast.baseline",
  );

  const base = baseRes.data;

  // Fire-and-forget CH comparison (no-op unless the surface flag is in
  // `comparison` mode). Served payload is always the Postgres `base`.

  // A real baseline is usable only when the query succeeded AND there were
  // actual completed raffles with a reconstructable prize cost in the window.
  // Otherwise the cost / avg anchors are zero and the model has nothing real to
  // stand on → empty state.
  const hasReal = base != null && base.raffleCount > 0 && base.totalPrizeCost > 0;

  // Day-span the baseline was measured over (lifetime is bounded to the
  // standard lookback). Drives the horizon-scaling of the real winner count in
  // the engine. Always ≥1.
  const periodDays = Math.max(1, daysForInsightsPeriodCapped(period));

  const realBaseline: ForecastBaseline | null = hasReal
    ? {
        totalCost: base.totalPrizeCost,
        uniqueClaimants: base.uniqueWinners,
        periodDays,
        claimProbability: base.claimProbability,
        avgBonusUsd: base.avgPrizePerWinner,
        empiricalCapUsd: base.maxRafflePrizeUsd,
        // Raffles have no per-claim dollar cap and no forward-ROI query.
        capHitRate: null,
        blendedRoi: null,
        avgGgrPerClaimant: 0,
      }
    : null;

  // No real raffle data for this period → clean empty state. We do NOT fall
  // back to synthetic numbers (the surface is "always real data").
  if (realBaseline == null) {
    return (
      <div className="rounded-2xl border border-dashed bg-muted/20 p-10 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <Ticket className="size-6" />
        </div>
        <p className="mt-4 text-sm font-semibold">No completed raffles for this period</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          The forecast anchors on real raffle activity ({insightsRewardsPeriodLabel(period)}). There
          were no completed raffles with a reconstructable prize value in this window, so there is
          nothing to model. Pick a wider period above.
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
