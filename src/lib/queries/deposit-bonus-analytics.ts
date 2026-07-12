import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import type { RewardsPeriod } from "./rewards-analytics";
import {
  getDepositBonusCategoryAnalytics,
  type CategoryAnalytics,
} from "./rewards-category-analytics";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Deposit-bonus deep-stats helper for /rewards/analytics' Deposit Bonus
 * tab.
 *
 * Wraps the shared `getDepositBonusCategoryAnalytics` (which provides
 * total / count / avg / median / max / unique recipients / daily series
 * / top users / top days) and layers deposit-bonus-specific stats on
 * top — currently the empirically-derived cap value + cap-hit rate.
 *
 * Cap value: the deposit-bonus cap is configured in the GAME BACKEND
 * (not in `site_config` on the main DB, and not in this admin
 * codebase). We therefore derive it empirically as `MAX(ABS(amount))`
 * observed in the period — that IS the largest payout the backend has
 * actually issued. "Cap hits" = count of rows whose ABS(amount) equals
 * that max. Stays correct if the cap is ever raised: the new max
 * becomes the new cap and the hit-rate naturally tracks it. If the cap
 * key shows up in site_config later, swap the source here and drop
 * the empirical derivation — every other call site stays the same.
 *
 * Per CLAUDE.md House-POV: deposit bonus is money the house GIVES
 * users → drag on house P&L → rose accent on the panel.
 */

export type DepositBonusAnalytics = CategoryAnalytics & {
  /** Observed cap — equal to `max`. */
  capValue: number;
  /** Count of rows where ABS(amount) === capValue. */
  capHits: number;
  /** capHits / count, 0–1. Multiply by 100 in the UI. */
  capHitRate: number;
};

function daysForPeriod(period: RewardsPeriod): number | null {
  switch (period) {
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return null;
  }
}

/**
 * Lifetime lookback cap (days) for the heavy deposit↔bonus balance-pairing
 * scan in {@link computeDepositBonusCohortExtras}. On the `all` window the
 * plain {@link daysForPeriod} returns `null` (unbounded), which would make
 * the pairing scan the entire `ledger_transactions` history. Bounding both
 * the deposit and the bonus side to the last year keeps the cold cache fill
 * tractable while still covering effectively all currently-relevant bonus
 * activity. Mirrors `LIFETIME_PAIRING_LOOKBACK_DAYS` / `INSIGHTS_LIFETIME_LOOKBACK_DAYS`
 * (365d) already used by the insights-rewards deposit-bonus folder so the
 * two stay aligned.
 */
const COHORT_LIFETIME_LOOKBACK_DAYS = 365;

/**
 * Like {@link daysForPeriod}, but the lifetime (`all`) window resolves to
 * {@link COHORT_LIFETIME_LOOKBACK_DAYS} instead of `null`. Used ONLY by the
 * cohort balance-pairing query so a lifetime view doesn't trigger a
 * full-history table scan. Finite windows return the same value.
 */
function cappedDaysForCohort(period: RewardsPeriod): number {
  return daysForPeriod(period) ?? COHORT_LIFETIME_LOOKBACK_DAYS;
}

/**
 * Cap-hit count for the period — wrapped in its own cache so the lookup
 * stays cheap and the cache key tracks the period + blacklist signature.
 * The cap-equal scan is bounded to one COUNT(*) and only runs after we
 * already know the empirical max, so the round-trip is tiny.
 */
async function computeCapHits(
  period: RewardsPeriod,
  capValue: number,
  blacklistIds: string[],
): Promise<number> {
  if (capValue <= 0) return 0;
  const db = await getDb();
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const blacklistSubquery = blacklistNotInClause("id", blacklistIds);

  const rows = await db.$queryRawUnsafe<{ cnt: string }[]>(`
    SELECT COUNT(*)::text AS cnt
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type::text = 'deposit_bonus'
      AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
      AND ABS(lt.amount::numeric) = ${capValue.toFixed(2)}
      ${dateFilter}
  `);
  return Number(rows[0]?.cnt ?? 0);
}

