import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { DashboardKpiWindow } from "@/lib/queries/dashboard-period";

import { getDashboardCashflowFromClickHouse } from "./queries/dashboard-cashflow";

/**
 * Comparison-mode plumbing for the CQRS rollout.
 *
 * In `comparison` mode a surface serves its Postgres result unchanged and runs
 * the ClickHouse path side-by-side purely to LOG drift — never to change what
 * the user sees. These helpers compute the drift and never throw, so wiring
 * them into a render path is safe (fire-and-forget).
 */

export type FieldDrift = {
  field: string;
  pg: number;
  ch: number;
  absDrift: number;
  pctDrift: number | null;
  /** Money fields pass within half a cent; counts must be exact. */
  ok: boolean;
};

export function computeDrift(
  pg: Record<string, number>,
  ch: Record<string, number>,
  moneyFields: readonly string[] = [],
): FieldDrift[] {
  return Object.keys(pg).map((field) => {
    const p = pg[field] ?? 0;
    const c = ch[field] ?? 0;
    const absDrift = Math.abs(p - c);
    const pctDrift = p !== 0 ? (absDrift / Math.abs(p)) * 100 : c === 0 ? 0 : null;
    const ok = moneyFields.includes(field) ? absDrift < 0.005 : absDrift === 0;
    return { field, pg: p, ch: c, absDrift, pctDrift, ok };
  });
}

export function logComparison(label: string, drift: FieldDrift[]): void {
  const summary = drift
    .map((d) => `${d.field}: pg=${d.pg} ch=${d.ch} Δ=${d.absDrift.toFixed(4)}`)
    .join(" | ");
  const failing = drift.filter((d) => !d.ok);
  if (failing.length === 0) {
    console.log(`[ch-compare] ${label} OK — ${summary}`);
  } else {
    console.warn(
      `[ch-compare] ${label} DRIFT ${failing.length}/${drift.length} — ${summary}`,
    );
  }
}

/**
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

    const blacklist = await getExcludedUserIds();
    const ch = await getDashboardCashflowFromClickHouse(window, blacklist);
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
    logComparison(`dashboard.cashflow[${window}]`, drift);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_cashflow",
      "comparison failed (ignored)",
      err,
    );
  }
}
