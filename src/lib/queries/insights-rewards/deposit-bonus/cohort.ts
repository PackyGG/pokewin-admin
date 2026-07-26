import { queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";
import {
  DEPOSIT_BONUS_CACHE_TAGS,
  getResolvedBlacklist,
  staffAndBlacklistSubquery,
  windowDateFilterCapped,
  windowDateFilterCappedTail,
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
 * within 30 seconds of the deposit. Same rule used by the other
 * deposit-bonus analytics surfaces.
 *
 * The two lenses are split into two independently-cached helpers:
 *   - {@link getDepositBonusCohortComparison} — the heavy with/without
 *     retention split (used by the Cohorts tab).
 *   - {@link getDepositBonusRatioDistribution} — the ratio histogram +
 *     mean/median (used by the Cap & Ratio tab).
 * Keeping them separate means the Cap tab doesn't pay for the cohort
 * retention CTE just to draw the ratio bars, and the Cohorts tab doesn't
 * re-run the ratio histogram. Both share the same canonical pairing.
 *
 * Staff + blacklist excluded. Read-only. Heavy SQL — lifetime windows
 * cap the deposit-side scan at 365 days (see `windowDateFilterCapped`)
 * and use a 5-minute revalidate.
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
};

export type DepositBonusRatioDistribution = {
  /** Total completed deposits in window (for empty-state gating). */
  totalDeposits: number;
  /** Bonus / deposit ratio bucketed histogram (5 buckets). */
  ratioBuckets: Array<{ label: string; count: number; volume: number }>;
  /** Mean of bonus/deposit ratio across paired rows (0..1). */
  meanRatio: number;
  /** Median bonus/deposit ratio. */
  medianRatio: number;
};

const emptySide = (): DepositBonusCohortComparison["withBonus"] => ({
  count: 0,
  sum: 0,
  avg: 0,
  median: 0,
  p99: 0,
  uniqueUsers: 0,
  retain7d: 0,
  retain30d: 0,
});

const liftPct = (a: number, b: number): number =>
  b > 0 ? ((a - b) / b) * 100 : 0;

// ─── Cohort comparison (with vs without bonus) ─────────────────────

async function computeCohortComparison(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusCohortComparison> {
  const db = await getDrizzleDb();
  const dateFilter = windowDateFilterCapped(period, "d");
  const bonusDateFilter = windowDateFilterCapped(period, "b");
  const wagerDateFilter = windowDateFilterCappedTail(period, "w", 30);
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  // CTE pairs every deposit to its (optional) deposit_bonus row,
  // computes per-row aggregates and per-side retention. Bonus pairing
  // rule = canonical 30s + balance match.
  //
  // PERFORMANCE — hash join + range join, NOT correlated subqueries.
  // The original `LEFT JOIN LATERAL (… LIMIT 1)` plus two correlated
  // retention `EXISTS` had no usable index for either lookup
  // (ledger_transactions — ~855k rows — is only indexed on id /
  // external_tx_id / fireblocks_tx_id), so each ran a full Seq Scan of
  // the whole table PER deposit row → 57014 statement timeout on EVERY
  // window (even 7d / 30d). We instead:
  //   1. materialise the window's deposit rows, the window's bonus rows,
  //      and the window+30d wager events (only for in-window depositors)
  //      into MATERIALIZED CTEs;
  //   2. hash-join deposits↔bonuses on (user_id, balance_before =
  //      balance_after) within the 30s window — `DISTINCT ON (wd.id) …
  //      ORDER BY wb.created_at ASC` keeps exactly the FIRST matching
  //      bonus per deposit, reproducing the old `LIMIT 1` semantics
  //      (LEFT join → unpaired deposits stay as the "without" cohort);
  //   3. compute 7d/30d retention via a single LEFT JOIN to the wager
  //      set over the wider 30d range + `bool_or` of the narrow 7d / wide
  //      30d window — identical booleans to the two `EXISTS`, but one
  //      hash range-join instead of 2× full-table re-scans per row.
  // Drops the query from a >30s timeout to ~2s on live prod data.
  // MATERIALIZED prevents Postgres from inlining the CTEs back into a
  // correlated form. Lifetime (`all`) is capped to 365d on every leg via
  // `windowDateFilterCapped(Tail)`.
  const splitRows = await queryRows<
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
  >(db, sql`
    WITH window_deposits AS MATERIALIZED (
      SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type::text = 'deposit'
        AND d.user_id IN ${userScope}
        ${dateFilter}
    ),
    window_bonuses AS MATERIALIZED (
      SELECT b.user_id, b.balance_before::numeric AS bal_before, ABS(b.amount::numeric) AS bonus_usd, b.created_at
      FROM ledger_transactions b
      WHERE b.status = 'completed'
        AND b.type::text = 'deposit_bonus'
        ${bonusDateFilter}
    ),
    wager_events AS MATERIALIZED (
      SELECT w.user_id, w.created_at
      FROM ledger_transactions w
      WHERE w.status = 'completed'
        AND w.type::text IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
        AND w.user_id IN (SELECT DISTINCT user_id FROM window_deposits)
        ${wagerDateFilter}
    ),
    paired AS (
      SELECT DISTINCT ON (wd.id)
        wd.id,
        wd.user_id,
        wd.created_at,
        ABS(wd.deposit_amt) AS deposit_usd,
        wb.bonus_usd
      FROM window_deposits wd
      LEFT JOIN window_bonuses wb
        ON wb.user_id = wd.user_id
        AND wb.bal_before = wd.bal_after
        AND wb.created_at >= wd.created_at
        AND wb.created_at < wd.created_at + INTERVAL '30 seconds'
      ORDER BY wd.id, wb.created_at ASC
    ),
    retention AS (
      SELECT
        p.id,
        p.user_id,
        p.bonus_usd,
        p.deposit_usd,
        COALESCE(bool_or(
          we.created_at > p.created_at + INTERVAL '1 hour'
          AND we.created_at <= p.created_at + INTERVAL '7 days'
        ), false) AS r7,
        COALESCE(bool_or(
          we.created_at > p.created_at + INTERVAL '1 hour'
          AND we.created_at <= p.created_at + INTERVAL '30 days'
        ), false) AS r30
      FROM paired p
      LEFT JOIN wager_events we
        ON we.user_id = p.user_id
        AND we.created_at > p.created_at + INTERVAL '1 hour'
        AND we.created_at <= p.created_at + INTERVAL '30 days'
      GROUP BY p.id, p.user_id, p.bonus_usd, p.deposit_usd
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
      return emptySide();
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

  return {
    totalDeposits,
    withBonus,
    withoutBonus,
    avgLiftPct: liftPct(withBonus.avg, withoutBonus.avg),
    medianLiftPct: liftPct(withBonus.median, withoutBonus.median),
    retain7dLiftPct: liftPct(withBonus.retain7d, withoutBonus.retain7d),
    retain30dLiftPct: liftPct(withBonus.retain30d, withoutBonus.retain30d),
  };
}

const cachedCohort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCohortComparison(period, blacklistIds),
  ["insights-rewards-deposit-bonus-cohort-v2"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusCohortComparison(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusCohortComparison> {
  const blacklist = await getResolvedBlacklist();
  void cacheTtlForInsightsPeriod(period); // signature parity
  return cachedCohort(period, blacklist);
}

// ─── Ratio distribution (bonus / deposit %) ────────────────────────

async function computeRatioDistribution(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusRatioDistribution> {
  const db = await getDrizzleDb();
  const dateFilter = windowDateFilterCapped(period, "d");
  const bonusDateFilter = windowDateFilterCapped(period, "b");
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  // Ratio histogram + count-weighted mean + global median in a single
  // pass over the paired set. Only paired rows count toward the
  // distribution (an unpaired deposit has no ratio). Same bucket
  // definitions as the legacy `deposit-bonus-analytics.ts`.
  //
  // PERFORMANCE — same materialised hash-join shape as the rollup above
  // (see the long PERFORMANCE comment in computeCohortComparison): the
  // correlated `JOIN LATERAL (… LIMIT 1)` Seq-Scanned the ~855k-row table
  // PER deposit row → 57014 timeout on every window. We materialise the
  // window's deposit + bonus rows and hash-join them on (user_id,
  // balance_before = balance_after) within the 30s window; an INNER join
  // keeps only deposits that matched a bonus and `DISTINCT ON (wd.id) …
  // ORDER BY wb.created_at ASC` keeps the first match per deposit (old
  // `JOIN LATERAL … LIMIT 1` semantics). `<> 0` deposit guard preserved.
  const ratioRows = await queryRows<
    {
      bucket: number;
      cnt: string;
      volume: string;
      mean_ratio: string | null;
    }[]
  >(db, sql`
    WITH window_deposits AS MATERIALIZED (
      SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type::text = 'deposit'
        AND d.user_id IN ${userScope}
        AND d.amount::numeric <> 0
        ${dateFilter}
    ),
    window_bonuses AS MATERIALIZED (
      SELECT b.user_id, b.balance_before::numeric AS bal_before, ABS(b.amount::numeric) AS bonus_usd, b.created_at
      FROM ledger_transactions b
      WHERE b.status = 'completed'
        AND b.type::text = 'deposit_bonus'
        ${bonusDateFilter}
    ),
    paired AS (
      SELECT DISTINCT ON (wd.id)
        ABS(wd.deposit_amt) AS deposit_usd,
        wb.bonus_usd,
        wb.bonus_usd / NULLIF(ABS(wd.deposit_amt), 0) AS ratio
      FROM window_deposits wd
      JOIN window_bonuses wb
        ON wb.user_id = wd.user_id
        AND wb.bal_before = wd.bal_after
        AND wb.created_at >= wd.created_at
        AND wb.created_at < wd.created_at + INTERVAL '30 seconds'
      ORDER BY wd.id, wb.created_at ASC
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
      AVG(ratio)::text AS mean_ratio
    FROM paired
    GROUP BY 1
  `);

  const buckets: DepositBonusRatioDistribution["ratioBuckets"] =
    RATIO_LABELS.map((label) => ({ label, count: 0, volume: 0 }));
  let meanNumerator = 0;
  let meanDenominator = 0;
  let totalPaired = 0;
  for (const r of ratioRows) {
    const idx = Number(r.bucket);
    const cnt = Number(r.cnt ?? 0);
    totalPaired += cnt;
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
  const globalMedianRows = await queryRows<
    { median_ratio: string | null }[]
  >(db, sql`
    WITH window_deposits AS MATERIALIZED (
      SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type::text = 'deposit'
        AND d.user_id IN ${userScope}
        AND d.amount::numeric <> 0
        ${dateFilter}
    ),
    window_bonuses AS MATERIALIZED (
      SELECT b.user_id, b.balance_before::numeric AS bal_before, ABS(b.amount::numeric) AS bonus_usd, b.created_at
      FROM ledger_transactions b
      WHERE b.status = 'completed'
        AND b.type::text = 'deposit_bonus'
        ${bonusDateFilter}
    ),
    paired AS (
      SELECT DISTINCT ON (wd.id)
        wb.bonus_usd / NULLIF(ABS(wd.deposit_amt), 0) AS ratio
      FROM window_deposits wd
      JOIN window_bonuses wb
        ON wb.user_id = wd.user_id
        AND wb.bal_before = wd.bal_after
        AND wb.created_at >= wd.created_at
        AND wb.created_at < wd.created_at + INTERVAL '30 seconds'
      ORDER BY wd.id, wb.created_at ASC
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
    totalDeposits: totalPaired,
    ratioBuckets: buckets,
    meanRatio,
    medianRatio,
  };
}

const cachedRatioDistribution = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeRatioDistribution(period, blacklistIds),
  ["insights-rewards-deposit-bonus-ratio-distribution-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusRatioDistribution(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusRatioDistribution> {
  const blacklist = await getResolvedBlacklist();
  void cacheTtlForInsightsPeriod(period); // signature parity
  return cachedRatioDistribution(period, blacklist);
}
