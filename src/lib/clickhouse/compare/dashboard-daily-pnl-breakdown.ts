import "server-only";

import { logError } from "@/lib/errors/logger";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

import { getDailyPnlBreakdownFromClickHouse } from "../queries/dashboard/daily-pnl-breakdown";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the Dashboard Daily-P&L (30-day) chart's
 * per-bar drilldown summary (`getDailyPnlBreakdown`). No-op unless the
 * `dashboard_daily_pnl_breakdown` surface is in `comparison` mode (forced off
 * whenever ClickHouse is dormant). Swallows every error — the served Postgres
 * payload is never affected.
 *
 * Compares the six reconciling summary money terms cent-exact + each section's
 * un-capped row count exactly, for the SAME UTC day `dayUtc` the PG path
 * resolved. Mirrors the PG twin's EXACT 2-role (creators KEPT) + blacklist
 * scope; the blacklist is fed in identically to both engines via
 * `getExcludedUserIds`.
 */
export async function compareDashboardDailyPnlBreakdown(
  dayUtc: string,
  pgValues: {
    deposits: number;
    withdrawals: number;
    balanceChange: number;
    inventoryChange: number;
    voucherChange: number;
    pnl: number;
    depositCount: number;
    withdrawalCount: number;
    balanceCount: number;
    inventoryCount: number;
    voucherCount: number;
  },
): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_daily_pnl_breakdown");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDailyPnlBreakdownFromClickHouse(dayUtc, blacklist);
    });

    const drift = computeDrift(
      {
        deposits: pgValues.deposits,
        withdrawals: pgValues.withdrawals,
        balanceChange: pgValues.balanceChange,
        inventoryChange: pgValues.inventoryChange,
        voucherChange: pgValues.voucherChange,
        pnl: pgValues.pnl,
        depositCount: pgValues.depositCount,
        withdrawalCount: pgValues.withdrawalCount,
        balanceCount: pgValues.balanceCount,
        inventoryCount: pgValues.inventoryCount,
        voucherCount: pgValues.voucherCount,
      },
      {
        deposits: ch.deposits,
        withdrawals: ch.withdrawals,
        balanceChange: ch.balanceChange,
        inventoryChange: ch.inventoryChange,
        voucherChange: ch.voucherChange,
        pnl: ch.pnl,
        depositCount: ch.depositCount,
        withdrawalCount: ch.withdrawalCount,
        balanceCount: ch.balanceCount,
        inventoryCount: ch.inventoryCount,
        voucherCount: ch.voucherCount,
      },
      // Money fields pass within half a cent; the *Count fields must match exactly.
      [
        "deposits",
        "withdrawals",
        "balanceChange",
        "inventoryChange",
        "voucherChange",
        "pnl",
      ],
    );
    logComparison(`dashboard.dailyPnlBreakdown[${dayUtc}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_daily_pnl_breakdown",
      "comparison failed (ignored)",
      err,
    );
  }
}
