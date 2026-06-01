import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getDepositBonusOverview } from "@/lib/queries/insights-rewards/deposit-bonus/overview";
import { getDepositBonusCapAnalysis } from "@/lib/queries/insights-rewards/deposit-bonus/cap-analysis";
import { getDepositBonusDailyBreakdown } from "@/lib/queries/insights-rewards/deposit-bonus/daily-breakdown";
import { getDepositBonusCohortComparison } from "@/lib/queries/insights-rewards/deposit-bonus/cohort";
import {
  getDepositBonusRepeatClaimants,
  getDepositBonusNewVsReturning,
  getDepositBonusTimeToClaim,
  getDepositBonusTimeOfDay,
} from "@/lib/queries/insights-rewards/deposit-bonus/behavior";
import { getDepositBonusROI } from "@/lib/queries/insights-rewards/deposit-bonus/roi";
import { getDepositBonusGeoSource } from "@/lib/queries/insights-rewards/deposit-bonus/geo-source";
import { getDepositBonusTopSpenders } from "@/lib/queries/insights-rewards/deposit-bonus/top-spenders";
import { getDepositBonusSuspicious } from "@/lib/queries/insights-rewards/deposit-bonus/suspicious";
import { settle, unwrap, buildSection } from "../../_export-section";

const AREA = "insights.export.deposit-bonus";

/**
 * Export gatherer for /insights/rewards/deposit-bonus.
 *
 * Gathers EVERY data block across all five tabs (Overview / Cap /
 * Cohorts / ROI / Risk) for the active period into a single
 * `ExportSection[]`: the KPI rollup, daily time-series, cap analysis
 * (histogram + per-day + cap-hitters + biggest cap deposits), cohort
 * comparison, repeat / new-vs-returning segments, time-to-claim +
 * time-of-day distributions, ROI, geo / source breakdowns, top
 * recipients, and the three risk surveillance lists.
 *
 * Reuses the exact same cached query helpers the page renders, so the
 * export reconciles with the UI by construction. Read-only. Server-only
 * (uses server-only query helpers); auth is enforced by the route
 * handler that calls this (`/insights/export`), which gates on the same
 * page-access key as the page.
 *
 * The "top N" lists are bounded inside their query helpers (top 10 / 25)
 * — same data the tab shows. Section names note the bound where it
 * applies.
 */
