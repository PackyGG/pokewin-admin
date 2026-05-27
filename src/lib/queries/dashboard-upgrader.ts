import { cache } from "react";
import { getDb } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { withTiming } from "@/lib/observability/query-timings";
import { MS_PER_DAY, MS_PER_HOUR } from "@/lib/utils/time";
import { blacklistNotInClause } from "./_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * Upgrader Stats section on /dashboard. A dedicated raw query that
 * doesn't bolt onto getDashboardStats — it's section-scoped and
 * streams behind its own Suspense, so the main KPI strips don't pay
 * for it. All numbers are house-POV:
 *   wager   = SUM(|amount|) over upgrader_bet rows
 *   payouts = SUM(|amount|) over upgrader_payout rows
 *   pnl     = wager − payouts (positive = house gained)
 *   edge    = pnl / wager * 100 (house edge %)
 *   bets    = COUNT(upgrader_bet rows)
 *   avgBet  = wager / bets
 *   players = COUNT(DISTINCT user_id) on upgrader_bet rows
 *
 * Staff (admin / support) + the excluded-users blacklist are dropped,
 * matching every other dashboard aggregate. Returns the full chip set
 * the other period cards use (1h / 3h / 6h / 12h / 24h / 3d / 7d /
 * 30d / all) so the section can flip windows client-side without a
 * roundtrip.
 */

const RANGES = ["1h", "3h", "6h", "12h", "24h", "3d", "7d", "30d", "all"] as const;
export type UpgraderPeriod = (typeof RANGES)[number];

export type UpgraderPeriodStats = {
  wager: number;
  payouts: number;
  pnl: number;
  edge: number;
  bets: number;
  avgBet: number;
  uniquePlayers: number;
};

export type UpgraderStats = Record<UpgraderPeriod, UpgraderPeriodStats>;

export const getUpgraderStats = cache(async (): Promise<UpgraderStats> => {
  return withTiming("dashboard.upgrader", () => upgraderStatsInner());
});

