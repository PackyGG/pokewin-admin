"use server";

import { requirePageAccess } from "@/lib/dal";
import type { ExportSection } from "@/lib/utils/export-csv";
import {
  INSIGHTS_PERIOD_LABELS,
  type InsightsPeriod,
} from "./types";
import { getInsightsOverview } from "@/lib/queries/insights-analytics/overview";
import {
  getInsightsCohorts,
  parseCohortsGranularity,
} from "@/lib/queries/insights-analytics/cohorts";
import {
  getInsightsRetention,
  parseRetentionBreakdown,
} from "@/lib/queries/insights-analytics/retention";
import {
  getInsightsLtv,
  parseLtvSegment,
} from "@/lib/queries/insights-analytics/ltv";
import {
  getInsightsFunnel,
  parseFunnelBreakdown,
} from "@/lib/queries/insights-analytics/funnel";
import {
  getInsightsHeatmap,
} from "@/lib/queries/insights-analytics/heatmap";
import {
  getInsightsWhales,
  parseWhalesLens,
} from "@/lib/queries/insights-analytics/whales";
import {
  getInsightsGeo,
  parseGeoGroupBy,
} from "@/lib/queries/insights-analytics/geo";
import {
  getSourcesBuckets,
  getSourcesCodes,
} from "@/lib/queries/insights-analytics/sources";
import { getMoneyFlowDecomposition } from "@/lib/queries/insights-analytics/money-flow";

/**
 * Sub-params carried through from the page so the export matches what
 * the admin currently has selected on each tab.
 */
export type AnalyticsExportParams = {
  cohortsBy?: string;
  retentionBy?: string;
  ltvBy?: string;
  funnelBy?: string;
  whalesBy?: string;
  geoBy?: string;
};

/**
 * Server export action for /insights/analytics.
 *
 * Gathers EVERY tab's primary dataset for the active period (and the
 * tab's current sub-lens, where one applies) into a single CSV:
 * Overview KPIs (current + previous + daily series), signup cohorts
 * (retention / wager / GGR / deposit trajectories), retention curves,
 * LTV segments + top users, funnel steps, hour-of-week heatmap cells +
 * totals, whales (current lens), geo breakdown, signup-source buckets +
 * codes, and the Money Flow GGR→P&L decomposition + its time-series.
 *
 * Reuses the exact same cached query helpers each tab renders, so the
 * export reconciles with the UI. Cohorts / retention / LTV / whales /
 * geo are global (period-independent inside their helpers); they are
 * still included so the export is a complete snapshot of the page.
 * Read-only. Gated by the same page-access check as the page.
 */
