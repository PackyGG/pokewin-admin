import { Share2 } from "lucide-react";

import { safeQuery } from "@/lib/errors/safe-query";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getAffiliateOverview } from "@/lib/queries/insights-rewards/affiliate/overview";
import { getAffiliateLevelConfigs } from "@/lib/queries/creators-analytics";

import { type ForecastBaseline, type AffiliateLevelConfig } from "../_forecast";
import { AffiliateForecastSimulatorIsland } from "./forecast-simulator";

/**
 * Forecast tab (server) on /insights/rewards/affiliate.
 *
 * Fetches the REAL affiliate baseline ONCE here (the canonical
 * `getAffiliateOverview` query), then hands serialized primitives into the
 * `"use client"` simulator island. The island runs the pure engine in `useMemo`
 * on every slider change — no server round-trip per keystroke (mirrors the
 * deposit-bonus reference).
 *
 * Active-timeframe-only: this query runs ONLY when Forecast is the active tab —
 * it lives inside the page's `<Suspense key={tab:period}>` boundary, so switching
 * to Forecast does not eagerly fire the other tabs' queries.
 *
 * The data ANCHORS are always REAL: total commission cost, active affiliates,
 * avg commission per affiliate and a downstream-wager ROI proxy all come from
 * `getAffiliateOverview`. There is NO demo fallback — if the period has no
 * affiliate-commission rows (totalCommissionPaid 0 AND no active affiliates), we
 * render a clean empty state instead of synthetic numbers. Only the BEHAVIOURAL
 * assumptions (referral quality, retention uplift, cannibalization, …) remain
 * tunable what-if levers.
 *
 * House-POV: commission is house cost → rose; savings against the house →
 * emerald; low-quality leakage → amber. (All applied in the island.)
 */
export async function AffiliateForecastTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  // The real commission LADDER (`affiliate_level_configs`) is fetched here,
  // read-only, at request time — it anchors the baseline + what-if scenarios to
  // the ACTUAL configured per-level commission rates (e.g. an 8-level 3%→10%
  // ladder), not the fabricated 5-tier placeholder. Period-agnostic (the ladder
  // is the same regardless of window), so it sits outside the period anchors.
  const [ovRes, cfgRes] = await Promise.all([
    safeQuery(
      () => getAffiliateOverview(period),
      null,
      "insights-rewards-affiliate.forecast.overview",
    ),
    safeQuery(
      () => getAffiliateLevelConfigs(),
      [],
      "insights-rewards-affiliate.forecast.level-configs",
    ),
  ]);

  const ov = ovRes.data;

  // Map the raw level-config rows onto the forecast's shape (rename to the
  // engine's camelCase field). Each `commission_rate` is already a fraction.
  const levelConfigs: AffiliateLevelConfig[] = (cfgRes.data ?? []).map((c) => ({
    level: c.level,
    label: c.label,
    commissionRate: c.commission_rate,
    threshold: c.threshold,
  }));

  // A real baseline is usable only when the overview query succeeded AND there
  // was actual commission activity in the window (commission paid AND active
  // affiliates). Otherwise the cost / avg anchors are zero and the model has
  // nothing real to stand on → empty state.
  const hasReal = ov != null && ov.totalCommissionPaid > 0 && ov.activeAffiliates > 0;

  // Day-span the baseline was measured over (lifetime is bounded to the standard
  // lookback). Drives the horizon-scaling of the real affiliate count in the
  // engine. Always ≥1.
  const periodDays = Math.max(1, daysForInsightsPeriodCapped(period));

  const realBaseline: (ForecastBaseline & { levelConfigs: AffiliateLevelConfig[] }) | null = hasReal
    ? {
        totalCost: ov.totalCommissionPaid,
        uniqueClaimants: ov.activeAffiliates,
        periodDays,
        // No clean qualified-affiliate denominator in the overview rollup — leave
        // null (the active-rate slider then falls back to its seed and the engine
        // treats the default lever as neutral). We do NOT fabricate a ratio.
        claimProbability: null,
        avgBonusUsd: ov.avgCommissionPerAffiliate,
        // The affiliate program has no per-affiliate "cap" — surface 0 (the
        // assumptions panel renders it as a $0 informational row). Not a model input.
        empiricalCapUsd: 0,
        capHitRate: null,
        // Real blended ROI proxy = downstream wager ÷ commission paid (how many $
        // of referred wager each $ of commission buys). House-POV positive.
        blendedRoi:
          ov.totalCommissionPaid > 0 ? ov.downstreamWager / ov.totalCommissionPaid : null,
        // Real avg downstream wager flow per active affiliate (a GGR proxy).
        avgGgrPerClaimant:
          ov.activeAffiliates > 0 ? ov.downstreamWager / ov.activeAffiliates : 0,
        // The REAL commission ladder → seeds the engine's per-tier baseline rates
        // + the blended reference, and drives the baseline + what-if scenarios.
        levelConfigs,
      }
    : null;

  // No real affiliate-commission data for this period → clean empty state. We do
  // NOT fall back to synthetic numbers (the page is "always real data").
  if (realBaseline == null) {
    return (
      <div className="rounded-2xl border border-dashed bg-muted/20 p-10 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400">
          <Share2 className="size-6" />
        </div>
        <p className="mt-4 text-sm font-semibold">No affiliate-commission data for this period</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          The forecast anchors on real affiliate commission activity ({insightsRewardsPeriodLabel(period)}).
          There were no completed affiliate-commission payouts in this window, so there is nothing to model.
          Pick a wider period above.
        </p>
      </div>
    );
  }

  return (
    <AffiliateForecastSimulatorIsland
      realBaseline={realBaseline}
      period={insightsRewardsPeriodLabel(period)}
    />
  );
}

export default AffiliateForecastTab;
