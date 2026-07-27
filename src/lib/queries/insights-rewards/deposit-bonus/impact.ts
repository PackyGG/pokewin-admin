import { blacklistNotInSql, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { getReadDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { type InsightsRewardsPeriod } from "../_period";
import { makeCachedPair } from "../_cache";
import {
  DEPOSIT_BONUS_CACHE_TAGS,
  staffAndBlacklistSubquery,
  windowDateFilter,
  windowDateFilterCapped,
  windowStartExpr,
} from "./_shared";

/**
 * Impact lenses for the Deposit Bonus insight page — built to answer one
 * concrete operating question: would a TIME-SPLIT bonus cap (splitting
 * the $100 daily bonus cap across smaller time windows) meaningfully
 * change payouts, and who would it hit?
 *
 * Rather than guess from aggregates, every helper here models the real
 * deposit behaviour that a time-split cap interacts with:
 *
 *   - getDepositBonusDepositFrequency  — per-user-per-day deposit-count
 *                                         distribution (1× / 2× / 3× / 4+)
 *                                         + avg & median deposits per
 *                                         active user per day. A time-split
 *                                         cap only bites users who deposit
 *                                         MULTIPLE times per day.
 *   - getDepositBonusDepositSizeDist   — deposit-size histogram across 7
 *                                         bands; calls out count + share of
 *                                         deposits ≥ $500 (the whales a
 *                                         time-cap would throttle).
 *   - getDepositBonusCapHitters        — users who hit the empirical bonus
 *                                         cap, with how often + their total
 *                                         deposit / wager / GGR contribution
 *                                         (top 100 by value). The headline
 *                                         "who triggers the cap" answer.
 *   - getDepositBonusTimeBetween       — gap between a user's consecutive
 *                                         deposits (LAG window) → median +
 *                                         5-bucket distribution. Tells you
 *                                         what window width a split cap
 *                                         should use.
 *   - getDepositBonusToWagerSegments   — (nice-to-have) avg bonus vs avg
 *                                         wager per deposit-size segment →
 *                                         which segments are most subsidised.
 *   - getDepositBonusPostCapBehavior   — (nice-to-have, approximate) what
 *                                         cap-hitters do after their first
 *                                         cap hit: keep depositing (no extra
 *                                         bonus) vs stop.
 *   - getDepositBonusCapHitterCohorts  — (nice-to-have) new vs returning
 *                                         split of cap-hitters.
 *
 * The empirical cap is `MAX(ABS(amount))` over `deposit_bonus` rows in the
 * window — identical to `cap-analysis.ts` so the two surfaces reconcile.
 *
 * House-POV: bonus payouts are house cost → rose. Deposits / wager / GGR
 * contribution (the house captures the spend) → emerald. Counts → blue.
 *
 * Staff + blacklist excluded everywhere. Read-only against the main DB.
 * Every helper is `unstable_cache`-wrapped keyed on (period, blacklist),
 * 60s on finite windows / 300s on lifetime, tagged
 * `insights-rewards-deposit-bonus`. The heavy per-user-per-day, LAG, and
 * cap-pairing scans use `windowDateFilterCapped` so the lifetime window
 * never triggers a full-history table scan.
 */

// Wager / payout ledger types — mirror `top-spenders.ts` so the per-user
// value contribution reconciles with the Top & Risk tab.
const WAGER_TYPES_SQL = `(
  'pack_opening','battle_bet','battle_sponsorship','upgrader_bet'
)`;
const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout')`;

/** Cap-hitter list bound — top 100 by value contribution. */
const CAP_HITTER_LIMIT = 100;

// ─── 1. Deposit-frequency distribution (per-user-per-day) ───────────

export type DepositFrequencyBucket = {
  /** "1×" / "2×" / "3×" / "4+×" */
  label: string;
  /** Inclusive lower bound of deposits-in-a-day. */
  minDeposits: number;
  /** Inclusive upper bound; +Infinity for the catch-all bucket. */
  maxDeposits: number;
  /** Number of distinct (user, day) pairs that fall in this band. */
  userDays: number;
  /** Share of all active user-days, 0..1. */
  share: number;
};

export type DepositBonusDepositFrequency = {
  buckets: DepositFrequencyBucket[];
  /** Distinct (user, day) pairs with ≥ 1 completed deposit. */
  totalUserDays: number;
  /** Distinct depositing users in window. */
  totalUsers: number;
  /** Mean deposits per active user-day. */
  avgDepositsPerUserDay: number;
  /** Median deposits per active user-day. */
  medianDepositsPerUserDay: number;
  /** Share of user-days with > 1 deposit (the multi-deposit days). */
  multiDepositDayShare: number;
};

const FREQUENCY_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "1×", min: 1, max: 1 },
  { label: "2×", min: 2, max: 2 },
  { label: "3×", min: 3, max: 3 },
  { label: "4+×", min: 4, max: Number.MAX_SAFE_INTEGER },
];

