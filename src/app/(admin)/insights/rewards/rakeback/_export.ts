import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  insightsRewardsPeriodLabel,
  insightsPeriodToCategoryPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { RakebackRoiLookback } from "./_constants";
import { getRakebackOverview } from "@/lib/queries/insights-rewards/rakeback/overview";
import { getRakebackRateDistribution } from "@/lib/queries/insights-rewards/rakeback/rate-distribution";
import { getRakebackCadence } from "@/lib/queries/insights-rewards/rakeback/cadence";
import { getRakebackActiveSubscribers } from "@/lib/queries/insights-rewards/rakeback/active-subscribers";
import { getRakebackLapsed } from "@/lib/queries/insights-rewards/rakeback/lapsed";
import { getRakebackRoi } from "@/lib/queries/insights-rewards/rakeback/roi";
import {
  getRakebackTopClaimers,
  type RakebackTopClaimerScope,
} from "@/lib/queries/insights-rewards/rakeback/top-claimers";
import { getRakebackDaily } from "@/lib/queries/insights-rewards/rakeback/daily";
import { getRakebackGeoSource } from "@/lib/queries/insights-rewards/rakeback/geo-source";
import { getRakebackExtras } from "@/lib/queries/rewards-category-extras";

/**
 * Export gatherer for /insights/rewards/rakeback.
 *
 * Bundles every tab's data for the active period (and the current ROI
 * lookback + top-claimer scope) into one CSV: overview KPIs, % of wager
 * distribution, claim cadence, active-subscriber weekly + cohort
 * retention, tier spread, lapsed claimants, ROI, top claimers, daily
 * breakdown, geo / source.
 *
 * Reuses the exact same cached query helpers the page renders. Rakeback
 * is house cost → rose in the UI; CSV carries raw machine values.
 * Read-only. Server-only; auth is enforced by the route handler that
 * calls this (`/insights/export`), which gates on the same page-access
 * key as the page.
 */
