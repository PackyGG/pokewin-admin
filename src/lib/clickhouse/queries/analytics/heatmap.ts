import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * ClickHouse twin of `@/lib/queries/analytics-heatmap` `getActivityHeatmap` —
 * the 7×24 hour-of-week activity grid (wager $ + deposit count), read from the
 * `packy_prod` CDC mirror. Comparison-mode only.
 *
 * SCOPE mirrored EXACTLY from the PG twin:
 *   • role NOT IN ('admin','support') (creators KEPT) + excluded-users blacklist.
 *   • status='completed'; created_at >= NOW()-N days (N = 7/30/90/180-capped).
 *   • wager = Σ|amount| of the 4-type wager set (incl. upgrader_bet); deposits =
 *     COUNT of type='deposit' rows.
 *
 * TZ BASIS: the PG twin buckets in UTC (EXTRACT(DOW/HOUR) with a UTC session).
 * `created_at` is DateTime64 stored UTC; CH buckets explicitly in 'UTC'. PG
 * EXTRACT(DOW) is Sunday=0..Saturday=6, which equals CH
 * `toDayOfWeek(t, 3, 'UTC') - 1` (mode 3 yields Sunday=1..Saturday=7).
 */

export type HeatmapPeriod = "7d" | "30d" | "90d" | "all";

export type HeatmapCellCh = {
  dayOfWeek: number;
  hour: number;
  wager: number;
  deposits: number;
};

export type HeatmapDataCh = {
  period: HeatmapPeriod;
  cells: HeatmapCellCh[];
  maxWager: number;
  maxDeposits: number;
  totalWager: number;
  totalDeposits: number;
};

function daysForPeriod(period: HeatmapPeriod): number {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return 180;
  }
}

const WAGER_HEATMAP_TYPES =
  "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";

export async function getActivityHeatmapFromClickHouse(
  period: HeatmapPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<HeatmapDataCh> {
  const days = daysForPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const cutoff = chDateTime(new Date(now.getTime() - days * 86_400_000));
  const params: Record<string, unknown> = { cutoff, blacklist };

  const blacklistClause = hasBlacklist
    ? "AND id NOT IN {blacklist:Array(String)}"
    : "";

  const sql = `
    WITH real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${blacklistClause}
    )
    SELECT
      toDayOfWeek(lt.created_at, 3, 'UTC') - 1 AS dow,
      toHour(lt.created_at, 'UTC')             AS hour,
      toString(sumIf(abs(lt.amount), lt.type IN ${WAGER_HEATMAP_TYPES})) AS wager,
      toString(countIf(lt.type = 'deposit'))                            AS deposits
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.user_id IN (SELECT id FROM real_users)
      AND lt.created_at >= {cutoff:DateTime64(6)}
    GROUP BY dow, hour`;

  const rows = await clickhouseRead.query<{
    dow: number;
    hour: number;
    wager: string;
    deposits: string;
  }>({ queryName: "analytics.heatmap", sql, params });

  const cells: HeatmapCellCh[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      cells.push({ dayOfWeek: dow, hour, wager: 0, deposits: 0 });
    }
  }
  const index = (dow: number, hour: number): number => dow * 24 + hour;

  let maxWager = 0;
  let maxDeposits = 0;
  let totalWager = 0;
  let totalDeposits = 0;

  for (const r of rows) {
    const cell = cells[index(Number(r.dow), Number(r.hour))];
    if (!cell) continue;
    const wager = toNumber(r.wager);
    const deposits = Number(r.deposits);
    cell.wager = wager;
    cell.deposits = deposits;
    if (wager > maxWager) maxWager = wager;
    if (deposits > maxDeposits) maxDeposits = deposits;
    totalWager += wager;
    totalDeposits += deposits;
  }

  return {
    period,
    cells,
    maxWager,
    maxDeposits,
    totalWager,
    totalDeposits,
  };
}