async function computeDepositFrequency(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusDepositFrequency> {
  const db = await getReadDrizzleDb();
  // Per-user-per-day grouping is heavy on the lifetime window — cap the
  // deposit scan to the pairing lookback (365d) so `all` never scans the
  // entire deposit history.
  const dateFilter = windowDateFilterCapped(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  // Count deposits per (user, UTC-day), then aggregate: how the per-day
  // deposit counts distribute across the frequency buckets, plus the
  // median / mean of the per-day count, plus distinct user + user-day
  // totals. One pass over a per-user-per-day CTE.
  const rows = await queryRows<
    {
      bucket: number;
      user_days: string;
    }[]
  >(db, sql`
    WITH per_user_day AS (
      SELECT
        lt.user_id,
        DATE(lt.created_at AT TIME ZONE 'UTC') AS day,
        COUNT(*)::int AS deposits
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
      GROUP BY lt.user_id, DATE(lt.created_at AT TIME ZONE 'UTC')
    )
    SELECT
      CASE
        WHEN deposits >= 4 THEN 3
        WHEN deposits = 3 THEN 2
        WHEN deposits = 2 THEN 1
        ELSE 0
      END AS bucket,
      COUNT(*)::text AS user_days
    FROM per_user_day
    GROUP BY 1
    ORDER BY 1
  `);

  const statsRows = await queryRows<
    {
      total_user_days: string;
      total_users: string;
      avg_per_day: string | null;
      median_per_day: string | null;
      multi_user_days: string;
    }[]
  >(db, sql`
    WITH per_user_day AS (
      SELECT
        lt.user_id,
        DATE(lt.created_at AT TIME ZONE 'UTC') AS day,
        COUNT(*)::int AS deposits
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
      GROUP BY lt.user_id, DATE(lt.created_at AT TIME ZONE 'UTC')
    )
    SELECT
      COUNT(*)::text AS total_user_days,
      COUNT(DISTINCT user_id)::text AS total_users,
      AVG(deposits)::text AS avg_per_day,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY deposits)::text AS median_per_day,
      COUNT(*) FILTER (WHERE deposits > 1)::text AS multi_user_days
    FROM per_user_day
  `);

  const buckets: DepositFrequencyBucket[] = FREQUENCY_BUCKETS.map((b) => ({
    label: b.label,
    minDeposits: b.min,
    maxDeposits: b.max === Number.MAX_SAFE_INTEGER ? Number.POSITIVE_INFINITY : b.max,
    userDays: 0,
    share: 0,
  }));
  for (const r of rows) {
    const idx = Number(r.bucket);
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx].userDays = Number(r.user_days ?? 0);
    }
  }

  const stats = statsRows[0];
  const totalUserDays = Number(stats?.total_user_days ?? 0);
  const totalUsers = Number(stats?.total_users ?? 0);
  const multiUserDays = Number(stats?.multi_user_days ?? 0);
  for (const b of buckets) {
    b.share = totalUserDays > 0 ? b.userDays / totalUserDays : 0;
  }

  return {
    buckets,
    totalUserDays,
    totalUsers,
    avgDepositsPerUserDay: stats?.avg_per_day != null ? toNumber(stats.avg_per_day) : 0,
    medianDepositsPerUserDay:
      stats?.median_per_day != null ? toNumber(stats.median_per_day) : 0,
    multiDepositDayShare: totalUserDays > 0 ? multiUserDays / totalUserDays : 0,
  };
}

// ─── 2. Deposit-size distribution ──────────────────────────────────

export type DepositSizeBucket = {
  /** "<$10" / "$10–50" / … / "$2K+" */
  label: string;
  /** Inclusive lower bound (USD). */
  min: number;
  /** Exclusive upper bound; +Infinity for the final bucket. */
  max: number;
  /** Completed deposits in this band. */
  count: number;
  /** Sum of deposit USD in this band. */
  volume: number;
  /** Share of all deposit COUNT, 0..1. */
  countShare: number;
  /** Whether this band counts toward the "≥ $500" whale callout. */
  isLarge: boolean;
};

export type DepositBonusDepositSizeDistribution = {
  buckets: DepositSizeBucket[];
  /** Total completed deposits in window. */
  totalDeposits: number;
  /** Total deposit volume in window. */
  totalVolume: number;
  /** Deposits ≥ $500 (the whales a time-cap would throttle). */
  largeDepositCount: number;
  /** Volume of deposits ≥ $500. */
  largeDepositVolume: number;
  /** largeDepositCount / totalDeposits, 0..1. */
  largeDepositCountShare: number;
  /** largeDepositVolume / totalVolume, 0..1. */
  largeDepositVolumeShare: number;
  /** Median deposit size (USD). */
  medianDepositUsd: number;
};

// Bucket boundaries (USD). The `>= 500` bands are flagged `isLarge`.
const SIZE_BUCKETS: Array<{
  label: string;
  min: number;
  max: number;
  isLarge: boolean;
}> = [
  { label: "<$10", min: 0, max: 10, isLarge: false },
  { label: "$10–50", min: 10, max: 50, isLarge: false },
  { label: "$50–100", min: 50, max: 100, isLarge: false },
  { label: "$100–500", min: 100, max: 500, isLarge: false },
  { label: "$500–1K", min: 500, max: 1000, isLarge: true },
  { label: "$1K–2K", min: 1000, max: 2000, isLarge: true },
  { label: "$2K+", min: 2000, max: Number.MAX_SAFE_INTEGER, isLarge: true },
];

