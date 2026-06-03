import { safeQuery } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getDepositBonusOverview } from "@/lib/queries/insights-rewards/deposit-bonus/overview";
import { getDepositBonusCapHitRate } from "@/lib/queries/insights-rewards/deposit-bonus/cap-analysis";
import { getDepositBonusROI } from "@/lib/queries/insights-rewards/deposit-bonus/roi";

import { DEMO_BASELINE, type ForecastBaseline } from "../_forecast";
import { ForecastSimulator } from "./forecast-simulator";

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
 * Anchor is REAL where a canonical source exists (cost / claimants / avg /
 * empirical cap → overview; cap-hit rate → capHitRate; downstream GGR/ROI →
 * roi). Behavioural assumptions stay tunable DEMO seeds in the island. If the
 * baseline fetch fails or the period has no bonus rows, we degrade to the DEMO
 * baseline + a DEMO badge instead of crashing the tab.
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
  // were actual bonus rows in the window (count > 0). Otherwise the cost/avg
  // anchors are zero and the model has nothing real to stand on → DEMO.
  const hasReal = ov != null && ov.count > 0;

  const realBaseline: ForecastBaseline | null = hasReal
    ? {
        totalCost: ov.totalCost,
        uniqueClaimants: ov.uniqueClaimants,
        avgBonusUsd: ov.avg,
        empiricalCapUsd: ov.max,
        capHitRate: cap?.capHitRate ?? null,
        blendedRoi: roi?.blendedRoi ?? null,
        avgGgrPerClaimant: roi?.avgGgrPerClaimant ?? 0,
      }
    : null;

  return (
    <ForecastSimulator
      realBaseline={realBaseline}
      demoBaseline={DEMO_BASELINE}
      isDemo={!hasReal}
      period={insightsRewardsPeriodLabel(period)}
    />
  );
}
