import { UserPlus } from "lucide-react";

import { safeQuery } from "@/lib/errors/safe-query";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getSignupOverview } from "@/lib/queries/insights-rewards/signup/overview";
import { getSignupTopRecipients } from "@/lib/queries/insights-rewards/signup/top-recipients";

import { type ForecastBaseline } from "../_forecast";
import { ForecastSimulatorIsland } from "./forecast-simulator";

/**
 * Forecast tab (server) on /insights/rewards/signup.
 *
 * Fetches the REAL baseline ONCE here (the canonical signup queries), then hands
 * serialized primitives into the `"use client"` simulator island. The island
 * runs the pure engine in `useMemo` on every slider change — no server
 * round-trip per keystroke (mirrors the deposit-bonus reference).
 *
 * Active-timeframe-only: this query pair runs ONLY when Forecast is the active
 * tab — it lives inside the page's `<Suspense key={tab:period}>` boundary, so
 * switching to Forecast does not eagerly fire the other tabs' queries.
 *
 * The data ANCHORS are always REAL:
 *   • total cost / claimants / claim rate / avg grant  → getSignupOverview
 *   • empirical cap (largest single grant)             → getSignupTopRecipients
 *
 * There is NO dedicated signup ROI / cap-hit query (signup grants are a
 * fixed-value welcome credit, not a window-capped deposit match), so cap-hit
 * rate and blended ROI are reported as unavailable ("—") rather than invented.
 * There is NO demo fallback — if the period has no signup-bonus claims (or the
 * baseline fetch fails), we render a clean empty state instead of synthetic
 * numbers. Only the BEHAVIOURAL assumptions (abuse share, retention uplift,
 * breakage, deposit-gate elasticity, …) remain tunable what-if levers.
 *
 * House-POV: grants are house cost → rose; savings against the house → emerald;
 * abuse → amber. (All applied in the island.)
 */
export async function ForecastTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const [ovRes, topRes] = await Promise.all([
    safeQuery(
      () => getSignupOverview(period),
      null,
      "insights-rewards-signup.forecast.overview",
    ),
    safeQuery(
      () => getSignupTopRecipients(period),
      null,
      "insights-rewards-signup.forecast.top-recipients",
    ),
  ]);

  const ov = ovRes.data;
  const top = topRes.data;

  // A real baseline is usable only when the overview query succeeded AND there
  // were actual signup-bonus claimants in the window. Otherwise the cost / avg
  // anchors are zero and the model has nothing real to stand on → empty state.
  const hasReal = ov != null && ov.claimants > 0;

  // Day-span the baseline was measured over (lifetime is bounded to the standard
  // lookback). Drives the horizon-scaling of the real claimant count in the
  // engine. Always ≥1.
  const periodDays = Math.max(1, daysForInsightsPeriodCapped(period));

  // Real measured claim rate = claimants ÷ signups (raw counts, for precision).
  // null when there were no signups (divide-by-zero guard → empty state).
  const claimProbability =
    ov != null && ov.signups > 0 ? ov.claimants / ov.signups : null;

  // Empirical cap = the largest single signup grant actually paid in the window
  // (top recipients are ranked by volume; the max single claim across them is a
  // faithful empirical ceiling). Falls back to the avg when no rows.
  const empiricalCapUsd =
    top != null && top.length > 0
      ? Math.max(...top.map((r) => r.largestClaim))
      : (ov?.avgPerClaim ?? 0);

  const realBaseline: ForecastBaseline | null =
    hasReal && ov != null
      ? {
          totalCost: ov.totalCost,
          uniqueClaimants: ov.claimants,
          periodDays,
          claimProbability,
          avgBonusUsd: ov.avgPerClaim,
          empiricalCapUsd,
          // No signup cap-hit / ROI query exists — report as unavailable rather
          // than fabricate. The island renders these as "—".
          capHitRate: null,
          blendedRoi: null,
          avgGgrPerClaimant: 0,
        }
      : null;

  // No real signup-bonus data for this period → clean empty state. We do NOT
  // fall back to synthetic numbers (the page is "always real data").
  if (realBaseline == null) {
    return (
      <div className="rounded-2xl border border-dashed bg-muted/20 p-10 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400">
          <UserPlus className="size-6" />
        </div>
        <p className="mt-4 text-sm font-semibold">No signup-bonus data for this period</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          The forecast anchors on real signup-bonus activity ({insightsRewardsPeriodLabel(period)}).
          There were no signup-bonus claimants in this window, so there is nothing to model. Pick a
          wider period above.
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