async function computeDepositSizeDistribution(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusDepositSizeDistribution> {
  const db = await getReadDrizzleDb();
  const dateFilter = windowDateFilter(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  // Single CASE-bucketed aggregate over completed deposits.
  const rows = await queryRows<
    { bucket: number; cnt: string; volume: string }[]
  >(db, sql`
    WITH deposits AS (
      SELECT ABS(lt.amount::numeric) AS amt
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
    )
    SELECT
      CASE
        WHEN amt < 10 THEN 0
        WHEN amt < 50 THEN 1
        WHEN amt < 100 THEN 2
        WHEN amt < 500 THEN 3
        WHEN amt < 1000 THEN 4
        WHEN amt < 2000 THEN 5
        ELSE 6
      END AS bucket,
      COUNT(*)::text AS cnt,
      COALESCE(SUM(amt), 0)::text AS volume
    FROM deposits
    GROUP BY 1
    ORDER BY 1
  `);

  const medianRows = await queryRows<
    { median_usd: string | null }[]
  >(db, sql`
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(lt.amount::numeric))::text AS median_usd
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type::text = 'deposit'
      AND lt.user_id IN ${userScope}
      ${dateFilter}
  `);

  const buckets: DepositSizeBucket[] = SIZE_BUCKETS.map((b) => ({
    label: b.label,
    min: b.min,
    max: b.max === Number.MAX_SAFE_INTEGER ? Number.POSITIVE_INFINITY : b.max,
    count: 0,
    volume: 0,
    countShare: 0,
    isLarge: b.isLarge,
  }));
  for (const r of rows) {
    const idx = Number(r.bucket);
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx].count = Number(r.cnt ?? 0);
      buckets[idx].volume = toNumber(r.volume);
    }
  }

  const totalDeposits = buckets.reduce((acc, b) => acc + b.count, 0);
  const totalVolume = buckets.reduce((acc, b) => acc + b.volume, 0);
  for (const b of buckets) {
    b.countShare = totalDeposits > 0 ? b.count / totalDeposits : 0;
  }
  const largeBuckets = buckets.filter((b) => b.isLarge);
  const largeDepositCount = largeBuckets.reduce((acc, b) => acc + b.count, 0);
  const largeDepositVolume = largeBuckets.reduce((acc, b) => acc + b.volume, 0);

  return {
    buckets,
    totalDeposits,
    totalVolume,
    largeDepositCount,
    largeDepositVolume,
    largeDepositCountShare:
      totalDeposits > 0 ? largeDepositCount / totalDeposits : 0,
    largeDepositVolumeShare: totalVolume > 0 ? largeDepositVolume / totalVolume : 0,
    medianDepositUsd:
      medianRows[0]?.median_usd != null ? toNumber(medianRows[0].median_usd) : 0,
  };
}

// ─── 3. Cap-hitters with value contribution ────────────────────────

export type CapHitterRow = {
  userId: string;
  username: string | null;
  /** Cap-equal bonus rows in window. */
  capHits: number;
  /** Whether they hit the cap more than once in window. */
  frequent: boolean;
  /** Completed deposit volume in window (USD). */
  depositTotal: number;
  /** Wager-side ledger volume in window (USD). */
  wagerTotal: number;
  /** Payout-side ledger volume in window (USD). */
  payoutTotal: number;
  /** wager − payouts in window (= GGR contribution). */
  ggrContribution: number;
  /** Total deposit_bonus volume in window for this user (USD). */
  bonusTotal: number;
};

export type DepositBonusCapHitters = {
  /** Empirical cap = MAX(ABS(amount)) in window. */
  capValue: number;
  /** Distinct users who hit the cap ≥ 1 time. */
  distinctCapHitters: number;
  /** Distinct depositors in window (denominator). */
  totalDepositors: number;
  /** distinctCapHitters / totalDepositors, 0..1. */
  capHitterShare: number;
  /** Combined wager of all cap-hitters (USD). */
  combinedWager: number;
  /** Combined GGR contribution of all cap-hitters (USD). */
  combinedGgr: number;
  /** Total wager across ALL depositors in window (denominator). */
  totalDepositorWager: number;
  /** combinedWager / totalDepositorWager, 0..1. */
  wagerShare: number;
  /** Top {@link CAP_HITTER_LIMIT} cap-hitters by GGR contribution desc. */
  rows: CapHitterRow[];
};

