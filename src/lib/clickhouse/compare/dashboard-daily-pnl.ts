import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

import {
  getDailyPnlFromClickHouse,
  type DailyPnlPoint,
} from "../queries/dashboard/daily-pnl";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the Dashboard "Daily P&L" 30-day chart
 * (`getDailyPnl`). No-op unless the `dashboard_daily_pnl` surface is in
 * `comparison` mode (forced off whenever ClickHouse is dormant). Swallows every
 * error — the served Postgres payload is never affected.
 *
 * The chart is a per-day series; this hook logs drift on the 30-day SUM of each
 * component (cent-exact money fields). Per-day, count-exact verification is the
 * job of the uncommitted parity harness (which feeds both engines an identical
 * `since`, so a boundary-day inclusion difference can't masquerade as drift).
 */
function sumPoints(points: DailyPnlPoint[]): Record<string, number> {
  return points.reduce(
    (acc, p) => {
      acc.deposits += p.deposits;
      acc.withdrawals += p.withdrawals;
      acc.balanceChange += p.balanceChange;
      acc.inventoryChange += p.inventoryChange;
      acc.voucherChange += p.voucherChange;
      acc.pnl += p.pnl;
      return acc;
    },
    {
      deposits: 0,
      withdrawals: 0,
      balanceChange: 0,
      inventoryChange: 0,
      voucherChange: 0,
      pnl: 0,
    },
  );
}

export async function compareDashboardDailyPnl(
  pgPoints: DailyPnlPoint[],
): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_daily_pnl");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDailyPnlFromClickHouse(blacklist);
    });
    const drift = computeDrift(sumPoints(pgPoints), sumPoints(ch), [
      "deposits",
      "withdrawals",
      "balanceChange",
      "inventoryChange",
      "voucherChange",
      "pnl",
    ]);
    logComparison("dashboard.dailyPnl[30d-sum]", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_daily_pnl",
      "comparison failed (ignored)",
      err,
    );
  }
}
