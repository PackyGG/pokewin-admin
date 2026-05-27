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
  // Outcome counts. A "win" is an upgrader_bet that produced an
  // upgrader_payout row with amount > 0; a "loss" is everything else.
  // Hit rate is `wins / bets` × 100. Decoupled from `bets` so a future
  // change to losing-bets-produce-a-zero-payout-row doesn't double-
  // count outcomes.
  wins: number;
  losses: number;
  hitRate: number;
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
  //
  // Wager is read from |amount| on upgrader_bet rows (always set).
  // Payouts use the larger of |amount| and the positive balance
  // delta — different game modes ship the won value through different
  // fields (battle_refund / rain_win use balance delta; pack/upgrader
  // can leave amount = 0 and the value in metadata / inventory). The
  // GREATEST(...) picks whichever the backend actually populated for
  // upgrader_payout. If both end up 0 the won value lives in
  // user_inventory linked via the game_session and the dollar tile
  // shows 0 — the Wins COUNT still reflects how many plays won.
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

      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${oneHourAgo}        THEN GREATEST(ABS(amount::numeric), (balance_after - balance_before)::numeric, 0) ELSE 0 END), 0)::text AS payouts_1h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${threeHoursAgo}     THEN GREATEST(ABS(amount::numeric), (balance_after - balance_before)::numeric, 0) ELSE 0 END), 0)::text AS payouts_3h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${sixHoursAgo}       THEN GREATEST(ABS(amount::numeric), (balance_after - balance_before)::numeric, 0) ELSE 0 END), 0)::text AS payouts_6h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${twelveHoursAgo}    THEN GREATEST(ABS(amount::numeric), (balance_after - balance_before)::numeric, 0) ELSE 0 END), 0)::text AS payouts_12h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${twentyFourHoursAgo} THEN GREATEST(ABS(amount::numeric), (balance_after - balance_before)::numeric, 0) ELSE 0 END), 0)::text AS payouts_24h,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${threeDaysAgo}     THEN GREATEST(ABS(amount::numeric), (balance_after - balance_before)::numeric, 0) ELSE 0 END), 0)::text AS payouts_3d,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${sevenDaysAgo}     THEN GREATEST(ABS(amount::numeric), (balance_after - balance_before)::numeric, 0) ELSE 0 END), 0)::text AS payouts_7d,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'  AND created_at >= ${thirtyDaysAgo}    THEN GREATEST(ABS(amount::numeric), (balance_after - balance_before)::numeric, 0) ELSE 0 END), 0)::text AS payouts_30d,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout'                                         THEN GREATEST(ABS(amount::numeric), (balance_after - balance_before)::numeric, 0) ELSE 0 END), 0)::text AS payouts_all,

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
      COUNT(DISTINCT CASE WHEN type = 'upgrader_bet'                                        THEN user_id END)::text AS players_all,

      -- Wins = every upgrader_payout row that exists in the window.
      -- The backend emits this type ONLY on a winning upgrade — losing
      -- plays just consume the input card and never produce a payout
      -- row. No amount / balance-delta filter so wins count holds even
      -- when the actual won value lives in a different field (e.g.
      -- inventory-side card value rather than the ledger amount).
      -- Losses are derived as bets − wins in Node so the row count
      -- stays a single ledger scan.
      COUNT(CASE WHEN type = 'upgrader_payout' AND created_at >= ${oneHourAgo}        THEN 1 END)::text AS wins_1h,
      COUNT(CASE WHEN type = 'upgrader_payout' AND created_at >= ${threeHoursAgo}     THEN 1 END)::text AS wins_3h,
      COUNT(CASE WHEN type = 'upgrader_payout' AND created_at >= ${sixHoursAgo}       THEN 1 END)::text AS wins_6h,
      COUNT(CASE WHEN type = 'upgrader_payout' AND created_at >= ${twelveHoursAgo}    THEN 1 END)::text AS wins_12h,
      COUNT(CASE WHEN type = 'upgrader_payout' AND created_at >= ${twentyFourHoursAgo} THEN 1 END)::text AS wins_24h,
      COUNT(CASE WHEN type = 'upgrader_payout' AND created_at >= ${threeDaysAgo}     THEN 1 END)::text AS wins_3d,
      COUNT(CASE WHEN type = 'upgrader_payout' AND created_at >= ${sevenDaysAgo}     THEN 1 END)::text AS wins_7d,
      COUNT(CASE WHEN type = 'upgrader_payout' AND created_at >= ${thirtyDaysAgo}    THEN 1 END)::text AS wins_30d,
      COUNT(CASE WHEN type = 'upgrader_payout'                                        THEN 1 END)::text AS wins_all
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
    const wins = num(`wins_${period}`);
    // Losses are derived: every bet either won (had a positive payout)
    // or lost. Clamp at 0 in case the wins count exceeds bets due to
    // edge cases (e.g. an upgrader_payout that lacks a matching bet in
    // the same window).
    const losses = Math.max(0, bets - wins);
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
      wins,
      losses,
      // Hit rate as a % of all bets. 0 when there are no bets in the
      // window so the tile reads "0.0%" instead of NaN.
      hitRate: bets > 0 ? (wins / bets) * 100 : 0,
    };
  };

  return RANGES.reduce<UpgraderStats>((acc, p) => {
    acc[p] = build(p);
    return acc;
  }, {} as UpgraderStats);
}