export async function exportAnalyticsData(
  period: InsightsPeriod,
  params: AnalyticsExportParams,
): Promise<ExportSection[]> {
  await requirePageAccess("/insights/analytics");

  const periodLabel = INSIGHTS_PERIOD_LABELS[period];
  const cohortsGranularity = parseCohortsGranularity(params.cohortsBy);
  const retentionBy = parseRetentionBreakdown(params.retentionBy);
  const ltvBy = parseLtvSegment(params.ltvBy);
  const funnelBy = parseFunnelBreakdown(params.funnelBy);
  const whalesLens = parseWhalesLens(params.whalesBy);
  const geoBy = parseGeoGroupBy(params.geoBy);

  const [
    overview,
    cohorts,
    retention,
    ltv,
    funnel,
    heatmap,
    whales,
    geo,
    sourcesBuckets,
    sourcesCodes,
    moneyFlow,
  ] = await Promise.all([
    getInsightsOverview(period),
    getInsightsCohorts(cohortsGranularity),
    getInsightsRetention(retentionBy),
    getInsightsLtv(ltvBy),
    getInsightsFunnel(period, funnelBy),
    getInsightsHeatmap(period),
    getInsightsWhales(whalesLens),
    getInsightsGeo(period, geoBy),
    getSourcesBuckets(period),
    getSourcesCodes(period),
    getMoneyFlowDecomposition(period, periodLabel),
  ]);

  const sections: ExportSection[] = [];

  // ── Overview KPIs (current + previous) ──────────────────────────
  const cur = overview.current;
  const prev = overview.previous;
  sections.push({
    name: `Analytics Overview KPIs (${periodLabel})`,
    columns: ["Metric", "Current", "Previous"],
    rows: [
      ["Deposits (USD)", cur.deposits, prev?.deposits ?? null],
      ["Deposit count", cur.depositCount, prev?.depositCount ?? null],
      ["Withdrawals (USD)", cur.withdrawals, prev?.withdrawals ?? null],
      ["Wager (USD)", cur.wager, prev?.wager ?? null],
      ["GGR (USD)", cur.ggr, prev?.ggr ?? null],
      ["NGR (USD)", cur.ngr, prev?.ngr ?? null],
      ["New signups", cur.newSignups, prev?.newSignups ?? null],
      ["Unique active", cur.uniqueActive, prev?.uniqueActive ?? null],
    ],
  });
  sections.push({
    name: "Overview Daily Series",
    columns: [
      "Date",
      "Deposits (USD)",
      "Withdrawals (USD)",
      "Wager (USD)",
      "GGR (USD)",
      "NGR (USD)",
      "Signups",
      "Active",
    ],
    rows: overview.daily.map((d) => [
      d.date,
      d.deposits,
      d.withdrawals,
      d.wager,
      d.ggr,
      d.ngr,
      d.signups,
      d.active,
    ]),
  });

  // ── Cohorts (one row per cohort × period offset) ────────────────
  const cohortRows: (string | number)[][] = [];
  for (const b of cohorts.buckets) {
    for (let i = 0; i < cohorts.maxPeriods; i++) {
      cohortRows.push([
        b.label,
        b.size,
        i,
        b.retained[i] ?? 0,
        b.wager[i] ?? 0,
        b.ggr[i] ?? 0,
        b.deposits[i] ?? 0,
      ]);
    }
  }
  sections.push({
    name: `Signup Cohorts (${cohorts.granularity})`,
    columns: [
      "Cohort",
      "Cohort size",
      "Period offset",
      "Retained",
      "Wager (USD)",
      "GGR (USD)",
      "Deposits (USD)",
    ],
    rows: cohortRows,
  });

  // ── Retention curves (one row per series × day) ─────────────────
  const retentionRows: (string | number)[][] = [];
  for (const s of retention.series) {
    for (const pt of s.curve) {
      retentionRows.push([s.label, s.cohort, pt.day, pt.retained, pt.pct]);
    }
  }
  sections.push({
    name: `Retention Curves (by ${retention.breakdownBy})`,
    columns: ["Series", "Cohort size", "Day", "Retained", "Retention %"],
    rows: retentionRows,
  });

  // ── LTV segments + top users ────────────────────────────────────
  sections.push({
    name: `LTV Segments (by ${ltv.segmentBy})`,
    columns: [
      "Segment",
      "Users",
      "Deposits (USD)",
      "Withdrawals (USD)",
      "Wager (USD)",
      "GGR contribution (USD)",
      "Bonus drag (USD)",
      "Net P&L (USD)",
      "Avg LTV (USD)",
      "Median LTV (USD)",
    ],
    rows: ltv.segments.map((s) => [
      s.label,
      s.users,
      s.deposits,
      s.withdrawals,
      s.wager,
      s.ggrContribution,
      s.bonusDrag,
      s.netPnl,
      s.avgLtv,
      s.medianLtv,
    ]),
  });
  sections.push({
    name: "LTV Top Users",
    columns: ["User ID", "Username", "GGR (USD)", "Deposits (USD)", "Net P&L (USD)"],
    rows: ltv.topUsers.map((u) => [
      u.userId,
      u.username,
      u.ggr,
      u.deposits,
      u.netPnl,
    ]),
  });

  // ── Funnel steps (one row per bucket × step) ────────────────────
  const funnelRows: (string | number | null)[][] = [];
  for (const bucket of funnel.buckets) {
    for (const step of bucket.steps) {
      funnelRows.push([
        bucket.label,
        step.label,
        step.count,
        step.dropoffFromPrev,
        step.conversionFromTop,
      ]);
    }
  }
  sections.push({
    name: `Funnel (by ${funnel.breakdownBy})`,
    columns: [
      "Bucket",
      "Step",
      "Count",
      "Dropoff from prev",
      "Conversion from top",
    ],
    rows: funnelRows,
  });

  // ── Heatmap cells + totals ──────────────────────────────────────
  sections.push({
    name: "Hour-of-Week Heatmap",
    columns: [
      "Day of week (0=Sun)",
      "Hour",
      "Signups",
      "Deposits (USD)",
      "Withdrawals (USD)",
      "Wager (USD)",
      "P&L (USD)",
      "Active",
    ],
    rows: heatmap.cells.map((c) => [
      c.dayOfWeek,
      c.hour,
      c.signups,
      c.deposits,
      c.withdrawals,
      c.wager,
      c.pnl,
      c.active,
    ]),
  });
  sections.push({
    name: "Heatmap Totals",
    columns: ["Metric", "Total"],
    rows: [
      ["Signups", heatmap.totals.signups],
      ["Deposits (USD)", heatmap.totals.deposits],
      ["Withdrawals (USD)", heatmap.totals.withdrawals],
      ["Wager (USD)", heatmap.totals.wager],
      ["P&L (USD)", heatmap.totals.pnl],
      ["Active", heatmap.totals.active],
    ],
  });

  // ── Whales (current lens) ───────────────────────────────────────
  sections.push({
    name: `Whales — ${whalesLens} (top 25)`,
    columns: ["User ID", "Username", "Amount (USD)", "Detail"],
    rows: whales.map((w) => [w.userId, w.username, w.amount, w.detail]),
  });

  // ── Geo breakdown ───────────────────────────────────────────────
  sections.push({
    name: `Geo (by ${geo.groupBy})`,
    columns: [
      "Key",
      "Label",
      "Country code",
      "Users",
      "Signups",
      "Deposits (USD)",
      "Withdrawals (USD)",
      "Wager (USD)",
      "GGR (USD)",
    ],
    rows: geo.rows.map((r) => [
      r.key,
      r.label,
      r.countryCode,
      r.users,
      r.signups,
      r.deposits,
      r.withdrawals,
      r.wager,
      r.ggr,
    ]),
  });

  // ── Sources: buckets + codes ────────────────────────────────────
  sections.push({
    name: "Signup Source Buckets",
    columns: [
      "Key",
      "Label",
      "Signups",
      "First deposit",
      "First wager",
      "MAW",
      "GGR driven (USD)",
      "Deposits driven (USD)",
      "Wager driven (USD)",
      "Avg GGR (USD)",
    ],
    rows: sourcesBuckets.map((r) => [
      r.key,
      r.label,
      r.signups,
      r.firstDeposit,
      r.firstWager,
      r.maw,
      r.ggrDriven,
      r.depositsDriven,
      r.wagerDriven,
      r.avgGgr,
    ]),
  });
  sections.push({
    name: "Signup Source Codes",
    columns: [
      "Code",
      "Affiliate user ID",
      "Signups",
      "First deposit",
      "GGR driven (USD)",
      "Wager driven (USD)",
    ],
    rows: sourcesCodes.map((r) => [
      r.code,
      r.affiliateUserId,
      r.signups,
      r.firstDeposit,
      r.ggrDriven,
      r.wagerDriven,
    ]),
  });

  // ── Money Flow decomposition + time-series ──────────────────────
  sections.push({
    name: `Money Flow — GGR to P&L (${moneyFlow.periodLabel})`,
    columns: ["Metric", "Value"],
    rows: [
      ["GGR (USD)", moneyFlow.ggr],
      ["Wagers (USD)", moneyFlow.wagers],
      ["Payouts (USD)", moneyFlow.payouts],
      ["Bonuses total (USD)", moneyFlow.bonusesTotal],
      ["Deposits (USD)", moneyFlow.deposits],
      ["Manual withdrawals (USD)", moneyFlow.manualWithdrawals],
      ["Card withdrawals (USD)", moneyFlow.cardWithdrawals],
      ["Inventory delta (USD)", moneyFlow.inventoryDelta],
      ["Voucher delta (USD)", moneyFlow.voucherDelta],
      ["P&L (USD)", moneyFlow.pnl],
      ["Residual (USD)", moneyFlow.residual],
    ],
  });
  sections.push({
    name: "Money Flow — Bonuses by Type",
    columns: ["Type", "Total (USD)"],
    rows: moneyFlow.bonusesByType.map((b) => [b.type, b.total]),
  });
  sections.push({
    name: "Money Flow — Daily Series",
    columns: ["Date", "GGR (USD)", "Bonuses (USD)", "P&L (USD)"],
    rows: moneyFlow.timeSeries.map((p) => [p.date, p.ggr, p.bonuses, p.pnl]),
  });

  return sections;
}
