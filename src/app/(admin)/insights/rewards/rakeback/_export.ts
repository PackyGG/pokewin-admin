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
import { settle, unwrap, buildSection } from "../../_export-section";

const AREA = "insights.export.rakeback";

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
  // Settle (not await-throw) so one failed query degrades only its own
  // section(s) instead of crashing the gatherer → BOM-only download.
  const [
    overviewR,
    rateR,
    cadenceR,
    activeR,
    extrasR,
    lapsedR,
    roiR,
    topClaimersR,
    dailyR,
    geoR,
  ] = await settle([
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
  const overview = () => unwrap(overviewR);
  const rate = () => unwrap(rateR);
  const cadence = () => unwrap(cadenceR);
  const active = () => unwrap(activeR);
  const extras = () => unwrap(extrasR);
  const lapsed = () => unwrap(lapsedR);
  const roi = () => unwrap(roiR);
  const topClaimers = () => unwrap(topClaimersR);
  const daily = () => unwrap(dailyR);
  const geo = () => unwrap(geoR);

  const label = insightsRewardsPeriodLabel(period);
  const geoColumns = ["Key", "Label", "Users", "Total (USD)", "Share %"];

  return [
    // ── Overview KPIs ─────────────────────────────────────────────
    buildSection(AREA, `Rakeback Overview KPIs (${label})`, ["Metric", "Value"], () => {
      const o = overview();
      const prior = o.priorWindow;
      return [
        ["Period", label],
        ["Total rakeback (USD)", o.totalRakeback],
        ["Claim count", o.count],
        ["Distinct claimants", o.distinctClaimants],
        ["Total wager (USD)", o.totalWager],
        ["Avg per claim (USD)", o.avgPerClaim],
        ["Largest claim (USD)", o.largestClaim],
        ["Prior rakeback (USD)", prior?.totalRakeback ?? null],
        ["Prior count", prior?.count ?? null],
        ["Prior claimants", prior?.distinctClaimants ?? null],
        ["Rakeback delta vs prior", prior?.rakebackDelta ?? null],
        ["Count delta vs prior", prior?.countDelta ?? null],
        ["Claimant delta vs prior", prior?.claimantDelta ?? null],
      ];
    }),

    // ── % of wager distribution ───────────────────────────────────
    buildSection(AREA, "Rakeback % of Wager — Summary", ["Metric", "Value"], () => {
      const r = rate();
      return [
        ["Avg % of wager", r.avgPctOfWager],
        ["Median % of wager", r.medianPctOfWager],
        ["Cohort size", r.cohortSize],
      ];
    }),
    buildSection(AREA, "Rakeback % of Wager — Distribution", ["Bucket", "Count", "Share"], () =>
      rate().buckets.map((b) => [b.label, b.count, b.share]),
    ),

    // ── Cadence ───────────────────────────────────────────────────
    buildSection(AREA, "Rakeback Cadence — Summary", ["Metric", "Value"], () => {
      const c = cadence();
      return [
        ["Total claims", c.totalClaims],
        ["Distinct claimants", c.distinctClaimants],
        ["Avg claims per active user", c.avgClaimsPerActiveUser],
        ["Median gap (hours)", c.medianGapHours],
      ];
    }),
    buildSection(AREA, "Rakeback Cadence — Gap Distribution", ["Bucket", "Count", "Share"], () =>
      cadence().buckets.map((b) => [b.label, b.count, b.share]),
    ),

    // ── Active subscribers ────────────────────────────────────────
    buildSection(AREA, "Rakeback Weekly Active", ["Week start", "Active users"], () =>
      active().weeklyActive.map((w) => [w.weekStart, w.activeUsers]),
    ),
    buildSection(
      AREA,
      "Rakeback Cohort Retention",
      ["Cohort week", "Cohort size", "Week offset", "Active count", "Share %"],
      () => {
        const rows: (string | number)[][] = [];
        for (const c of active().cohorts) {
          for (const r of c.retention) {
            rows.push([c.cohortWeekStart, c.cohortSize, r.weekOffset, r.activeCount, r.sharePct]);
          }
        }
        return rows;
      },
    ),

    // ── Tier spread (from shared extras) ──────────────────────────
    buildSection(
      AREA,
      "Rakeback Tier Spread",
      ["Type", "Count", "Volume (USD)", "Share"],
      () => extras().rakebackTypeSpread.map((t) => [t.type, t.count, t.volume, t.share]),
    ),

    // ── Lapsed claimants (null for lifetime — no prior frame) ─────
    buildSection(AREA, "Rakeback Lapsed — Summary", ["Metric", "Value"], () => {
      const l = lapsed();
      return l
        ? [
            ["Total lapsed users", l.totalLapsedUsers],
            ["Total lost rakeback (USD)", l.totalLostRakeback],
            ["Reason: churned", l.reasons.churned],
            ["Reason: less active", l.reasons.lessActive],
            ["Reason: still active", l.reasons.stillActive],
          ]
        : [["Note", "Lapsed analysis is unavailable for the lifetime window."]];
    }),
    buildSection(
      AREA,
      "Rakeback Lapsed — Sample Users",
      [
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
      () =>
        (lapsed()?.sampleUsers ?? []).map((u) => [
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
    ),

    // ── ROI ───────────────────────────────────────────────────────
    buildSection(AREA, "Rakeback ROI", ["Metric", "Value"], () => {
      const r = roi();
      return [
        ["Cost (USD)", r.cost],
        ["Subsequent GGR (USD)", r.subsequentGgr],
        ["ROI ratio (GGR / cost)", r.roiRatio],
        ["Net return (USD)", r.netReturn],
        ["Claimants", r.claimants],
        ["Lookback (days)", r.lookbackDays],
      ];
    }),

    // ── Top claimers ──────────────────────────────────────────────
    buildSection(
      AREA,
      `Rakeback Top Claimers (${scope})`,
      [
        "User ID",
        "Username",
        "Total rakeback (USD)",
        "Claim count",
        "Avg per claim (USD)",
        "Lifetime rakeback (USD)",
      ],
      () =>
        topClaimers().map((c) => [
          c.userId,
          c.username,
          c.totalRakeback,
          c.claimCount,
          c.avgPerClaim,
          c.lifetimeRakeback,
        ]),
    ),

    // ── Daily breakdown ───────────────────────────────────────────
    buildSection(
      AREA,
      "Rakeback Daily Breakdown",
      ["Date", "Count", "Volume (USD)", "Avg (USD)", "Distinct claimants"],
      () => daily().map((d) => [d.date, d.count, d.volume, d.avg, d.distinctClaimants]),
    ),

    // ── Geo / source ──────────────────────────────────────────────
    buildSection(AREA, "Rakeback by Country", geoColumns, () =>
      geo().countries.map((r) => [r.key, r.label, r.userCount, r.total, r.share]),
    ),
    buildSection(AREA, "Rakeback by Source", geoColumns, () =>
      geo().sources.map((r) => [r.key, r.label, r.userCount, r.total, r.share]),
    ),
  ];
}