async function upgraderStatsInner(): Promise<UpgraderStats> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 1 * MS_PER_HOUR);
  const threeHoursAgo = new Date(now.getTime() - 3 * MS_PER_HOUR);
  const sixHoursAgo = new Date(now.getTime() - 6 * MS_PER_HOUR);
  const twelveHoursAgo = new Date(now.getTime() - 12 * MS_PER_HOUR);
  const twentyFourHoursAgo = new Date(now.getTime() - 1 * MS_PER_DAY);
  const threeDaysAgo = new Date(now.getTime() - 3 * MS_PER_DAY);
  const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_PER_DAY);

  // 36 columns: wager + payouts + bets + uniquePlayers per period × 9
  // periods. All driven off the same scan since the WHERE clause
  // narrows to just the upgrader rows.
  type Row = Record<string, string>;
  const rows = await db.$queryRaw<Row[]>`
    WITH real_users AS (
      SELECT id FROM "user"
      WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    )
    SELECT
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet'     AND created_at >= ${oneHourAgo}        THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager_1h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet'     AND created_at >= ${threeHoursAgo}     THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager_3h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet'     AND created_at >= ${sixHoursAgo}       THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager_6h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet'     AND created_at >= ${twelveHoursAgo}    THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager_12h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet'     AND created_at >= ${twentyFourHoursAgo} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager_24h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet'     AND created_at >= ${threeDaysAgo}     THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager_3d,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet'     AND created_at >= ${sevenDaysAgo}     THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager_7d,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet'     AND created_at >= ${thirtyDaysAgo}    THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager_30d,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet'                                            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager_all,

      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${oneHourAgo}        THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS payouts_1h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${threeHoursAgo}     THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS payouts_3h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${sixHoursAgo}       THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS payouts_6h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${twelveHoursAgo}    THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS payouts_12h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${twentyFourHoursAgo} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS payouts_24h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${threeDaysAgo}     THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS payouts_3d,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${sevenDaysAgo}     THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS payouts_7d,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${thirtyDaysAgo}    THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS payouts_30d,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'                                         THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS payouts_all,

      COUNT(CASE WHEN type = 'upgrader_bet' AND created_at >= ${oneHourAgo}        THEN 1 END)::text AS bets_1h,
      COUNT(CASE WHEN type = 'upgrader_bet' AND created_at >= ${threeHoursAgo}     THEN 1 END)::text AS bets_3h,
      COUNT(CASE WHEN type = 'upgrader_bet' AND created_at >= ${sixHoursAgo}       THEN 1 END)::text AS bets_6h,
      COUNT(CASE WHEN type = 'upgrader_bet' AND created_at >= ${twelveHoursAgo}    THEN 1 END)::text AS bets_12h,
      COUNT(CASE WHEN type = 'upgrader_bet' AND created_at >= ${twentyFourHoursAgo} THEN 1 END)::text AS bets_24h,
      COUNT(CASE WHEN type = 'upgrader_bet' AND created_at >= ${threeDaysAgo}     THEN 1 END)::text AS bets_3d,
      COUNT(CASE WHEN type = 'upgrader_bet' AND created_at >= ${sevenDaysAgo}     THEN 1 END)::text AS bets_7d,
      COUNT(CASE WHEN type = 'upgrader_bet' AND created_at >= ${thirtyDaysAgo}    THEN 1 END)::text AS bets_30d,
      COUNT(CASE WHEN type = 'upgrader_bet'                                        THEN 1 END)::text AS bets_all,

      COUNT(DISTINCT CASE WHEN type = 'upgrader_bet' AND created_at >= ${oneHourAgo}        THEN user_id END)::text AS players_1h,
      COUNT(DISTINCT CASE WHEN type = 'upgrader_bet' AND created_at >= ${threeHoursAgo}     THEN user_id END)::text AS players_3h,
      COUNT(DISTINCT CASE WHEN type = 'upgrader_bet' AND created_at >= ${sixHoursAgo}       THEN user_id END)::text AS players_6h,
      COUNT(DISTINCT CASE WHEN type = 'upgrader_bet' AND created_at >= ${twelveHoursAgo}    THEN user_id END)::text AS players_12h,
      COUNT(DISTINCT CASE WHEN type = 'upgrader_bet' AND created_at >= ${twentyFourHoursAgo} THEN user_id END)::text AS players_24h,
      COUNT(DISTINCT CASE WHEN type = 'upgrader_bet' AND created_at >= ${threeDaysAgo}     THEN user_id END)::text AS players_3d,
      COUNT(DISTINCT CASE WHEN type = 'upgrader_bet' AND created_at >= ${sevenDaysAgo}     THEN user_id END)::text AS players_7d,
      COUNT(DISTINCT CASE WHEN type = 'upgrader_bet' AND created_at >= ${thirtyDaysAgo}    THEN user_id END)::text AS players_30d,
      COUNT(DISTINCT CASE WHEN type = 'upgrader_bet'                                        THEN user_id END)::text AS players_all
    FROM ledger_transactions
    WHERE type IN ('upgrader_bet', 'upgrader_payout')
      AND status = 'completed'
      AND user_id IN (SELECT id FROM real_users)
  `;

  const r = rows[0] ?? {};
  const num = (key: string): number => parseFloat(r[key] ?? "0") || 0;

  const build = (period: UpgraderPeriod): UpgraderPeriodStats => {
    const wager = num(`wager_${period}`);
    const payouts = num(`payouts_${period}`);
    const bets = num(`bets_${period}`);
    const uniquePlayers = num(`players_${period}`);
    const pnl = wager - payouts;
    return {
      wager,
      payouts,
      pnl,
      // House edge as a percentage of total wager. 0 when there's no
      // wager so the tile reads "0.0%" instead of NaN.
      edge: wager > 0 ? (pnl / wager) * 100 : 0,
      bets,
      avgBet: bets > 0 ? wager / bets : 0,
      uniquePlayers,
    };
  };

  return RANGES.reduce<UpgraderStats>((acc, p) => {
    acc[p] = build(p);
    return acc;
  }, {} as UpgraderStats);
}
