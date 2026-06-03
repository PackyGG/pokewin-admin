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
  windowDateFilterCapped,
} from "./_shared";

/**
 * Cap analysis for the Deposit Bonus insight page.
 *
 * The deposit-bonus cap is configured in the GAME BACKEND (not
 * `site_config`). We derive it empirically as `MAX(ABS(amount))` over
 * the window — that IS the largest bonus the backend has issued.
 * "Cap hits" = rows whose ABS(amount) equals that max.
 *
 * Surface:
 *   - capValue                — empirical cap for the window
 *   - capHits                 — count of rows hitting the cap
 *   - capHitRate              — capHits / count
 *   - dailyCapHitRate         — per-day cap hits + total bonuses + rate
 *   - amountDistribution      — histogram of bonus amounts in 8 buckets
 *                               spanning $0 → capValue
 *   - topCapHitters           — top 10 users by number of cap hits in
 *                               window, plus their total bonus volume
 *   - biggestCapDeposits      — top 10 deposits that triggered a cap-
 *                               equal bonus (largest deposit_usd first)
 *
 * Staff + blacklist excluded. Read-only. Cached per window.
 */

export type CapAmountBucket = {
  /** Bucket label e.g. "$0–10". */
  label: string;
  /** Lower bound (inclusive). */
  min: number;
  /** Upper bound (exclusive for non-final, inclusive for final). */
  max: number;
  count: number;
  /** Sum of ABS(amount) inside the bucket. */
  volume: number;
};

export type TopCapHitter = {
  userId: string;
  username: string | null;
  capHits: number;
  totalBonus: number;
  /** Last cap-hit timestamp (ISO). */
  lastHitAt: string;
};

export type BiggestCapDeposit = {
  userId: string;
  username: string | null;
  depositUsd: number;
  bonusUsd: number;
  /** ISO timestamp of the deposit. */
  createdAt: string;
};

export type DepositBonusCapAnalysis = {
  capValue: number;
  capHits: number;
  /** capHits / count, 0..1. */
  capHitRate: number;
  /** Distinct users who hit the cap at least once in window. */
  uniqueCapHitters: number;
  /** Per-day cap hit rate (ASC). */
  dailyCapHitRate: Array<{
    date: string;
    bonuses: number;
    capHits: number;
    /** capHits / bonuses, 0..1. */
    rate: number;
  }>;
  amountDistribution: CapAmountBucket[];
  topCapHitters: TopCapHitter[];
  biggestCapDeposits: BiggestCapDeposit[];
};

const HISTOGRAM_BUCKETS = 8;
const TOP_LIMIT = 10;

