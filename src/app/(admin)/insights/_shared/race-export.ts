import "server-only";

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
import { settle, unwrap, buildSection } from "../_export-section";

const AREA = "insights.export.race";

/**
 * Export gatherer for /insights/rewards/race.
 *
 * Bundles every tab's data for the active period into one CSV: the
 * overview KPIs + daily prize series, per-race breakdown, per-type
 * rollup, position-payout distribution, repeat-winner analysis, ROI,
 * geo / source / signup cohorts, and the period + lifetime top-winner
 * leaderboards.
 *
 * Reuses the exact same cached query helpers the page renders. Race
 * prizes are house cost → rose in the UI; CSV carries raw machine
 * values. Read-only. Server-only; auth is enforced by the route handler
 * that calls this (`/insights/export`), which gates on the same
 * page-access key as the page.
 */
export async function gatherRaceExportSections(
  period: InsightsRewardsPeriod,
): Promise<ExportSection[]> {
  // Settle (not await-throw) so one failed query degrades only its own
  // section(s) instead of crashing the gatherer → BOM-only download.
  const [
    overviewR,
    breakdownR,
    perTypeR,
    positionsR,
    repeatR,
    roiR,
    cohortR,
    topR,
  ] = await settle([
    getRaceInsightsOverview(period),
    getRaceInsightsBreakdown(period),
    getRaceInsightsPerType(period),
    getRaceInsightsPositions(period),
    getRaceInsightsRepeatWinners(period),
    getRaceInsightsROI(period),
    getRaceInsightsCohort(period),
    getRaceInsightsTopWinners(period),
  ]);
  const overview = () => unwrap(overviewR);
  const breakdown = () => unwrap(breakdownR);
  const perType = () => unwrap(perTypeR);
  const positions = () => unwrap(positionsR);
  const repeat = () => unwrap(repeatR);
  const roi = () => unwrap(roiR);
  const cohort = () => unwrap(cohortR);
  const top = () => unwrap(topR);

  const label = insightsRewardsPeriodLabel(period);
  const cohortColumns = ["Key", "Label", "Winners", "Total prize (USD)", "Share %"];
  const topWinnerColumns = [
    "User ID",
    "Username",
    "Race count",
    "Total prize (USD)",
    "Avg prize (USD)",
    "Lifetime total (USD)",
  ];

  return [
    // ── Overview KPIs ─────────────────────────────────────────────
    buildSection(AREA, `Race Overview KPIs (${label})`, ["Metric", "Value"], () => {
      const o = overview();
      return [
        ["Period", label],
        ["Total prize paid (USD)", o.totalPrizePaid],
        ["Distinct races", o.distinctRaces],
        ["Distinct winners", o.distinctWinners],
        ["Winner count", o.winnerCount],
        ["Avg prize per race (USD)", o.avgPrizePerRace],
        ["Avg prize per winner (USD)", o.avgPrizePerWinner],
      ];
    }),
    buildSection(AREA, "Race Daily Prizes", ["Date", "Total (USD)", "Count"], () =>
      overview().dailyPrizes.map((d) => [d.date, d.total, d.count]),
    ),

    // ── Per-race breakdown ────────────────────────────────────────
    buildSection(
      AREA,
      "Race Breakdown",
      [
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
      () =>
        breakdown().map((r) => [
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
    ),

    // ── Per-type rollup ───────────────────────────────────────────
    buildSection(
      AREA,
      "Race by Type",
      [
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
      () =>
        perType().map((r) => [
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
    ),

    // ── Position-payout distribution ──────────────────────────────
    buildSection(
      AREA,
      "Race Position Distribution",
      ["Position", "Count", "Volume (USD)", "Avg prize (USD)"],
      () => positions().map((b) => [b.label, b.count, b.volume, b.avgPrize]),
    ),

    // ── Repeat winners ────────────────────────────────────────────
    buildSection(
      AREA,
      "Race Repeat Winners",
      ["User ID", "Username", "Race count", "Total prize (USD)", "Avg prize (USD)"],
      () =>
        repeat().topRepeatWinners.map((r) => [
          r.userId,
          r.username,
          r.raceCount,
          r.totalPrize,
          r.avgPrize,
        ]),
    ),
    buildSection(
      AREA,
      "Race Repeat Frequency Buckets",
      ["Bucket", "User count", "Total prize (USD)"],
      () => repeat().frequencyBuckets.map((b) => [b.label, b.userCount, b.totalPrize]),
    ),

    // ── ROI ───────────────────────────────────────────────────────
    buildSection(AREA, "Race ROI", ["Metric", "Value"], () => {
      const r = roi();
      return [
        ["Cost (USD)", r.cost],
        ["Claimant count", r.claimantCount],
        ["Subsequent wager (USD)", r.subsequentWager],
        ["Subsequent payout (USD)", r.subsequentPayout],
        ["Subsequent GGR (USD)", r.subsequentGgr],
        ["ROI (GGR / cost)", r.roi],
        ["Avg GGR per winner (USD)", r.avgGgrPerWinner],
        ["Lookback (days)", r.lookbackDays],
      ];
    }),

    // ── Cohorts: countries / sources / signup cohorts ─────────────
    buildSection(AREA, "Race Winners by Country", cohortColumns, () =>
      cohort().countries.map((r) => [r.key, r.label, r.winnerCount, r.totalPrize, r.share]),
    ),
    buildSection(AREA, "Race Winners by Source", cohortColumns, () =>
      cohort().sources.map((r) => [r.key, r.label, r.winnerCount, r.totalPrize, r.share]),
    ),
    buildSection(AREA, "Race Winners by Signup Cohort", cohortColumns, () =>
      cohort().signupCohorts.map((r) => [r.key, r.label, r.winnerCount, r.totalPrize, r.share]),
    ),

    // ── Top winners (period + lifetime) ───────────────────────────
    buildSection(AREA, "Race Top Winners (period)", topWinnerColumns, () =>
      top().period.map((r) => [
        r.userId,
        r.username,
        r.raceCount,
        r.totalPrize,
        r.avgPrize,
        r.lifetimeTotal,
      ]),
    ),
    buildSection(AREA, "Race Top Winners (lifetime)", topWinnerColumns, () =>
      top().lifetime.map((r) => [
        r.userId,
        r.username,
        r.raceCount,
        r.totalPrize,
        r.avgPrize,
        r.lifetimeTotal,
      ]),
    ),
  ];
}
