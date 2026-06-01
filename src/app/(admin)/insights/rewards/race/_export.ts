"use server";

import { requirePageAccess } from "@/lib/dal";
import type { ExportSection } from "@/lib/utils/export-csv";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getRaceInsightsOverview } from "@/lib/queries/insights-rewards/race/overview";
import { getRaceInsightsBreakdown } from "@/lib/queries/insights-rewards/race/breakdown";
import { getRaceInsightsPerType } from "@/lib/queries/insights-rewards/race/per-type";
import { getRaceInsightsPositions } from "@/lib/queries/insights-rewards/race/positions";
import { getRaceInsightsRepeatWinners } from "@/lib/queries/insights-rewards/race/repeat-winners";
import { getRaceInsightsROI } from "@/lib/queries/insights-rewards/race/roi";
import { getRaceInsightsCohort } from "@/lib/queries/insights-rewards/race/cohort";
import { getRaceInsightsTopWinners } from "@/lib/queries/insights-rewards/race/top-winners";

/**
 * Server export action for /insights/rewards/race.
 *
 * Bundles every tab's data for the active period into one CSV: the
 * overview KPIs + daily prize series, per-race breakdown, per-type
 * rollup, position-payout distribution, repeat-winner analysis, ROI,
 * geo / source / signup cohorts, and the period + lifetime top-winner
 * leaderboards.
 *
 * Reuses the exact same cached query helpers the page renders. Race
 * prizes are house cost → rose in the UI; CSV carries raw machine
 * values. Read-only. Gated by the same page-access check as the page.
 */
