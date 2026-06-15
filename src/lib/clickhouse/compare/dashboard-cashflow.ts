import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { DashboardKpiWindow } from "@/lib/queries/dashboard-period";

import { getDashboardCashflowFromClickHouse } from "../queries/dashboard-cashflow";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Canonical per-surface compare module (the Phase 2B/2C template).
 *
 * Every CQRS comparison surface follows this exact shape: gate on
 * `getAdminReadMode(<surface>)` and no-op unless `comparison`, fetch the
 * excluded-users blacklist + run the ClickHouse twin with the SAME args under
 * `timeCh`, diff against the Postgres values via `computeDrift` (money fields
 * within half a cent; counts exact), log via `logComparison`, and swallow every
 * error via `logError` so the served Postgres payload is never affected.
 *
 * Fire-and-forget comparison for the Dashboard cash-flow KPIs. No-op unless the
 * `dashboard_cashflow` surface is in `comparison` mode (which itself is forced
 * off whenever ClickHouse is dormant). Swallows every error — the served
 * Postgres payload is never affected.
 */
export async function compareDashboardCashflow(
  window: DashboardKpiWindow,
  pgValues: {
    deposits: number;
    depositCount: number;
    withdrawals: number;
    withdrawalCount: number;
  },
): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_cashflow");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDashboardCashflowFromClickHouse(window, blacklist);
    });
    const drift = computeDrift(
      {
        deposits: pgValues.deposits,
        withdrawals: pgValues.withdrawals,
        depositCount: pgValues.depositCount,
        withdrawalCount: pgValues.withdrawalCount,
      },
      {
        deposits: ch.deposits,
        withdrawals: ch.withdrawals,
        depositCount: ch.depositCount,
        withdrawalCount: ch.withdrawalCount,
      },
      ["deposits", "withdrawals"],
    );
    logComparison(`dashboard.cashflow[${window}]`, drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_cashflow",
      "comparison failed (ignored)",
      err,
    );
  }
}
