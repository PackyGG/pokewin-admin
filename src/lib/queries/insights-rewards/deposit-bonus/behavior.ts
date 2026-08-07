import { queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
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
  staffAndBlacklistSubquery,
  windowDateFilter,
  windowDateFilterCapped,
  windowStartExpr,
} from "./_shared";

/**
 * Behavioural lenses for deposit bonuses:
 *
 *   - getDepositBonusTimeToClaim     — latency distribution between
 *                                       a deposit and its bonus claim
 *                                       (most fire within seconds;
 *                                       outliers > 60s hint at backend
 *                                       lag)
 *   - getDepositBonusRepeatClaimants — segmentation by lifetime claim
 *                                       count (1 / 2-5 / 6-20 / 21+)
 *   - getDepositBonusNewVsReturning  — first-time vs returning claimants
 *                                       in the window
 *   - getDepositBonusTimeOfDay       — hour-of-day + day-of-week patterns
 *
 * Staff + blacklist excluded. Read-only against ledger_transactions.
 */

// ─── Time-to-claim ─────────────────────────────────────────────────

export type DepositBonusTimeToClaim = {
  /** Distribution of seconds between deposit and bonus claim — bucketed. */
  buckets: Array<{
    label: string;
    /** Inclusive lower bound in seconds. */
    minSeconds: number;
    /** Exclusive upper bound; +Infinity for the catch-all bucket. */
    maxSeconds: number;
    count: number;
  }>;
  /** Number of paired bonuses surveyed. */
  totalPaired: number;
  /** Median latency in seconds. */
  medianSeconds: number;
  /** P95 latency in seconds. */
  p95Seconds: number;
  /** P99 latency. */
  p99Seconds: number;
  /** Max latency (capped by the join window — 30s). */
  maxSeconds: number;
  /** Mean latency. */
  meanSeconds: number;
};

const TIME_BUCKETS: Array<{
  label: string;
  min: number;
  max: number;
}> = [
  { label: "< 1s", min: 0, max: 1 },
  { label: "1–2s", min: 1, max: 2 },
  { label: "2–5s", min: 2, max: 5 },
  { label: "5–10s", min: 5, max: 10 },
  { label: "10–30s", min: 10, max: 30 },
  { label: "30s+", min: 30, max: 999_999 },
];

