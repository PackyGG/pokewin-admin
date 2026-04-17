import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Activity heatmap: 7 days × 24 hours of wager volume + deposit count.
 *
 * Buckets are aligned to UTC — the admin can rotate the display to their
 * local TZ in the UI if needed, but the storage bucket is universal.
 * Staff excluded.
 *
 * Returns two metrics per (day, hour) cell:
 *   • wager — sum of wager amount (pack_opening + battle_bet +
 *             battle_sponsorship) in the cell
 *   • deposits — count of completed deposit ledger rows in the cell
 *
 * Period-scoped. "All" periods cap at 180 days to keep the query cheap.
 */

export type HeatmapPeriod = "7d" | "30d" | "90d" | "all";

function daysForPeriod(period: HeatmapPeriod): number {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      // Cap to keep the query bounded — the heatmap is a rolling window,
      // not a true lifetime aggregate.
      return 180;
  }
}

export type HeatmapCell = {
  dayOfWeek: number; // 0 = Sunday (postgres DOW convention), 6 = Saturday
  hour: number;
  wager: number;
  deposits: number;
};

export type HeatmapData = {
  period: HeatmapPeriod;
  cells: HeatmapCell[]; // 7*24 = 168 entries, one per (dow, hour)
  maxWager: number;
  maxDeposits: number;
  totalWager: number;
  totalDeposits: number;
};

export async function getActivityHeatmap(
  period: HeatmapPeriod,
): Promise<HeatmapData> {
  const days = daysForPeriod(period);

  const rows = await db.$queryRawUnsafe<
    {
      dow: number;
      hour: number;
      wager: string;
      deposits: string;
    }[]
  >(`
    SELECT
      EXTRACT(DOW FROM lt.created_at)::int AS dow,
      EXTRACT(HOUR FROM lt.created_at)::int AS hour,
      COALESCE(SUM(CASE WHEN lt.type IN ('pack_opening','battle_bet','battle_sponsorship')
        THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS wager,
      COUNT(CASE WHEN lt.type = 'deposit' THEN 1 END)::text AS deposits
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','creator'))
      AND lt.created_at >= NOW() - INTERVAL '${days} days'
    GROUP BY EXTRACT(DOW FROM lt.created_at)::int, EXTRACT(HOUR FROM lt.created_at)::int
  `);

  // Seed a 7×24 grid with zeros so the heatmap renders a complete matrix
  // even for sparse periods.
  const cells: HeatmapCell[] = [];
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
    const cell = cells[index(r.dow, r.hour)];
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