async function computeCapHitters(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusCapHitters> {
  const db = await getReadDrizzleDb();
  const dateFilter = windowDateFilter(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // Step 1: empirical cap = MAX(ABS(amount)) over deposit_bonus rows.
  // Same definition as cap-analysis.ts so the two surfaces agree.
  const capRows = await queryRows<{ max_amount: string | null }[]>(db, sql`
    SELECT MAX(ABS(lt.amount::numeric))::text AS max_amount
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type::text = 'deposit_bonus'
      AND lt.user_id IN ${userScope}
      ${dateFilter}
  `);
  const capValue =
    capRows[0]?.max_amount != null ? toNumber(capRows[0].max_amount) : 0;

  if (capValue <= 0) {
    return {
      capValue: 0,
      distinctCapHitters: 0,
      totalDepositors: 0,
      capHitterShare: 0,
      combinedWager: 0,
      combinedGgr: 0,
      totalDepositorWager: 0,
      wagerShare: 0,
      rows: [],
    };
  }

  const capLiteral = Number(capValue.toFixed(2));

  // Step 2: denominators — distinct depositors + their total wager in
  // window. Cheap aggregate scans.
  const denomRows = await queryRows<
    { depositors: string; depositor_wager: string }[]
  >(db, sql`
    WITH depositors AS (
      SELECT DISTINCT lt.user_id
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
    )
    SELECT
      (SELECT COUNT(*)::text FROM depositors) AS depositors,
      (
        SELECT COALESCE(SUM(ABS(w.amount::numeric)), 0)::text
        FROM ledger_transactions w
        WHERE w.status = 'completed'
          AND w.type::text IN ${sql.raw(WAGER_TYPES_SQL)}
          AND w.user_id IN (SELECT user_id FROM depositors)
          ${windowDateFilter(period, "w")}
      ) AS depositor_wager
  `);
  const totalDepositors = Number(denomRows[0]?.depositors ?? 0);
  const totalDepositorWager = toNumber(denomRows[0]?.depositor_wager);

  // Step 3: cap-hitters + their per-user value contribution. Start from
  // the distinct cap-hit users (ABS(amount) == cap), then join window
  // bonus / deposit / wager / payout rollups — same CTE shape as
  // top-spenders.ts. Bounded to the top 100 by GGR contribution.
  const hitterRows = await queryRows<
    {
      user_id: string;
      username: string | null;
      cap_hits: string;
      bonus_total: string;
      deposit_total: string;
      wager_total: string;
      payout_total: string;
    }[]
  >(db, sql`
    WITH cap_hitters AS (
      SELECT
        lt.user_id,
        COUNT(*)::int AS cap_hits
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
        AND ABS(lt.amount::numeric) = ${capLiteral}
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    bonus_window AS (
      SELECT lt.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS bonus_total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN (SELECT user_id FROM cap_hitters)
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    deposit_window AS (
      SELECT lt.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS deposit_total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit'
        AND lt.user_id IN (SELECT user_id FROM cap_hitters)
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    wager_window AS (
      SELECT lt.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS wager_total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)}
        AND lt.user_id IN (SELECT user_id FROM cap_hitters)
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    payout_window AS (
      SELECT lt.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS payout_total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${sql.raw(PAYOUT_TYPES_SQL)}
        AND lt.user_id IN (SELECT user_id FROM cap_hitters)
        ${dateFilter}
      GROUP BY lt.user_id
    )
    SELECT
      ch.user_id,
      u.username,
      ch.cap_hits::text AS cap_hits,
      COALESCE(bw.bonus_total, 0)::text AS bonus_total,
      COALESCE(dw.deposit_total, 0)::text AS deposit_total,
      COALESCE(ww.wager_total, 0)::text AS wager_total,
      COALESCE(pw.payout_total, 0)::text AS payout_total
    FROM cap_hitters ch
    JOIN "user" u ON u.id = ch.user_id
    LEFT JOIN bonus_window bw ON bw.user_id = ch.user_id
    LEFT JOIN deposit_window dw ON dw.user_id = ch.user_id
    LEFT JOIN wager_window ww ON ww.user_id = ch.user_id
    LEFT JOIN payout_window pw ON pw.user_id = ch.user_id
    ORDER BY (COALESCE(ww.wager_total, 0) - COALESCE(pw.payout_total, 0)) DESC
    LIMIT ${CAP_HITTER_LIMIT}
  `);

  // Combined wager + GGR across ALL cap-hitters (not just the top 100 the
  // table shows) — separate cheap aggregate so the headline share is
  // accurate even when the list is truncated.
  const combinedRows = await queryRows<
    { distinct_hitters: string; combined_wager: string; combined_payout: string }[]
  >(db, sql`
    WITH cap_hitters AS (
      SELECT DISTINCT lt.user_id
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        AND ABS(lt.amount::numeric) = ${capLiteral}
        ${dateFilter}
    )
    SELECT
      (SELECT COUNT(*)::text FROM cap_hitters) AS distinct_hitters,
      (
        SELECT COALESCE(SUM(ABS(w.amount::numeric)), 0)::text
        FROM ledger_transactions w
        WHERE w.status = 'completed'
          AND w.type::text IN ${sql.raw(WAGER_TYPES_SQL)}
          AND w.user_id IN (SELECT user_id FROM cap_hitters)
          ${windowDateFilter(period, "w")}
      ) AS combined_wager,
      (
        SELECT COALESCE(SUM(ABS(p.amount::numeric)), 0)::text
        FROM ledger_transactions p
        WHERE p.status = 'completed'
          AND p.type::text IN ${sql.raw(PAYOUT_TYPES_SQL)}
          AND p.user_id IN (SELECT user_id FROM cap_hitters)
          ${windowDateFilter(period, "p")}
      ) AS combined_payout
  `);
  const distinctCapHitters = Number(combinedRows[0]?.distinct_hitters ?? 0);
  const combinedWager = toNumber(combinedRows[0]?.combined_wager);
  const combinedPayout = toNumber(combinedRows[0]?.combined_payout);
  const combinedGgr = combinedWager - combinedPayout;

  const rows: CapHitterRow[] = hitterRows.map((r) => {
    const wagerTotal = toNumber(r.wager_total);
    const payoutTotal = toNumber(r.payout_total);
    const capHits = Number(r.cap_hits ?? 0);
    return {
      userId: r.user_id,
      username: r.username,
      capHits,
      frequent: capHits > 1,
      depositTotal: toNumber(r.deposit_total),
      wagerTotal,
      payoutTotal,
      ggrContribution: wagerTotal - payoutTotal,
      bonusTotal: toNumber(r.bonus_total),
    };
  });

  return {
    capValue,
    distinctCapHitters,
    totalDepositors,
    capHitterShare: totalDepositors > 0 ? distinctCapHitters / totalDepositors : 0,
    combinedWager,
    combinedGgr,
    totalDepositorWager,
    wagerShare: totalDepositorWager > 0 ? combinedWager / totalDepositorWager : 0,
    rows,
  };
}

// ─── 4. Time-between-deposits (LAG window) ──────────────────────────

export type TimeGapBucket = {
  /** "<30min" / "30min–2h" / "2–6h" / "6–24h" / ">24h" */
  label: string;
  /** Inclusive lower bound (minutes). */
  minMinutes: number;
  /** Exclusive upper bound (minutes); +Infinity for the catch-all. */
  maxMinutes: number;
  count: number;
  /** Share of all consecutive-deposit gaps, 0..1. */
  share: number;
};

export type DepositBonusTimeBetween = {
  buckets: TimeGapBucket[];
  /** Number of consecutive-deposit gaps surveyed (deposits − distinct users). */
  totalGaps: number;
  /** Median gap in minutes. */
  medianGapMinutes: number;
  /** P25 gap in minutes. */
  p25GapMinutes: number;
  /** P75 gap in minutes. */
  p75GapMinutes: number;
  /** Share of gaps under 24h (intra-day re-deposits a split cap would touch). */
  intraDayShare: number;
};

const GAP_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "<30min", min: 0, max: 30 },
  { label: "30min–2h", min: 30, max: 120 },
  { label: "2–6h", min: 120, max: 360 },
  { label: "6–24h", min: 360, max: 1440 },
  { label: ">24h", min: 1440, max: Number.MAX_SAFE_INTEGER },
];