export async function gatherDepositBonusExportSections(
  period: InsightsRewardsPeriod,
): Promise<ExportSection[]> {
  // Settle (not await-throw) so one failed query degrades only its own
  // section(s) instead of crashing the gatherer → BOM-only download.
  const [
    overviewR,
    capR,
    dailyR,
    cohortR,
    repeatR,
    newVsReturningR,
    timeToClaimR,
    timeOfDayR,
    roiR,
    geoR,
    topSpendersR,
    suspiciousR,
  ] = await settle([
    getDepositBonusOverview(period),
    getDepositBonusCapAnalysis(period),
    getDepositBonusDailyBreakdown(period),
    getDepositBonusCohortComparison(period),
    getDepositBonusRepeatClaimants(period),
    getDepositBonusNewVsReturning(period),
    getDepositBonusTimeToClaim(period),
    getDepositBonusTimeOfDay(period),
    getDepositBonusROI(period),
    getDepositBonusGeoSource(period),
    getDepositBonusTopSpenders(period),
    getDepositBonusSuspicious(period),
  ]);
  const overview = () => unwrap(overviewR);
  const cap = () => unwrap(capR);
  const daily = () => unwrap(dailyR);
  const cohort = () => unwrap(cohortR);
  const repeat = () => unwrap(repeatR);
  const newVsReturning = () => unwrap(newVsReturningR);
  const timeToClaim = () => unwrap(timeToClaimR);
  const timeOfDay = () => unwrap(timeOfDayR);
  const roi = () => unwrap(roiR);
  const geo = () => unwrap(geoR);
  const topSpenders = () => unwrap(topSpendersR);
  const suspicious = () => unwrap(suspiciousR);

  const periodLabel = insightsRewardsPeriodLabel(period);

  return [
    // ── KPI rollup ────────────────────────────────────────────────
    // Cross-cuts overview + cap + roi. The overview rows are required;
    // the cap and roi cells are read defensively so a failure in only
    // cap or roi leaves null placeholders rather than blanking the
    // whole (otherwise-populated) KPI section.
    buildSection(AREA, `Deposit Bonus KPIs (${periodLabel})`, ["Metric", "Value"], () => {
      const o = overview();
      const prior = o.priorWindow;
      // Read a single cell off the (independent) cap / roi queries; if
      // that query failed, yield null so this otherwise-populated KPI
      // section keeps every cell that DID resolve.
      const capRow = <T,>(pick: (c: ReturnType<typeof cap>) => T): T | null => {
        try {
          return pick(cap());
        } catch {
          return null;
        }
      };
      const roiRow = <T,>(pick: (r: ReturnType<typeof roi>) => T): T | null => {
        try {
          return pick(roi());
        } catch {
          return null;
        }
      };
      return [
        ["Period", periodLabel],
        ["Total cost (USD)", o.totalCost],
        ["Bonuses awarded", o.count],
        ["Unique claimants", o.uniqueClaimants],
        ["Avg bonus (USD)", o.avg],
        ["Median bonus (USD)", o.median],
        ["Max bonus / empirical cap (USD)", o.max],
        ["Cap hit rate", capRow((c) => c.capHitRate)],
        ["Cap hits", capRow((c) => c.capHits)],
        ["Unique cap hitters", capRow((c) => c.uniqueCapHitters)],
        ["Avg per claimant (USD)", o.uniqueClaimants > 0 ? o.totalCost / o.uniqueClaimants : 0],
        ["Prior cost (USD)", prior?.totalCost ?? null],
        ["Prior count", prior?.count ?? null],
        ["Prior claimants", prior?.uniqueClaimants ?? null],
        ["Cost delta vs prior", prior?.costDelta ?? null],
        ["Count delta vs prior", prior?.countDelta ?? null],
        ["Claimant delta vs prior", prior?.claimantDelta ?? null],
        ["ROI cost (USD)", roiRow((r) => r.cost)],
        ["ROI subsequent GGR (USD)", roiRow((r) => r.subsequentGgr)],
        ["ROI subsequent wager (USD)", roiRow((r) => r.wager)],
        ["ROI subsequent payouts (USD)", roiRow((r) => r.payouts)],
        ["Blended ROI (GGR / cost)", roiRow((r) => r.blendedRoi)],
        ["ROI avg GGR per claimant (USD)", roiRow((r) => r.avgGgrPerClaimant)],
        ["ROI lookback (days)", roiRow((r) => r.effectiveLookbackDays)],
      ];
    }),

    // ── Daily time-series (overview chart) ────────────────────────
    buildSection(
      AREA,
      "Daily Bonus Volume",
      ["Date", "Volume (USD)", "Count", "Claimants"],
      () => overview().dailyVolume.map((d) => [d.date, d.volume, d.count, d.claimants]),
    ),

    // ── Daily breakdown table ─────────────────────────────────────
    buildSection(
      AREA,
      "Daily Breakdown",
      [
        "Date",
        "Deposits",
        "Deposit Volume (USD)",
        "Deposits w/ bonus",
        "Attach rate",
        "Bonuses",
        "Bonus Volume (USD)",
        "Avg bonus (USD)",
        "Bonus/Deposit ratio",
        "Claimants",
      ],
      () =>
        daily().map((r) => [
          r.date,
          r.depositCount,
          r.depositVolume,
          r.depositWithBonusCount,
          r.attachRate,
          r.bonusCount,
          r.bonusVolume,
          r.avgBonus,
          r.bonusToDepositRatio,
          r.uniqueClaimants,
        ]),
    ),

    // ── Cap: amount distribution histogram ────────────────────────
    buildSection(
      AREA,
      "Cap — Amount Distribution",
      ["Bucket", "Min (USD)", "Max (USD)", "Count", "Volume (USD)"],
      () => cap().amountDistribution.map((b) => [b.label, b.min, b.max, b.count, b.volume]),
    ),

    // ── Cap: per-day cap hit rate ─────────────────────────────────
    buildSection(
      AREA,
      "Cap — Daily Hit Rate",
      ["Date", "Bonuses", "Cap hits", "Rate"],
      () => cap().dailyCapHitRate.map((r) => [r.date, r.bonuses, r.capHits, r.rate]),
    ),

    // ── Cap: top cap hitters (top 10) ─────────────────────────────
    buildSection(
      AREA,
      "Cap — Top Cap Hitters (top 10)",
      ["User ID", "Username", "Cap hits", "Total bonus (USD)", "Last hit (UTC)"],
      () =>
        cap().topCapHitters.map((r) => [
          r.userId,
          r.username,
          r.capHits,
          r.totalBonus,
          r.lastHitAt,
        ]),
    ),

    // ── Cap: biggest cap-paired deposits (top 10) ─────────────────
    buildSection(
      AREA,
      "Cap — Biggest Cap Deposits (top 10)",
      ["User ID", "Username", "Deposit (USD)", "Bonus (USD)", "Created (UTC)"],
      () =>
        cap().biggestCapDeposits.map((r) => [
          r.userId,
          r.username,
          r.depositUsd,
          r.bonusUsd,
          r.createdAt,
        ]),
    ),

    // ── Cohort comparison (with vs without bonus) ─────────────────
    buildSection(
      AREA,
      "Cohort Comparison (deposits with vs without bonus)",
      ["Metric", "With bonus", "Without bonus"],
      () => {
        const c = cohort();
        return [
          ["Deposits", c.withBonus.count, c.withoutBonus.count],
          ["Sum (USD)", c.withBonus.sum, c.withoutBonus.sum],
          ["Avg (USD)", c.withBonus.avg, c.withoutBonus.avg],
          ["Median (USD)", c.withBonus.median, c.withoutBonus.median],
          ["P99 (USD)", c.withBonus.p99, c.withoutBonus.p99],
          ["Unique users", c.withBonus.uniqueUsers, c.withoutBonus.uniqueUsers],
          ["Retain 7d", c.withBonus.retain7d, c.withoutBonus.retain7d],
          ["Retain 30d", c.withBonus.retain30d, c.withoutBonus.retain30d],
        ];
      },
    ),
    buildSection(AREA, "Cohort Lift & Ratio Summary", ["Metric", "Value"], () => {
      const c = cohort();
      return [
        ["Total deposits", c.totalDeposits],
        ["Avg-deposit lift %", c.avgLiftPct],
        ["Median-deposit lift %", c.medianLiftPct],
        ["Retain 7d lift %", c.retain7dLiftPct],
        ["Retain 30d lift %", c.retain30dLiftPct],
        ["Mean bonus/deposit ratio", c.meanRatio],
        ["Median bonus/deposit ratio", c.medianRatio],
      ];
    }),
    buildSection(AREA, "Bonus/Deposit Ratio Histogram", ["Bucket", "Count", "Volume (USD)"], () =>
      cohort().ratioBuckets.map((b) => [b.label, b.count, b.volume]),
    ),

    // ── Repeat-claimant segments ──────────────────────────────────
    buildSection(
      AREA,
      "Repeat Claimant Segments",
      ["Segment", "Users", "Total bonus (USD)", "Avg bonus/user (USD)", "Wager in window (USD)"],
      () =>
        repeat().segments.map((s) => [
          s.label,
          s.users,
          s.totalBonus,
          s.avgBonusPerUser,
          s.wagerInWindow,
        ]),
    ),

    // ── New vs returning claimants ────────────────────────────────
    buildSection(AREA, "New vs Returning Claimants", ["Metric", "New", "Returning"], () => {
      const n = newVsReturning();
      return [
        ["Users", n.newClaimants.users, n.returningClaimants.users],
        ["Total bonus (USD)", n.newClaimants.totalBonus, n.returningClaimants.totalBonus],
        [
          "Avg bonus/user (USD)",
          n.newClaimants.avgBonusPerUser,
          n.returningClaimants.avgBonusPerUser,
        ],
        [
          "Avg first deposit (USD)",
          n.newClaimants.avgFirstDepositUsd,
          n.returningClaimants.avgFirstDepositUsd,
        ],
        ["Retain 7d", n.newClaimants.retain7d, n.returningClaimants.retain7d],
        [
          "2nd deposit 30d rate",
          n.newClaimants.secondDeposit30dRate,
          n.returningClaimants.secondDeposit30dRate,
        ],
      ];
    }),

    // ── Time-to-claim distribution ────────────────────────────────
    buildSection(AREA, "Time-to-Claim Distribution", ["Bucket", "Count"], () =>
      timeToClaim().buckets.map((b) => [b.label, b.count]),
    ),
    buildSection(AREA, "Time-to-Claim Summary", ["Metric", "Seconds"], () => {
      const t = timeToClaim();
      return [
        ["Total paired", t.totalPaired],
        ["Median", t.medianSeconds],
        ["Mean", t.meanSeconds],
        ["P95", t.p95Seconds],
        ["P99", t.p99Seconds],
        ["Max", t.maxSeconds],
      ];
    }),

    // ── Time-of-day distributions ─────────────────────────────────
    buildSection(AREA, "Hour-of-Day Distribution (UTC)", ["Hour", "Count", "Volume (USD)"], () =>
      timeOfDay().hourly.map((h) => [h.hour, h.count, h.volume]),
    ),
    buildSection(AREA, "Day-of-Week Distribution (UTC)", ["Day", "Count", "Volume (USD)"], () =>
      timeOfDay().daily.map((d) => [d.label, d.count, d.volume]),
    ),

    // ── Geo / source breakdowns ───────────────────────────────────
    buildSection(
      AREA,
      "Top Countries by Bonus (top 12)",
      ["Country", "Claimants", "Total (USD)", "Avg/user (USD)", "Share %"],
      () => geo().countries.map((r) => [r.label, r.userCount, r.total, r.avgPerUser, r.share]),
    ),
    buildSection(
      AREA,
      "Top Signup Sources by Bonus (top 10)",
      ["Source", "Claimants", "Total (USD)", "Avg/user (USD)", "Share %"],
      () => geo().sources.map((r) => [r.label, r.userCount, r.total, r.avgPerUser, r.share]),
    ),

    // ── Top recipients (top 25) ───────────────────────────────────
    buildSection(
      AREA,
      "Top Bonus Recipients (top 25)",
      [
        "User ID",
        "Username",
        "Bonus (USD)",
        "Bonus count",
        "Lifetime bonus (USD)",
        "Lifetime bonus count",
        "Deposit (USD)",
        "Wager (USD)",
        "Payout (USD)",
        "P&L in window / GGR (USD)",
      ],
      () =>
        topSpenders().map((r) => [
          r.userId,
          r.username,
          r.bonusTotal,
          r.bonusCount,
          r.lifetimeBonusTotal,
          r.lifetimeBonusCount,
          r.depositTotal,
          r.wagerTotal,
          r.payoutTotal,
          r.pnlInWindow,
        ]),
    ),

    // ── Risk: surveillance lists (each top 25) ────────────────────
    buildSection(
      AREA,
      "Risk — Withdrew After Bonus, No Wager (top 25)",
      [
        "User ID",
        "Username",
        "Bonus in window (USD)",
        "Bonus count",
        "Withdraw amount (USD)",
        "Hours to withdraw",
        "Withdrew at (UTC)",
      ],
      () =>
        suspicious().withdrewAfterBonus.map((r) => [
          r.userId,
          r.username,
          r.bonusInWindow,
          r.bonusCount,
          r.withdrawAmount,
          r.hoursToWithdraw,
          r.withdrewAt,
        ]),
    ),
    buildSection(
      AREA,
      "Risk — Claimed Bonus, No Wager (top 25)",
      [
        "User ID",
        "Username",
        "Bonus in window (USD)",
        "Bonus count",
        "Has ever wagered",
        "Last bonus at (UTC)",
      ],
      () =>
        suspicious().noWager.map((r) => [
          r.userId,
          r.username,
          r.bonusInWindow,
          r.bonusCount,
          r.hasEverWagered ? "yes" : "no",
          r.lastBonusAt,
        ]),
    ),
    buildSection(
      AREA,
      "Risk — Shared Fingerprint Clusters (top 25)",
      ["Visitor ID", "User count", "Sample user IDs", "Sample usernames", "Bonus in window (USD)"],
      () =>
        suspicious().sharedFingerprint.map((r) => [
          r.visitorId,
          r.userCount,
          r.sampleUserIds.join(" | "),
          r.sampleUsernames.map((u) => u ?? "—").join(" | "),
          r.bonusInWindow,
        ]),
    ),
  ];
}
