import { blacklistNotInSql, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";
import {
  DEPOSIT_BONUS_CACHE_TAGS,
  getResolvedBlacklist,
  windowDateFilter,
} from "./_shared";

/**
 * Top 25 bonus recipients for the active window.
 *
 * Each row carries:
 *   - userId / username (link target for /users/[id])
 *   - bonusTotal — total deposit_bonus volume in window
 *   - bonusCount — number of claims in window
 *   - lifetimeBonusTotal — total deposit_bonus volume ALL TIME (so
 *     admins see whether a top spender is a window-only spike or a
 *     long-term recipient)
 *   - depositTotal — deposit volume in window
 *   - wagerTotal — wager-side ledger volume in window
 *   - payoutTotal — payout-side ledger volume in window
 *   - pnlInWindow — wager − payouts (= GGR contribution in window)
 *
 * Staff + blacklist excluded. Read-only. Cached per (period, blacklist).
 */

const WAGER_TYPES_SQL = `(
  'pack_opening','battle_bet','battle_sponsorship','upgrader_bet'
)`;
const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout')`;

const TOP_LIMIT = 25;

export type DepositBonusTopSpender = {
  userId: string;
  username: string | null;
  bonusTotal: number;
  bonusCount: number;
  lifetimeBonusTotal: number;
  lifetimeBonusCount: number;
  depositTotal: number;
  wagerTotal: number;
  payoutTotal: number;
  /** wager − payouts in window (GGR contribution). */
  pnlInWindow: number;
};

async function computeTopSpenders(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusTopSpender[]> {
  const db = await getReadDrizzleDb();
  const dateFilter = windowDateFilter(period);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // Per-user windowed bonus rollup → top 25 → join lifetime + wager /
  // payout / deposit rollups all bounded to the window.
  const rows = await queryRows<
    {
      user_id: string;
      username: string | null;
      bonus_total: string;
      bonus_count: string;
      lifetime_bonus_total: string;
      lifetime_bonus_count: string;
      deposit_total: string;
      wager_total: string;
      payout_total: string;
    }[]
  >(db, sql`
    WITH window_bonus AS (
      SELECT
        lt.user_id,
        SUM(ABS(lt.amount::numeric)) AS bonus_total,
        COUNT(*)::int AS bonus_count
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
        ${dateFilter}
      GROUP BY lt.user_id
      ORDER BY SUM(ABS(lt.amount::numeric)) DESC
      LIMIT ${TOP_LIMIT}
    ),
    lifetime_bonus AS (
      SELECT
        lt.user_id,
        SUM(ABS(lt.amount::numeric)) AS lifetime_bonus_total,
        COUNT(*)::int AS lifetime_bonus_count
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN (SELECT user_id FROM window_bonus)
      GROUP BY lt.user_id
    ),
    window_deposits AS (
      SELECT lt.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS deposit_total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit'
        AND lt.user_id IN (SELECT user_id FROM window_bonus)
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    window_wager AS (
      SELECT lt.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS wager_total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)}
        AND lt.user_id IN (SELECT user_id FROM window_bonus)
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    window_payout AS (
      SELECT lt.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS payout_total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${sql.raw(PAYOUT_TYPES_SQL)}
        AND lt.user_id IN (SELECT user_id FROM window_bonus)
        ${dateFilter}
      GROUP BY lt.user_id
    )
    SELECT
      wb.user_id,
      u.username,
      wb.bonus_total::text AS bonus_total,
      wb.bonus_count::text AS bonus_count,
      COALESCE(lb.lifetime_bonus_total, wb.bonus_total)::text AS lifetime_bonus_total,
      COALESCE(lb.lifetime_bonus_count, wb.bonus_count)::text AS lifetime_bonus_count,
      COALESCE(wd.deposit_total, 0)::text AS deposit_total,
      COALESCE(ww.wager_total, 0)::text AS wager_total,
      COALESCE(wp.payout_total, 0)::text AS payout_total
    FROM window_bonus wb
    JOIN "user" u ON u.id = wb.user_id
    LEFT JOIN lifetime_bonus lb ON lb.user_id = wb.user_id
    LEFT JOIN window_deposits wd ON wd.user_id = wb.user_id
    LEFT JOIN window_wager ww ON ww.user_id = wb.user_id
    LEFT JOIN window_payout wp ON wp.user_id = wb.user_id
    ORDER BY wb.bonus_total DESC
  `);

  return rows.map((r) => {
    const wagerTotal = toNumber(r.wager_total);
    const payoutTotal = toNumber(r.payout_total);
    return {
      userId: r.user_id,
      username: r.username,
      bonusTotal: toNumber(r.bonus_total),
      bonusCount: Number(r.bonus_count ?? 0),
      lifetimeBonusTotal: toNumber(r.lifetime_bonus_total),
      lifetimeBonusCount: Number(r.lifetime_bonus_count ?? 0),
      depositTotal: toNumber(r.deposit_total),
      wagerTotal,
      payoutTotal,
      pnlInWindow: wagerTotal - payoutTotal,
    };
  });
}

const cachedTopSpenders = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTopSpenders(period, blacklistIds),
  ["insights-rewards-deposit-bonus-top-spenders-v2"],
  { revalidate: 60, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

const cachedTopSpendersLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTopSpenders(period, blacklistIds),
  ["insights-rewards-deposit-bonus-top-spenders-lifetime-v2"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusTopSpenders(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusTopSpender[]> {
  const blacklist = await getResolvedBlacklist();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedTopSpendersLifetime(period, blacklist)
    : cachedTopSpenders(period, blacklist);
}
