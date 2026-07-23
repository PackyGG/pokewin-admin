import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getAffiliateOverview } from "@/lib/queries/insights-rewards/affiliate/overview";
import { getTopAffiliatesByWager } from "@/lib/queries/insights-rewards/affiliate/leaderboards";
import { getAffiliateLifetimeRoi } from "@/lib/queries/insights-rewards/affiliate/lifetime-roi";
import { getAffiliateCohort } from "@/lib/queries/insights-rewards/affiliate/cohort";
import { getAffiliateClaimCadence } from "@/lib/queries/insights-rewards/affiliate/claim-cadence";
import { getAffiliateCodePerformance } from "@/lib/queries/insights-rewards/affiliate/code-performance";
import { getAffiliateCodeSwitch } from "@/lib/queries/insights-rewards/affiliate/code-switch";
import { getAffiliateGeoBreakdown } from "@/lib/queries/insights-rewards/affiliate/geo";
import { getInactiveAffiliates } from "@/lib/queries/insights-rewards/affiliate/inactive";
import { getAffiliateTierDistribution } from "@/lib/queries/insights-rewards/affiliate/tier-distribution";
import { settle, unwrap, buildSection } from "../_export-section";

const AREA = "insights.export.affiliate";

/**
 * Export gatherer for /insights/rewards/affiliate.
 *
 * Bundles every tab's data for the active period into one CSV: overview
 * KPIs + daily commission/wager series, top affiliates by wager, tier
 * distribution, lifetime ROI, cohort quality, claim cadence, per-code
 * performance, code-switching, geo breakdowns (affiliate + referred),
 * and inactive affiliates.
 *
 * Reuses the exact same cached query helpers the page renders.
 * Commission is house cost; ROI proxy positive = house profit (emerald
 * in UI). CSV carries raw machine values. Read-only. Server-only; auth
 * is enforced by the route handler that calls this (`/insights/export`),
 * which gates on the same page-access key as the page.
 *
 * Each query is settled independently and each section is built in
 * isolation (see `../../_export-section`), so one failing sub-query
 * blanks only its own section(s) instead of crashing the whole export
 * (which would yield a BOM-only "empty CSV" download).
 */