async function computeTimeToClaim(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusTimeToClaim> {
  const db = await getReadDrizzleDb();
  // Lifetime is capped to the pairing lookback (365d) so the deposit-side
  // scan doesn't span the entire deposit history.
  const dateFilter = windowDateFilterCapped(period, "d");
  const bonusDateFilter = windowDateFilterCapped(period, "b");
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  // Same canonical pairing (balance_before == balance_after, 30s) so
  // results reconcile with cohort + cap queries.
  //
  // PERFORMANCE — hash join over a materialised bonus set, NOT a
  // correlated LATERAL. The original `JOIN LATERAL (… LIMIT 1)` had no
  // usable index for `balance_before::numeric = wd.bal_after`
  // (ledger_transactions — ~855k rows — is only indexed on id /
  // external_tx_id / fireblocks_tx_id), so it Seq-Scanned the whole table
  // PER deposit row → 57014 statement timeout on EVERY window (even 7d).
  // We materialise the window's deposit rows AND bonus rows and hash-join
  // them on (user_id, balance_before = balance_after) within the 30s
  // window; `DISTINCT ON (wd.id) … ORDER BY wb.created_at ASC` keeps the
  // FIRST matching bonus per deposit (old `LIMIT 1` semantics; INNER join
  // → only paired deposits, identical to the original). Drops the query
  // from a >30s timeout to <1s on live prod data. MATERIALIZED stops
  // Postgres re-inlining the bonus CTE into a correlated form.
  const rows = await queryRows<
    {
      bucket: number;
      cnt: string;
    }[]
  >(db, sql`
    WITH window_deposits AS MATERIALIZED (
      SELECT d.id, d.user_id, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type::text = 'deposit'
        AND d.user_id IN ${userScope}
        ${dateFilter}
    ),
    window_bonuses AS MATERIALIZED (
      SELECT b.user_id, b.balance_before::numeric AS bal_before, b.created_at
      FROM ledger_transactions b
      WHERE b.status = 'completed'
        AND b.type::text = 'deposit_bonus'
        ${bonusDateFilter}
    ),
    paired AS (
      SELECT DISTINCT ON (wd.id)
        EXTRACT(EPOCH FROM (wb.created_at - wd.created_at))::numeric AS delta_s
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
        WHEN delta_s < 1 THEN 0
        WHEN delta_s < 2 THEN 1
        WHEN delta_s < 5 THEN 2
        WHEN delta_s < 10 THEN 3
        WHEN delta_s < 30 THEN 4
        ELSE 5
      END AS bucket,
      COUNT(*)::text AS cnt
    FROM paired
    GROUP BY 1
    ORDER BY 1
  `);

  const buckets: DepositBonusTimeToClaim["buckets"] = TIME_BUCKETS.map((b) => ({
    label: b.label,
    minSeconds: b.min,
    maxSeconds: b.max === 999_999 ? Number.POSITIVE_INFINITY : b.max,
    count: 0,
  }));
  let totalPaired = 0;
  for (const r of rows) {
    const idx = Number(r.bucket);
    const cnt = Number(r.cnt ?? 0);
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx].count = cnt;
    }
    totalPaired += cnt;
  }

  // Percentile pull — separate query but same materialised hash-join
  // shape as the bucket query above (see its PERFORMANCE comment).
  const statsRows = await queryRows<
    {
      median_s: string | null;
      p95_s: string | null;
      p99_s: string | null;
      mean_s: string | null;
      max_s: string | null;
    }[]
  >(db, sql`
    WITH window_deposits AS MATERIALIZED (
      SELECT d.id, d.user_id, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type::text = 'deposit'
        AND d.user_id IN ${userScope}
        ${dateFilter}
    ),
    window_bonuses AS MATERIALIZED (
      SELECT b.user_id, b.balance_before::numeric AS bal_before, b.created_at
      FROM ledger_transactions b
      WHERE b.status = 'completed'
        AND b.type::text = 'deposit_bonus'
        ${bonusDateFilter}
    ),
    paired AS (
      SELECT DISTINCT ON (wd.id)
        EXTRACT(EPOCH FROM (wb.created_at - wd.created_at))::numeric AS delta_s
      FROM window_deposits wd
      JOIN window_bonuses wb
        ON wb.user_id = wd.user_id
        AND wb.bal_before = wd.bal_after
        AND wb.created_at >= wd.created_at
        AND wb.created_at < wd.created_at + INTERVAL '30 seconds'
      ORDER BY wd.id, wb.created_at ASC
    )
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY delta_s)::text AS median_s,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delta_s)::text AS p95_s,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY delta_s)::text AS p99_s,
      AVG(delta_s)::text AS mean_s,
      MAX(delta_s)::text AS max_s
    FROM paired
  `);

  const stats = statsRows[0];
  return {
    buckets,
    totalPaired,
    medianSeconds: stats?.median_s != null ? toNumber(stats.median_s) : 0,
    p95Seconds: stats?.p95_s != null ? toNumber(stats.p95_s) : 0,
    p99Seconds: stats?.p99_s != null ? toNumber(stats.p99_s) : 0,
    meanSeconds: stats?.mean_s != null ? toNumber(stats.mean_s) : 0,
    maxSeconds: stats?.max_s != null ? toNumber(stats.max_s) : 0,
  };
}

const cachedTimeToClaim = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTimeToClaim(period, blacklistIds),
  ["insights-rewards-deposit-bonus-ttc-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusTimeToClaim(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusTimeToClaim> {
  const blacklist = await getResolvedBlacklist();
  void cacheTtlForInsightsPeriod(period); // signature parity
  return cachedTimeToClaim(period, blacklist);
}

// ─── Repeat-claimants segmentation ─────────────────────────────────

