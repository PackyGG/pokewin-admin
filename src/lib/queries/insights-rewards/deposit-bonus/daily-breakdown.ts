import { queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";
import {
  DEPOSIT_BONUS_CACHE_TAGS,
  getResolvedBlacklist,
  staffAndBlacklistSubquery,
  windowDateFilterCapped,
} from "./_shared";

/**
 * Day-by-day breakdown table for the period.
 *
 * For each day in window:
 *   - deposits count + deposits volume
 *   - deposits-with-bonus count
 *   - bonus volume
 *   - bonus / deposit ratio for the day
 *   - avg bonus per claim
 *   - distinct claimants
 *
 * Lifetime windows cap the table at the latest 60 days so the page
 * doesn't render a thousand rows.
 *
 * Staff + blacklist excluded. Read-only.
 */

export type DepositBonusDailyRow = {
  /** ISO date (yyyy-mm-dd). */
  date: string;
  depositCount: number;
  depositVolume: number;
  depositWithBonusCount: number;
  bonusCount: number;
  bonusVolume: number;
  uniqueClaimants: number;
  /** bonusVolume / depositVolume, or 0 when no deposits. */
  bonusToDepositRatio: number;
  /** depositWithBonusCount / depositCount, or 0. */
  attachRate: number;
  /** bonusVolume / bonusCount, or 0. */
  avgBonus: number;
};

const LIFETIME_DAY_LIMIT = 60;

async function computeDailyBreakdown(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusDailyRow[]> {
  const db = await getReadDrizzleDb();
  const days = daysForInsightsPeriod(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);
  // Lifetime is capped to the pairing lookback (365d) so the per-day
  // `with_bonus` EXISTS pairing doesn't scan the full deposit history.
  // The table itself is additionally row-capped below.
  const dateFilter = windowDateFilterCapped(period, "lt");
  const dateFilterD = windowDateFilterCapped(period, "d");
  const limitClause =
    days === null ? sql`LIMIT ${LIFETIME_DAY_LIMIT}` : sql.raw("");

  // Three small per-day rollups joined on date — deposits / bonuses /
  // bonus-attached deposits via the canonical pairing rule.
  const rows = await queryRows<
    {
      date: Date | string;
      deposit_count: string;
      deposit_volume: string;
      with_bonus_count: string;
      bonus_count: string;
      bonus_volume: string;
      claimants: string;
    }[]
  >(db, sql`
    WITH deposits AS (
      SELECT
        DATE(d.created_at) AS date,
        COUNT(*)::int AS deposit_count,
        COALESCE(SUM(ABS(d.amount::numeric)), 0)::numeric AS deposit_volume
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type::text = 'deposit'
        AND d.user_id IN ${userScope}
        ${dateFilterD}
      GROUP BY DATE(d.created_at)
    ),
    bonuses AS (
      SELECT
        DATE(lt.created_at) AS date,
        COUNT(*)::int AS bonus_count,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::numeric AS bonus_volume,
        COUNT(DISTINCT lt.user_id)::int AS claimants
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
      GROUP BY DATE(lt.created_at)
    ),
    with_bonus AS (
      SELECT
        DATE(d.created_at) AS date,
        COUNT(*)::int AS with_bonus_count
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type::text = 'deposit'
        AND d.user_id IN ${userScope}
        ${dateFilterD}
        AND EXISTS (
          SELECT 1 FROM ledger_transactions lt
          WHERE lt.user_id = d.user_id
            AND lt.type::text = 'deposit_bonus'
            AND lt.status = 'completed'
            AND lt.balance_before::numeric = d.balance_after::numeric
            AND lt.created_at >= d.created_at
            AND lt.created_at < d.created_at + INTERVAL '30 seconds'
        )
      GROUP BY DATE(d.created_at)
    ),
    all_dates AS (
      SELECT date FROM deposits
      UNION
      SELECT date FROM bonuses
      UNION
      SELECT date FROM with_bonus
    )
    SELECT
      ad.date,
      COALESCE(d.deposit_count, 0)::text AS deposit_count,
      COALESCE(d.deposit_volume, 0)::text AS deposit_volume,
      COALESCE(wb.with_bonus_count, 0)::text AS with_bonus_count,
      COALESCE(b.bonus_count, 0)::text AS bonus_count,
      COALESCE(b.bonus_volume, 0)::text AS bonus_volume,
      COALESCE(b.claimants, 0)::text AS claimants
    FROM all_dates ad
    LEFT JOIN deposits d ON d.date = ad.date
    LEFT JOIN bonuses b ON b.date = ad.date
    LEFT JOIN with_bonus wb ON wb.date = ad.date
    ORDER BY ad.date DESC
    ${limitClause}
  `);

  return rows.map((r) => {
    const depositCount = Number(r.deposit_count ?? 0);
    const depositVolume = toNumber(r.deposit_volume);
    const bonusCount = Number(r.bonus_count ?? 0);
    const bonusVolume = toNumber(r.bonus_volume);
    const withBonusCount = Number(r.with_bonus_count ?? 0);
    return {
      date: new Date(r.date).toISOString().split("T")[0],
      depositCount,
      depositVolume,
      depositWithBonusCount: withBonusCount,
      bonusCount,
      bonusVolume,
      uniqueClaimants: Number(r.claimants ?? 0),
      bonusToDepositRatio:
        depositVolume > 0 ? bonusVolume / depositVolume : 0,
      attachRate: depositCount > 0 ? withBonusCount / depositCount : 0,
      avgBonus: bonusCount > 0 ? bonusVolume / bonusCount : 0,
    };
  });
}

const cachedDailyBreakdown = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeDailyBreakdown(period, blacklistIds),
  ["insights-rewards-deposit-bonus-daily-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusDailyBreakdown(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusDailyRow[]> {
  const blacklist = await getResolvedBlacklist();
  return cachedDailyBreakdown(period, blacklist);
}
