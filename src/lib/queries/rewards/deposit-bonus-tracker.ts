import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  getResolvedBlacklist,
  staffAndBlacklistSubquery,
} from "@/lib/queries/insights-rewards/deposit-bonus/_shared";

/**
 * Deposit-bonus tracker for /rewards/deposit-bonus.
 *
 * The affiliate deposit bonus was rebuilt (2026-06): it is now a fixed 5% of
 * each deposit, capped at `deposit_bonus_cap_per_period_usd` within a rolling
 * `deposit_bonus_period_hours` window (replacing the old ~$100/24h ceiling).
 * This surface tracks live spend AND quantifies the savings vs the old regime.
 *
 * Savings method (owner-chosen): EMPIRICAL effective-rate, not a guessed
 * counterfactual formula. We measure bonus paid per $ deposited BEFORE the
 * cutover (the old regime's effective rate) and AFTER it (the new regime),
 * and project the difference onto deposit volume. No old formula is invented.
 *
 * Cutover anchor: the `created_at` of the `deposit_bonus_cap_per_period_usd`
 * site_config row — the verifiable moment the new cap went live. Read live so
 * it stays correct without a hardcoded date (falls back to the known go-live
 * timestamp if the row is ever absent).
 *
 * Source of truth: `ledger_transactions`
 *   - bonus   = rows status='completed', type='deposit_bonus'
 *   - deposit = rows status='completed', type='deposit'
 * Real users only (staff + blacklist excluded), House POV: bonus = rose cost,
 * savings = emerald (money the house keeps). Every scan is bounded (≤ 90d) and
 * served by the created_at index (Index-or-ClickHouse: indexed Postgres path).
 */

/** The bonus is a fixed 5% of each deposit (enforced by the backend). */
export const DEPOSIT_BONUS_RATE_PCT = 5;

/** Trailing window (days) used to measure the OLD regime's effective rate. */
export const OLD_BASELINE_LOOKBACK_DAYS = 30;

/** Fallback go-live timestamp if the site_config row is ever missing. */
const CUTOVER_FALLBACK = "2026-06-17 19:36:40";

export type DepositBonusTracker = {
  /** Cutover timestamp (ISO, UTC) the new capped system went live. */
  cutover: string;
  /** Spend since cutover (the new regime so far). */
  since: {
    bonus: number;
    count: number;
    claimants: number;
    avg: number;
    max: number;
    deposits: number;
    depositors: number;
    /** bonus / deposits, or null when no deposits yet. */
    effRate: number | null;
  };
  /** The old regime, measured over the trailing window before cutover. */
  old: {
    lookbackDays: number;
    bonus: number;
    deposits: number;
    effRate: number | null;
  };
  /** All bonus activity in the bounded (90d) history. */
  lifetime: { bonus: number; count: number };
  /** Deposit volume over the trailing 30 days — the projection run-rate base. */
  last30dDeposits: number;
  /** How much of the savings comes from the cap clamping the 5% bonus. */
  cap: {
    capUsd: number | null;
    /** 5% of all post-cutover deposits — the uncapped theoretical bonus. */
    uncapped5pct: number;
    /** uncapped5pct − actual bonus paid since cutover (≥ 0). */
    clamped: number;
    /** Deposits since cutover whose 5% alone exceeds the cap. */
    overCapCount: number;
    depositCount: number;
    overCapPct: number | null;
  };
  savings: {
    /** Old-rate × post-cutover deposits − actual bonus paid since cutover. */
    realizedSinceCutover: number | null;
    /** (oldRate − newRate) × trailing-30d deposits — a forward estimate. */
    projectedPer30d: number | null;
    oldEffRate: number | null;
    newEffRate: number | null;
  };
  /** Daily series (last 90d, ASC) for the regime-change chart. */
  daily: Array<{
    date: string;
    bonus: number;
    deposits: number;
    effRate: number | null;
  }>;
};

