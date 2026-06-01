import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import { parseRewardsPeriod, type RewardsPeriod } from "./rewards-analytics";
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
      AND lt.type = 'deposit_bonus'
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

// Re-export the period parser used by the analytics page so callers
// outside the page don't need a second import path.
export { parseRewardsPeriod };

// ── Cohort + distribution extras ──────────────────────────────────────

/**
 * Cohort split — completed deposits in the period, with vs without an
 * accompanying `deposit_bonus` ledger row. Links each bonus to its
 * triggering deposit using the SAME rule the live money-movement feed
 * uses (`bonus.balance_before == deposit.balance_after`, bonus fires
 * within 2 minutes of the deposit). That rule is canonical in
 * `dashboard-live.ts` — reusing it here keeps the with/without split
 * reconciled with every other deposit↔bonus pairing on the admin panel.
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
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null
      ? `AND d.created_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const windowStartExpr =
    days !== null
      ? `NOW() - INTERVAL '${days} days'`
      : `'-infinity'::timestamp`;
  const blacklistSubquery = blacklistNotInClause("id", blacklistIds);

  // Canonical bonus↔deposit linking rule (from dashboard-live.ts):
  // bonus.balance_before == deposit.balance_after AND bonus fires
  // within 2 minutes of the deposit. We materialise the per-deposit
  // bonus amount via a LATERAL join — one bonus row per deposit
  // (`LIMIT 1`) so a freak duplicate bonus can't double-count.
  //
  // First-time vs repeat split is based on whether the user had ANY
  // `deposit_bonus` row BEFORE the window starts. That keeps the
  // definition simple ("did the window introduce this claimant?") and
  // matches how acquisition analytics elsewhere in the codebase treats
  // first-time events (analytics-funnel.ts, analytics-ltv.ts).
  const rollupRows = await db.$queryRawUnsafe<CohortRollupRow[]>(`
    WITH window_deposits AS (
      SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type = 'deposit'
        AND d.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
        ${dateFilter}
    ),
    paired AS (
      SELECT
        wd.id,
        wd.user_id,
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
          AND lt.created_at < wd.created_at + INTERVAL '2 minutes'
        ORDER BY lt.created_at ASC
        LIMIT 1
      ) b ON TRUE
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
            AND prior.type = 'deposit_bonus'
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
  const bucketRows = await db.$queryRawUnsafe<
    { bucket: number; cnt: string; volume: string }[]
  >(`
    WITH window_deposits AS (
      SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
      FROM ledger_transactions d
      WHERE d.status = 'completed'
        AND d.type = 'deposit'
        AND d.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
        ${dateFilter}
    ),
    paired AS (
      SELECT
        ABS(wd.deposit_amt) AS deposit_usd,
        b.bonus_usd
      FROM window_deposits wd
      JOIN LATERAL (
        SELECT ABS(lt.amount::numeric) AS bonus_usd
        FROM ledger_transactions lt
        WHERE lt.user_id = wd.user_id
          AND lt.type = 'deposit_bonus'
          AND lt.status = 'completed'
          AND lt.balance_before::numeric = wd.bal_after
          AND lt.created_at >= wd.created_at
          AND lt.created_at < wd.created_at + INTERVAL '2 minutes'
        ORDER BY lt.created_at ASC
        LIMIT 1
      ) b ON TRUE
      WHERE wd.deposit_amt <> 0
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
      WITH window_deposits AS (
        SELECT d.id, d.user_id, d.amount::numeric AS deposit_amt, d.balance_after::numeric AS bal_after, d.created_at
        FROM ledger_transactions d
        WHERE d.status = 'completed'
          AND d.type = 'deposit'
          AND d.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
          ${dateFilter}
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
          AND lt.type = 'deposit_bonus'
          AND lt.status = 'completed'
          AND lt.balance_before::numeric = wd.bal_after
          AND lt.created_at >= wd.created_at
          AND lt.created_at < wd.created_at + INTERVAL '2 minutes'
          AND ABS(lt.amount::numeric) = ${capValue.toFixed(2)}
        ORDER BY lt.created_at ASC
        LIMIT 1
      ) b ON TRUE
      ORDER BY ABS(wd.deposit_amt) DESC
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

const cachedDepositBonusCohortExtras = unstable_cache(
  async (period: RewardsPeriod, capValue: number, blacklistIds: string[]) =>
    computeDepositBonusCohortExtras(period, capValue, blacklistIds),
  ["rewards-deposit-bonus-cohort-extras-v1"],
  { revalidate: 60, tags: ["rewards-analytics"] },
);

export async function getDepositBonusCohortExtras(
  period: RewardsPeriod,
  capValue: number,
): Promise<DepositBonusCohortExtras> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cachedDepositBonusCohortExtras(period, capValue, sorted);
}