async function computeTimeBetween(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusTimeBetween> {
  const db = await getReadDrizzleDb();
  // LAG window over the full per-user deposit history is heavy on
  // lifetime — cap the deposit scan to 365d.
  const dateFilter = windowDateFilterCapped(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  // LAG over deposits ordered by created_at per user → gap in minutes
  // between consecutive deposits. The first deposit per user has a NULL
  // lag (no prior) and is excluded by the WHERE on `prev_at`.
  const rows = await queryRows<
    { bucket: number; cnt: string }[]
  >(db, sql`
    WITH ordered AS (
      SELECT
        lt.user_id,
        lt.created_at,
        LAG(lt.created_at) OVER (
          PARTITION BY lt.user_id ORDER BY lt.created_at
        ) AS prev_at
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
    ),
    gaps AS (
      SELECT
        EXTRACT(EPOCH FROM (created_at - prev_at)) / 60.0 AS gap_minutes
      FROM ordered
      WHERE prev_at IS NOT NULL
    )
    SELECT
      CASE
        WHEN gap_minutes < 30 THEN 0
        WHEN gap_minutes < 120 THEN 1
        WHEN gap_minutes < 360 THEN 2
        WHEN gap_minutes < 1440 THEN 3
        ELSE 4
      END AS bucket,
      COUNT(*)::text AS cnt
    FROM gaps
    GROUP BY 1
    ORDER BY 1
  `);

  const statsRows = await queryRows<
    {
      total_gaps: string;
      median_min: string | null;
      p25_min: string | null;
      p75_min: string | null;
      intra_day: string;
    }[]
  >(db, sql`
    WITH ordered AS (
      SELECT
        lt.user_id,
        lt.created_at,
        LAG(lt.created_at) OVER (
          PARTITION BY lt.user_id ORDER BY lt.created_at
        ) AS prev_at
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
    ),
    gaps AS (
      SELECT
        EXTRACT(EPOCH FROM (created_at - prev_at)) / 60.0 AS gap_minutes
      FROM ordered
      WHERE prev_at IS NOT NULL
    )
    SELECT
      COUNT(*)::text AS total_gaps,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_minutes)::text AS median_min,
      PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY gap_minutes)::text AS p25_min,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY gap_minutes)::text AS p75_min,
      COUNT(*) FILTER (WHERE gap_minutes < 1440)::text AS intra_day
    FROM gaps
  `);

  const buckets: TimeGapBucket[] = GAP_BUCKETS.map((b) => ({
    label: b.label,
    minMinutes: b.min,
    maxMinutes: b.max === Number.MAX_SAFE_INTEGER ? Number.POSITIVE_INFINITY : b.max,
    count: 0,
    share: 0,
  }));
  for (const r of rows) {
    const idx = Number(r.bucket);
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx].count = Number(r.cnt ?? 0);
    }
  }

  const stats = statsRows[0];
  const totalGaps = Number(stats?.total_gaps ?? 0);
  const intraDay = Number(stats?.intra_day ?? 0);
  for (const b of buckets) {
    b.share = totalGaps > 0 ? b.count / totalGaps : 0;
  }

  return {
    buckets,
    totalGaps,
    medianGapMinutes: stats?.median_min != null ? toNumber(stats.median_min) : 0,
    p25GapMinutes: stats?.p25_min != null ? toNumber(stats.p25_min) : 0,
    p75GapMinutes: stats?.p75_min != null ? toNumber(stats.p75_min) : 0,
    intraDayShare: totalGaps > 0 ? intraDay / totalGaps : 0,
  };
}