type ScalarRow = {
  cutover: string;
  cap: string | null;
  new_deposit_count: string | null;
  new_dep_over_cap_count: string | null;
  new_bonus: string | null;
  new_count: string | null;
  new_claimants: string | null;
  new_max: string | null;
  new_deposits: string | null;
  new_depositors: string | null;
  old_bonus: string | null;
  old_deposits: string | null;
  lifetime_bonus: string | null;
  lifetime_count: string | null;
  last30d_deposits: string | null;
};

async function computeTracker(
  blacklistIds: string[],
): Promise<DepositBonusTracker> {
  const db = await getDb();
  const userScope = staffAndBlacklistSubquery(blacklistIds);

  // ── Scalars: bonus + deposit rollups split by regime via the `cut` CTE.
  // Both legs are bounded to the last 90d (covers the old baseline window,
  // the entire post-cutover window, the trailing-30d run-rate, and all bonus
  // history — deposit_bonus only began ~74d ago). The cutover comes from the
  // site_config row so T lives in the same naive-UTC frame as created_at.
  const [scalarRows, dailyRows] = await Promise.all([
    db.$queryRawUnsafe<ScalarRow[]>(`
      WITH cut AS (
        SELECT COALESCE(MIN(created_at), TIMESTAMP '${CUTOVER_FALLBACK}') AS t
        FROM site_config
        WHERE key = 'deposit_bonus_cap_per_period_usd'
      ),
      bonus AS (
        SELECT lt.amount, lt.user_id, lt.created_at
        FROM ledger_transactions lt
        WHERE lt.status = 'completed'
          AND lt.type = 'deposit_bonus'
          AND lt.user_id IN ${userScope}
          AND lt.created_at >= NOW() - INTERVAL '90 days'
      ),
      dep AS (
        SELECT lt.amount, lt.user_id, lt.created_at
        FROM ledger_transactions lt
        WHERE lt.status = 'completed'
          AND lt.type = 'deposit'
          AND lt.user_id IN ${userScope}
          AND lt.created_at >= NOW() - INTERVAL '90 days'
      ),
      cap AS (
        SELECT COALESCE(
          (SELECT value FROM site_config
            WHERE key = 'deposit_bonus_cap_per_period_usd')::numeric, 20) AS c
      )
      SELECT
        to_char((SELECT t FROM cut), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cutover,
        (SELECT c::text FROM cap) AS cap,
        (SELECT COUNT(*)::text FROM dep d, cut WHERE d.created_at >= cut.t) AS new_deposit_count,
        (SELECT COUNT(*)::text FROM dep d, cut, cap
          WHERE d.created_at >= cut.t
            AND ABS(d.amount::numeric) * 0.05 > cap.c) AS new_dep_over_cap_count,
        (SELECT COALESCE(SUM(ABS(b.amount::numeric)), 0)::text FROM bonus b, cut
          WHERE b.created_at >= cut.t) AS new_bonus,
        (SELECT COUNT(*)::text FROM bonus b, cut WHERE b.created_at >= cut.t) AS new_count,
        (SELECT COUNT(DISTINCT b.user_id)::text FROM bonus b, cut
          WHERE b.created_at >= cut.t) AS new_claimants,
        (SELECT COALESCE(MAX(ABS(b.amount::numeric)), 0)::text FROM bonus b, cut
          WHERE b.created_at >= cut.t) AS new_max,
        (SELECT COALESCE(SUM(ABS(d.amount::numeric)), 0)::text FROM dep d, cut
          WHERE d.created_at >= cut.t) AS new_deposits,
        (SELECT COUNT(DISTINCT d.user_id)::text FROM dep d, cut
          WHERE d.created_at >= cut.t) AS new_depositors,
        (SELECT COALESCE(SUM(ABS(b.amount::numeric)), 0)::text FROM bonus b, cut
          WHERE b.created_at >= cut.t - INTERVAL '${OLD_BASELINE_LOOKBACK_DAYS} days'
            AND b.created_at < cut.t) AS old_bonus,
        (SELECT COALESCE(SUM(ABS(d.amount::numeric)), 0)::text FROM dep d, cut
          WHERE d.created_at >= cut.t - INTERVAL '${OLD_BASELINE_LOOKBACK_DAYS} days'
            AND d.created_at < cut.t) AS old_deposits,
        (SELECT COALESCE(SUM(ABS(b.amount::numeric)), 0)::text FROM bonus b) AS lifetime_bonus,
        (SELECT COUNT(*)::text FROM bonus b) AS lifetime_count,
        (SELECT COALESCE(SUM(ABS(d.amount::numeric)), 0)::text FROM dep d
          WHERE d.created_at >= NOW() - INTERVAL '30 days') AS last30d_deposits
    `),
    db.$queryRawUnsafe<
      { date: Date; bonus: string; deposits: string }[]
    >(`
      WITH days AS (
        SELECT generate_series(
          DATE(NOW() - INTERVAL '89 days'), DATE(NOW()), INTERVAL '1 day'
        )::date AS d
      ),
      b AS (
        SELECT DATE(lt.created_at) AS d, SUM(ABS(lt.amount::numeric)) AS v
        FROM ledger_transactions lt
        WHERE lt.status = 'completed' AND lt.type = 'deposit_bonus'
          AND lt.user_id IN ${userScope}
          AND lt.created_at >= NOW() - INTERVAL '90 days'
        GROUP BY 1
      ),
      dp AS (
        SELECT DATE(lt.created_at) AS d, SUM(ABS(lt.amount::numeric)) AS v
        FROM ledger_transactions lt
        WHERE lt.status = 'completed' AND lt.type = 'deposit'
          AND lt.user_id IN ${userScope}
          AND lt.created_at >= NOW() - INTERVAL '90 days'
        GROUP BY 1
      )
      SELECT days.d AS date,
             COALESCE(b.v, 0)::text AS bonus,
             COALESCE(dp.v, 0)::text AS deposits
      FROM days
      LEFT JOIN b ON b.d = days.d
      LEFT JOIN dp ON dp.d = days.d
      ORDER BY days.d ASC
    `),
  ]);

  const r = scalarRows[0];
  const newBonus = toNumber(r?.new_bonus);
  const newCount = Number(r?.new_count ?? 0);
  const newClaimants = Number(r?.new_claimants ?? 0);
  const newMax = toNumber(r?.new_max);
  const newDeposits = toNumber(r?.new_deposits);
  const newDepositors = Number(r?.new_depositors ?? 0);
  const oldBonus = toNumber(r?.old_bonus);
  const oldDeposits = toNumber(r?.old_deposits);
  const lifetimeBonus = toNumber(r?.lifetime_bonus);
  const lifetimeCount = Number(r?.lifetime_count ?? 0);
  const last30dDeposits = toNumber(r?.last30d_deposits);
  const capUsd = r?.cap != null ? toNumber(r.cap) : null;
  const newDepositCount = Number(r?.new_deposit_count ?? 0);
  const overCapCount = Number(r?.new_dep_over_cap_count ?? 0);
  const uncapped5pct = 0.05 * newDeposits;
  const clamped = Math.max(0, uncapped5pct - newBonus);

  const newEffRate = newDeposits > 0 ? newBonus / newDeposits : null;
  const oldEffRate = oldDeposits > 0 ? oldBonus / oldDeposits : null;

  // Realized savings since cutover: what the OLD effective rate would have
  // cost on the SAME post-cutover deposits, minus what we actually paid.
  const realizedSinceCutover =
    oldEffRate !== null ? oldEffRate * newDeposits - newBonus : null;

  // Forward estimate: apply the rate delta to a typical 30d deposit volume.
  const projectedPer30d =
    oldEffRate !== null && newEffRate !== null
      ? (oldEffRate - newEffRate) * last30dDeposits
      : null;

  const daily = dailyRows.map((d) => {
    const bonus = toNumber(d.bonus);
    const deposits = toNumber(d.deposits);
    return {
      date: new Date(d.date).toISOString().split("T")[0],
      bonus,
      deposits,
      effRate: deposits > 0 ? bonus / deposits : null,
    };
  });

  return {
    cutover: r?.cutover ?? `${CUTOVER_FALLBACK.replace(" ", "T")}Z`,
    since: {
      bonus: newBonus,
      count: newCount,
      claimants: newClaimants,
      avg: newCount > 0 ? newBonus / newCount : 0,
      max: newMax,
      deposits: newDeposits,
      depositors: newDepositors,
      effRate: newEffRate,
    },
    old: {
      lookbackDays: OLD_BASELINE_LOOKBACK_DAYS,
      bonus: oldBonus,
      deposits: oldDeposits,
      effRate: oldEffRate,
    },
    lifetime: { bonus: lifetimeBonus, count: lifetimeCount },
    last30dDeposits,
    cap: {
      capUsd,
      uncapped5pct,
      clamped,
      overCapCount,
      depositCount: newDepositCount,
      overCapPct: newDepositCount > 0 ? overCapCount / newDepositCount : null,
    },
    savings: {
      realizedSinceCutover,
      projectedPer30d,
      oldEffRate,
      newEffRate,
    },
    daily,
  };
}