const cachedCapHits = unstable_cache(
  async (period: RewardsPeriod, capValue: number, blacklistIds: string[]) =>
    computeCapHits(period, capValue, blacklistIds),
  ["rewards-deposit-bonus-cap-hits-v1"],
  { revalidate: 60, tags: ["rewards-analytics"] },
);

export async function getDepositBonusAnalytics(
  period: RewardsPeriod,
): Promise<DepositBonusAnalytics> {
  const base = await getDepositBonusCategoryAnalytics(period);
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const capHits = await cachedCapHits(period, base.max, sorted);
  const capHitRate = base.count > 0 ? capHits / base.count : 0;
  return {
    ...base,
    capValue: base.max,
    capHits,
    capHitRate,
  };
}

// ── Cohort + distribution extras ──────────────────────────────────────

/**
 * Cohort split — completed deposits in the period, with vs without an
 * accompanying `deposit_bonus` ledger row. Links each bonus to its
 * triggering deposit using the SAME rule the live money-movement feed
 * uses (`bonus.balance_before == deposit.balance_after`). That rule is
 * canonical in `dashboard-live.ts` — reusing it here keeps the
 * with/without split reconciled with every other deposit↔bonus pairing
 * on the admin panel.
 *
 * Note: dashboard-live.ts allows up to 2 minutes between the deposit
 * and the bonus (defensive upper bound for slow ledger writes). For
 * the analytics rollups here we tighten to 30 seconds — bonuses fire
 * immediately after deposits in practice, and the tighter window
 * dramatically shrinks the LATERAL join's cross-product before the
 * time-window filter. The pairing accuracy is unchanged for the
 * normal path; only freak long-delayed bonuses are dropped.
 *
 * Cohort buckets reported:
 *   - depositsWith / depositsWithout      — count split
 *   - shareWith                           — % of completed deposits that
 *                                           triggered a bonus claim
 *   - avgDepositWith / avgDepositWithout  — avg USD per deposit per side
 *   - liftPct                             — % difference avg-with vs
 *                                           avg-without (claimants
 *                                           historically deposit larger)
 *
 * Bonus-to-deposit ratio histogram (buckets):
 *   0–5 / 5–15 / 15–30 / 30–60 / 60–100+ % of deposit returned as bonus.
 *   Each bucket has count + total bonus volume so the chart can show
 *   the typical match rate at a glance.
 *
 * First-time vs repeat split:
 *   For each `deposit_bonus` row in the window, look up whether the user
 *   had any earlier `deposit_bonus` row (regardless of window). First-
 *   timers tell us how much of the window's bonus volume is acquisition
 *   spend vs ongoing operating cost.
 *
 * Top cap deposits:
 *   Five largest deposits in the window whose bonus equalled the cap.
 *   Surfaces "who's reliably hitting the cap" so the team can decide if
 *   the cap needs raising.
 */
export type DepositBonusCohortExtras = {
  /** Completed deposits in the window — staff/blacklist already excluded. */
  totalDeposits: number;
  /** Subset of `totalDeposits` whose deposit triggered a bonus claim. */
  depositsWith: number;
  /** Subset of `totalDeposits` with no matching bonus row. */
  depositsWithout: number;
  /** 0–1 — depositsWith / totalDeposits. */
  shareWith: number;
  /** Avg deposit size USD for the with-bonus cohort. */
  avgDepositWith: number;
  /** Avg deposit size USD for the without-bonus cohort. */
  avgDepositWithout: number;
  /**
   * % lift of avg-with over avg-without ((with − without) / without).
   * 0 when the without cohort is empty / zero. Positive value → bonus
   * claimants deposit larger amounts on average.
   */
  liftPct: number;
  /** First-time `deposit_bonus` claimants in the window. */
  firstTimeClaimants: number;
  /** Returning claimants — had at least one prior `deposit_bonus` row. */
  repeatClaimants: number;
  /** 0–1 — firstTimeClaimants / (firstTimeClaimants + repeatClaimants). */
  shareFirstTime: number;
  /**
   * Bonus / deposit ratio histogram. Buckets are half-open lower-
   * inclusive; the 60+ bucket is the catch-all for outsized matches
   * (typically promo-coupled deposits). Each bucket carries the bonus
   * count and the total deposit USD inside the bucket.
   */
  ratioBuckets: Array<{
    label: string;
    count: number;
    volume: number;
  }>;
  /**
   * Top 5 deposits in the window where the awarded bonus equalled the
   * empirical cap. Surfaces "who is reliably hitting the cap".
   */
  topCapDeposits: Array<{
    userId: string;
    username: string | null;
    depositUsd: number;
    bonusUsd: number;
    createdAt: string;
  }>;
};

