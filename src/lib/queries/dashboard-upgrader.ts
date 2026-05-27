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
 * for it.
 *
 * SOURCE OF TRUTH — `upgrader_games`, NOT `ledger_transactions`.
 * The backend debits the wager as an `upgrader_bet` ledger row but
 * never emits a matching `upgrader_payout` credit (see
 * backend/src/services/upgrader.service.ts — payout_ledger_tx_id is
 * always null). Aggregating payouts off the ledger therefore read 0,
 * which pinned the section at a fake 100% house edge. Both the wager
 * and the won value already live on `upgrader_games`, so every number
 * here is computed straight off that table:
 *   wager   = SUM(bet_amount)            — what players risked
 *   payouts = SUM(won_amount)            — gross value returned (0 on a loss)
 *   pnl     = wager − payouts (positive = house gained)
 *   edge    = pnl / wager * 100 (house edge %)
 *   bets    = COUNT(*) rows
 *   avgBet  = wager / bets
 *   players = COUNT(DISTINCT user_id)
 *
 * `won_amount` is the GROSS amount credited on a win (bet × cashout
 * multiplier, persisted to 2dp) and is 0 for losing plays, so
 * wager − SUM(won_amount) is the true house margin without any ledger
 * round-trip.
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
  // Outcome counts. A "win" is an upgrader_games row with
  // won_amount > 0; a "loss" is won_amount = 0. Hit rate is
  // `wins / bets` × 100.
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

  // 45 columns: wager + payouts + bets + uniquePlayers + wins per
  // period × 9 periods. All driven off a single scan of upgrader_games
  // narrowed to real users.
  //
  // Wager is bet_amount (always set on every row). Payouts is
  // won_amount — the gross value credited on a win, 0 for a loss — so
  // there's no ambiguity about where the won value lives (the ledger
  // round-trip the old query used never had a matching payout row).
  type Row = Record<string, string>;
  const rows = await db.$queryRaw<Row[]>`
    WITH real_users AS (
      SELECT id FROM "user"
      WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    )
    SELECT
      COALESCE(SUM(CASE WHEN created_at >= ${oneHourAgo}        THEN bet_amount::numeric ELSE 0 END), 0)::text AS wager_1h,
      COALESCE(SUM(CASE WHEN created_at >= ${threeHoursAgo}     THEN bet_amount::numeric ELSE 0 END), 0)::text AS wager_3h,
      COALESCE(SUM(CASE WHEN created_at >= ${sixHoursAgo}       THEN bet_amount::numeric ELSE 0 END), 0)::text AS wager_6h,
      COALESCE(SUM(CASE WHEN created_at >= ${twelveHoursAgo}    THEN bet_amount::numeric ELSE 0 END), 0)::text AS wager_12h,
      COALESCE(SUM(CASE WHEN created_at >= ${twentyFourHoursAgo} THEN bet_amount::numeric ELSE 0 END), 0)::text AS wager_24h,
      COALESCE(SUM(CASE WHEN created_at >= ${threeDaysAgo}      THEN bet_amount::numeric ELSE 0 END), 0)::text AS wager_3d,
      COALESCE(SUM(CASE WHEN created_at >= ${sevenDaysAgo}      THEN bet_amount::numeric ELSE 0 END), 0)::text AS wager_7d,
      COALESCE(SUM(CASE WHEN created_at >= ${thirtyDaysAgo}     THEN bet_amount::numeric ELSE 0 END), 0)::text AS wager_30d,
      COALESCE(SUM(bet_amount::numeric), 0)::text AS wager_all,

      COALESCE(SUM(CASE WHEN created_at >= ${oneHourAgo}        THEN won_amount::numeric ELSE 0 END), 0)::text AS payouts_1h,
      COALESCE(SUM(CASE WHEN created_at >= ${threeHoursAgo}     THEN won_amount::numeric ELSE 0 END), 0)::text AS payouts_3h,
      COALESCE(SUM(CASE WHEN created_at >= ${sixHoursAgo}       THEN won_amount::numeric ELSE 0 END), 0)::text AS payouts_6h,
      COALESCE(SUM(CASE WHEN created_at >= ${twelveHoursAgo}    THEN won_amount::numeric ELSE 0 END), 0)::text AS payouts_12h,
      COALESCE(SUM(CASE WHEN created_at >= ${twentyFourHoursAgo} THEN won_amount::numeric ELSE 0 END), 0)::text AS payouts_24h,
      COALESCE(SUM(CASE WHEN created_at >= ${threeDaysAgo}      THEN won_amount::numeric ELSE 0 END), 0)::text AS payouts_3d,
      COALESCE(SUM(CASE WHEN created_at >= ${sevenDaysAgo}      THEN won_amount::numeric ELSE 0 END), 0)::text AS payouts_7d,
      COALESCE(SUM(CASE WHEN created_at >= ${thirtyDaysAgo}     THEN won_amount::numeric ELSE 0 END), 0)::text AS payouts_30d,
      COALESCE(SUM(won_amount::numeric), 0)::text AS payouts_all,

      COUNT(CASE WHEN created_at >= ${oneHourAgo}        THEN 1 END)::text AS bets_1h,
      COUNT(CASE WHEN created_at >= ${threeHoursAgo}     THEN 1 END)::text AS bets_3h,
      COUNT(CASE WHEN created_at >= ${sixHoursAgo}       THEN 1 END)::text AS bets_6h,
      COUNT(CASE WHEN created_at >= ${twelveHoursAgo}    THEN 1 END)::text AS bets_12h,
      COUNT(CASE WHEN created_at >= ${twentyFourHoursAgo} THEN 1 END)::text AS bets_24h,
      COUNT(CASE WHEN created_at >= ${threeDaysAgo}      THEN 1 END)::text AS bets_3d,
      COUNT(CASE WHEN created_at >= ${sevenDaysAgo}      THEN 1 END)::text AS bets_7d,
      COUNT(CASE WHEN created_at >= ${thirtyDaysAgo}     THEN 1 END)::text AS bets_30d,
      COUNT(*)::text AS bets_all,

      COUNT(DISTINCT CASE WHEN created_at >= ${oneHourAgo}        THEN user_id END)::text AS players_1h,
      COUNT(DISTINCT CASE WHEN created_at >= ${threeHoursAgo}     THEN user_id END)::text AS players_3h,
      COUNT(DISTINCT CASE WHEN created_at >= ${sixHoursAgo}       THEN user_id END)::text AS players_6h,
      COUNT(DISTINCT CASE WHEN created_at >= ${twelveHoursAgo}    THEN user_id END)::text AS players_12h,
      COUNT(DISTINCT CASE WHEN created_at >= ${twentyFourHoursAgo} THEN user_id END)::text AS players_24h,
      COUNT(DISTINCT CASE WHEN created_at >= ${threeDaysAgo}      THEN user_id END)::text AS players_3d,
      COUNT(DISTINCT CASE WHEN created_at >= ${sevenDaysAgo}      THEN user_id END)::text AS players_7d,
      COUNT(DISTINCT CASE WHEN created_at >= ${thirtyDaysAgo}     THEN user_id END)::text AS players_30d,
      COUNT(DISTINCT user_id)::text AS players_all,

      -- Wins = rows with won_amount > 0. Losing plays persist a row
      -- with won_amount = 0, so losses fall out as bets − wins.
      COUNT(CASE WHEN won_amount::numeric > 0 AND created_at >= ${oneHourAgo}        THEN 1 END)::text AS wins_1h,
      COUNT(CASE WHEN won_amount::numeric > 0 AND created_at >= ${threeHoursAgo}     THEN 1 END)::text AS wins_3h,
      COUNT(CASE WHEN won_amount::numeric > 0 AND created_at >= ${sixHoursAgo}       THEN 1 END)::text AS wins_6h,
      COUNT(CASE WHEN won_amount::numeric > 0 AND created_at >= ${twelveHoursAgo}    THEN 1 END)::text AS wins_12h,
      COUNT(CASE WHEN won_amount::numeric > 0 AND created_at >= ${twentyFourHoursAgo} THEN 1 END)::text AS wins_24h,
      COUNT(CASE WHEN won_amount::numeric > 0 AND created_at >= ${threeDaysAgo}      THEN 1 END)::text AS wins_3d,
      COUNT(CASE WHEN won_amount::numeric > 0 AND created_at >= ${sevenDaysAgo}      THEN 1 END)::text AS wins_7d,
      COUNT(CASE WHEN won_amount::numeric > 0 AND created_at >= ${thirtyDaysAgo}     THEN 1 END)::text AS wins_30d,
      COUNT(CASE WHEN won_amount::numeric > 0                                        THEN 1 END)::text AS wins_all
    FROM upgrader_games
    WHERE user_id IN (SELECT id FROM real_users)
  `;

  const r = rows[0] ?? {};
  const num = (key: string): number => parseFloat(r[key] ?? "0") || 0;

  const build = (period: UpgraderPeriod): UpgraderPeriodStats => {
    const wager = num(`wager_${period}`);
    const payouts = num(`payouts_${period}`);
    const bets = num(`bets_${period}`);
    const uniquePlayers = num(`players_${period}`);
    const wins = num(`wins_${period}`);
    // Every game either won (won_amount > 0) or lost. Clamp at 0 for
    // defensive safety only — wins is a strict subset of bets here.
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
