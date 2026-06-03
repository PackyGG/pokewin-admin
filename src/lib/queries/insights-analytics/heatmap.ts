import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { periodToDays, type InsightsPeriod } from "@/app/(admin)/insights/analytics/types";

/**
 * 7×24 activity heatmap with multi-metric support. Per cell, we
 * compute six values so a metric toggle in the UI flips between
 * them with no extra DB hit:
 *   • signups   — count of new user rows (no ledger join)
 *   • deposits  — count of completed deposit ledger rows
 *   • withdrawals — count of completed/shipped card_withdrawal_requests
 *   • wager     — sum of customer wager (no creator on-stream play)
 *   • pnl       — wager − payouts (house gain, can go negative)
 *   • active    — distinct active users
 *
 * Period scopes the window. Lifetime caps at 180 days so the query
 * stays bounded.
 *
 * Staff (admin/support) + manual blacklist excluded.
 */

export type HeatmapMetric =
  | "signups"
  | "deposits"
  | "withdrawals"
  | "wager"
  | "pnl"
  | "active";

export function parseHeatmapMetric(value: string | undefined): HeatmapMetric {
  switch (value) {
    case "signups":
    case "deposits":
    case "withdrawals":
    case "wager":
    case "pnl":
    case "active":
      return value;
    default:
      return "wager";
  }
}

export type HeatmapCellValues = {
  signups: number;
  deposits: number;
  withdrawals: number;
  wager: number;
  pnl: number;
  active: number;
};

export type HeatmapCell = HeatmapCellValues & {
  dayOfWeek: number; // 0 = Sunday
  hour: number;
};

export type HeatmapData = {
  period: InsightsPeriod;
  cells: HeatmapCell[];
  totals: HeatmapCellValues;
  // Per-metric max — needed so the UI can normalize each metric
  // independently without scanning the cells client-side.
  maxes: HeatmapCellValues;
};

export async function getInsightsHeatmap(period: InsightsPeriod): Promise<HeatmapData> {
  const db = await getDb();
  const days = periodToDays(period) ?? 180;
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);

  // Two raws — one for ledger-derived metrics, one for the signup
  // count which lives on the user table (no ledger join).
  const [ledgerRows, signupRows, withdrawalRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        dow: number;
        hour: number;
        deposits: string;
        wager: string;
        payouts: string;
        active: string;
      }[]
    >(`
      SELECT
        EXTRACT(DOW FROM lt.created_at)::int AS dow,
        EXTRACT(HOUR FROM lt.created_at)::int AS hour,
        COUNT(CASE WHEN lt.type::text = 'deposit' THEN 1 END)::text AS deposits,
        COALESCE(SUM(CASE WHEN lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
          THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS wager,
        COALESCE(SUM(CASE WHEN lt.type::text IN ('battle_refund','upgrader_payout','card_sale','reward_card_sale')
          THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS payouts,
        COUNT(DISTINCT lt.user_id)::text AS active
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn})
        AND lt.created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY EXTRACT(DOW FROM lt.created_at)::int, EXTRACT(HOUR FROM lt.created_at)::int
    `),
    db.$queryRawUnsafe<{ dow: number; hour: number; count: string }[]>(`
      SELECT
        EXTRACT(DOW FROM created_at)::int AS dow,
        EXTRACT(HOUR FROM created_at)::int AS hour,
        COUNT(*)::text AS count
      FROM "user"
      WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        AND created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY EXTRACT(DOW FROM created_at)::int, EXTRACT(HOUR FROM created_at)::int
    `),
    db.$queryRawUnsafe<{ dow: number; hour: number; count: string }[]>(`
      SELECT
        EXTRACT(DOW FROM COALESCE(cwr.completed_at, cwr.shipped_at))::int AS dow,
        EXTRACT(HOUR FROM COALESCE(cwr.completed_at, cwr.shipped_at))::int AS hour,
        COUNT(*)::text AS count
      FROM card_withdrawal_requests cwr
      WHERE cwr.status IN ('completed', 'shipped')
        AND COALESCE(cwr.completed_at, cwr.shipped_at) >= NOW() - INTERVAL '${days} days'
        AND cwr.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistIdNotIn})
      GROUP BY EXTRACT(DOW FROM COALESCE(cwr.completed_at, cwr.shipped_at))::int,
               EXTRACT(HOUR FROM COALESCE(cwr.completed_at, cwr.shipped_at))::int
    `),
  ]);

  // Seed a 7×24 grid so the UI always renders a complete matrix even
  // for sparse periods.
  const cells: HeatmapCell[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      cells.push({
        dayOfWeek: dow,
        hour,
        signups: 0,
        deposits: 0,
        withdrawals: 0,
        wager: 0,
        pnl: 0,
        active: 0,
      });
    }
  }
  const index = (dow: number, hour: number) => dow * 24 + hour;

  const totals: HeatmapCellValues = {
    signups: 0,
    deposits: 0,
    withdrawals: 0,
    wager: 0,
    pnl: 0,
    active: 0,
  };
  const maxes: HeatmapCellValues = {
    signups: 0,
    deposits: 0,
    withdrawals: 0,
    wager: 0,
    pnl: 0,
    active: 0,
  };

  for (const r of ledgerRows) {
    const c = cells[index(r.dow, r.hour)];
    if (!c) continue;
    c.deposits = Number(r.deposits);
    c.wager = toNumber(r.wager);
    c.pnl = c.wager - toNumber(r.payouts);
    c.active = Number(r.active);
    totals.deposits += c.deposits;
    totals.wager += c.wager;
    totals.pnl += c.pnl;
    totals.active += c.active;
  }
  for (const r of signupRows) {
    const c = cells[index(r.dow, r.hour)];
    if (!c) continue;
    c.signups = Number(r.count);
    totals.signups += c.signups;
  }
  for (const r of withdrawalRows) {
    const c = cells[index(r.dow, r.hour)];
    if (!c) continue;
    c.withdrawals = Number(r.count);
    totals.withdrawals += c.withdrawals;
  }
  for (const c of cells) {
    if (c.signups > maxes.signups) maxes.signups = c.signups;
    if (c.deposits > maxes.deposits) maxes.deposits = c.deposits;
    if (c.withdrawals > maxes.withdrawals) maxes.withdrawals = c.withdrawals;
    if (c.wager > maxes.wager) maxes.wager = c.wager;
    // PnL can go negative; use absolute max so both directions can color
    // proportionally.
    if (Math.abs(c.pnl) > maxes.pnl) maxes.pnl = Math.abs(c.pnl);
    if (c.active > maxes.active) maxes.active = c.active;
  }

  return { period, cells, totals, maxes };
}