type CohortRollupRow = {
  total_deposits: string;
  deposits_with: string;
  sum_deposits_with: string | null;
  sum_deposits_without: string | null;
  first_time_claimants: string;
  repeat_claimants: string;
};

async function computeDepositBonusCohortExtras(
  period: RewardsPeriod,
  capValue: number,
  blacklistIds: string[],
): Promise<DepositBonusCohortExtras> {
  const db = await getDb();
  // Lifetime (`all`) is CAPPED to COHORT_LIFETIME_LOOKBACK_DAYS (365d):
  // both the deposit and the bonus side of the pairing are bounded so a
  // lifetime view does not scan the entire ledger history. Finite windows
  // use their own day count unchanged.
  const cappedDays = cappedDaysForCohort(period);
  const dateFilter = `AND d.created_at >= NOW() - INTERVAL '${cappedDays} days'`;
  // The matching bonus fires within 30s AFTER its deposit, so any bonus
  // that can pair with an in-window deposit is itself inside the same
  // window (plus 30s slack). Bounding the bonus side to the same lookback
  // is what makes the hash join cheap — without it Postgres scans the full
  // `deposit_bonus` history per deposit row.
  const bonusDateFilter = `AND b.created_at >= NOW() - INTERVAL '${cappedDays} days'`;
  const windowStartExpr = `NOW() - INTERVAL '${cappedDays} days'`;
  const blacklistSubquery = blacklistNotInClause("id", blacklistIds);

  // Canonical bonus↔deposit linking rule (from dashboard-live.ts):
  // bonus.balance_before == deposit.balance_after AND bonus fires
  // within 30s of the deposit (tightened from 2 min for query
  // performance — see header comment).
  //
  // PERFORMANCE — hash join over a materialised bonus set, NOT a
  // correlated LATERAL. The original `LEFT JOIN LATERAL (… LIMIT 1)` had no
  // usable index for `balance_before::numeric = deposit.balance_after`
  // (ledger_transactions is only indexed on id / external_tx_id /
  // fireblocks_tx_id), so it ran a full Seq Scan of the 860k-row table PER
  // deposit row → 57014 statement timeout on EVERY window (even 7d). We
  // instead materialise the window's deposit rows AND the window's bonus
  // rows into CTEs and let Postgres hash-join them on
  // (user_id, balance_before = balance_after) with the 30s time window;
  // `DISTINCT ON (wd.id) … ORDER BY wb.created_at ASC` keeps exactly the
  // FIRST matching bonus per deposit, reproducing the old `LIMIT 1`
  // semantics (a single bonus may still attach to two deposits, same as the
  // per-deposit LATERAL). This drops the query from a >30s timeout to
  // ~1.3s. MATERIALIZED prevents Postgres from inlining the bonus CTE back
  // into a correlated form.
  //
  // First-time vs repeat split is based on whether the user had ANY
  // `deposit_bonus` row BEFORE the window starts. That keeps the
  // definition simple ("did the window introduce this claimant?") and
  // matches how acquisition analytics elsewhere in the codebase treats
  // first-time events (analytics-funnel.ts, analytics-ltv.ts).
  const rollupRows = await db.$queryRawUnsafe<CohortRollupRow[]>(`
    WITH window_deposits AS MATERIALIZED (
      SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type::text = 'deposit'
        AND d.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
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
        wd.id,
        wd.user_id,
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
    distinct_claimants AS (
      SELECT DISTINCT user_id FROM paired WHERE bonus_usd IS NOT NULL
    ),
    claimant_history AS (
      SELECT
        dc.user_id,
        EXISTS (
          SELECT 1 FROM ledger_transactions prior
          WHERE prior.user_id = dc.user_id
            AND prior.type::text = 'deposit_bonus'
            AND prior.status = 'completed'
            AND prior.created_at < ${windowStartExpr}
        ) AS had_prior
      FROM distinct_claimants dc
    )
    SELECT
      COUNT(*)::text AS total_deposits,
      COUNT(*) FILTER (WHERE paired.bonus_usd IS NOT NULL)::text AS deposits_with,
      SUM(CASE WHEN paired.bonus_usd IS NOT NULL THEN paired.deposit_usd ELSE 0 END)::text AS sum_deposits_with,
      SUM(CASE WHEN paired.bonus_usd IS NULL THEN paired.deposit_usd ELSE 0 END)::text AS sum_deposits_without,
      (SELECT COUNT(*) FILTER (WHERE NOT had_prior)::text FROM claimant_history) AS first_time_claimants,
      (SELECT COUNT(*) FILTER (WHERE had_prior)::text FROM claimant_history) AS repeat_claimants
    FROM paired
  `);

  const rollup = rollupRows[0];
  const totalDeposits = Number(rollup?.total_deposits ?? 0);
  const depositsWith = Number(rollup?.deposits_with ?? 0);
  const depositsWithout = totalDeposits - depositsWith;
  const sumWith = toNumber(rollup?.sum_deposits_with);
  const sumWithout = toNumber(rollup?.sum_deposits_without);
  const avgDepositWith = depositsWith > 0 ? sumWith / depositsWith : 0;
  const avgDepositWithout =
    depositsWithout > 0 ? sumWithout / depositsWithout : 0;
  const liftPct =
    avgDepositWithout > 0
      ? ((avgDepositWith - avgDepositWithout) / avgDepositWithout) * 100
      : 0;
  const firstTimeClaimants = Number(rollup?.first_time_claimants ?? 0);
  const repeatClaimants = Number(rollup?.repeat_claimants ?? 0);
  const claimantTotal = firstTimeClaimants + repeatClaimants;
  const shareFirstTime =
    claimantTotal > 0 ? firstTimeClaimants / claimantTotal : 0;
  const shareWith = totalDeposits > 0 ? depositsWith / totalDeposits : 0;

  // Bonus-to-deposit ratio histogram — buckets are half-open (lower
  // inclusive). Same paired set, but only rows with a matching bonus.
  // Bucket boundaries match common loyalty-bonus tier breakpoints.
  // Same materialised hash-join shape as the rollup above (see the long
  // PERFORMANCE comment there) — an inner JOIN keeps only deposits that
  // matched a bonus, and `DISTINCT ON (wd.id)` keeps the first match per
  // deposit (old `JOIN LATERAL … LIMIT 1` semantics).
  const bucketRows = await db.$queryRawUnsafe<
    { bucket: number; cnt: string; volume: string }[]
  >(`
    WITH window_deposits AS MATERIALIZED (
      SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type::text = 'deposit'
        AND d.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
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
        wb.bonus_usd
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
        WHEN (bonus_usd / deposit_usd) * 100 < 5  THEN 0
        WHEN (bonus_usd / deposit_usd) * 100 < 15 THEN 1
        WHEN (bonus_usd / deposit_usd) * 100 < 30 THEN 2
        WHEN (bonus_usd / deposit_usd) * 100 < 60 THEN 3
        ELSE 4
      END AS bucket,
      COUNT(*)::text AS cnt,
      SUM(bonus_usd)::text AS volume
    FROM paired
    GROUP BY 1
  `);

  const BUCKET_LABELS = ["0–5%", "5–15%", "15–30%", "30–60%", "60%+"];
  const bucketCounts: Array<{ label: string; count: number; volume: number }> =
    BUCKET_LABELS.map((label) => ({ label, count: 0, volume: 0 }));
  for (const row of bucketRows) {
    const idx = Number(row.bucket);
    if (idx >= 0 && idx < bucketCounts.length) {
      bucketCounts[idx].count = Number(row.cnt);
      bucketCounts[idx].volume = toNumber(row.volume);
    }
  }

  // Top cap-hit deposits — five largest deposits in the window whose
  // paired bonus equalled the empirical cap. Skipped when cap is 0.
  let topCapDeposits: DepositBonusCohortExtras["topCapDeposits"] = [];
  if (capValue > 0) {
    const capRows = await db.$queryRawUnsafe<
      {
        user_id: string;
        username: string | null;
        deposit_usd: string;
        bonus_usd: string;
        created_at: Date;
      }[]
    >(`
      WITH window_deposits AS MATERIALIZED (
        SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
        FROM ledger_transactions d
        WHERE d.status = 'completed'
          AND d.type::text = 'deposit'
          AND d.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
          ${dateFilter}
      ),
      window_bonuses AS MATERIALIZED (
        SELECT b.user_id, b.balance_before::numeric AS bal_before, ABS(b.amount::numeric) AS bonus_usd, b.created_at
        FROM ledger_transactions b
        WHERE b.status = 'completed'
          AND b.type::text = 'deposit_bonus'
          AND ABS(b.amount::numeric) = ${capValue.toFixed(2)}
          ${bonusDateFilter}
      ),
      matched AS (
        SELECT DISTINCT ON (wd.id)
          wd.user_id,
          ABS(wd.deposit_amt) AS deposit_usd,
          wb.bonus_usd,
          wd.created_at
        FROM window_deposits wd
        JOIN window_bonuses wb
          ON wb.user_id = wd.user_id
          AND wb.bal_before = wd.bal_after
          AND wb.created_at >= wd.created_at
          AND wb.created_at < wd.created_at + INTERVAL '30 seconds'
        ORDER BY wd.id, wb.created_at ASC
      )
      SELECT
        m.user_id,
        u.username,
        m.deposit_usd::text AS deposit_usd,
        m.bonus_usd::text AS bonus_usd,
        m.created_at
      FROM matched m
      JOIN "user" u ON u.id = m.user_id
      ORDER BY m.deposit_usd DESC
      LIMIT 5
    `);

    topCapDeposits = capRows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      depositUsd: toNumber(r.deposit_usd),
      bonusUsd: toNumber(r.bonus_usd),
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  return {
    totalDeposits,
    depositsWith,
    depositsWithout,
    shareWith,
    avgDepositWith,
    avgDepositWithout,
    liftPct,
    firstTimeClaimants,
    repeatClaimants,
    shareFirstTime,
    ratioBuckets: bucketCounts,
    topCapDeposits,
  };
}

// 5-minute revalidate (vs 60s on the cheap baseline). The cohort SQL
// pairs every window deposit to its bonus via an unindexed equality
// (balance_before == balance_after). Even after the hash-join rewrite
// (materialised bonus set instead of a per-row LATERAL seq scan) it is
// still the heaviest query on the tab — ~1.3s on prod vs the cheap
// baseline's sub-200ms. 30d cohort numbers don't move minute-to-minute;
// a 5-min cache trades a small staleness for a much better hit rate.
const cachedDepositBonusCohortExtras = unstable_cache(
  async (period: RewardsPeriod, capValue: number, blacklistIds: string[]) =>
    computeDepositBonusCohortExtras(period, capValue, blacklistIds),
  ["rewards-deposit-bonus-cohort-extras-v2"],
  { revalidate: 300, tags: ["rewards-analytics"] },
);

export async function getDepositBonusCohortExtras(
  period: RewardsPeriod,
  capValue: number,
): Promise<DepositBonusCohortExtras> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cachedDepositBonusCohortExtras(period, capValue, sorted);
}
