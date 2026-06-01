import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getAffiliateOverview } from "@/lib/queries/insights-rewards/affiliate/overview";
import {
  getTopAffiliatesByCommission,
  getTopAffiliatesByWager,
} from "@/lib/queries/insights-rewards/affiliate/leaderboards";
import { getAffiliateLifetimeRoi } from "@/lib/queries/insights-rewards/affiliate/lifetime-roi";
import { getAffiliateCohort } from "@/lib/queries/insights-rewards/affiliate/cohort";
import { getAffiliateClaimCadence } from "@/lib/queries/insights-rewards/affiliate/claim-cadence";
import { getAffiliateCodePerformance } from "@/lib/queries/insights-rewards/affiliate/code-performance";
import { getAffiliateCodeSwitch } from "@/lib/queries/insights-rewards/affiliate/code-switch";
import { getAffiliateGeoBreakdown } from "@/lib/queries/insights-rewards/affiliate/geo";
import { getInactiveAffiliates } from "@/lib/queries/insights-rewards/affiliate/inactive";

/**
 * Export gatherer for /insights/rewards/affiliate.
 *
 * Bundles every tab's data for the active period into one CSV: overview
 * KPIs + daily commission/wager series, top affiliates by commission +
 * by wager, lifetime ROI, cohort quality, claim cadence, per-code
 * performance, code-switching, geo breakdowns (affiliate + referred),
 * and inactive affiliates.
 *
 * Reuses the exact same cached query helpers the page renders.
 * Commission is house cost; ROI proxy positive = house profit (emerald
 * in UI). CSV carries raw machine values. Read-only. Server-only; auth
 * is enforced by the route handler that calls this (`/insights/export`),
 * which gates on the same page-access key as the page.
 */