export async function exportRaceData(
  period: InsightsRewardsPeriod,
): Promise<ExportSection[]> {
  await requirePageAccess("/insights/rewards/race");

  const [overview, breakdown, perType, positions, repeat, roi, cohort, top] =
    await Promise.all([
      getRaceInsightsOverview(period),
      getRaceInsightsBreakdown(period),
      getRaceInsightsPerType(period),
      getRaceInsightsPositions(period),
      getRaceInsightsRepeatWinners(period),
      getRaceInsightsROI(period),
      getRaceInsightsCohort(period),
      getRaceInsightsTopWinners(period),
    ]);

  const label = insightsRewardsPeriodLabel(period);
  const sections: ExportSection[] = [];

  // ── Overview KPIs ───────────────────────────────────────────────
  sections.push({
    name: `Race Overview KPIs (${label})`,
    columns: ["Metric", "Value"],
    rows: [
      ["Period", label],
      ["Total prize paid (USD)", overview.totalPrizePaid],
      ["Distinct races", overview.distinctRaces],
      ["Distinct winners", overview.distinctWinners],
      ["Winner count", overview.winnerCount],
      ["Avg prize per race (USD)", overview.avgPrizePerRace],
      ["Avg prize per winner (USD)", overview.avgPrizePerWinner],
    ],
  });
  sections.push({
    name: "Race Daily Prizes",
    columns: ["Date", "Total (USD)", "Count"],
    rows: overview.dailyPrizes.map((d) => [d.date, d.total, d.count]),
  });

  // ── Per-race breakdown ──────────────────────────────────────────
  sections.push({
    name: "Race Breakdown",
    columns: [
      "Race type",
      "Period start",
      "Prize pool (USD)",
      "Winners",
      "Top position",
      "Top prize (USD)",
      "Top user ID",
      "Top username",
      "Position spread",
      "Configured budget (USD)",
      "Tier utilisation",
    ],
    rows: breakdown.map((r) => [
      r.raceType,
      r.periodStart,
      r.prizePool,
      r.winnerCount,
      r.topPosition,
      r.topPrize,
      r.topUserId,
      r.topUsername,
      r.positionSpread,
      r.configuredBudget,
      r.tierUtilisation,
    ]),
  });

  // ── Per-type rollup ─────────────────────────────────────────────
  sections.push({
    name: "Race by Type",
    columns: [
      "Race type",
      "Distinct races",
      "Prize pool total (USD)",
      "Winners",
      "Distinct winners",
      "Avg prize per race (USD)",
      "Configured budget (USD)",
      "Tier budget for window (USD)",
      "Tier utilisation",
      "Avg entrants per race",
      "Conversion rate",
    ],
    rows: perType.map((r) => [
      r.raceType,
      r.distinctRaces,
      r.prizePoolTotal,
      r.winnerCount,
      r.distinctWinners,
      r.avgPrizePerRace,
      r.configuredBudget,
      r.tierBudgetForWindow,
      r.tierUtilisation,
      r.avgEntrantsPerRace,
      r.conversionRate,
    ]),
  });

  // ── Position-payout distribution ────────────────────────────────
  sections.push({
    name: "Race Position Distribution",
    columns: ["Position", "Count", "Volume (USD)", "Avg prize (USD)"],
    rows: positions.map((b) => [b.label, b.count, b.volume, b.avgPrize]),
  });

  // ── Repeat winners ──────────────────────────────────────────────
  sections.push({
    name: "Race Repeat Winners",
    columns: ["User ID", "Username", "Race count", "Total prize (USD)", "Avg prize (USD)"],
    rows: repeat.topRepeatWinners.map((r) => [
      r.userId,
      r.username,
      r.raceCount,
      r.totalPrize,
      r.avgPrize,
    ]),
  });
  sections.push({
    name: "Race Repeat Frequency Buckets",
    columns: ["Bucket", "User count", "Total prize (USD)"],
    rows: repeat.frequencyBuckets.map((b) => [
      b.label,
      b.userCount,
      b.totalPrize,
    ]),
  });

  // ── ROI ─────────────────────────────────────────────────────────
  sections.push({
    name: "Race ROI",
    columns: ["Metric", "Value"],
    rows: [
      ["Cost (USD)", roi.cost],
      ["Claimant count", roi.claimantCount],
      ["Subsequent wager (USD)", roi.subsequentWager],
      ["Subsequent payout (USD)", roi.subsequentPayout],
      ["Subsequent GGR (USD)", roi.subsequentGgr],
      ["ROI (GGR / cost)", roi.roi],
      ["Avg GGR per winner (USD)", roi.avgGgrPerWinner],
      ["Lookback (days)", roi.lookbackDays],
    ],
  });

  // ── Cohorts: countries / sources / signup cohorts ───────────────
  const cohortColumns = ["Key", "Label", "Winners", "Total prize (USD)", "Share %"];
  sections.push({
    name: "Race Winners by Country",
    columns: cohortColumns,
    rows: cohort.countries.map((r) => [r.key, r.label, r.winnerCount, r.totalPrize, r.share]),
  });
  sections.push({
    name: "Race Winners by Source",
    columns: cohortColumns,
    rows: cohort.sources.map((r) => [r.key, r.label, r.winnerCount, r.totalPrize, r.share]),
  });
  sections.push({
    name: "Race Winners by Signup Cohort",
    columns: cohortColumns,
    rows: cohort.signupCohorts.map((r) => [r.key, r.label, r.winnerCount, r.totalPrize, r.share]),
  });

  // ── Top winners (period + lifetime) ─────────────────────────────
  const topWinnerColumns = [
    "User ID",
    "Username",
    "Race count",
    "Total prize (USD)",
    "Avg prize (USD)",
    "Lifetime total (USD)",
  ];
  sections.push({
    name: "Race Top Winners (period)",
    columns: topWinnerColumns,
    rows: top.period.map((r) => [
      r.userId,
      r.username,
      r.raceCount,
      r.totalPrize,
      r.avgPrize,
      r.lifetimeTotal,
    ]),
  });
  sections.push({
    name: "Race Top Winners (lifetime)",
    columns: topWinnerColumns,
    rows: top.lifetime.map((r) => [
      r.userId,
      r.username,
      r.raceCount,
      r.totalPrize,
      r.avgPrize,
      r.lifetimeTotal,
    ]),
  });

  return sections;
}
