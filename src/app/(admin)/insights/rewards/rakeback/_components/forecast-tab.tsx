import { TrendingDown } from "lucide-react";

import { safeQuery } from "@/lib/errors/safe-query";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getRakebackOverview } from "@/lib/queries/insights-rewards/rakeback/overview";
import { getRakebackRoi } from "@/lib/queries/insights-rewards/rakeback/roi";

import { type ForecastBaseline } from "../_forecast";
import { ForecastSimulatorIsland } from "./forecast-simulator";

/**
 * Forecast tab (server) on /insights/rewards/rakeback.
 *
 * Fetches the REAL baseline ONCE here (the canonical rakeback queries), then
 * hands serialized primitives into the `"use client"` simulator island. The
 * island runs the pure engine in `useMemo` on every slider change — no server
 * round-trip per keystroke (mirrors the deposit-bonus reference).
 *
 * Active-timeframe-only: this query pair runs ONLY when Forecast is the active
 * tab — it lives inside the page's `<Suspense key={tab:period}>` boundary, so
 * switching to Forecast does not eagerly fire the other tabs' queries.
 *
 * The data ANCHORS are always REAL:
 *   • total rakeback cost / distinct claimants / avg per claim / total wager /
 *     blended rate (rakeback ÷ wager) → `getRakebackOverview`
 *   • downstream GGR / ROI / avg GGR per claimant → `getRakebackRoi`
 *
 * Rakeback-specific extensions: `ForecastBaseline` (the shared kit shape) has no
 * dedicated field for the blended RATE or the total WAGER, which the rate-policy
 * engine needs. We attach them as extra serializable properties on the baseline
 * object (`blendedRate` / `totalWager`); the rakeback config's `defaults` reads
 * them defensively (and derives wager from cost ÷ rate if ever absent). Extra
 * props survive the RSC serialization since the baseline is a plain object.
 *
 * Real-vs-modeled honesty:
 *   • Rakeback has NO cap, so `empiricalCapUsd` carries the largest single claim
 *     (the empirical per-claim ceiling) and `capHitRate` is null.
 *   • Rakeback's overview has no clean "qualifying depositors" denominator, so
 *     `claimProbability` is null → the claim-probability slider seeds from the
 *     named default (still tunable for what-if). This is the documented contract.
 *
 * There is NO demo fallback — if the period has no rakeback rows (or the
 * overview fetch fails / total wager is zero so a blended rate is undefined), we
 * render a clean empty state instead of synthetic numbers.
 *
 * House-POV: rakeback is house cost → rose; savings against the house →
 * emerald; farmed-wager leakage → amber. (All applied in the island.)
 */
export async function ForecastTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const [ovRes, roiRes] = await Promise.all([
    safeQuery(
      () => getRakebackOverview(period),
      null,
      "insights-rewards-rakeback.forecast.overview",
    ),
    safeQuery(
      () => getRakebackRoi(period),
      null,
      "insights-rewards-rakeback.forecast.roi",
    ),
  ]);

  const ov = ovRes.data;
  const roi = roiRes.data;

  // A real baseline is usable only when the overview query succeeded AND there
  // were actual rakeback rows in the window (count > 0) AND a blended rate is
  // computable (total wager > 0). Without a rate the cost base is undefined →
  // empty state rather than synthetic numbers.
  const blendedRate =
    ov != null && ov.totalWager > 0 ? ov.totalRakeback / ov.totalWager : 0;
  const hasReal = ov != null && ov.count > 0 && blendedRate > 0;

  // Day-span the baseline was measured over (lifetime is bounded to the standard
  // lookback). Drives the horizon-scaling of the real claimant count + wager in
  // the engine. Always ≥1.
  const periodDays = Math.max(1, daysForInsightsPeriodCapped(period));

  // Avg downstream GGR per claimant from the ROI query (subsequent GGR ÷ the
  // claimants it was measured against). 0 when no claimants.
  const avgGgrPerClaimant =
    roi != null && roi.claimants > 0 ? roi.subsequentGgr / roi.claimants : 0;

  // The baseline + the two rakeback-specific extension fields the rate engine
  // needs (the shared `ForecastBaseline` shape has no rate / wager slot).
  const realBaseline:
    | (ForecastBaseline & { blendedRate: number; totalWager: number })
    | null = hasReal
    ? {
        totalCost: ov.totalRakeback,
        uniqueClaimants: ov.distinctClaimants,
        periodDays,
        // No clean qualifier denominator for rakeback → null (slider seeds from
        // the named default; the engine treats the default lever as neutral).
        claimProbability: null,
        avgBonusUsd: ov.avgPerClaim,
        // No rakeback cap — the largest single claim is the empirical ceiling.
        empiricalCapUsd: ov.largestClaim,
        capHitRate: null,
        blendedRoi: roi?.roiRatio ?? null,
        avgGgrPerClaimant,
        // ── Rakeback-specific extensions (read by the config's defaults) ──
        blendedRate,
        totalWager: ov.totalWager,
      }
    : null;

  // No real rakeback data for this period → clean empty state. We do NOT fall
  // back to synthetic numbers (the page is "always real data").
  if (realBaseline == null) {
    return (
      <div className="rounded-2xl border border-dashed bg-muted/20 p-10 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400">
          <TrendingDown className="size-6" />
        </div>
        <p className="mt-4 text-sm font-semibold">No rakeback data for this period</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          The forecast anchors on real rakeback activity ({insightsRewardsPeriodLabel(period)}).
          There were no rakeback claims (with attributed wager) in this window, so there is nothing
          to model. Pick a wider period above.
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
