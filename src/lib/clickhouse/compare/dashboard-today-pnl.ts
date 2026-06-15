import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

import { getWindowedPnlFromClickHouse } from "../queries/dashboard/windowed-pnl";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the Dashboard "P&L Today" tile
 * (`getTodayPnl`). No-op unless the `dashboard_today_pnl` surface is in
 * `comparison` mode (forced off whenever ClickHouse is dormant). Swallows every
 * error — the served Postgres payload is never affected.
 *
 * The CH twin reuses the SAME window start the PG path computed (today 00:00
 * UTC, carried as `dayStartIso`) so the two windows are identical.
 */
export async function compareDashboardTodayPnl(pgValues: {
  deposits: number;
  withdrawals: number;
  balanceChange: number;
  inventoryChange: number;
  voucherChange: number;
  pnl: number;
  dayStartIso: string;
}): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_today_pnl");
    if (mode !== "comparison") return;

    const since = new Date(pgValues.dayStartIso);
    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getWindowedPnlFromClickHouse(since, blacklist);
    });
    const drift = computeDrift(
      {
        deposits: pgValues.deposits,
        withdrawals: pgValues.withdrawals,
        balanceChange: pgValues.balanceChange,
        inventoryChange: pgValues.inventoryChange,
        voucherChange: pgValues.voucherChange,
        pnl: pgValues.pnl,
      },
      {
        deposits: ch.deposits,
        withdrawals: ch.withdrawals,
        balanceChange: ch.balanceChange,
        inventoryChange: ch.inventoryChange,
        voucherChange: ch.voucherChange,
        pnl: ch.pnl,
      },
      ["deposits", "withdrawals", "balanceChange", "inventoryChange", "voucherChange", "pnl"],
    );
    logComparison("dashboard.todayPnl", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_today_pnl",
      "comparison failed (ignored)",
      err,
    );
  }
}
