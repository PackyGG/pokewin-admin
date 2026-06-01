import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getRewardsCrossCategorySummary } from "@/lib/queries/insights-rewards/cross-category-summary";
import { getRewardsCategorySpendBreakdown } from "@/lib/queries/insights-rewards/category-spend-breakdown";
import { getCreatorWithdrawalsSummary } from "@/lib/queries/insights-rewards/creator-withdrawals";

/**
 * Export gatherer for /insights/rewards (the Overview tab — the
 * page's cross-category landing surface).
 *
 * Bundles the cross-category KPI summary, the per-category spend
 * breakdown (count / claimants / share), the per-category daily
 * time-series, and the creator-withdrawals summary for the active
 * period into one CSV.
 *
 * Reuses the same cached query helpers the overview tab renders.
 * Read-only. Server-only; auth is enforced by the route handler that
 * calls this (`/insights/export`), which gates on the same page-access
 * key as the page.
 */
export async function gatherRewardsOverviewExportSections(
  period: InsightsRewardsPeriod,
): Promise<ExportSection[]> {
  const [summary, spend, creatorWd] = await Promise.all([
    getRewardsCrossCategorySummary(period),
    getRewardsCategorySpendBreakdown(period),
    getCreatorWithdrawalsSummary(period),
  ]);

  const periodLabel = insightsRewardsPeriodLabel(period);
  const prior = summary.priorWindow;
  const sections: ExportSection[] = [];

  // ── Cross-category KPI summary ──────────────────────────────────
  sections.push({
    name: `Rewards Overview KPIs (${periodLabel})`,
    columns: ["Metric", "Value"],
    rows: [
      ["Period", periodLabel],
      ["Total marketing cost (USD)", summary.totalCost],
      ["Total payouts (count)", summary.totalCount],
      ["Active claimants", summary.activeClaimants],
      ["Total wager (USD)", summary.totalWager],
      ["Total reward payouts (USD)", summary.totalPayouts],
      ["GGR (USD)", summary.ggr],
      ["Marketing % of GGR", summary.marketingPctOfGgr],
      ["Marketing % of wager", summary.marketingPctOfWager],
      ["Creator withdrawals total (USD)", creatorWd.total],
      ["Creator withdrawals count", creatorWd.count],
      ["Prior cost (USD)", prior?.totalCost ?? null],
      ["Prior payout count", prior?.totalCount ?? null],
      ["Prior claimants", prior?.activeClaimants ?? null],
      ["Cost delta vs prior", prior?.costDelta ?? null],
      ["Count delta vs prior", prior?.countDelta ?? null],
      ["Claimant delta vs prior", prior?.claimantDelta ?? null],
    ],
  });

  // ── Spend by category ───────────────────────────────────────────
  sections.push({
    name: "Spend by Category",
    columns: ["Category", "Total (USD)", "Payouts", "Claimants", "Share %"],
    rows: spend.rows.map((r) => [
      r.label,
      r.total,
      r.count,
      r.claimants,
      r.share,
    ]),
  });

  // ── Per-category daily time-series (long format) ────────────────
  const dailyRows: (string | number)[][] = [];
  for (const row of spend.rows) {
    for (const pt of row.dailySeries) {
      dailyRows.push([pt.date, row.label, pt.total]);
    }
  }
  dailyRows.sort((a, b) =>
    String(a[0]).localeCompare(String(b[0])) ||
    String(a[1]).localeCompare(String(b[1])),
  );
  sections.push({
    name: "Daily Marketing Cost by Category",
    columns: ["Date", "Category", "Total (USD)"],
    rows: dailyRows,
  });

  return sections;
}
