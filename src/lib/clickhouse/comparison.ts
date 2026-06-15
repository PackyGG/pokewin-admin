import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { MetricWindow } from "@/lib/metrics/queries";
import type {
  DashboardKpiWindow,
  DashboardPeriod,
} from "@/lib/queries/dashboard-period";

import { getDashboardCashflowFromClickHouse } from "./queries/dashboard-cashflow";
import { getWindowMetricsFromClickHouse } from "./queries/window-metrics";
import {
  getDashboardTrendSeriesFromClickHouse,
  type DashboardTrendSeries,
} from "./queries/trend-series";
import {
  getRealizedPnlSnapshotFromClickHouse,
  type RealizedPnlSnapshot,
} from "./queries/realized-pnl";

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

export function logComparison(
  label: string,
  drift: FieldDrift[],
  durationMs?: number,
): void {
  const summary = drift
    .map((d) => `${d.field}: pg=${d.pg} ch=${d.ch} Δ=${d.absDrift.toFixed(4)}`)
    .join(" | ");
  // `duration_ms` shares the failure-line convention so timing is greppable
  // across every observability surface; present on BOTH the OK and DRIFT
  // branches.
  const timing = durationMs != null ? ` duration_ms=${durationMs}` : "";
  const failing = drift.filter((d) => !d.ok);
  if (failing.length === 0) {
    console.log(`[ch-compare] ${label} OK${timing} — ${summary}`);
  } else {
    console.warn(
      `[ch-compare] ${label} DRIFT ${failing.length}/${drift.length}${timing} — ${summary}`,
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

    const startedAt = Date.now();
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
    logComparison(`dashboard.cashflow[${window}]`, drift, Date.now() - startedAt);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_cashflow",
      "comparison failed (ignored)",
      err,
    );
  }
}

/**
 * Fire-and-forget comparison for the Dashboard headline window-metrics (GGR /
 * NGR / wager / payout / rain). No-op unless the `dashboard_headline_ggr`
 * surface is in `comparison` mode (forced off whenever ClickHouse is dormant).
 * The ClickHouse twin is fed the SAME `MetricWindow` + blacklist used to
 * compute the Postgres values, so logged drift reflects engine/CDC-lag only.
 * `bets` is a count (omitted from the money-tolerance list → must match
 * exactly); the empirical RTP / house-edge ratios are derived from these legs
 * and are not compared directly. Swallows every error — the served Postgres
 * payload is never affected.
 */
export async function compareWindowMetrics(
  args: { window: MetricWindow; windowLabel: string },
  pgValues: {
    wager: number;
    gamingPayout: number;
    ggr: number;
    ngr: number;
    bets: number;
    rainWinTotal: number;
    rainTipTotal: number;
    rainHouseCost: number;
  },
): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_headline_ggr");
    if (mode !== "comparison") return;

    const startedAt = Date.now();
    const blacklist = await getExcludedUserIds();
    const ch = await getWindowMetricsFromClickHouse(args.window, blacklist);
    const drift = computeDrift(
      {
        wager: pgValues.wager,
        gamingPayout: pgValues.gamingPayout,
        ggr: pgValues.ggr,
        ngr: pgValues.ngr,
        rainWinTotal: pgValues.rainWinTotal,
        rainTipTotal: pgValues.rainTipTotal,
        rainHouseCost: pgValues.rainHouseCost,
        bets: pgValues.bets,
      },
      {
        wager: ch.wager,
        gamingPayout: ch.gamingPayout,
        ggr: ch.ggr,
        ngr: ch.ngr,
        rainWinTotal: ch.rainWinTotal,
        rainTipTotal: ch.rainTipTotal,
        rainHouseCost: ch.rainHouseCost,
        bets: ch.bets,
      },
      [
        "wager",
        "gamingPayout",
        "ggr",
        "ngr",
        "rainWinTotal",
        "rainTipTotal",
        "rainHouseCost",
      ],
    );
    logComparison(
      `dashboard_headline_ggr[${args.windowLabel}]`,
      drift,
      Date.now() - startedAt,
    );
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_headline_ggr",
      "comparison failed (ignored)",
      err,
    );
  }
}

/**
 * Reduce a trend series to per-leg window totals so the per-bucket arrays can
 * be diffed as scalars via `computeDrift`. Both engines emit the SAME canonical
 * bucket labels (so the padded series share a bucket set); summing each leg
 * across all buckets gives a window total that is parity-clean iff every bucket
 * is. Money legs use the half-cent tolerance; the three count legs (signups,
 * ftdCount, activeDepositors) are summed as integers and must match exactly.
 */
