import { blacklistNotInSql, daysAgoFilter, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { WAGER_TYPES_SQL } from "@/lib/queries/_wager-payout-types";
import { SIGNUP_CACHE_TAG } from "./_shared";

/**
 * Retention lift — claimers vs non-claimers — for
 * /insights/rewards/signup.
 *
 * Cohort: in-window signups. Split into two cuts:
 *   - claimers     — cohort users with ≥1 `balance_reward_claim`
 *   - nonClaimers  — cohort users without any claim
 *
 * For each cut compute the share of the cohort still active at three
 * retention windows after signup:
 *
 *   24h — at least one wager OR deposit within 24h of signup
 *   7d  — at least one wager OR deposit within 7d  of signup
 *   30d — at least one wager OR deposit within 30d of signup
 *
 * "Active" = any wager ledger row (pack_opening / battle_bet /
 * battle_sponsorship / upgrader_bet / withdrawal_shipping_fee) OR a
 * `deposit` row. Using both signals avoids the false-negative where a
 * user deposited but didn't play in the window.
 *
 * Lift % = (claimer share − non-claimer share) / non-claimer share —
 * answers "does taking the signup bonus push retention up vs baseline".
 *
 * NOTE on windowing: cohort users near the END of the window may not
 * have HAD time to be retained 30d — admins should read these numbers
 * with the windowing caveat in mind. The "lifetime" period is the
 * cleanest read since every cohort user has been around long enough
 * for the 30d test.
 */

export type RetentionCurveValue = {
  claimerCount: number;
  claimerRetained: number;
  claimerShare: number;
  nonClaimerCount: number;
  nonClaimerRetained: number;
  nonClaimerShare: number;
  /** (claimerShare − nonClaimerShare) / nonClaimerShare, null when nonClaimer = 0. */
  liftPct: number | null;
};

export type Retention = {
  retention24h: RetentionCurveValue;
  retention7d: RetentionCurveValue;
  retention30d: RetentionCurveValue;
};

async function computeRetention(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<Retention> {
  const db = await getReadDrizzleDb();
  const days = daysForInsightsPeriod(period);
  const signupDateFilter = daysAgoFilter("u.created_at", days);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // Build one CTE per retention window. Each row has per-user
  // signup_at + had_claim + retained_24h / 7d / 30d booleans so we can
  // roll up in a single sweep. The retained-X-hours fields are
  // computed via EXISTS-subqueries because that lets PG short-circuit
  // once the first qualifying ledger row is found per user (cheaper
  // than aggregating MIN(activity_at)).
  type Row = {
    had_claim: number;
    retained_24h: number;
    retained_7d: number;
    retained_30d: number;
  };
  const rows = await queryRows<Row[]>(db, sql`
    WITH cohort AS (
      SELECT u.id AS user_id, u.created_at AS signed_up_at
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${signupDateFilter}
    ),
    claim_users AS (
      SELECT DISTINCT c.user_id
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'balance_reward_claim'
    )
    SELECT
      CASE WHEN cu.user_id IS NULL THEN 0 ELSE 1 END AS had_claim,
      CASE WHEN EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt.user_id = c.user_id
          AND lt.status = 'completed'
          AND (lt.type::text = 'deposit' OR lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)})
          AND lt.created_at <= c.signed_up_at + INTERVAL '1 day'
      ) THEN 1 ELSE 0 END AS retained_24h,
      CASE WHEN EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt.user_id = c.user_id
          AND lt.status = 'completed'
          AND (lt.type::text = 'deposit' OR lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)})
          AND lt.created_at <= c.signed_up_at + INTERVAL '7 days'
      ) THEN 1 ELSE 0 END AS retained_7d,
      CASE WHEN EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt.user_id = c.user_id
          AND lt.status = 'completed'
          AND (lt.type::text = 'deposit' OR lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)})
          AND lt.created_at <= c.signed_up_at + INTERVAL '30 days'
      ) THEN 1 ELSE 0 END AS retained_30d
    FROM cohort c
    LEFT JOIN claim_users cu ON cu.user_id = c.user_id
  `);

  let claimerTotal = 0;
  let nonClaimerTotal = 0;
  let claimer24h = 0;
  let claimer7d = 0;
  let claimer30d = 0;
  let nonClaimer24h = 0;
  let nonClaimer7d = 0;
  let nonClaimer30d = 0;
  for (const r of rows) {
    const hadClaim = Number(r.had_claim) === 1;
    if (hadClaim) {
      claimerTotal += 1;
      if (Number(r.retained_24h) === 1) claimer24h += 1;
      if (Number(r.retained_7d) === 1) claimer7d += 1;
      if (Number(r.retained_30d) === 1) claimer30d += 1;
    } else {
      nonClaimerTotal += 1;
      if (Number(r.retained_24h) === 1) nonClaimer24h += 1;
      if (Number(r.retained_7d) === 1) nonClaimer7d += 1;
      if (Number(r.retained_30d) === 1) nonClaimer30d += 1;
    }
  }

  const build = (
    claimerRetained: number,
    nonClaimerRetained: number,
  ): RetentionCurveValue => {
    const claimerShare =
      claimerTotal > 0 ? claimerRetained / claimerTotal : 0;
    const nonClaimerShare =
      nonClaimerTotal > 0 ? nonClaimerRetained / nonClaimerTotal : 0;
    const liftPct =
      nonClaimerShare > 0
        ? ((claimerShare - nonClaimerShare) / nonClaimerShare) * 100
        : null;
    return {
      claimerCount: claimerTotal,
      claimerRetained,
      claimerShare,
      nonClaimerCount: nonClaimerTotal,
      nonClaimerRetained,
      nonClaimerShare,
      liftPct,
    };
  };

  return {
    retention24h: build(claimer24h, nonClaimer24h),
    retention7d: build(claimer7d, nonClaimer7d),
    retention30d: build(claimer30d, nonClaimer30d),
  };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeRetention(period, blacklistIds),
  ["insights-rewards-signup-retention-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeRetention(period, blacklistIds),
  ["insights-rewards-signup-retention-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupRetention(
  period: InsightsRewardsPeriod,
): Promise<Retention> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const data = await (cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted));
  return data;
}
