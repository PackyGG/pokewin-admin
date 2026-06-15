import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

import {
  getDashboardStatsFromClickHouse,
  type DashboardStatsCh,
} from "../queries/dashboard/stats";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Fire-and-forget comparison for the Dashboard headline KPI composite
 * (`getDashboardStats` / `dashboardStatsInner`). No-op unless the
 * `dashboard_stats` surface is in `comparison` mode (forced off whenever
 * ClickHouse is dormant). Swallows every error — the served Postgres payload is
 * never affected.
 *
 * The CH twin reuses the SAME window cutoffs the PG path computed this render
 * (period cutoff, the canonical upgrader-window start, and the day/week/month +
 * rolling-24h/7d boundaries) so the two engines diff over identical windows;
 * any residual is CDC lag (transient, moves between runs) rather than
 * structural drift.
 *
 * DEFERRED legs (NOT diffed here — honest scope):
 *   • `ggr` — covered by the dedicated `dashboard_headline_ggr` surface twin
 *     (`getWindowMetrics` / `getWindowMetricsFromClickHouse`); diffing it here
 *     would double-log the same comparison.
 *   • chart arrays (dailyWagers / dailyDeposits / dailySignups / dailyFtds /
 *     dailyActiveDepositors / dailyWagerAttribution) — covered by the dedicated
 *     `dashboard_trend_series` surface twin.
 *   • `creatorWithdrawals` / `creatorWithdrawalsCount` — the creator deal-payout
 *     cash-out leg pairs `card_withdrawal_requests.voucher_ids` (an array) with
 *     `vouchers.origin IN ('creator_fill_conversion','creator_multiplier_payout')`
 *     under a DISTINCT (request, voucher). That array ⋈ origin pairing is a
 *     deterministic-ordering / balance-pairing risk (clickhouse-rules §5c);
 *     deferred rather than shipped with unverified settled-window drift.
 */
export type DashboardStatsCompareInput = {
  // window cutoffs (ISO) — identical to what the PG legs used this render
  periodCutoffIso: string;
  upgraderSinceIso: string;
  startOfDayIso: string;
  startOfWeekIso: string;
  startOfMonthIso: string;
  rolling24hIso: string;
  rolling7dIso: string;
} & { [K in keyof DashboardStatsCh]: number };

const MONEY_FIELDS: readonly (keyof DashboardStatsCh)[] = [
  "deposits",
  "withdrawals",
  "wagers",
  "wagersPacks",
  "wagersBattles",
  "wagersUpgrader",
  "wagersOrganic",
  "wagersRaw",
  "realizedPnlPeriod",
  "totalDeposited",
  "totalWithdrawn",
  "totalWagered",
  "totalWon",
  "ftdTotal24h",
  "balanceChangePeriod",
  "manualWdPeriod",
  "inventoryChangePeriod",
  "voucherChangePeriod",
];

const FIELDS: readonly (keyof DashboardStatsCh)[] = [
  // counts
  "usersTotal",
  "usersToday",
  "usersWeek",
  "usersMonth",
  "signups24h",
  "uniqueDepositors",
  "depositCountLifetime",
  "depositCount24h",
  "depositCount7d",
  "depositCountPeriod",
  "withdrawalCountPeriod",
  "ftds24h",
  "packsOpened24h",
  "battlesPlayed24h",
  // money
  ...MONEY_FIELDS,
];

export async function compareDashboardStats(
  pg: DashboardStatsCompareInput,
): Promise<void> {
  try {
    const mode = await getAdminReadMode("dashboard_stats");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getDashboardStatsFromClickHouse(
        {
          periodCutoff: new Date(pg.periodCutoffIso),
          upgraderSince: new Date(pg.upgraderSinceIso),
          startOfDay: new Date(pg.startOfDayIso),
          startOfWeek: new Date(pg.startOfWeekIso),
          startOfMonth: new Date(pg.startOfMonthIso),
          rolling24h: new Date(pg.rolling24hIso),
          rolling7d: new Date(pg.rolling7dIso),
        },
        blacklist,
      );
    });

    const pgRecord: Record<string, number> = {};
    const chRecord: Record<string, number> = {};
    for (const f of FIELDS) {
      pgRecord[f] = pg[f];
      chRecord[f] = ch[f];
    }

    const drift = computeDrift(pgRecord, chRecord, MONEY_FIELDS as string[]);
    logComparison("dashboard.stats", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.dashboard_stats",
      "comparison failed (ignored)",
      err,
    );
  }
}