function sumTrendSeries(series: DashboardTrendSeries): Record<string, number> {
  const sum = <T>(rows: T[], pick: (row: T) => number): number =>
    rows.reduce((acc, row) => acc + pick(row), 0);
  return {
    packsWager: sum(series.dailyWagers, (r) => r.packs),
    battlesWager: sum(series.dailyWagers, (r) => r.battles),
    upgraderWager: sum(series.dailyWagers, (r) => r.upgrader),
    deposits: sum(series.dailyDeposits, (r) => r.amount),
    ftdTotal: sum(series.dailyFtds, (r) => r.total),
    organicWager: sum(series.dailyWagerAttribution, (r) => r.organic),
    creatorCodedWager: sum(series.dailyWagerAttribution, (r) => r.creatorCoded),
    signups: sum(series.dailySignups, (r) => r.count),
    ftdCount: sum(series.dailyFtds, (r) => r.count),
    activeDepositors: sum(series.dailyActiveDepositors, (r) => r.count),
  };
}

/**
 * Fire-and-forget comparison for the Dashboard trend-series charts. No-op
 * unless the `dashboard_trend_series` surface is in `comparison` mode (forced
 * off whenever ClickHouse is dormant). The ClickHouse twin is fed the SAME
 * period + blacklist used to compute the Postgres series; both series are
 * reduced to per-leg window totals (see `sumTrendSeries`) and diffed. The three
 * count legs are omitted from the money list so they must match exactly.
 * Swallows every error — the served Postgres payload is never affected.
 */
export async function compareTrendSeries(
  period: DashboardPeriod,
  pgSeries: DashboardTrendSeries,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_trend_series");
    if (mode !== "comparison") return;

    const startedAt = Date.now();
    const blacklist = await getExcludedUserIds();
    const ch = await getDashboardTrendSeriesFromClickHouse(period, blacklist);
    const drift = computeDrift(sumTrendSeries(pgSeries), sumTrendSeries(ch), [
      "packsWager",
      "battlesWager",
      "upgraderWager",
      "deposits",
      "ftdTotal",
      "organicWager",
      "creatorCodedWager",
    ]);
    logComparison(`dashboard_trend_series[${period}]`, drift, Date.now() - startedAt);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_trend_series",
      "comparison failed (ignored)",
      err,
    );
  }
}

/**
 * Fire-and-forget comparison for the lifetime realized-P&L snapshot. No-op
 * unless the `dashboard_realized_pnl_lifetime` surface is in `comparison` mode
 * (forced off whenever ClickHouse is dormant). The ClickHouse twin is fed the
 * SAME blacklist used to compute the Postgres snapshot and uses the PG twin's
 * creator-keeping scope, so logged drift reflects engine/CDC-lag only. Every
 * field is money. Swallows every error — the served Postgres payload is never
 * affected.
 */
export async function compareRealizedPnl(
  pgValues: RealizedPnlSnapshot,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_realized_pnl_lifetime");
    if (mode !== "comparison") return;

    const startedAt = Date.now();
    const blacklist = await getExcludedUserIds();
    const ch = await getRealizedPnlSnapshotFromClickHouse(blacklist);
    const drift = computeDrift(
      {
        pnl: pgValues.pnl,
        totalDeposited: pgValues.totalDeposited,
        totalWithdrawn: pgValues.totalWithdrawn,
        userBalance: pgValues.userBalance,
        inventory: pgValues.inventory,
        vouchers: pgValues.vouchers,
        unclaimedRakeback: pgValues.unclaimedRakeback,
      },
      {
        pnl: ch.pnl,
        totalDeposited: ch.totalDeposited,
        totalWithdrawn: ch.totalWithdrawn,
        userBalance: ch.userBalance,
        inventory: ch.inventory,
        vouchers: ch.vouchers,
        unclaimedRakeback: ch.unclaimedRakeback,
      },
      [
        "pnl",
        "totalDeposited",
        "totalWithdrawn",
        "userBalance",
        "inventory",
        "vouchers",
        "unclaimedRakeback",
      ],
    );
    logComparison(
      `dashboard_realized_pnl_lifetime[lifetime]`,
      drift,
      Date.now() - startedAt,
    );
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_realized_pnl_lifetime",
      "comparison failed (ignored)",
      err,
    );
  }
}
