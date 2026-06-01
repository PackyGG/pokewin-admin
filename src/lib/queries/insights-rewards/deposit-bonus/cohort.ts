import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";
import {
  DEPOSIT_BONUS_CACHE_TAGS,
  getResolvedBlacklist,
  staffAndBlacklistSubquery,
  windowDateFilter,
} from "./_shared";

/**
 * Cohort comparison + ratio histogram for /insights/rewards/deposit-bonus.
 *
 * Compares completed deposits in the window split by whether they
 * triggered a deposit_bonus claim:
 *
 *   - with-bonus  / without-bonus  → count, sum, avg, median
 *   - top-1% deposit size per side
 *   - 7d / 30d retention via subsequent wager activity after the deposit
 *
 * Plus the bonus / deposit ratio histogram in 5 fixed buckets
 * (matches the existing legacy helper in `deposit-bonus-analytics.ts`)
 * + a continuous mean / median ratio.
 *
 * Bonus↔deposit pairing rule: `bonus.balance_before == deposit.balance_after`
 * within 30 seconds of the deposit. Same rule used by every other
 * surface that joins the two (dashboard-live.ts + deposit-bonus-analytics.ts).
 *
 * Staff + blacklist excluded. Read-only. Heavy SQL — cached with a
 * 5-minute revalidate on lifetime windows.
 */

const RATIO_LABELS = ["0–5%", "5–15%", "15–30%", "30–60%", "60%+"] as const;

export type DepositBonusCohortComparison = {
  /** Total completed deposits in window. */
  totalDeposits: number;
  withBonus: {
    count: number;
    sum: number;
    avg: number;
    median: number;
    /** 99th-percentile deposit size. */
    p99: number;
    /** Distinct depositors. */
    uniqueUsers: number;
    /** 7-day return rate — share of users who wagered again within 7d of deposit. */
    retain7d: number;
    /** 30-day return rate — share of users who wagered again within 30d of deposit. */
    retain30d: number;
  };
  withoutBonus: {
    count: number;
    sum: number;
    avg: number;
    median: number;
    p99: number;
    uniqueUsers: number;
    retain7d: number;
    retain30d: number;
  };
  /** Avg-deposit lift (with − without) / without. */
  avgLiftPct: number;
  /** Median-deposit lift. */
  medianLiftPct: number;
  /** 7d retention lift. */
  retain7dLiftPct: number;
  /** 30d retention lift. */
  retain30dLiftPct: number;
  /** Bonus / deposit ratio bucketed histogram (5 buckets). */
  ratioBuckets: Array<{ label: string; count: number; volume: number }>;
  /** Mean of bonus/deposit ratio across paired rows (0..1). */
  meanRatio: number;
  /** Median bonus/deposit ratio. */
  medianRatio: number;
};

