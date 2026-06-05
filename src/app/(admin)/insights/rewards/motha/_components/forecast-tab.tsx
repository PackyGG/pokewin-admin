import { Gift } from "lucide-react";

import { safeQuery } from "@/lib/errors/safe-query";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getMothaGiveawayOverview } from "@/lib/queries/insights-rewards/motha/overview";

import { type MothaForecastBaseline } from "../_forecast";
import { ForecastSimulatorIsland } from "./forecast-simulator";

/**
 * Forecast tab (server) for the "Motha giveaways" reward.
 *
 * Fetches the REAL baseline ONCE here (the canonical motha-giveaway overview
 * query — motha's `creator_tip` + `rain_tip` + `battle_sponsorship` outflows),
 * then hands serialized primitives into the `"use client"` simulator island.
 * The island runs the pure engine in `useMemo` on every slider change — no
 * server round-trip per keystroke.
 *
 * The data ANCHORS are always REAL: total giveaway cost, the per-channel split,
 * the avg giveaway and the active-day count come from `getMothaGiveawayOverview`.
 * There is NO demo fallback — if the period has no motha giveaway rows (or the
 * baseline fetch fails), we render a clean empty state instead of synthetic
 * numbers. Only the BEHAVIOURAL assumptions (engagement uplift, waste share,
 * goodwill sensitivity, …) remain tunable what-if levers.
 *
 * House-POV: giveaways are house cost → rose; savings against the house →
 * emerald; wasteful spend → amber. (All applied in the island.)
 *
 * Exported as `ForecastTab` to match the hub registry's import convention
 * (`import { ForecastTab as ... }`, see `insights/forecast/_registry.tsx` +
 * the deposit-bonus reference). `MothaForecastTab` is a named alias for clarity.
 */
export async function ForecastTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const ovRes = await safeQuery(
    () => getMothaGiveawayOverview(period),
    null,
    "insights-rewards-motha.forecast.overview",
  );

  const ov = ovRes.data;

  // A real baseline is usable only when the overview query succeeded AND motha
  // actually gave something away in the window (totalCost > 0). Otherwise the
  // model has nothing real to stand on → empty state.
  const hasReal = ov != null && ov.totalCost > 0;

  // Day-span the baseline was measured over (lifetime is bounded to the
  // standard lookback). Drives the horizon-scaling of the active-day count in
  // the engine. Always ≥1.
  const periodDays = Math.max(1, daysForInsightsPeriodCapped(period));

  const realBaseline: MothaForecastBaseline | null = hasReal
    ? {
        // ── generic ForecastBaseline ──
        totalCost: ov.totalCost,
        // Volume anchor = distinct active days motha gave away on.
        uniqueClaimants: ov.uniqueClaimants,
        periodDays,
        // This reward has no claim funnel (active-days volume) → no real
        // P(claim). The engine treats a null here as the neutral default.
        claimProbability: null,
        avgBonusUsd: ov.avg,
        empiricalCapUsd: ov.max,
        // Cap-hit / ROI lenses do not apply to a founder giveaway budget.
        capHitRate: null,
        blendedRoi: null,
        avgGgrPerClaimant: 0,
        // ── motha-specific extras (read by the config's `defaults`) ──
        byChannel: ov.byChannel,
        giveawaysPerActiveDay:
          ov.uniqueClaimants > 0 ? ov.count / ov.uniqueClaimants : 0,
      }
    : null;

  // No real motha giveaway data for this period → clean empty state. We do NOT
  // fall back to synthetic numbers (the page is "always real data").
  if (realBaseline == null) {
    return (
      <div className="rounded-2xl border border-dashed bg-muted/20 p-10 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400">
          <Gift className="size-6" />
        </div>
        <p className="mt-4 text-sm font-semibold">No motha giveaways for this period</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          The forecast anchors on real giveaway activity from the motha account (
          {insightsRewardsPeriodLabel(period)}) across creator tips, rain tips and
          sponsored battles. There were none in this window, so there is nothing to
          model. Pick a wider period above.
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

/** Named alias of {@link ForecastTab} (clearer at a glance in the registry). */
export const MothaForecastTab = ForecastTab;