export async function gatherAffiliateExportSections(
  period: InsightsRewardsPeriod,
): Promise<ExportSection[]> {
  const [
    overviewR,
    topWagerR,
    tierDistributionR,
    lifetimeRoiR,
    cohortR,
    cadenceR,
    codePerfR,
    codeSwitchR,
    geoR,
    inactiveR,
  ] = await settle([
    getAffiliateOverview(period),
    getTopAffiliatesByWager(period),
    getAffiliateTierDistribution(),
    getAffiliateLifetimeRoi(),
    getAffiliateCohort(period),
    getAffiliateClaimCadence(period),
    getAffiliateCodePerformance(period),
    getAffiliateCodeSwitch(period),
    getAffiliateGeoBreakdown(period),
    getInactiveAffiliates(period),
  ]);
  const overview = () => unwrap(overviewR);
  const topWager = () => unwrap(topWagerR);
  const tierDistribution = () => unwrap(tierDistributionR);
  const lifetimeRoi = () => unwrap(lifetimeRoiR);
  const cohort = () => unwrap(cohortR);
  const cadence = () => unwrap(cadenceR);
  const codePerf = () => unwrap(codePerfR);
  const codeSwitch = () => unwrap(codeSwitchR);
  const geo = () => unwrap(geoR);
  const inactive = () => unwrap(inactiveR);

  const label = insightsRewardsPeriodLabel(period);

  return [
    // ── Overview KPIs ─────────────────────────────────────────────
    buildSection(AREA, `Affiliate Overview KPIs (${label})`, ["Metric", "Value"], () => {
      const o = overview();
      return [
        ["Period", label],
        ["Active affiliates", o.activeAffiliates],
        ["Total commission paid (USD)", o.totalCommissionPaid],
        ["Leaderboard prizes paid (USD)", o.leaderboardPrizePaid],
        ["Leaderboard prize count", o.leaderboardPrizeCount],
        ["Total affiliate reward cost (USD)", o.totalAffiliateRewardCost],
        ["Downstream wager (USD)", o.downstreamWager],
        ["Distinct referred users", o.distinctReferredUsers],
        ["Claim count", o.claimCount],
        ["Avg commission per affiliate (USD)", o.avgCommissionPerAffiliate],
        ["ROI (wager − commission, USD)", o.roiUsd],
        ["Commission % of wager", o.commissionPctOfWager],
      ];
    }),
    buildSection(AREA, "Affiliate Daily Commission", ["Date", "Commission (USD)", "Count"], () =>
      overview().dailyCommission.map((d) => [d.date, d.commission, d.count]),
    ),
    buildSection(AREA, "Affiliate Daily Downstream Wager", ["Date", "Wager (USD)"], () =>
      overview().dailyWager.map((d) => [d.date, d.wager]),
    ),

    // ── Leaderboards ──────────────────────────────────────────────
    buildSection(
      AREA,
      "Top Affiliates by Wager",
      [
        "Affiliate user ID",
        "Username",
        "Referred wager (USD)",
        "Referred count",
        "Commission paid (USD)",
      ],
      () =>
        topWager().map((r) => [
          r.affiliateUserId,
          r.username,
          r.referredWager,
          r.referredCount,
          r.commissionPaid,
        ]),
    ),

    // ── Tier distribution ─────────────────────────────────────────
    // Period-agnostic (lifetime): tier is computed from each affiliate's
    // lifetime referred wager vs the affiliate_level_configs threshold
    // ladder (no stored level column exists in prod). Commission paid is
    // house cost; referred wager is house-positive.
    buildSection(
      AREA,
      "Affiliate Tier Distribution (lifetime)",
      [
        "Level",
        "Label",
        "Commission rate",
        "Wager threshold (USD)",
        "Affiliate count",
        "% of all affiliates",
        "Total referred wager (USD)",
        "Total commission paid (USD)",
      ],
      () =>
        tierDistribution().rows.map((r) => [
          r.level,
          r.label,
          r.commissionRate,
          r.threshold,
          r.affiliateCount,
          r.sharePct,
          r.totalReferredWager,
          r.totalCommissionPaid,
        ]),
    ),

    // ── Lifetime ROI ──────────────────────────────────────────────
    buildSection(
      AREA,
      "Affiliate Lifetime ROI",
      [
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
      () =>
        lifetimeRoi().map((r) => [
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
    ),

    // ── Cohort quality ────────────────────────────────────────────
    buildSection(
      AREA,
      "Affiliate Cohort Quality",
      [
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
      () =>
        cohort().map((r) => [
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
    ),

    // ── Claim cadence ─────────────────────────────────────────────
    buildSection(
      AREA,
      "Affiliate Claim Cadence",
      [
        "Affiliate user ID",
        "Username",
        "Claim count",
        "Total commission (USD)",
        "Mean claim amount (USD)",
        "Median claim amount (USD)",
        "Mean gap (hours)",
        "Median gap (hours)",
      ],
      () =>
        cadence().map((r) => [
          r.affiliateUserId,
          r.username,
          r.claimCount,
          r.totalCommission,
          r.meanClaimAmount,
          r.medianClaimAmount,
          r.meanGapHours,
          r.medianGapHours,
        ]),
    ),

    // ── Code performance ──────────────────────────────────────────
    buildSection(
      AREA,
      "Affiliate Code Performance",
      [
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
      () =>
        codePerf().map((r) => [
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
    ),

    // ── Code switching ────────────────────────────────────────────
    buildSection(
      AREA,
      "Affiliate Code Switching",
      [
        "Affiliate user ID",
        "Username",
        "Cohort size",
        "Switchers (any)",
        "Switchers (away)",
        "Switch-away share",
        "Multi-code share",
      ],
      () =>
        codeSwitch().map((r) => [
          r.affiliateUserId,
          r.username,
          r.cohortSize,
          r.switchersAny,
          r.switchersAway,
          r.switchAwayShare,
          r.multiCodeShare,
        ]),
    ),

    // ── Geo breakdowns ────────────────────────────────────────────
    buildSection(
      AREA,
      "Affiliate Geo (affiliates)",
      ["Country", "Affiliate count", "Commission (USD)", "Share %"],
      () => geo().affiliateGeo.map((r) => [r.code, r.affiliateCount, r.commission, r.share]),
    ),
    buildSection(
      AREA,
      "Affiliate Geo (referred users)",
      ["Country", "Referred user count", "Downstream wager (USD)", "Share %"],
      () =>
        geo().referredGeo.map((r) => [
          r.code,
          r.referredUserCount,
          r.downstreamWager,
          r.share,
        ]),
    ),

    // ── Inactive affiliates ───────────────────────────────────────
    buildSection(
      AREA,
      "Inactive Affiliates",
      [
        "Affiliate user ID",
        "Username",
        "Total referred",
        "Total paid out lifetime (USD)",
        "Last claim at (UTC)",
        "Last usage at (UTC)",
        "Window downstream wager (USD)",
        "Has window usage",
      ],
      () =>
        inactive().map((r) => [
          r.affiliateUserId,
          r.username,
          r.totalReferred,
          r.totalPaidOutLifetime,
          r.lastClaimAt,
          r.lastUsageAt,
          r.windowDownstreamWager,
          r.hasWindowUsage ? "yes" : "no",
        ]),
    ),
  ];
}
