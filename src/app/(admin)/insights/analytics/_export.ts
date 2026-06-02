import "server-only";

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
import { settle, unwrap, buildSection } from "../_export-section";

const AREA = "insights.export.analytics";

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
 * Export gatherer for /insights/analytics.
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
 * Read-only. Server-only; auth is enforced by the route handler that
 * calls this (`/insights/export`), which gates on the same page-access
 * key as the page.
 */
export async function gatherAnalyticsExportSections(
  period: InsightsPeriod,
  params: AnalyticsExportParams,
): Promise<ExportSection[]> {
  const periodLabel = INSIGHTS_PERIOD_LABELS[period];
  const cohortsGranularity = parseCohortsGranularity(params.cohortsBy);
  const retentionBy = parseRetentionBreakdown(params.retentionBy);
  const ltvBy = parseLtvSegment(params.ltvBy);
  const funnelBy = parseFunnelBreakdown(params.funnelBy);
  const whalesLens = parseWhalesLens(params.whalesBy);
  const geoBy = parseGeoGroupBy(params.geoBy);

  // Settle (not await-throw) so one failed query degrades only its own
  // section(s) instead of crashing the gatherer → BOM-only download.
  const [
    overviewR,
    cohortsR,
    retentionR,
    ltvR,
    funnelR,
    heatmapR,
    whalesR,
    geoR,
    sourcesBucketsR,
    sourcesCodesR,
    moneyFlowR,
  ] = await settle([
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
  const overview = () => unwrap(overviewR);
  const cohorts = () => unwrap(cohortsR);
  const retention = () => unwrap(retentionR);
  const ltv = () => unwrap(ltvR);
  const funnel = () => unwrap(funnelR);
  const heatmap = () => unwrap(heatmapR);
  const whales = () => unwrap(whalesR);
  const geo = () => unwrap(geoR);
  const sourcesBuckets = () => unwrap(sourcesBucketsR);
  const sourcesCodes = () => unwrap(sourcesCodesR);
  const moneyFlow = () => unwrap(moneyFlowR);

  // Section names that embed a sub-lens read off a (possibly-failed)
  // query value; fall back to the parsed param when unavailable so the
  // header is still meaningful.
  const cohortsName = `Signup Cohorts (${
    cohortsR.status === "fulfilled" ? cohortsR.value.granularity : cohortsGranularity
  })`;
  const retentionName = `Retention Curves (by ${
    retentionR.status === "fulfilled" ? retentionR.value.breakdownBy : retentionBy
  })`;
  const ltvName = `LTV Segments (by ${
    ltvR.status === "fulfilled" ? ltvR.value.segmentBy : ltvBy
  })`;
  const funnelName = `Funnel (by ${
    funnelR.status === "fulfilled" ? funnelR.value.breakdownBy : funnelBy
  })`;
  const geoName = `Geo (by ${geoR.status === "fulfilled" ? geoR.value.groupBy : geoBy})`;
  const moneyFlowName = `Money Flow — GGR to P&L (${
    moneyFlowR.status === "fulfilled" ? moneyFlowR.value.periodLabel : periodLabel
  })`;

  return [
    // ── Overview KPIs (current + previous) ────────────────────────
    buildSection(
      AREA,
      `Analytics Overview KPIs (${periodLabel})`,
      ["Metric", "Current", "Previous"],
      () => {
        const cur = overview().current;
        const prev = overview().previous;
        return [
          ["Deposits (USD)", cur.deposits, prev?.deposits ?? null],
          ["Deposit count", cur.depositCount, prev?.depositCount ?? null],
          ["Withdrawals (USD)", cur.withdrawals, prev?.withdrawals ?? null],
          ["Wager (USD)", cur.wager, prev?.wager ?? null],
          ["Organic wager (USD)", cur.wagerOrganic, prev?.wagerOrganic ?? null],
          [
            "Creator-coded wager (USD)",
            cur.wagerCreatorCoded,
            prev?.wagerCreatorCoded ?? null,
          ],
          ["GGR (USD)", cur.ggr, prev?.ggr ?? null],
          ["NGR (USD)", cur.ngr, prev?.ngr ?? null],
          ["New signups", cur.newSignups, prev?.newSignups ?? null],
          ["Unique active", cur.uniqueActive, prev?.uniqueActive ?? null],
        ];
      },
    ),
    buildSection(
      AREA,
      "Overview Daily Series",
      [
        "Date",
        "Deposits (USD)",
        "Withdrawals (USD)",
        "Wager (USD)",
        "Organic wager (USD)",
        "Creator-coded wager (USD)",
        "GGR (USD)",
        "NGR (USD)",
        "Signups",
        "Active",
      ],
      () =>
        overview().daily.map((d) => [
          d.date,
          d.deposits,
          d.withdrawals,
          d.wager,
          d.wagerOrganic,
          d.wagerCreatorCoded,
          d.ggr,
          d.ngr,
          d.signups,
          d.active,
        ]),
    ),

    // ── Cohorts (one row per cohort × period offset) ──────────────
    buildSection(
      AREA,
      cohortsName,
      [
        "Cohort",
        "Cohort size",
        "Period offset",
        "Retained",
        "Wager (USD)",
        "GGR (USD)",
        "Deposits (USD)",
      ],
      () => {
        const c = cohorts();
        const rows: (string | number)[][] = [];
        for (const b of c.buckets) {
          for (let i = 0; i < c.maxPeriods; i++) {
            rows.push([
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
        return rows;
      },
    ),

    // ── Retention curves (one row per series × day) ───────────────
    buildSection(
      AREA,
      retentionName,
      ["Series", "Cohort size", "Day", "Retained", "Retention %"],
      () => {
        const rows: (string | number)[][] = [];
        for (const s of retention().series) {
          for (const pt of s.curve) {
            rows.push([s.label, s.cohort, pt.day, pt.retained, pt.pct]);
          }
        }
        return rows;
      },
    ),

    // ── LTV segments + top users ──────────────────────────────────
    buildSection(
      AREA,
      ltvName,
      [
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
      () =>
        ltv().segments.map((s) => [
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
    ),
    buildSection(
      AREA,
      "LTV Top Users",
      ["User ID", "Username", "GGR (USD)", "Deposits (USD)", "Net P&L (USD)"],
      () => ltv().topUsers.map((u) => [u.userId, u.username, u.ggr, u.deposits, u.netPnl]),
    ),

    // ── Funnel steps (one row per bucket × step) ──────────────────
    buildSection(
      AREA,
      funnelName,
      ["Bucket", "Step", "Count", "Dropoff from prev", "Conversion from top"],
      () => {
        const rows: (string | number | null)[][] = [];
        for (const bucket of funnel().buckets) {
          for (const step of bucket.steps) {
            rows.push([
              bucket.label,
              step.label,
              step.count,
              step.dropoffFromPrev,
              step.conversionFromTop,
            ]);
          }
        }
        return rows;
      },
    ),

    // ── Heatmap cells + totals ────────────────────────────────────
    buildSection(
      AREA,
      "Hour-of-Week Heatmap",
      [
        "Day of week (0=Sun)",
        "Hour",
        "Signups",
        "Deposits (USD)",
        "Withdrawals (USD)",
        "Wager (USD)",
        "P&L (USD)",
        "Active",
      ],
      () =>
        heatmap().cells.map((c) => [
          c.dayOfWeek,
          c.hour,
          c.signups,
          c.deposits,
          c.withdrawals,
          c.wager,
          c.pnl,
          c.active,
        ]),
    ),
    buildSection(AREA, "Heatmap Totals", ["Metric", "Total"], () => {
      const t = heatmap().totals;
      return [
        ["Signups", t.signups],
        ["Deposits (USD)", t.deposits],
        ["Withdrawals (USD)", t.withdrawals],
        ["Wager (USD)", t.wager],
        ["P&L (USD)", t.pnl],
        ["Active", t.active],
      ];
    }),

    // ── Whales (current lens) ─────────────────────────────────────
    buildSection(
      AREA,
      `Whales — ${whalesLens} (top 25)`,
      ["User ID", "Username", "Amount (USD)", "Detail"],
      () => whales().map((w) => [w.userId, w.username, w.amount, w.detail]),
    ),

    // ── Geo breakdown ─────────────────────────────────────────────
    buildSection(
      AREA,
      geoName,
      [
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
      () =>
        geo().rows.map((r) => [
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
    ),

    // ── Sources: buckets + codes ──────────────────────────────────
    buildSection(
      AREA,
      "Signup Source Buckets",
      [
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
      () =>
        sourcesBuckets().map((r) => [
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
    ),
    buildSection(
      AREA,
      "Signup Source Codes",
      [
        "Code",
        "Affiliate user ID",
        "Signups",
        "First deposit",
        "GGR driven (USD)",
        "Wager driven (USD)",
      ],
      () =>
        sourcesCodes().map((r) => [
          r.code,
          r.affiliateUserId,
          r.signups,
          r.firstDeposit,
          r.ggrDriven,
          r.wagerDriven,
        ]),
    ),

    // ── Money Flow decomposition + time-series ────────────────────
    buildSection(AREA, moneyFlowName, ["Metric", "Value"], () => {
      const mf = moneyFlow();
      return [
        ["GGR (USD)", mf.ggr],
        ["Wagers (USD)", mf.wagers],
        ["Payouts (USD)", mf.payouts],
        ["Bonuses total (USD)", mf.bonusesTotal],
        ["Deposits (USD)", mf.deposits],
        ["Manual withdrawals (USD)", mf.manualWithdrawals],
        ["Card withdrawals (USD)", mf.cardWithdrawals],
        ["Inventory delta (USD)", mf.inventoryDelta],
        ["Voucher delta (USD)", mf.voucherDelta],
        ["P&L (USD)", mf.pnl],
        ["Residual (USD)", mf.residual],
      ];
    }),
    buildSection(AREA, "Money Flow — Bonuses by Type", ["Type", "Total (USD)"], () =>
      moneyFlow().bonusesByType.map((b) => [b.type, b.total]),
    ),
    buildSection(
      AREA,
      "Money Flow — Daily Series",
      ["Date", "GGR (USD)", "Bonuses (USD)", "P&L (USD)"],
      () => moneyFlow().timeSeries.map((p) => [p.date, p.ggr, p.bonuses, p.pnl]),
    ),
  ];
}