async function computeCapAnalysis(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusCapAnalysis> {
  const db = await getDb();
  const dateFilter = windowDateFilter(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  // Step 1: empirical cap = MAX(ABS(amount)). Always cheap.
  const capRows = await db.$queryRawUnsafe<
    { max_amount: string | null; cnt: string }[]
  >(`
    SELECT
      MAX(ABS(lt.amount::numeric))::text AS max_amount,
      COUNT(*)::text AS cnt
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type::text = 'deposit_bonus'
      AND lt.user_id IN ${userScope}
      ${dateFilter}
  `);
  const capValue =
    capRows[0]?.max_amount != null ? toNumber(capRows[0].max_amount) : 0;
  const totalCount = Number(capRows[0]?.cnt ?? 0);

  if (capValue <= 0 || totalCount === 0) {
    return {
      capValue: 0,
      capHits: 0,
      capHitRate: 0,
      uniqueCapHitters: 0,
      dailyCapHitRate: [],
      amountDistribution: [],
      topCapHitters: [],
      biggestCapDeposits: [],
    };
  }

  // Step 2: cap-equal rows + per-day series + histogram + top hitters.
  // capValue is used as a literal numeric — toFixed(2) keeps the SQL
  // safe (we already validated it's a positive number).
  const capLiteral = capValue.toFixed(2);
  const [hitsRows, dailyRows, histogramRows, topHittersRows] =
    await Promise.all([
      db.$queryRawUnsafe<
        { hits: string; hitters: string }[]
      >(`
        SELECT
          COUNT(*)::text AS hits,
          COUNT(DISTINCT lt.user_id)::text AS hitters
        FROM ledger_transactions lt
        WHERE lt.status = 'completed'
          AND lt.type::text = 'deposit_bonus'
          AND lt.user_id IN ${userScope}
          AND ABS(lt.amount::numeric) = ${capLiteral}
          ${dateFilter}
      `),
      db.$queryRawUnsafe<
        { date: Date; bonuses: string; cap_hits: string }[]
      >(`
        SELECT
          DATE(lt.created_at) AS date,
          COUNT(*)::text AS bonuses,
          COUNT(*) FILTER (WHERE ABS(lt.amount::numeric) = ${capLiteral})::text AS cap_hits
        FROM ledger_transactions lt
        WHERE lt.status = 'completed'
          AND lt.type::text = 'deposit_bonus'
          AND lt.user_id IN ${userScope}
          ${dateFilter}
        GROUP BY DATE(lt.created_at)
        ORDER BY date ASC
      `),
      db.$queryRawUnsafe<
        { bucket: number; cnt: string; volume: string }[]
      >(`
        WITH bounded AS (
          SELECT
            ABS(lt.amount::numeric) AS amt
          FROM ledger_transactions lt
          WHERE lt.status = 'completed'
            AND lt.type::text = 'deposit_bonus'
            AND lt.user_id IN ${userScope}
            ${dateFilter}
        )
        SELECT
          LEAST(${HISTOGRAM_BUCKETS - 1},
                FLOOR(amt / NULLIF(${capLiteral} / ${HISTOGRAM_BUCKETS}, 0))
          )::int AS bucket,
          COUNT(*)::text AS cnt,
          COALESCE(SUM(amt), 0)::text AS volume
        FROM bounded
        GROUP BY 1
        ORDER BY 1
      `),
      db.$queryRawUnsafe<
        {
          user_id: string;
          username: string | null;
          hits: string;
          total_bonus: string;
          last_hit_at: Date;
        }[]
      >(`
        SELECT
          u.id AS user_id,
          u.username,
          COUNT(*)::text AS hits,
          SUM(ABS(lt.amount::numeric))::text AS total_bonus,
          MAX(lt.created_at) AS last_hit_at
        FROM ledger_transactions lt
        JOIN "user" u ON u.id = lt.user_id
        WHERE lt.status = 'completed'
          AND lt.type::text = 'deposit_bonus'
          AND u.role NOT IN ('admin', 'support')
          AND ABS(lt.amount::numeric) = ${capLiteral}
          ${dateFilter}
        GROUP BY u.id, u.username
        ORDER BY COUNT(*) DESC, SUM(ABS(lt.amount::numeric)) DESC
        LIMIT ${TOP_LIMIT}
      `),
    ]);

  const capHits = Number(hitsRows[0]?.hits ?? 0);
  const uniqueCapHitters = Number(hitsRows[0]?.hitters ?? 0);
  const capHitRate = totalCount > 0 ? capHits / totalCount : 0;

  const dailyCapHitRate = dailyRows.map((r) => {
    const bonuses = Number(r.bonuses ?? 0);
    const hits = Number(r.cap_hits ?? 0);
    return {
      date: new Date(r.date).toISOString().split("T")[0],
      bonuses,
      capHits: hits,
      rate: bonuses > 0 ? hits / bonuses : 0,
    };
  });

  // Build a fixed 8-bucket histogram. Each bucket spans capValue/8.
  // SQL emits sparse rows; we expand to the full list so the UI can
  // render an even-spaced chart without gaps.
  const bucketWidth = capValue / HISTOGRAM_BUCKETS;
  const histogramByIdx = new Map<number, { count: number; volume: number }>();
  for (const r of histogramRows) {
    const idx = Number(r.bucket);
    if (idx >= 0 && idx < HISTOGRAM_BUCKETS) {
      histogramByIdx.set(idx, {
        count: Number(r.cnt ?? 0),
        volume: toNumber(r.volume),
      });
    }
  }
  const amountDistribution: CapAmountBucket[] = Array.from(
    { length: HISTOGRAM_BUCKETS },
    (_, idx) => {
      const min = bucketWidth * idx;
      const max = bucketWidth * (idx + 1);
      const data = histogramByIdx.get(idx) ?? { count: 0, volume: 0 };
      return {
        label: `$${Math.round(min)}–${Math.round(max)}`,
        min,
        max,
        count: data.count,
        volume: data.volume,
      };
    },
  );

  const topCapHitters: TopCapHitter[] = topHittersRows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    capHits: Number(r.hits ?? 0),
    totalBonus: toNumber(r.total_bonus),
    lastHitAt: new Date(r.last_hit_at).toISOString(),
  }));

  // Step 3: top 10 deposits that triggered a cap-equal bonus. Same
  // canonical bonus↔deposit pairing as `deposit-bonus-analytics.ts`
  // (balance_before == balance_after, 30s window).
  const biggestCapDepositsRows = await db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      deposit_usd: string;
      bonus_usd: string;
      created_at: Date;
    }[]
  >(`
    WITH window_deposits AS (
      SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type::text = 'deposit'
        AND d.user_id IN ${userScope}
        ${windowDateFilterCapped(period, "d")}
    )
    SELECT
      wd.user_id,
      u.username,
      ABS(wd.deposit_amt)::text AS deposit_usd,
      b.bonus_usd::text AS bonus_usd,
      wd.created_at
    FROM window_deposits wd
    JOIN "user" u ON u.id = wd.user_id
    JOIN LATERAL (
      SELECT ABS(lt.amount::numeric) AS bonus_usd
      FROM ledger_transactions lt
      WHERE lt.user_id = wd.user_id
        AND lt.type::text = 'deposit_bonus'
        AND lt.status = 'completed'
        AND lt.balance_before::numeric = wd.bal_after
        AND lt.created_at >= wd.created_at
        AND lt.created_at < wd.created_at + INTERVAL '30 seconds'
        AND ABS(lt.amount::numeric) = ${capLiteral}
      ORDER BY lt.created_at ASC
      LIMIT 1
    ) b ON TRUE
    ORDER BY ABS(wd.deposit_amt) DESC
    LIMIT ${TOP_LIMIT}
  `);

  const biggestCapDeposits: BiggestCapDeposit[] = biggestCapDepositsRows.map(
    (r) => ({
      userId: r.user_id,
      username: r.username,
      depositUsd: toNumber(r.deposit_usd),
      bonusUsd: toNumber(r.bonus_usd),
      createdAt: new Date(r.created_at).toISOString(),
    }),
  );

  return {
    capValue,
    capHits,
    capHitRate,
    uniqueCapHitters,
    dailyCapHitRate,
    amountDistribution,
    topCapHitters,
    biggestCapDeposits,
  };
}

