"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getDailyPnlBreakdown,
  type DailyPnlBreakdown,
} from "@/lib/queries/dashboard-daily-pnl-breakdown";
import { compareDashboardDailyPnlBreakdown } from "@/lib/clickhouse/compare/dashboard-daily-pnl-breakdown";

/**
 * Server action backing the Daily-P&L (30-day) chart's per-bar drilldown
 * modal on /dashboard.
 *
 * Each bar of the Daily-P&L chart represents one UTC calendar day's house
 * P&L. Clicking a bar opens a modal that fetches THAT day's full breakdown
 * via this action — the FIRST time the modal opens for the day; the result
 * is cached in the modal's local state and reused on re-open (no re-fetch),
 * mirroring the GGR top-contributors expander + the reward-cost "Show
 * claimants" drilldown. The dashboard's initial render NEVER calls this, so
 * the 30 bars stream without loading any day's breakdown (CLAUDE.md
 * active-timeframe / lazy rule).
 *
 * Read-only (no mutation, no audit). Auth-gated with the SAME
 * `requirePageAccess("/dashboard")` DAL guard the sibling dashboard server
 * read (`fetchGgrTopContributors`) uses, so only admins permitted on the
 * dashboard can drill a day.
 *
 * `dayUtc` is a free string from the client; the query helper strictly
 * validates it as `YYYY-MM-DD` and throws on anything else, so a tampered
 * value can't widen the scan. The returned per-component totals are computed
 * the SAME WAY `getDailyPnl` computes the bar (same scope, same UTC-day
 * bucketing, same ledger event types, same wipe correction), so the modal's
 * summary reconciles to the bar height.
 */
export async function fetchDailyPnlBreakdown(
  dayUtc: string,
): Promise<DailyPnlBreakdown> {
  await requirePageAccess("/dashboard");
  const breakdown = await getDailyPnlBreakdown(dayUtc);
  // CQRS rollout: in `comparison` mode, run the ClickHouse single-day breakdown
  // path side-by-side and LOG drift. Fire-and-forget + never-throwing — the
  // returned breakdown stays 100% Postgres. No-op unless the flag is `comparison`.
  void compareDashboardDailyPnlBreakdown(dayUtc, {
    deposits: breakdown.summary.deposits,
    withdrawals: breakdown.summary.withdrawals,
    balanceChange: breakdown.summary.balanceChange,
    inventoryChange: breakdown.summary.inventoryChange,
    voucherChange: breakdown.summary.voucherChange,
    pnl: breakdown.summary.pnl,
    depositCount: breakdown.deposits.totalCount,
    withdrawalCount: breakdown.withdrawals.totalCount,
    balanceCount: breakdown.balanceChanges.totalCount,
    inventoryCount: breakdown.inventoryChanges.totalCount,
    voucherCount: breakdown.voucherChanges.totalCount,
  });
  return breakdown;
}
