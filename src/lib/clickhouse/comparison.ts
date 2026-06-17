import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { MetricWindow } from "@/lib/metrics/queries";
import type { DashboardPeriod } from "@/lib/queries/dashboard-period";

import { bucketCrmSnapshot, type CrmSnapshot } from "@/lib/queries/crm-types";

import { computeDrift, logComparison } from "./compare/_core";
import { getCrmRowsFromClickHouse } from "./queries/crm";
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

// The drift primitives now live in ./compare/_core; re-exported here so the
// historical `@/lib/clickhouse/comparison` import path still resolves.
export { computeDrift, logComparison };
export type { FieldDrift } from "./compare/_core";
// compareDashboardCashflow now lives in its own per-surface module (the
// canonical Phase 2B/2C template); re-exported so the dashboard wiring import
// is unchanged.
export { compareDashboardCashflow } from "./compare/dashboard-cashflow";

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
 * Flatten a CRM snapshot to scalar leaves so `computeDrift` can diff it.
 * Money leaves (totals + per-segment deposits/ggr) use the half-cent tolerance;
 * the count leaves (customer counts + per-segment user counts) are omitted from
 * the money list below so they must match EXACTLY.
 */
function flattenCrmSnapshot(s: CrmSnapshot): Record<string, number> {
  const out: Record<string, number> = {
    totalCustomers: s.totalCustomers,
    depositingCustomers: s.depositingCustomers,
    newCustomers: s.newCustomers,
    totalDeposits: s.totalDeposits,
    totalNetDeposits: s.totalNetDeposits,
    totalGgr: s.totalGgr,
    avgDepositPerCustomer: s.avgDepositPerCustomer,
  };
  for (const row of s.lifecycle) {
    out[`lc_${row.key}_users`] = row.users;
    out[`lc_${row.key}_deposits`] = row.deposits;
    out[`lc_${row.key}_ggr`] = row.ggr;
  }
  for (const row of s.vipTiers) {
    out[`vip_${row.key}_users`] = row.users;
    out[`vip_${row.key}_deposits`] = row.deposits;
    out[`vip_${row.key}_ggr`] = row.ggr;
  }
  return out;
}

/** The money leaves of the flattened CRM snapshot (half-cent tolerance). */
function crmMoneyKeys(s: CrmSnapshot): string[] {
  const keys = [
    "totalDeposits",
    "totalNetDeposits",
    "totalGgr",
    "avgDepositPerCustomer",
  ];
  for (const row of s.lifecycle) keys.push(`lc_${row.key}_deposits`, `lc_${row.key}_ggr`);
  for (const row of s.vipTiers) keys.push(`vip_${row.key}_deposits`, `vip_${row.key}_ggr`);
  return keys;
}

/**
 * Fire-and-forget comparison for the Player-CRM snapshot. No-op unless the
 * `crm_snapshot` surface is in `comparison` mode (forced off whenever
 * ClickHouse is dormant). The ClickHouse twin is fed the SAME `anchor` +
 * blacklist used to compute the Postgres snapshot and bucketed by the SAME
 * pure `bucketCrmSnapshot`, so logged drift reflects engine/CDC-lag only.
 * Customer/segment counts must match exactly (omitted from the money list);
 * totals + per-segment money use the half-cent tolerance. Swallows every
 * error — the served Postgres payload is never affected.
 */
export async function compareCrmSnapshot(
  anchor: Date,
  blacklist: string[],
  pgSnapshot: CrmSnapshot,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("crm_snapshot");
    if (mode !== "comparison") return;

    const startedAt = Date.now();
    const ch = bucketCrmSnapshot(await getCrmRowsFromClickHouse(anchor, blacklist));
    const drift = computeDrift(
      flattenCrmSnapshot(pgSnapshot),
      flattenCrmSnapshot(ch),
      crmMoneyKeys(pgSnapshot),
    );
    logComparison("crm_snapshot[lifetime]", drift, Date.now() - startedAt);
  } catch (err) {
    logError("clickhouse.compare.crm_snapshot", "comparison failed (ignored)", err);
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