type RepeatClaimantSegment = {
  /** Segment label, e.g. "1", "2–5". */
  label: string;
  /** Lower bound inclusive. */
  minClaims: number;
  /** Upper bound (inclusive when > 0, +Inf for catch-all). */
  maxClaims: number;
  /** Users in this segment. */
  users: number;
  /** Total bonus volume awarded to this segment in window. */
  totalBonus: number;
  /** Avg per user. */
  avgBonusPerUser: number;
  /** Subsequent wager volume in window for this segment (LTV proxy). */
  wagerInWindow: number;
};

export type DepositBonusRepeatClaimants = {
  segments: RepeatClaimantSegment[];
  /** Total claimants in window. */
  totalClaimants: number;
  /** Total bonus volume in window. */
  totalBonus: number;
};

async function computeRepeatClaimants(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusRepeatClaimants> {
  const db = await getReadDrizzleDb();
  const dateFilter = windowDateFilter(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  // Per-user lifetime claim count snapshot (across all time), plus
  // their window-bounded bonus volume + wager volume. Segments by
  // lifetime count match the spec.
  const rows = await queryRows<
    {
      user_id: string;
      lifetime_claims: string;
      bonus_in_window: string;
      wager_in_window: string;
    }[]
  >(db, sql`
    WITH window_users AS (
      SELECT DISTINCT lt.user_id
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
    ),
    lifetime_counts AS (
      SELECT lt.user_id, COUNT(*)::int AS lifetime_claims
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN (SELECT user_id FROM window_users)
      GROUP BY lt.user_id
    ),
    bonus_window AS (
      SELECT lt.user_id, SUM(ABS(lt.amount::numeric)) AS bonus_in_window
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN (SELECT user_id FROM window_users)
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    wager_window AS (
      SELECT lt.user_id, SUM(ABS(lt.amount::numeric)) AS wager_in_window
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
        AND lt.user_id IN (SELECT user_id FROM window_users)
        ${dateFilter}
      GROUP BY lt.user_id
    )
    SELECT
      wu.user_id,
      COALESCE(lc.lifetime_claims, 0)::text AS lifetime_claims,
      COALESCE(bw.bonus_in_window, 0)::text AS bonus_in_window,
      COALESCE(ww.wager_in_window, 0)::text AS wager_in_window
    FROM window_users wu
    LEFT JOIN lifetime_counts lc ON lc.user_id = wu.user_id
    LEFT JOIN bonus_window bw ON bw.user_id = wu.user_id
    LEFT JOIN wager_window ww ON ww.user_id = wu.user_id
  `);

  const segments: RepeatClaimantSegment[] = [
    { label: "1 claim", minClaims: 1, maxClaims: 1, users: 0, totalBonus: 0, avgBonusPerUser: 0, wagerInWindow: 0 },
    { label: "2–5", minClaims: 2, maxClaims: 5, users: 0, totalBonus: 0, avgBonusPerUser: 0, wagerInWindow: 0 },
    { label: "6–20", minClaims: 6, maxClaims: 20, users: 0, totalBonus: 0, avgBonusPerUser: 0, wagerInWindow: 0 },
    { label: "21+", minClaims: 21, maxClaims: Number.POSITIVE_INFINITY, users: 0, totalBonus: 0, avgBonusPerUser: 0, wagerInWindow: 0 },
  ];
  let totalBonus = 0;
  for (const r of rows) {
    const lifetime = Number(r.lifetime_claims ?? 0);
    const bonus = toNumber(r.bonus_in_window);
    const wager = toNumber(r.wager_in_window);
    const idx =
      lifetime <= 1
        ? 0
        : lifetime <= 5
          ? 1
          : lifetime <= 20
            ? 2
            : 3;
    segments[idx].users += 1;
    segments[idx].totalBonus += bonus;
    segments[idx].wagerInWindow += wager;
    totalBonus += bonus;
  }
  for (const seg of segments) {
    seg.avgBonusPerUser = seg.users > 0 ? seg.totalBonus / seg.users : 0;
  }
  return { segments, totalClaimants: rows.length, totalBonus };
}

const cachedRepeat = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeRepeatClaimants(period, blacklistIds),
  ["insights-rewards-deposit-bonus-repeat-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusRepeatClaimants(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusRepeatClaimants> {
  const blacklist = await getResolvedBlacklist();
  return cachedRepeat(period, blacklist);
}

// ─── New vs returning ──────────────────────────────────────────────

export type DepositBonusNewVsReturning = {
  newClaimants: {
    users: number;
    totalBonus: number;
    avgBonusPerUser: number;
    avgFirstDepositUsd: number;
    /** % of the cohort who wagered within 7d of first claim. */
    retain7d: number;
    /** % who made a SECOND deposit within 30d of first claim. */
    secondDeposit30dRate: number;
  };
  returningClaimants: {
    users: number;
    totalBonus: number;
    avgBonusPerUser: number;
    avgFirstDepositUsd: number;
    retain7d: number;
    secondDeposit30dRate: number;
  };
};

async function computeNewVsReturning(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusNewVsReturning> {
  const db = await getReadDrizzleDb();
  const dateFilter = windowDateFilter(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);
  const windowStart = windowStartExpr(period);

  // For each claimant in window, decide "first-time" via prior bonus
  // row before the window. Then compute per-cohort:
  //   - total bonus + count
  //   - first deposit size in window (joined via pairing rule)
  //   - 7d retention via subsequent wager
  //   - second deposit within 30d
  const rows = await queryRows<
    {
      cohort: "new" | "returning";
      users: string;
      bonus_total: string;
      avg_first_deposit: string | null;
      retain7d_users: string;
      second_dep_users: string;
    }[]
  >(db, sql`
    WITH first_claim AS (
      SELECT lt.user_id, MIN(lt.created_at) AS first_claim_at
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    classified AS (
      SELECT
        fc.user_id,
        fc.first_claim_at,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM ledger_transactions prior
            WHERE prior.user_id = fc.user_id
              AND prior.type::text = 'deposit_bonus'
              AND prior.status = 'completed'
              AND prior.created_at < ${windowStart}
          ) THEN 'returning'
          ELSE 'new'
        END AS cohort
      FROM first_claim fc
    ),
    bonus_total AS (
      SELECT lt.user_id, SUM(ABS(lt.amount::numeric)) AS bonus_in_window
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        ${dateFilter}
        AND lt.user_id IN (SELECT user_id FROM classified)
      GROUP BY lt.user_id
    ),
    first_deposit AS (
      SELECT
        c.user_id,
        (
          SELECT ABS(d.amount::numeric)
          FROM ledger_transactions d
          WHERE d.user_id = c.user_id
            AND d.type::text = 'deposit'
            AND d.status = 'completed'
            AND d.created_at <= c.first_claim_at
          ORDER BY d.created_at DESC
          LIMIT 1
        ) AS first_deposit_usd
      FROM classified c
    ),
    retain7d AS (
      SELECT c.user_id
      FROM classified c
      WHERE EXISTS (
        SELECT 1 FROM ledger_transactions w
        WHERE w.user_id = c.user_id
          AND w.status = 'completed'
          AND w.type::text IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
          AND w.created_at > c.first_claim_at + INTERVAL '1 hour'
          AND w.created_at <= c.first_claim_at + INTERVAL '7 days'
      )
    ),
    second_dep AS (
      SELECT c.user_id
      FROM classified c
      WHERE EXISTS (
        SELECT 1 FROM ledger_transactions d2
        WHERE d2.user_id = c.user_id
          AND d2.type::text = 'deposit'
          AND d2.status = 'completed'
          AND d2.created_at > c.first_claim_at + INTERVAL '1 hour'
          AND d2.created_at <= c.first_claim_at + INTERVAL '30 days'
      )
    )
    SELECT
      c.cohort,
      COUNT(*)::text AS users,
      COALESCE(SUM(bt.bonus_in_window), 0)::text AS bonus_total,
      AVG(fd.first_deposit_usd)::text AS avg_first_deposit,
      COUNT(*) FILTER (WHERE r.user_id IS NOT NULL)::text AS retain7d_users,
      COUNT(*) FILTER (WHERE sd.user_id IS NOT NULL)::text AS second_dep_users
    FROM classified c
    LEFT JOIN bonus_total bt ON bt.user_id = c.user_id
    LEFT JOIN first_deposit fd ON fd.user_id = c.user_id
    LEFT JOIN retain7d r ON r.user_id = c.user_id
    LEFT JOIN second_dep sd ON sd.user_id = c.user_id
    GROUP BY c.cohort
  `);

  const parseSide = (cohort: "new" | "returning") => {
    const row = rows.find((r) => r.cohort === cohort);
    const users = Number(row?.users ?? 0);
    const totalBonus = toNumber(row?.bonus_total);
    return {
      users,
      totalBonus,
      avgBonusPerUser: users > 0 ? totalBonus / users : 0,
      avgFirstDepositUsd:
        row?.avg_first_deposit != null ? toNumber(row.avg_first_deposit) : 0,
      retain7d: users > 0 ? Number(row?.retain7d_users ?? 0) / users : 0,
      secondDeposit30dRate:
        users > 0 ? Number(row?.second_dep_users ?? 0) / users : 0,
    };
  };

  return {
    newClaimants: parseSide("new"),
    returningClaimants: parseSide("returning"),
  };
}

const cachedNewVsReturning = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeNewVsReturning(period, blacklistIds),
  ["insights-rewards-deposit-bonus-new-returning-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusNewVsReturning(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusNewVsReturning> {
  const blacklist = await getResolvedBlacklist();
  return cachedNewVsReturning(period, blacklist);
}

// ─── Time-of-day pattern ───────────────────────────────────────────

export type DepositBonusTimeOfDay = {
  /** 24 bins, index 0 = midnight UTC. */
  hourly: Array<{ hour: number; count: number; volume: number }>;
  /** 7 bins, 0 = Sunday per ISO/Postgres EXTRACT(DOW). */
  daily: Array<{ dayOfWeek: number; label: string; count: number; volume: number }>;
};

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function computeTimeOfDay(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusTimeOfDay> {
  const db = await getReadDrizzleDb();
  const dateFilter = windowDateFilter(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  const [hourlyRows, dailyRows] = await Promise.all([
    queryRows<
      { hour: number; cnt: string; volume: string }[]
    >(db, sql`
      SELECT
        EXTRACT(HOUR FROM lt.created_at AT TIME ZONE 'UTC')::int AS hour,
        COUNT(*)::text AS cnt,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS volume
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
      GROUP BY 1
      ORDER BY 1
    `),
    queryRows<
      { dow: number; cnt: string; volume: string }[]
    >(db, sql`
      SELECT
        EXTRACT(DOW FROM lt.created_at AT TIME ZONE 'UTC')::int AS dow,
        COUNT(*)::text AS cnt,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS volume
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        ${dateFilter}
      GROUP BY 1
      ORDER BY 1
    `),
  ]);

  const hourly: DepositBonusTimeOfDay["hourly"] = Array.from(
    { length: 24 },
    (_, h) => ({ hour: h, count: 0, volume: 0 }),
  );
  for (const r of hourlyRows) {
    const h = Number(r.hour);
    if (h >= 0 && h < 24) {
      hourly[h] = {
        hour: h,
        count: Number(r.cnt ?? 0),
        volume: toNumber(r.volume),
      };
    }
  }

  const daily: DepositBonusTimeOfDay["daily"] = Array.from(
    { length: 7 },
    (_, d) => ({ dayOfWeek: d, label: DOW_LABELS[d], count: 0, volume: 0 }),
  );
  for (const r of dailyRows) {
    const d = Number(r.dow);
    if (d >= 0 && d < 7) {
      daily[d] = {
        dayOfWeek: d,
        label: DOW_LABELS[d],
        count: Number(r.cnt ?? 0),
        volume: toNumber(r.volume),
      };
    }
  }

  return { hourly, daily };
}

const cachedTimeOfDay = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTimeOfDay(period, blacklistIds),
  ["insights-rewards-deposit-bonus-tod-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusTimeOfDay(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusTimeOfDay> {
  const blacklist = await getResolvedBlacklist();
  return cachedTimeOfDay(period, blacklist);
}