export async function gatherAffiliateExportSections(
  period: InsightsRewardsPeriod,
): Promise<ExportSection[]> {
  const [
    overview,
    topCommission,
    topWager,
    lifetimeRoi,
    cohort,
    cadence,
    codePerf,
    codeSwitch,
    geo,
    inactive,
  ] = await Promise.all([
    getAffiliateOverview(period),
    getTopAffiliatesByCommission(period),
    getTopAffiliatesByWager(period),
    getAffiliateLifetimeRoi(),
    getAffiliateCohort(period),
    getAffiliateClaimCadence(period),
    getAffiliateCodePerformance(period),
    getAffiliateCodeSwitch(period),
    getAffiliateGeoBreakdown(period),
    getInactiveAffiliates(period),
  ]);

  const label = insightsRewardsPeriodLabel(period);
  const sections: ExportSection[] = [];

  // ── Overview KPIs ───────────────────────────────────────────────
  sections.push({
    name: `Affiliate Overview KPIs (${label})`,
    columns: ["Metric", "Value"],
    rows: [
      ["Period", label],
      ["Active affiliates", overview.activeAffiliates],
      ["Total commission paid (USD)", overview.totalCommissionPaid],
      ["Downstream wager (USD)", overview.downstreamWager],
      ["Distinct referred users", overview.distinctReferredUsers],
      ["Claim count", overview.claimCount],
      ["Avg commission per affiliate (USD)", overview.avgCommissionPerAffiliate],
      ["ROI (wager − commission, USD)", overview.roiUsd],
      ["Commission % of wager", overview.commissionPctOfWager],
    ],
  });
  sections.push({
    name: "Affiliate Daily Commission",
    columns: ["Date", "Commission (USD)", "Count"],
    rows: overview.dailyCommission.map((d) => [d.date, d.commission, d.count]),
  });
  sections.push({
    name: "Affiliate Daily Downstream Wager",
    columns: ["Date", "Wager (USD)"],
    rows: overview.dailyWager.map((d) => [d.date, d.wager]),
  });

  // ── Leaderboards ────────────────────────────────────────────────
  sections.push({
    name: "Top Affiliates by Commission",
    columns: [
      "Affiliate user ID",
      "Username",
      "Commission paid (USD)",
      "Claim count",
      "Referred users in window",
    ],
    rows: topCommission.map((r) => [
      r.affiliateUserId,
      r.username,
      r.commissionPaid,
      r.claimCount,
      r.referredUsersInWindow,
    ]),
  });
  sections.push({
    name: "Top Affiliates by Wager",
    columns: [
      "Affiliate user ID",
      "Username",
      "Referred wager (USD)",
      "Referred count",
      "Commission paid (USD)",
    ],
    rows: topWager.map((r) => [
      r.affiliateUserId,
      r.username,
      r.referredWager,
      r.referredCount,
      r.commissionPaid,
    ]),
  });

  // ── Lifetime ROI ────────────────────────────────────────────────
  sections.push({
    name: "Affiliate Lifetime ROI",
    columns: [
      "Affiliate user ID",
      "Username",
      "Total referred",
      "Lifetime commission paid (USD)",
      "Lifetime accrued available (USD)",
      "Lifetime earned gross (USD)",
      "Lifetime downstream wager (USD)",
      "ROI proxy (USD)",
      "Commission % of wager",
    ],
    rows: lifetimeRoi.map((r) => [
      r.affiliateUserId,
      r.username,
      r.totalReferred,
      r.lifetimeCommissionPaid,
      r.lifetimeAccruedAvailable,
      r.lifetimeEarnedGross,
      r.lifetimeDownstreamWager,
      r.roiProxyUsd,
      r.commissionPctOfWager,
    ]),
  });

  // ── Cohort quality ──────────────────────────────────────────────
  sections.push({
    name: "Affiliate Cohort Quality",
    columns: [
      "Affiliate user ID",
      "Username",
      "Referred active",
      "Cohort wager (USD)",
      "Avg wager per referred (USD)",
      "Depositors",
      "Repeat depositors",
      "Deposit conversion",
      "Repeat conversion",
      "Avg first deposit (USD)",
    ],
    rows: cohort.map((r) => [
      r.affiliateUserId,
      r.username,
      r.referredActive,
      r.cohortWager,
      r.avgWagerPerReferred,
      r.depositors,
      r.repeatDepositors,
      r.depositConversion,
      r.repeatConversion,
      r.avgFirstDepositUsd,
    ]),
  });

  // ── Claim cadence ───────────────────────────────────────────────
  sections.push({
    name: "Affiliate Claim Cadence",
    columns: [
      "Affiliate user ID",
      "Username",
      "Claim count",
      "Total commission (USD)",
      "Mean claim amount (USD)",
      "Median claim amount (USD)",
      "Mean gap (hours)",
      "Median gap (hours)",
    ],
    rows: cadence.map((r) => [
      r.affiliateUserId,
      r.username,
      r.claimCount,
      r.totalCommission,
      r.meanClaimAmount,
      r.medianClaimAmount,
      r.meanGapHours,
      r.medianGapHours,
    ]),
  });

  // ── Code performance ────────────────────────────────────────────
  sections.push({
    name: "Affiliate Code Performance",
    columns: [
      "Code",
      "Affiliate user ID",
      "Affiliate username",
      "Clicks",
      "Signups",
      "Depositors",
      "Wagerers",
      "Total downstream wager (USD)",
      "Commission accrued (USD)",
      "Click→signup %",
      "Signup→deposit %",
      "Deposit→wager %",
    ],
    rows: codePerf.map((r) => [
      r.code,
      r.affiliateUserId,
      r.affiliateUsername,
      r.clicks,
      r.signups,
      r.depositors,
      r.wagerers,
      r.totalDownstreamWager,
      r.commissionAccrued,
      r.clickToSignupPct,
      r.signupToDepositPct,
      r.depositToWagerPct,
    ]),
  });

  // ── Code switching ──────────────────────────────────────────────
  sections.push({
    name: "Affiliate Code Switching",
    columns: [
      "Affiliate user ID",
      "Username",
      "Cohort size",
      "Switchers (any)",
      "Switchers (away)",
      "Switch-away share",
      "Multi-code share",
    ],
    rows: codeSwitch.map((r) => [
      r.affiliateUserId,
      r.username,
      r.cohortSize,
      r.switchersAny,
      r.switchersAway,
      r.switchAwayShare,
      r.multiCodeShare,
    ]),
  });

  // ── Geo breakdowns ──────────────────────────────────────────────
  sections.push({
    name: "Affiliate Geo (affiliates)",
    columns: ["Country", "Affiliate count", "Commission (USD)", "Share %"],
    rows: geo.affiliateGeo.map((r) => [
      r.code,
      r.affiliateCount,
      r.commission,
      r.share,
    ]),
  });
  sections.push({
    name: "Affiliate Geo (referred users)",
    columns: ["Country", "Referred user count", "Downstream wager (USD)", "Share %"],
    rows: geo.referredGeo.map((r) => [
      r.code,
      r.referredUserCount,
      r.downstreamWager,
      r.share,
    ]),
  });

  // ── Inactive affiliates ─────────────────────────────────────────
  sections.push({
    name: "Inactive Affiliates",
    columns: [
      "Affiliate user ID",
      "Username",
      "Total referred",
      "Total paid out lifetime (USD)",
      "Last claim at (UTC)",
      "Last usage at (UTC)",
      "Window downstream wager (USD)",
      "Has window usage",
    ],
    rows: inactive.map((r) => [
      r.affiliateUserId,
      r.username,
      r.totalReferred,
      r.totalPaidOutLifetime,
      r.lastClaimAt,
      r.lastUsageAt,
      r.windowDownstreamWager,
      r.hasWindowUsage ? "yes" : "no",
    ]),
  });

  return sections;
}
