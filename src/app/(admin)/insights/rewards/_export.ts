import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getRewardsCrossCategorySummary } from "@/lib/queries/insights-rewards/cross-category-summary";
import { getRewardsCategorySpendBreakdown } from "@/lib/queries/insights-rewards/category-spend-breakdown";
import { getCreatorWithdrawalsSummary } from "@/lib/queries/insights-rewards/creator-withdrawals";
import { settle, unwrap, buildSection } from "../_export-section";

const AREA = "insights.export.rewards";

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
  // Settle (not await-throw) so one failed query degrades only its own
  // section(s) instead of crashing the gatherer → BOM-only download.
  const [summaryR, spendR, creatorWdR] = await settle([
    getRewardsCrossCategorySummary(period),
    getRewardsCategorySpendBreakdown(period),
    getCreatorWithdrawalsSummary(period),
  ]);
  const summary = () => unwrap(summaryR);
  const spend = () => unwrap(spendR);
  const creatorWd = () => unwrap(creatorWdR);

  const periodLabel = insightsRewardsPeriodLabel(period);

  return [
    // ── Cross-category KPI summary ────────────────────────────────
    buildSection(AREA, `Rewards Overview KPIs (${periodLabel})`, ["Metric", "Value"], () => {
      const s = summary();
      const prior = s.priorWindow;
      // Creator-withdrawals is its own query; if only that one failed,
      // still emit the rest with em-dash placeholders for its two cells.
      let cwTotal: number | null = null;
      let cwCount: number | null = null;
      try {
        const cw = creatorWd();
        cwTotal = cw.total;
        cwCount = cw.count;
      } catch {
        /* leave nulls — its own section logs the failure */
      }
      return [
        ["Period", periodLabel],
        ["Total marketing cost (USD)", s.totalCost],
        ["Total payouts (count)", s.totalCount],
        ["Active claimants", s.activeClaimants],
        ["Total wager (USD)", s.totalWager],
        ["Total reward payouts (USD)", s.totalPayouts],
        ["GGR (USD)", s.ggr],
        ["Marketing % of GGR", s.marketingPctOfGgr],
        ["Marketing % of wager", s.marketingPctOfWager],
        ["Creator withdrawals total (USD)", cwTotal],
        ["Creator withdrawals count", cwCount],
        ["Prior cost (USD)", prior?.totalCost ?? null],
        ["Prior payout count", prior?.totalCount ?? null],
        ["Prior claimants", prior?.activeClaimants ?? null],
        ["Cost delta vs prior", prior?.costDelta ?? null],
        ["Count delta vs prior", prior?.countDelta ?? null],
        ["Claimant delta vs prior", prior?.claimantDelta ?? null],
      ];
    }),

    // ── Spend by category ─────────────────────────────────────────
    buildSection(
      AREA,
      "Spend by Category",
      ["Category", "Total (USD)", "Payouts", "Claimants", "Share %"],
      () => spend().rows.map((r) => [r.label, r.total, r.count, r.claimants, r.share]),
    ),

    // ── Per-category daily time-series (long format) ──────────────
    buildSection(
      AREA,
      "Daily Marketing Cost by Category",
      ["Date", "Category", "Total (USD)"],
      () => {
        const dailyRows: (string | number)[][] = [];
        for (const row of spend().rows) {
          for (const pt of row.dailySeries) {
            dailyRows.push([pt.date, row.label, pt.total]);
          }
        }
        dailyRows.sort(
          (a, b) =>
            String(a[0]).localeCompare(String(b[0])) ||
            String(a[1]).localeCompare(String(b[1])),
        );
        return dailyRows;
      },
    ),
  ];
}
