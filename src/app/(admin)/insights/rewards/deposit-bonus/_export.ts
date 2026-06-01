"use server";

import { requirePageAccess } from "@/lib/dal";
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

/**
 * Server export action for /insights/rewards/deposit-bonus.
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
 * export reconciles with the UI by construction. Read-only. Gated by
 * the same page-access check as the page.
 *
 * The "top N" lists are bounded inside their query helpers (top 10 / 25)
 * — same data the tab shows. Section names note the bound where it
 * applies.
 */
export async function exportDepositBonusData(
  period: InsightsRewardsPeriod,
): Promise<ExportSection[]> {
  await requirePageAccess("/insights/rewards/deposit-bonus");

  const [
    overview,
    cap,
    daily,
    cohort,
    repeat,
    newVsReturning,
    timeToClaim,
    timeOfDay,
    roi,
    geo,
    topSpenders,
    suspicious,
  ] = await Promise.all([
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

  const periodLabel = insightsRewardsPeriodLabel(period);
  const sections: ExportSection[] = [];

  // ── KPI rollup ──────────────────────────────────────────────────
  const prior = overview.priorWindow;
  sections.push({
    name: `Deposit Bonus KPIs (${periodLabel})`,
    columns: ["Metric", "Value"],
    rows: [
      ["Period", periodLabel],
      ["Total cost (USD)", overview.totalCost],
      ["Bonuses awarded", overview.count],
      ["Unique claimants", overview.uniqueClaimants],
      ["Avg bonus (USD)", overview.avg],
      ["Median bonus (USD)", overview.median],
      ["Max bonus / empirical cap (USD)", overview.max],
      ["Cap hit rate", cap.capHitRate],
      ["Cap hits", cap.capHits],
      ["Unique cap hitters", cap.uniqueCapHitters],
      [
        "Avg per claimant (USD)",
        overview.uniqueClaimants > 0
          ? overview.totalCost / overview.uniqueClaimants
          : 0,
      ],
      ["Prior cost (USD)", prior?.totalCost ?? null],
      ["Prior count", prior?.count ?? null],
      ["Prior claimants", prior?.uniqueClaimants ?? null],
      ["Cost delta vs prior", prior?.costDelta ?? null],
      ["Count delta vs prior", prior?.countDelta ?? null],
      ["Claimant delta vs prior", prior?.claimantDelta ?? null],
      ["ROI cost (USD)", roi.cost],
      ["ROI subsequent GGR (USD)", roi.subsequentGgr],
      ["ROI subsequent wager (USD)", roi.wager],
      ["ROI subsequent payouts (USD)", roi.payouts],
      ["Blended ROI (GGR / cost)", roi.blendedRoi],
      ["ROI avg GGR per claimant (USD)", roi.avgGgrPerClaimant],
      ["ROI lookback (days)", roi.effectiveLookbackDays],
    ],
  });

  // ── Daily time-series (overview chart) ──────────────────────────
  sections.push({
    name: "Daily Bonus Volume",
    columns: ["Date", "Volume (USD)", "Count", "Claimants"],
    rows: overview.dailyVolume.map((d) => [
      d.date,
      d.volume,
      d.count,
      d.claimants,
    ]),
  });

  // ── Daily breakdown table ───────────────────────────────────────
  sections.push({
    name: "Daily Breakdown",
    columns: [
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
    rows: daily.map((r) => [
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
  });

  // ── Cap: amount distribution histogram ──────────────────────────
  sections.push({
    name: "Cap — Amount Distribution",
    columns: ["Bucket", "Min (USD)", "Max (USD)", "Count", "Volume (USD)"],
    rows: cap.amountDistribution.map((b) => [
      b.label,
      b.min,
      b.max,
      b.count,
      b.volume,
    ]),
  });

  // ── Cap: per-day cap hit rate ───────────────────────────────────
  sections.push({
    name: "Cap — Daily Hit Rate",
    columns: ["Date", "Bonuses", "Cap hits", "Rate"],
    rows: cap.dailyCapHitRate.map((r) => [
      r.date,
      r.bonuses,
      r.capHits,
      r.rate,
    ]),
  });

  // ── Cap: top cap hitters (top 10) ───────────────────────────────
  sections.push({
    name: "Cap — Top Cap Hitters (top 10)",
    columns: [
      "User ID",
      "Username",
      "Cap hits",
      "Total bonus (USD)",
      "Last hit (UTC)",
    ],
    rows: cap.topCapHitters.map((r) => [
      r.userId,
      r.username,
      r.capHits,
      r.totalBonus,
      r.lastHitAt,
    ]),
  });

  // ── Cap: biggest cap-paired deposits (top 10) ───────────────────
  sections.push({
    name: "Cap — Biggest Cap Deposits (top 10)",
    columns: [
      "User ID",
      "Username",
      "Deposit (USD)",
      "Bonus (USD)",
      "Created (UTC)",
    ],
    rows: cap.biggestCapDeposits.map((r) => [
      r.userId,
      r.username,
      r.depositUsd,
      r.bonusUsd,
      r.createdAt,
    ]),
  });

  // ── Cohort comparison (with vs without bonus) ───────────────────
  sections.push({
    name: "Cohort Comparison (deposits with vs without bonus)",
    columns: [
      "Metric",
      "With bonus",
      "Without bonus",
    ],
    rows: [
      ["Deposits", cohort.withBonus.count, cohort.withoutBonus.count],
      ["Sum (USD)", cohort.withBonus.sum, cohort.withoutBonus.sum],
      ["Avg (USD)", cohort.withBonus.avg, cohort.withoutBonus.avg],
      ["Median (USD)", cohort.withBonus.median, cohort.withoutBonus.median],
      ["P99 (USD)", cohort.withBonus.p99, cohort.withoutBonus.p99],
      ["Unique users", cohort.withBonus.uniqueUsers, cohort.withoutBonus.uniqueUsers],
      ["Retain 7d", cohort.withBonus.retain7d, cohort.withoutBonus.retain7d],
      ["Retain 30d", cohort.withBonus.retain30d, cohort.withoutBonus.retain30d],
    ],
  });
  sections.push({
    name: "Cohort Lift & Ratio Summary",
    columns: ["Metric", "Value"],
    rows: [
      ["Total deposits", cohort.totalDeposits],
      ["Avg-deposit lift %", cohort.avgLiftPct],
      ["Median-deposit lift %", cohort.medianLiftPct],
      ["Retain 7d lift %", cohort.retain7dLiftPct],
      ["Retain 30d lift %", cohort.retain30dLiftPct],
      ["Mean bonus/deposit ratio", cohort.meanRatio],
      ["Median bonus/deposit ratio", cohort.medianRatio],
    ],
  });
  sections.push({
    name: "Bonus/Deposit Ratio Histogram",
    columns: ["Bucket", "Count", "Volume (USD)"],
    rows: cohort.ratioBuckets.map((b) => [b.label, b.count, b.volume]),
  });

  // ── Repeat-claimant segments ────────────────────────────────────
  sections.push({
    name: "Repeat Claimant Segments",
    columns: [
      "Segment",
      "Users",
      "Total bonus (USD)",
      "Avg bonus/user (USD)",
      "Wager in window (USD)",
    ],
    rows: repeat.segments.map((s) => [
      s.label,
      s.users,
      s.totalBonus,
      s.avgBonusPerUser,
      s.wagerInWindow,
    ]),
  });

  // ── New vs returning claimants ──────────────────────────────────
  sections.push({
    name: "New vs Returning Claimants",
    columns: ["Metric", "New", "Returning"],
    rows: [
      ["Users", newVsReturning.newClaimants.users, newVsReturning.returningClaimants.users],
      ["Total bonus (USD)", newVsReturning.newClaimants.totalBonus, newVsReturning.returningClaimants.totalBonus],
      ["Avg bonus/user (USD)", newVsReturning.newClaimants.avgBonusPerUser, newVsReturning.returningClaimants.avgBonusPerUser],
      ["Avg first deposit (USD)", newVsReturning.newClaimants.avgFirstDepositUsd, newVsReturning.returningClaimants.avgFirstDepositUsd],
      ["Retain 7d", newVsReturning.newClaimants.retain7d, newVsReturning.returningClaimants.retain7d],
      ["2nd deposit 30d rate", newVsReturning.newClaimants.secondDeposit30dRate, newVsReturning.returningClaimants.secondDeposit30dRate],
    ],
  });

  // ── Time-to-claim distribution ──────────────────────────────────
  sections.push({
    name: "Time-to-Claim Distribution",
    columns: ["Bucket", "Count"],
    rows: timeToClaim.buckets.map((b) => [b.label, b.count]),
  });
  sections.push({
    name: "Time-to-Claim Summary",
    columns: ["Metric", "Seconds"],
    rows: [
      ["Total paired", timeToClaim.totalPaired],
      ["Median", timeToClaim.medianSeconds],
      ["Mean", timeToClaim.meanSeconds],
      ["P95", timeToClaim.p95Seconds],
      ["P99", timeToClaim.p99Seconds],
      ["Max", timeToClaim.maxSeconds],
    ],
  });

  // ── Time-of-day distributions ───────────────────────────────────
  sections.push({
    name: "Hour-of-Day Distribution (UTC)",
    columns: ["Hour", "Count", "Volume (USD)"],
    rows: timeOfDay.hourly.map((h) => [h.hour, h.count, h.volume]),
  });
  sections.push({
    name: "Day-of-Week Distribution (UTC)",
    columns: ["Day", "Count", "Volume (USD)"],
    rows: timeOfDay.daily.map((d) => [d.label, d.count, d.volume]),
  });

  // ── Geo / source breakdowns ─────────────────────────────────────
  sections.push({
    name: "Top Countries by Bonus (top 12)",
    columns: ["Country", "Claimants", "Total (USD)", "Avg/user (USD)", "Share %"],
    rows: geo.countries.map((r) => [
      r.label,
      r.userCount,
      r.total,
      r.avgPerUser,
      r.share,
    ]),
  });
  sections.push({
    name: "Top Signup Sources by Bonus (top 10)",
    columns: ["Source", "Claimants", "Total (USD)", "Avg/user (USD)", "Share %"],
    rows: geo.sources.map((r) => [
      r.label,
      r.userCount,
      r.total,
      r.avgPerUser,
      r.share,
    ]),
  });

  // ── Top recipients (top 25) ─────────────────────────────────────
  sections.push({
    name: "Top Bonus Recipients (top 25)",
    columns: [
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
    rows: topSpenders.map((r) => [
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
  });

  // ── Risk: surveillance lists (each top 25) ──────────────────────
  sections.push({
    name: "Risk — Withdrew After Bonus, No Wager (top 25)",
    columns: [
      "User ID",
      "Username",
      "Bonus in window (USD)",
      "Bonus count",
      "Withdraw amount (USD)",
      "Hours to withdraw",
      "Withdrew at (UTC)",
    ],
    rows: suspicious.withdrewAfterBonus.map((r) => [
      r.userId,
      r.username,
      r.bonusInWindow,
      r.bonusCount,
      r.withdrawAmount,
      r.hoursToWithdraw,
      r.withdrewAt,
    ]),
  });
  sections.push({
    name: "Risk — Claimed Bonus, No Wager (top 25)",
    columns: [
      "User ID",
      "Username",
      "Bonus in window (USD)",
      "Bonus count",
      "Has ever wagered",
      "Last bonus at (UTC)",
    ],
    rows: suspicious.noWager.map((r) => [
      r.userId,
      r.username,
      r.bonusInWindow,
      r.bonusCount,
      r.hasEverWagered ? "yes" : "no",
      r.lastBonusAt,
    ]),
  });
  sections.push({
    name: "Risk — Shared Fingerprint Clusters (top 25)",
    columns: [
      "Visitor ID",
      "User count",
      "Sample user IDs",
      "Sample usernames",
      "Bonus in window (USD)",
    ],
    rows: suspicious.sharedFingerprint.map((r) => [
      r.visitorId,
      r.userCount,
      r.sampleUserIds.join(" | "),
      r.sampleUsernames.map((u) => u ?? "—").join(" | "),
      r.bonusInWindow,
    ]),
  });

  return sections;
}