const cachedTracker = unstable_cache(
  async (blacklistIds: string[]) => computeTracker(blacklistIds),
  ["rewards-deposit-bonus-tracker-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards-deposit-bonus"] },
);

export async function getDepositBonusTracker(): Promise<DepositBonusTracker> {
  const blacklist = await getResolvedBlacklist();
  return cachedTracker(blacklist);
}

export type DepositBonusRecipient = {
  userId: string;
  username: string | null;
  bonus: number;
  count: number;
  max: number;
};

async function computeTopRecipients(
  blacklistIds: string[],
): Promise<DepositBonusRecipient[]> {
  const db = await getDb();
  const userScope = staffAndBlacklistSubquery(blacklistIds);
  type Row = {
    user_id: string;
    username: string | null;
    bonus: string;
    cnt: string;
    max: string;
  };
  // Since-cutover deposit-bonus leaderboard. Grouped on the
  // (user_id, type, status, created_at) index, joined to "user" by PK.
  const rows = await db.$queryRawUnsafe<Row[]>(`
    WITH cut AS (
      SELECT COALESCE(MIN(created_at), TIMESTAMP '${CUTOVER_FALLBACK}') AS t
      FROM site_config WHERE key = 'deposit_bonus_cap_per_period_usd'
    )
    SELECT lt.user_id,
           u.username,
           SUM(ABS(lt.amount::numeric))::text AS bonus,
           COUNT(*)::text AS cnt,
           MAX(ABS(lt.amount::numeric))::text AS max
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    CROSS JOIN cut
    WHERE lt.status = 'completed'
      AND lt.type = 'deposit_bonus'
      AND lt.user_id IN ${userScope}
      AND lt.created_at >= cut.t
    GROUP BY lt.user_id, u.username
    ORDER BY SUM(ABS(lt.amount::numeric)) DESC
    LIMIT 50
  `);
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    bonus: toNumber(r.bonus),
    count: Number(r.cnt),
    max: toNumber(r.max),
  }));
}

const cachedRecipients = unstable_cache(
  async (blacklistIds: string[]) => computeTopRecipients(blacklistIds),
  ["rewards-deposit-bonus-recipients-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards-deposit-bonus"] },
);

export async function getDepositBonusTopRecipients(): Promise<
  DepositBonusRecipient[]
> {
  const blacklist = await getResolvedBlacklist();
  return cachedRecipients(blacklist);
}