async function computeCohortComparison(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusCohortComparison> {
  const db = await getDb();
  const dateFilter = windowDateFilter(period, "d");
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  // CTE pairs every deposit to its (optional) deposit_bonus row,
  // computes per-row aggregates and per-side retention. Bonus pairing
  // rule = canonical 30s + balance match.
  const splitRows = await db.$queryRawUnsafe<
    {
      side: "with" | "without";
      cnt: string;
      sum_dep: string;
      avg_dep: string | null;
      median_dep: string | null;
      p99_dep: string | null;
      users: string;
      ret7: string;
      ret30: string;
    }[]
  >(`
    WITH window_deposits AS (
      SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type = 'deposit'
        AND d.user_id IN ${userScope}
        ${dateFilter}
    ),
    paired AS (
      SELECT
        wd.id,
        wd.user_id,
        wd.created_at,
        ABS(wd.deposit_amt) AS deposit_usd,
        b.bonus_usd
      FROM window_deposits wd
      LEFT JOIN LATERAL (
        SELECT ABS(lt.amount::numeric) AS bonus_usd
        FROM ledger_transactions lt
        WHERE lt.user_id = wd.user_id
          AND lt.type = 'deposit_bonus'
          AND lt.status = 'completed'
          AND lt.balance_before::numeric = wd.bal_after
          AND lt.created_at >= wd.created_at
          AND lt.created_at < wd.created_at + INTERVAL '30 seconds'
        ORDER BY lt.created_at ASC
        LIMIT 1
      ) b ON TRUE
    ),
    retention AS (
      SELECT
        p.id,
        p.user_id,
        p.bonus_usd,
        p.deposit_usd,
        EXISTS (
          SELECT 1 FROM ledger_transactions w
          WHERE w.user_id = p.user_id
            AND w.status = 'completed'
            AND w.type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
            AND w.created_at > p.created_at + INTERVAL '1 hour'
            AND w.created_at <= p.created_at + INTERVAL '7 days'
        ) AS r7,
        EXISTS (
          SELECT 1 FROM ledger_transactions w
          WHERE w.user_id = p.user_id
            AND w.status = 'completed'
            AND w.type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
            AND w.created_at > p.created_at + INTERVAL '1 hour'
            AND w.created_at <= p.created_at + INTERVAL '30 days'
        ) AS r30
      FROM paired p
    )
    SELECT
      CASE WHEN bonus_usd IS NOT NULL THEN 'with' ELSE 'without' END AS side,
      COUNT(*)::text AS cnt,
      COALESCE(SUM(deposit_usd), 0)::text AS sum_dep,
      AVG(deposit_usd)::text AS avg_dep,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY deposit_usd)::text AS median_dep,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY deposit_usd)::text AS p99_dep,
      COUNT(DISTINCT user_id)::text AS users,
      COUNT(*) FILTER (WHERE r7)::text AS ret7,
      COUNT(*) FILTER (WHERE r30)::text AS ret30
    FROM retention
    GROUP BY 1
  `);

  const parseSide = (
    row: (typeof splitRows)[number] | undefined,
    side: "with" | "without",
  ): DepositBonusCohortComparison["withBonus"] => {
    if (!row || row.side !== side) {
      return {
        count: 0,
        sum: 0,
        avg: 0,
        median: 0,
        p99: 0,
        uniqueUsers: 0,
        retain7d: 0,
        retain30d: 0,
      };
    }
    const count = Number(row.cnt ?? 0);
    return {
      count,
      sum: toNumber(row.sum_dep),
      avg: row.avg_dep != null ? toNumber(row.avg_dep) : 0,
      median: row.median_dep != null ? toNumber(row.median_dep) : 0,
      p99: row.p99_dep != null ? toNumber(row.p99_dep) : 0,
      uniqueUsers: Number(row.users ?? 0),
      retain7d: count > 0 ? Number(row.ret7 ?? 0) / count : 0,
      retain30d: count > 0 ? Number(row.ret30 ?? 0) / count : 0,
    };
  };

  const withRow = splitRows.find((r) => r.side === "with");
  const withoutRow = splitRows.find((r) => r.side === "without");
  const withBonus = parseSide(withRow, "with");
  const withoutBonus = parseSide(withoutRow, "without");
  const totalDeposits = withBonus.count + withoutBonus.count;

  const liftPct = (a: number, b: number): number =>
    b > 0 ? ((a - b) / b) * 100 : 0;

  // Ratio histogram + mean/median ratio — separate query, only paired
  // rows. Same bucket definitions as `deposit-bonus-analytics.ts`.
  const ratioRows = await db.$queryRawUnsafe<
    {
      bucket: number;
      cnt: string;
      volume: string;
      mean_ratio: string | null;
      median_ratio: string | null;
    }[]
  >(`
    WITH window_deposits AS (
      SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type = 'deposit'
        AND d.user_id IN ${userScope}
        ${dateFilter}
    ),
    paired AS (
      SELECT
        ABS(wd.deposit_amt) AS deposit_usd,
        b.bonus_usd,
        b.bonus_usd / NULLIF(ABS(wd.deposit_amt), 0) AS ratio
      FROM window_deposits wd
      JOIN LATERAL (
        SELECT ABS(lt.amount::numeric) AS bonus_usd
        FROM ledger_transactions lt
        WHERE lt.user_id = wd.user_id
          AND lt.type = 'deposit_bonus'
          AND lt.status = 'completed'
          AND lt.balance_before::numeric = wd.bal_after
          AND lt.created_at >= wd.created_at
          AND lt.created_at < wd.created_at + INTERVAL '30 seconds'
        ORDER BY lt.created_at ASC
        LIMIT 1
      ) b ON TRUE
      WHERE wd.deposit_amt <> 0
    )
    SELECT
      CASE
        WHEN deposit_usd <= 0 THEN 0
        WHEN ratio * 100 < 5  THEN 0
        WHEN ratio * 100 < 15 THEN 1
        WHEN ratio * 100 < 30 THEN 2
        WHEN ratio * 100 < 60 THEN 3
        ELSE 4
      END AS bucket,
      COUNT(*)::text AS cnt,
      SUM(bonus_usd)::text AS volume,
      AVG(ratio)::text AS mean_ratio,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ratio)::text AS median_ratio
    FROM paired
    GROUP BY 1
  `);

  const buckets: DepositBonusCohortComparison["ratioBuckets"] =
    RATIO_LABELS.map((label) => ({ label, count: 0, volume: 0 }));
  let meanNumerator = 0;
  let meanDenominator = 0;
  for (const r of ratioRows) {
    const idx = Number(r.bucket);
    const cnt = Number(r.cnt ?? 0);
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx].count = cnt;
      buckets[idx].volume = toNumber(r.volume);
    }
    // Build a count-weighted mean across buckets. Each bucket carries
    // an AVG(ratio) restricted to that bucket → recompose into a
    // global mean by weighting by the bucket count.
    if (r.mean_ratio != null && cnt > 0) {
      meanNumerator += toNumber(r.mean_ratio) * cnt;
      meanDenominator += cnt;
    }
  }
  // Better-quality global median via a second small query — sample
  // size ~= paired rows. Cheap enough on the windowed set.
  const globalMedianRows = await db.$queryRawUnsafe<
    { median_ratio: string | null }[]
  >(`
    WITH window_deposits AS (
      SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type = 'deposit'
        AND d.user_id IN ${userScope}
        ${dateFilter}
    ),
    paired AS (
      SELECT b.bonus_usd / NULLIF(ABS(wd.deposit_amt), 0) AS ratio
      FROM window_deposits wd
      JOIN LATERAL (
        SELECT ABS(lt.amount::numeric) AS bonus_usd
        FROM ledger_transactions lt
        WHERE lt.user_id = wd.user_id
          AND lt.type = 'deposit_bonus'
          AND lt.status = 'completed'
          AND lt.balance_before::numeric = wd.bal_after
          AND lt.created_at >= wd.created_at
          AND lt.created_at < wd.created_at + INTERVAL '30 seconds'
        ORDER BY lt.created_at ASC
        LIMIT 1
      ) b ON TRUE
      WHERE wd.deposit_amt <> 0
    )
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ratio)::text AS median_ratio
    FROM paired
  `);
  const medianRatio =
    globalMedianRows[0]?.median_ratio != null
      ? toNumber(globalMedianRows[0].median_ratio)
      : 0;
  const meanRatio =
    meanDenominator > 0 ? meanNumerator / meanDenominator : 0;

  return {
    totalDeposits,
    withBonus,
    withoutBonus,
    avgLiftPct: liftPct(withBonus.avg, withoutBonus.avg),
    medianLiftPct: liftPct(withBonus.median, withoutBonus.median),
    retain7dLiftPct: liftPct(withBonus.retain7d, withoutBonus.retain7d),
    retain30dLiftPct: liftPct(withBonus.retain30d, withoutBonus.retain30d),
    ratioBuckets: buckets,
    meanRatio,
    medianRatio,
  };
}

const cachedCohort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCohortComparison(period, blacklistIds),
  ["insights-rewards-deposit-bonus-cohort-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusCohortComparison(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusCohortComparison> {
  const blacklist = await getResolvedBlacklist();
  void cacheTtlForInsightsPeriod(period); // signature parity
  return cachedCohort(period, blacklist);
}
