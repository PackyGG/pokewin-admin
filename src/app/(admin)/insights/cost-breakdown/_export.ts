import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  INSIGHTS_PERIOD_LABELS,
  type InsightsPeriod,
} from "../analytics/types";
import { getCostBreakdown } from "@/lib/queries/insights-analytics/cost-breakdown";
import { settle, unwrap, buildSection } from "../_export-section";

const AREA = "insights.export.cost-breakdown";

/**
 * Export gatherer for /insights/cost-breakdown.
 *
 * Bundles the wager → P&L waterfall, the ranked leakage categories
 * (amount + %-of-GGR + %-of-wager), the margin-health ratios, the daily
 * GGR/cost/P&L trend, and the gaming-margin contributors into one CSV.
 *
 * Reuses the exact same `getCostBreakdown` helper the page renders (top
 * 50 contributors here vs 10 on-screen), so the export reconciles with
 * the page — and, transitively, with /ggr + /insights/analytics Money
 * Flow + /insights/rewards (since getCostBreakdown is itself an
 * assembly of getMoneyFlowDecomposition + the canonical GGR type sets).
 * Read-only. Server-only; auth is enforced by the route handler that
 * calls this (`/insights/export`), which gates on the same page-access
 * key as the page.
 */
export async function gatherCostBreakdownExportSections(
  period: InsightsPeriod,
): Promise<ExportSection[]> {
  const periodLabel = INSIGHTS_PERIOD_LABELS[period];
  // Single backing query. Settle (not await-throw) so a failure degrades
  // every section to empty rather than crashing the gatherer → BOM-only
  // download. `unwrap` inside each buildSection thunk re-throws on
  // failure and is caught there, emitting that section's header + 0 rows.
  const [dataResult] = await settle([getCostBreakdown(period, periodLabel, 50)]);
  const data = () => unwrap(dataResult);

  return [
    // ── Top-line summary ──────────────────────────────────────────
    buildSection(AREA, `Cost Breakdown Summary (${periodLabel})`, ["Metric", "Value"], () => {
      const d = data();
      return [
        ["Period", periodLabel],
        ["Total wager (USD)", d.totalWager],
        ["Gameplay winnings paid back (USD)", d.gamingPayouts],
        ["Reward / marketing payouts (USD)", d.rewardPayouts],
        ["GGR / gaming margin (USD)", d.ggr],
        ["Inventory value held by users (USD)", d.inventoryDelta],
        ["Card withdrawals shipped (USD)", d.cardWithdrawals],
        ["Unclaimed voucher liability (USD)", d.voucherDelta],
        ["Unexplained residual (USD)", d.residual],
        ["Net P&L realized (USD)", d.pnl],
        ["Total cost wager − P&L (USD)", d.totalCost],
        ["Biggest leak", d.biggestLeak?.label ?? "—"],
        ["Biggest leak amount (USD)", d.biggestLeak?.amount ?? 0],
      ];
    }),

    // ── The waterfall, in running-total order ─────────────────────
    buildSection(
      AREA,
      "Waterfall (wager → P&L)",
      ["Line", "Kind", "Signed amount (USD)", "Magnitude (USD)", "% of GGR", "% of wager"],
      () =>
        data().lines.map((l) => [
          l.label,
          l.kind,
          l.signedAmount,
          l.amount,
          l.pctOfGgr,
          l.pctOfWager,
        ]),
    ),

    // ── Ranked leakage categories ─────────────────────────────────
    buildSection(
      AREA,
      "Cost Categories Ranked (biggest first)",
      ["Rank", "Category", "Amount (USD)", "% of GGR", "% of wager"],
      () =>
        data()
          .rankedCosts.filter((l) => l.amount > 0)
          .map((l, i) => [i + 1, l.label, l.amount, l.pctOfGgr, l.pctOfWager]),
    ),

    // ── Margin health ─────────────────────────────────────────────
    buildSection(AREA, "Margin Health", ["Metric", "Value"], () => {
      const m = data().margin;
      return [
        ["RTP (payouts / wager)", m.rtp],
        ["House edge (GGR / wager)", m.houseEdge],
        ["GGR % of wager", m.ggrPctOfWager],
        ["P&L % of wager", m.pnlPctOfWager],
        ["Cost % of GGR", m.costPctOfGgr],
        ["P&L % of GGR", m.pnlPctOfGgr],
      ];
    }),

    // ── Daily trend ───────────────────────────────────────────────
    buildSection(
      AREA,
      "Daily Trend (GGR / cost / P&L)",
      ["Date", "GGR (USD)", "Cost (USD)", "Net P&L (USD)"],
      () => data().trend.map((t) => [t.date, t.ggr, t.cost, t.pnl]),
    ),

    // ── Gaming-margin contributors ────────────────────────────────
    buildSection(
      AREA,
      "Top Contributors (top 50, house-POV net)",
      ["User ID", "Username", "Wager (USD)", "Payouts (USD)", "Net house-POV (USD)"],
      () =>
        data().contributors.map((c) => [
          c.userId,
          c.username,
          c.wagerTotal,
          c.payoutTotal,
          c.net,
        ]),
    ),
  ];
}
