import { sql } from "drizzle-orm";
import { getReadDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

/** Per-frequency rakeback slice (daily / weekly / monthly). */
export type RakebackFrequencyStat = {
  /** USD claimed (credited) for this cadence. */
  claimedUsd: number;
  /** USD still claimable (accrued, not yet claimed) for this cadence. */
  claimableUsd: number;
  /** Number of CLAIMED rows for this cadence. */
  claimedCount: number;
};

export type UserRewards = {
  openOneTimeCount: number;
  rakebackClaimableUsd: number;
  rakebackClaimedUsd: number;
  /** Total number of claimed rakeback rows (all cadences). */
  rakebackClaimedCount: number;
  /**
   * Claimed rakeback split by cadence. `rakeback_type` is a THREE-member enum
   * on the game DB — `daily | weekly | monthly` (verified read-only against
   * live prod 2026-07-11). There is NO "instant" cadence; the three slices sum
   * EXACTLY to `rakebackClaimedUsd` / `rakebackClaimableUsd`.
   */
  byFrequency: {
    daily: RakebackFrequencyStat;
    weekly: RakebackFrequencyStat;
    monthly: RakebackFrequencyStat;
  };
  /**
   * CROSS-CUTTING subset (NOT a fourth cadence): rakeback CLAIMED via the
   * instant / early-claim flow (`rakeback_claims.last_preclaim_at IS NOT
   * NULL`). An instant claim is still one of the three cadences above — this
   * is the "of which instant-claimed" overlap, so it must NOT be added to the
   * cadence total. `null` when the `last_preclaim_at` column is absent on the
   * connected DB env (schema drift on a dev-toggled admin) — the UI then hides
   * the instant line instead of showing a fabricated zero.
   */
  instantClaimedUsd: number | null;
  instantClaimedCount: number | null;
};

type RakebackType = "daily" | "weekly" | "monthly";
const EMPTY_FREQ: RakebackFrequencyStat = {
  claimedUsd: 0,
  claimableUsd: 0,
  claimedCount: 0,
};

/** All-zero rewards payload — the canonical fallback for the `safeQuery`
 *  timeout wrapper and dev render fixtures (keep in one place so callers don't
 *  hand-build the shape and drift when fields are added). */
export const EMPTY_USER_REWARDS: UserRewards = {
  openOneTimeCount: 0,
  rakebackClaimableUsd: 0,
  rakebackClaimedUsd: 0,
  rakebackClaimedCount: 0,
  byFrequency: {
    daily: { ...EMPTY_FREQ },
    weekly: { ...EMPTY_FREQ },
    monthly: { ...EMPTY_FREQ },
  },
  instantClaimedUsd: null,
  instantClaimedCount: null,
};

export async function getUserRewards(userId: string): Promise<UserRewards> {
  const db = await getReadDrizzleDb();
  // Each number is pushed down to SQL so the payload stays O(1) regardless of
  // the user's reward history size. All three reads are per-user and hit the
  // user_id-leading index (rakeback: the
  // `rakeback_claims_user_id_rakeback_type_period_start_unique` index — Bitmap
  // Index Scan verified read-only via EXPLAIN against live prod 2026-07-11;
  // user_rewards: the user_id FK). No seq scan on MAIN.
  const [openOneTimeResult, byTypeResult, instantRow] = await Promise.all([
    db.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM user_rewards ur
      JOIN rewards r ON r.id = ur.reward_id
      WHERE ur.user_id = ${userId}
        AND ur.opened_at IS NULL
        AND r.type::text = 'one_time'
    `),
    // Grouped by cadence — uses ONLY always-present columns so it can never
    // drift-fault. Sums reconcile to the totals below.
    db.execute<{
      rakeback_type: RakebackType;
      claimable: string;
      claimed: string;
      claimed_count: number;
    }>(sql`
      SELECT
        rakeback_type::text AS rakeback_type,
        COALESCE(SUM(CASE WHEN claimed_at IS NULL     THEN rakeback_amount_usd::numeric ELSE 0 END), 0)::text AS claimable,
        COALESCE(SUM(CASE WHEN claimed_at IS NOT NULL THEN rakeback_amount_usd::numeric ELSE 0 END), 0)::text AS claimed,
        COUNT(*) FILTER (WHERE claimed_at IS NOT NULL)::int                                                  AS claimed_count
      FROM rakeback_claims
      WHERE user_id = ${userId}
      GROUP BY rakeback_type
    `),
    // Instant / early-claim SUBSET — references the drift-prone
    // `last_preclaim_at` column, so it is isolated with its own `.catch` →
    // null. A dev-toggled admin on a DB without the column degrades to null
    // (UI hides the line) instead of zeroing the whole rewards card.
    db.execute<{ amt: string; n: number }>(sql`
        SELECT
          COALESCE(SUM(rakeback_amount_usd::numeric), 0)::text AS amt,
          COUNT(*)::int                                        AS n
        FROM rakeback_claims
        WHERE user_id = ${userId}
          AND claimed_at IS NOT NULL
          AND last_preclaim_at IS NOT NULL
      `)
      .then((result) => result.rows[0] ?? null)
      .catch(() => null),
  ]);
  const openOneTimeCount = Number(openOneTimeResult.rows[0]?.total ?? 0);

  const byFrequency = {
    daily: { ...EMPTY_FREQ },
    weekly: { ...EMPTY_FREQ },
    monthly: { ...EMPTY_FREQ },
  };
  let rakebackClaimableUsd = 0;
  let rakebackClaimedUsd = 0;
  let rakebackClaimedCount = 0;

  for (const row of byTypeResult.rows) {
    const slice = byFrequency[row.rakeback_type];
    if (!slice) continue; // guard an unexpected/future enum member
    slice.claimableUsd = toNumber(row.claimable ?? 0);
    slice.claimedUsd = toNumber(row.claimed ?? 0);
    slice.claimedCount = Number(row.claimed_count ?? 0);
    rakebackClaimableUsd += slice.claimableUsd;
    rakebackClaimedUsd += slice.claimedUsd;
    rakebackClaimedCount += slice.claimedCount;
  }

  return {
    openOneTimeCount,
    rakebackClaimableUsd,
    rakebackClaimedUsd,
    rakebackClaimedCount,
    byFrequency,
    instantClaimedUsd: instantRow ? toNumber(instantRow.amt ?? 0) : null,
    instantClaimedCount: instantRow ? Number(instantRow.n ?? 0) : null,
  };
}