// ─── 5. Bonus-to-wager ratio per deposit-size segment (nice-to-have) ─

export type BonusWagerSegment = {
  /** Deposit-size band label. */
  label: string;
  /** Users whose window deposit total falls in this band. */
  users: number;
  /** Avg bonus received per user in this band (USD). */
  avgBonus: number;
  /** Avg wager per user in this band (USD). */
  avgWager: number;
  /** avgBonus / avgWager — how subsidised the segment is, 0..1+ (null if no wager). */
  subsidyRatio: number | null;
};

export type DepositBonusToWagerSegments = {
  segments: BonusWagerSegment[];
};

// Segment users by their TOTAL window deposit volume into the same size
// bands as the deposit-size histogram (collapsed: the three < $100 bands
// roll into one "casual" bucket for readability).
async function computeBonusWagerSegments(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusToWagerSegments> {
  const db = await getReadDrizzleDb();
  const dateFilter = windowDateFilter(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  const rows = await queryRows<
    {
      segment: number;
      users: string;
      total_bonus: string;
      total_wager: string;
    }[]
  >(db, sql`
    WITH per_user AS (
      SELECT
        d.user_id,
        SUM(ABS(d.amount::numeric)) AS deposit_total
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type::text = 'deposit'
        AND d.user_id IN ${userScope}
        ${windowDateFilter(period, "d")}
      GROUP BY d.user_id
    ),
    bonus_window AS (
      SELECT lt.user_id, SUM(ABS(lt.amount::numeric)) AS bonus_total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN (SELECT user_id FROM per_user)
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    wager_window AS (
      SELECT lt.user_id, SUM(ABS(lt.amount::numeric)) AS wager_total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)}
        AND lt.user_id IN (SELECT user_id FROM per_user)
        ${dateFilter}
      GROUP BY lt.user_id
    )
    SELECT
      CASE
        WHEN pu.deposit_total < 100 THEN 0
        WHEN pu.deposit_total < 500 THEN 1
        WHEN pu.deposit_total < 2000 THEN 2
        ELSE 3
      END AS segment,
      COUNT(*)::text AS users,
      COALESCE(SUM(bw.bonus_total), 0)::text AS total_bonus,
      COALESCE(SUM(ww.wager_total), 0)::text AS total_wager
    FROM per_user pu
    LEFT JOIN bonus_window bw ON bw.user_id = pu.user_id
    LEFT JOIN wager_window ww ON ww.user_id = pu.user_id
    GROUP BY 1
    ORDER BY 1
  `);

  const SEGMENT_LABELS = ["<$100", "$100–500", "$500–2K", "$2K+"];
  const segments: BonusWagerSegment[] = SEGMENT_LABELS.map((label) => ({
    label,
    users: 0,
    avgBonus: 0,
    avgWager: 0,
    subsidyRatio: null,
  }));
  for (const r of rows) {
    const idx = Number(r.segment);
    if (idx < 0 || idx >= segments.length) continue;
    const users = Number(r.users ?? 0);
    const totalBonus = toNumber(r.total_bonus);
    const totalWager = toNumber(r.total_wager);
    const avgBonus = users > 0 ? totalBonus / users : 0;
    const avgWager = users > 0 ? totalWager / users : 0;
    segments[idx] = {
      label: segments[idx].label,
      users,
      avgBonus,
      avgWager,
      subsidyRatio: avgWager > 0 ? avgBonus / avgWager : null,
    };
  }
  return { segments };
}

// ─── 6. Post-cap re-deposit behaviour (nice-to-have, approximate) ───

export type DepositBonusPostCapBehavior = {
  /** Empirical cap for the window. */
  capValue: number;
  /** Cap-hitters surveyed (distinct users with a cap hit in window). */
  capHitters: number;
  /**
   * Cap-hitters who made ≥ 1 further deposit AFTER their first cap hit in
   * the window. Approximation: counts any later completed deposit.
   */
  keptDepositing: number;
  /** Cap-hitters with NO further deposit after their first cap hit. */
  stopped: number;
  /**
   * Of the post-cap deposits, how many received NO additional bonus
   * (no paired deposit_bonus row within 30s) — i.e. deposited despite the
   * cap being exhausted. Approximation via the canonical pairing rule.
   */
  postCapDepositsNoBonus: number;
  /** Total post-cap deposits across all cap-hitters. */
  postCapDepositsTotal: number;
};

async function computePostCapBehavior(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusPostCapBehavior> {
  const db = await getReadDrizzleDb();
  // The bonus side (cap detection + first-cap pairing) uses the plain
  // window bound; the deposit side of the post-cap scan is capped to 365d
  // on lifetime so it doesn't walk the full deposit history.
  const bonusDateFilter = windowDateFilter(period);
  const depositDateFilter = windowDateFilterCapped(period, "d");
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  const capRows = await queryRows<{ max_amount: string | null }[]>(db, sql`
    SELECT MAX(ABS(lt.amount::numeric))::text AS max_amount
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type::text = 'deposit_bonus'
      AND lt.user_id IN ${userScope}
      ${bonusDateFilter}
  `);
  const capValue =
    capRows[0]?.max_amount != null ? toNumber(capRows[0].max_amount) : 0;

  if (capValue <= 0) {
    return {
      capValue: 0,
      capHitters: 0,
      keptDepositing: 0,
      stopped: 0,
      postCapDepositsNoBonus: 0,
      postCapDepositsTotal: 0,
    };
  }

  const capLiteral = Number(capValue.toFixed(2));

  // First cap-hit time per user, then count later deposits + whether each
  // later deposit got a paired bonus (canonical balance_before==balance_after
  // 30s rule). The deposit scan is capped to 365d on lifetime.
  const rows = await queryRows<
    {
      cap_hitters: string;
      kept: string;
      stopped: string;
      post_total: string;
      post_no_bonus: string;
    }[]
  >(db, sql`
    WITH first_cap AS (
      SELECT lt.user_id, MIN(lt.created_at) AS first_cap_at
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        AND ABS(lt.amount::numeric) = ${capLiteral}
        ${bonusDateFilter}
      GROUP BY lt.user_id
    ),
    post_deposits AS (
      SELECT
        fc.user_id,
        d.id AS deposit_id,
        d.balance_after::numeric AS bal_after,
        d.created_at
      FROM first_cap fc
      JOIN ledger_transactions d
        ON d.user_id = fc.user_id
        AND d.status = 'completed'
        AND d.type::text = 'deposit'
        AND d.created_at > fc.first_cap_at
        ${depositDateFilter}
    ),
    post_paired AS (
      SELECT
        pd.user_id,
        pd.deposit_id,
        EXISTS (
          SELECT 1
          FROM ledger_transactions b
          WHERE b.user_id = pd.user_id
            AND b.type::text = 'deposit_bonus'
            AND b.status = 'completed'
            AND b.balance_before::numeric = pd.bal_after
            AND b.created_at >= pd.created_at
            AND b.created_at < pd.created_at + INTERVAL '30 seconds'
        ) AS got_bonus
      FROM post_deposits pd
    )
    SELECT
      (SELECT COUNT(*)::text FROM first_cap) AS cap_hitters,
      (SELECT COUNT(DISTINCT user_id)::text FROM post_deposits) AS kept,
      (
        SELECT COUNT(*)::text FROM first_cap fc
        WHERE NOT EXISTS (
          SELECT 1 FROM post_deposits pd WHERE pd.user_id = fc.user_id
        )
      ) AS stopped,
      (SELECT COUNT(*)::text FROM post_paired) AS post_total,
      (SELECT COUNT(*)::text FROM post_paired WHERE got_bonus = false) AS post_no_bonus
  `);

  const r = rows[0];
  return {
    capValue,
    capHitters: Number(r?.cap_hitters ?? 0),
    keptDepositing: Number(r?.kept ?? 0),
    stopped: Number(r?.stopped ?? 0),
    postCapDepositsNoBonus: Number(r?.post_no_bonus ?? 0),
    postCapDepositsTotal: Number(r?.post_total ?? 0),
  };
}

// ─── 8. New vs returning cap triggers (nice-to-have) ────────────────

export type CapHitterCohortSide = {
  /** Distinct cap-hitters in this cohort. */
  users: number;
  /** Their combined cap hits. */
  capHits: number;
  /** Their combined deposit volume in window (USD). */
  depositTotal: number;
  /** Their combined wager in window (USD). */
  wagerTotal: number;
};

export type DepositBonusCapHitterCohorts = {
  /** Empirical cap for the window. */
  capValue: number;
  /** Signed up within the period window. */
  newCohort: CapHitterCohortSide;
  /** Signed up before the period window. */
  returningCohort: CapHitterCohortSide;
};

async function computeCapHitterCohorts(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusCapHitterCohorts> {
  const db = await getReadDrizzleDb();
  const dateFilter = windowDateFilter(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);
  const windowStart = windowStartExpr(period);

  const capRows = await queryRows<{ max_amount: string | null }[]>(db, sql`
    SELECT MAX(ABS(lt.amount::numeric))::text AS max_amount
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type::text = 'deposit_bonus'
      AND lt.user_id IN ${userScope}
      ${dateFilter}
  `);
  const capValue =
    capRows[0]?.max_amount != null ? toNumber(capRows[0].max_amount) : 0;

  const empty: CapHitterCohortSide = {
    users: 0,
    capHits: 0,
    depositTotal: 0,
    wagerTotal: 0,
  };
  if (capValue <= 0) {
    return { capValue: 0, newCohort: { ...empty }, returningCohort: { ...empty } };
  }

  const capLiteral = Number(capValue.toFixed(2));

  // Cap-hitters classified by signup time relative to the window start,
  // with their window deposit + wager volume. `new` = user.created_at
  // within the window; `returning` = signed up before. On lifetime the
  // window start is -infinity, so every hitter is "returning" — surfaced
  // honestly (lifetime has no "new within window" notion).
  const rows = await queryRows<
    {
      cohort: "new" | "returning";
      users: string;
      cap_hits: string;
      deposit_total: string;
      wager_total: string;
    }[]
  >(db, sql`
    WITH cap_hitters AS (
      SELECT lt.user_id, COUNT(*)::int AS cap_hits
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        AND ABS(lt.amount::numeric) = ${capLiteral}
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    classified AS (
      SELECT
        ch.user_id,
        ch.cap_hits,
        CASE
          WHEN u.created_at >= ${windowStart} THEN 'new'
          ELSE 'returning'
        END AS cohort
      FROM cap_hitters ch
      JOIN "user" u ON u.id = ch.user_id
    ),
    deposit_window AS (
      SELECT lt.user_id, SUM(ABS(lt.amount::numeric)) AS deposit_total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit'
        AND lt.user_id IN (SELECT user_id FROM classified)
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    wager_window AS (
      SELECT lt.user_id, SUM(ABS(lt.amount::numeric)) AS wager_total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)}
        AND lt.user_id IN (SELECT user_id FROM classified)
        ${dateFilter}
      GROUP BY lt.user_id
    )
    SELECT
      c.cohort,
      COUNT(*)::text AS users,
      SUM(c.cap_hits)::text AS cap_hits,
      COALESCE(SUM(dw.deposit_total), 0)::text AS deposit_total,
      COALESCE(SUM(ww.wager_total), 0)::text AS wager_total
    FROM classified c
    LEFT JOIN deposit_window dw ON dw.user_id = c.user_id
    LEFT JOIN wager_window ww ON ww.user_id = c.user_id
    GROUP BY c.cohort
  `);

  const parseSide = (cohort: "new" | "returning"): CapHitterCohortSide => {
    const row = rows.find((r) => r.cohort === cohort);
    return {
      users: Number(row?.users ?? 0),
      capHits: Number(row?.cap_hits ?? 0),
      depositTotal: toNumber(row?.deposit_total),
      wagerTotal: toNumber(row?.wager_total),
    };
  };

  return {
    capValue,
    newCohort: parseSide("new"),
    returningCohort: parseSide("returning"),
  };
}

// ─── Cache wrappers ─────────────────────────────────────────────────
// Shared `makeCachedPair` (60s/300s, (period,blacklist)-keyed) lives in
// `../_cache`; pass this surface's cache-tag bucket so invalidation still
// ties to `insights-rewards-deposit-bonus`.

export const getDepositBonusDepositFrequency = makeCachedPair(
  computeDepositFrequency,
  "insights-rewards-deposit-bonus-impact-frequency",
  DEPOSIT_BONUS_CACHE_TAGS,
);

export const getDepositBonusDepositSizeDistribution = makeCachedPair(
  computeDepositSizeDistribution,
  "insights-rewards-deposit-bonus-impact-size",
  DEPOSIT_BONUS_CACHE_TAGS,
);

export const getDepositBonusCapHitters = makeCachedPair(
  computeCapHitters,
  "insights-rewards-deposit-bonus-impact-cap-hitters-v2",
  DEPOSIT_BONUS_CACHE_TAGS,
);

export const getDepositBonusTimeBetween = makeCachedPair(
  computeTimeBetween,
  "insights-rewards-deposit-bonus-impact-time-between",
  DEPOSIT_BONUS_CACHE_TAGS,
);

export const getDepositBonusToWagerSegments = makeCachedPair(
  computeBonusWagerSegments,
  "insights-rewards-deposit-bonus-impact-bonus-wager",
  DEPOSIT_BONUS_CACHE_TAGS,
);

export const getDepositBonusPostCapBehavior = makeCachedPair(
  computePostCapBehavior,
  "insights-rewards-deposit-bonus-impact-post-cap",
  DEPOSIT_BONUS_CACHE_TAGS,
);

export const getDepositBonusCapHitterCohorts = makeCachedPair(
  computeCapHitterCohorts,
  "insights-rewards-deposit-bonus-impact-cohorts",
  DEPOSIT_BONUS_CACHE_TAGS,
);