// ─── Lightweight cap-hit-rate (Overview KPI strip) ─────────────────

export type DepositBonusCapHitRate = {
  /** Empirical cap = MAX(ABS(amount)) in window. */
  capValue: number;
  /** Rows whose ABS(amount) equals the cap. */
  capHits: number;
  /** Total bonus rows in window. */
  totalCount: number;
  /** capHits / totalCount, 0..1. */
  capHitRate: number;
};

/**
 * Cheap cap-hit-rate rollup — just the two scalar aggregates the
 * Overview tab's KPI strip needs (`capHitRate`), without the histogram,
 * per-day series, top-hitters, or the LATERAL biggest-cap-deposit
 * pairing that {@link computeCapAnalysis} runs. Two small aggregate
 * scans over `deposit_bonus` rows only. Reconciles with the full cap
 * analysis by construction (same filters, same empirical-cap definition).
 */
async function computeCapHitRate(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusCapHitRate> {
  const db = await getDb();
  const dateFilter = windowDateFilter(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  const capRows = await db.$queryRawUnsafe<
    { max_amount: string | null; cnt: string }[]
  >(`
    SELECT
      MAX(ABS(lt.amount::numeric))::text AS max_amount,
      COUNT(*)::text AS cnt
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type::text = 'deposit_bonus'
      AND lt.user_id IN ${userScope}
      ${dateFilter}
  `);
  const capValue =
    capRows[0]?.max_amount != null ? toNumber(capRows[0].max_amount) : 0;
  const totalCount = Number(capRows[0]?.cnt ?? 0);

  if (capValue <= 0 || totalCount === 0) {
    return { capValue: 0, capHits: 0, totalCount, capHitRate: 0 };
  }

  const capLiteral = capValue.toFixed(2);
  const hitsRows = await db.$queryRawUnsafe<{ hits: string }[]>(`
    SELECT COUNT(*)::text AS hits
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type::text = 'deposit_bonus'
      AND lt.user_id IN ${userScope}
      AND ABS(lt.amount::numeric) = ${capLiteral}
      ${dateFilter}
  `);
  const capHits = Number(hitsRows[0]?.hits ?? 0);
  return {
    capValue,
    capHits,
    totalCount,
    capHitRate: totalCount > 0 ? capHits / totalCount : 0,
  };
}

const cachedCapHitRate = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCapHitRate(period, blacklistIds),
  ["insights-rewards-deposit-bonus-cap-hit-rate-v1"],
  { revalidate: 60, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

const cachedCapHitRateLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCapHitRate(period, blacklistIds),
  ["insights-rewards-deposit-bonus-cap-hit-rate-lifetime-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusCapHitRate(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusCapHitRate> {
  const blacklist = await getResolvedBlacklist();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedCapHitRateLifetime(period, blacklist)
    : cachedCapHitRate(period, blacklist);
}

// ─── Full cap analysis (Cap & Ratio tab) ───────────────────────────

const cachedCapAnalysis = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCapAnalysis(period, blacklistIds),
  ["insights-rewards-deposit-bonus-cap-analysis-v1"],
  { revalidate: 60, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

const cachedCapAnalysisLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCapAnalysis(period, blacklistIds),
  ["insights-rewards-deposit-bonus-cap-analysis-lifetime-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusCapAnalysis(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusCapAnalysis> {
  const blacklist = await getResolvedBlacklist();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedCapAnalysisLifetime(period, blacklist)
    : cachedCapAnalysis(period, blacklist);
}