export async function gatherRakebackExportSections(
  period: InsightsRewardsPeriod,
  lookback: RakebackRoiLookback,
  scope: RakebackTopClaimerScope,
): Promise<ExportSection[]> {
  const categoryPeriod = insightsPeriodToCategoryPeriod(period);
  const [
    overview,
    rate,
    cadence,
    active,
    extras,
    lapsed,
    roi,
    topClaimers,
    daily,
    geo,
  ] = await Promise.all([
    getRakebackOverview(period),
    getRakebackRateDistribution(period),
    getRakebackCadence(period),
    getRakebackActiveSubscribers(period),
    getRakebackExtras(categoryPeriod),
    getRakebackLapsed(period),
    getRakebackRoi(period, lookback),
    getRakebackTopClaimers(period, scope),
    getRakebackDaily(period),
    getRakebackGeoSource(period),
  ]);

  const label = insightsRewardsPeriodLabel(period);
  const prior = overview.priorWindow;
  const sections: ExportSection[] = [];

  // ── Overview KPIs ───────────────────────────────────────────────
  sections.push({
    name: `Rakeback Overview KPIs (${label})`,
    columns: ["Metric", "Value"],
    rows: [
      ["Period", label],
      ["Total rakeback (USD)", overview.totalRakeback],
      ["Claim count", overview.count],
      ["Distinct claimants", overview.distinctClaimants],
      ["Total wager (USD)", overview.totalWager],
      ["Avg per claim (USD)", overview.avgPerClaim],
      ["Largest claim (USD)", overview.largestClaim],
      ["Prior rakeback (USD)", prior?.totalRakeback ?? null],
      ["Prior count", prior?.count ?? null],
      ["Prior claimants", prior?.distinctClaimants ?? null],
      ["Rakeback delta vs prior", prior?.rakebackDelta ?? null],
      ["Count delta vs prior", prior?.countDelta ?? null],
      ["Claimant delta vs prior", prior?.claimantDelta ?? null],
    ],
  });

  // ── % of wager distribution ─────────────────────────────────────
  sections.push({
    name: "Rakeback % of Wager — Summary",
    columns: ["Metric", "Value"],
    rows: [
      ["Avg % of wager", rate.avgPctOfWager],
      ["Median % of wager", rate.medianPctOfWager],
      ["Cohort size", rate.cohortSize],
    ],
  });
  sections.push({
    name: "Rakeback % of Wager — Distribution",
    columns: ["Bucket", "Count", "Share"],
    rows: rate.buckets.map((b) => [b.label, b.count, b.share]),
  });

  // ── Cadence ─────────────────────────────────────────────────────
  sections.push({
    name: "Rakeback Cadence — Summary",
    columns: ["Metric", "Value"],
    rows: [
      ["Total claims", cadence.totalClaims],
      ["Distinct claimants", cadence.distinctClaimants],
      ["Avg claims per active user", cadence.avgClaimsPerActiveUser],
      ["Median gap (hours)", cadence.medianGapHours],
    ],
  });
  sections.push({
    name: "Rakeback Cadence — Gap Distribution",
    columns: ["Bucket", "Count", "Share"],
    rows: cadence.buckets.map((b) => [b.label, b.count, b.share]),
  });

  // ── Active subscribers ──────────────────────────────────────────
  sections.push({
    name: "Rakeback Weekly Active",
    columns: ["Week start", "Active users"],
    rows: active.weeklyActive.map((w) => [w.weekStart, w.activeUsers]),
  });
  const cohortRetentionRows: (string | number)[][] = [];
  for (const c of active.cohorts) {
    for (const r of c.retention) {
      cohortRetentionRows.push([
        c.cohortWeekStart,
        c.cohortSize,
        r.weekOffset,
        r.activeCount,
        r.sharePct,
      ]);
    }
  }
  sections.push({
    name: "Rakeback Cohort Retention",
    columns: ["Cohort week", "Cohort size", "Week offset", "Active count", "Share %"],
    rows: cohortRetentionRows,
  });

  // ── Tier spread (from shared extras) ────────────────────────────
  sections.push({
    name: "Rakeback Tier Spread",
    columns: ["Type", "Count", "Volume (USD)", "Share"],
    rows: extras.rakebackTypeSpread.map((t) => [t.type, t.count, t.volume, t.share]),
  });

  // ── Lapsed claimants (null for lifetime — no prior frame) ───────
  sections.push({
    name: "Rakeback Lapsed — Summary",
    columns: ["Metric", "Value"],
    rows: lapsed
      ? [
          ["Total lapsed users", lapsed.totalLapsedUsers],
          ["Total lost rakeback (USD)", lapsed.totalLostRakeback],
          ["Reason: churned", lapsed.reasons.churned],
          ["Reason: less active", lapsed.reasons.lessActive],
          ["Reason: still active", lapsed.reasons.stillActive],
        ]
      : [["Note", "Lapsed analysis is unavailable for the lifetime window."]],
  });
  sections.push({
    name: "Rakeback Lapsed — Sample Users",
    columns: [
      "User ID",
      "Username",
      "Prior rakeback (USD)",
      "Prior claims",
      "Current deposit (USD)",
      "Prior deposit (USD)",
      "Current wager (USD)",
      "Prior wager (USD)",
      "Reason",
    ],
    rows: (lapsed?.sampleUsers ?? []).map((u) => [
      u.userId,
      u.username,
      u.priorRakeback,
      u.priorClaims,
      u.currentDeposit,
      u.priorDeposit,
      u.currentWager,
      u.priorWager,
      u.reason,
    ]),
  });

  // ── ROI ─────────────────────────────────────────────────────────
  sections.push({
    name: "Rakeback ROI",
    columns: ["Metric", "Value"],
    rows: [
      ["Cost (USD)", roi.cost],
      ["Subsequent GGR (USD)", roi.subsequentGgr],
      ["ROI ratio (GGR / cost)", roi.roiRatio],
      ["Net return (USD)", roi.netReturn],
      ["Claimants", roi.claimants],
      ["Lookback (days)", roi.lookbackDays],
    ],
  });

  // ── Top claimers ────────────────────────────────────────────────
  sections.push({
    name: `Rakeback Top Claimers (${scope})`,
    columns: [
      "User ID",
      "Username",
      "Total rakeback (USD)",
      "Claim count",
      "Avg per claim (USD)",
      "Lifetime rakeback (USD)",
    ],
    rows: topClaimers.map((c) => [
      c.userId,
      c.username,
      c.totalRakeback,
      c.claimCount,
      c.avgPerClaim,
      c.lifetimeRakeback,
    ]),
  });

  // ── Daily breakdown ─────────────────────────────────────────────
  sections.push({
    name: "Rakeback Daily Breakdown",
    columns: ["Date", "Count", "Volume (USD)", "Avg (USD)", "Distinct claimants"],
    rows: daily.map((d) => [d.date, d.count, d.volume, d.avg, d.distinctClaimants]),
  });

  // ── Geo / source ────────────────────────────────────────────────
  const geoColumns = ["Key", "Label", "Users", "Total (USD)", "Share %"];
  sections.push({
    name: "Rakeback by Country",
    columns: geoColumns,
    rows: geo.countries.map((r) => [r.key, r.label, r.userCount, r.total, r.share]),
  });
  sections.push({
    name: "Rakeback by Source",
    columns: geoColumns,
    rows: geo.sources.map((r) => [r.key, r.label, r.userCount, r.total, r.share]),
  });

  return sections;
}
