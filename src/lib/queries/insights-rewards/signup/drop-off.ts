import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { WAGER_TYPES_SQL } from "@/lib/queries/_wager-payout-types";
import { SIGNUP_CACHE_TAG } from "./_shared";

/**
 * Drop-off cause breakdown for /insights/rewards/signup.
 *
 * For the non-claimer cohort (cohort users who never made a
 * `balance_reward_claim` row), split them into 5 buckets that explain
 * the drop-off:
 *
 *   - dormant          — never made ANY post-signup ledger row
 *   - depositedNoClaim — deposited but never claimed
 *   - wageredNoClaim   — wagered but never deposited or claimed
 *                        (impossible on prod today, but the bucket
 *                        is included for legacy / pre-deposit users)
 *   - bannedOrLocked   — `is_banned` or `is_locked` flag set
 *   - other            — non-dormant, non-deposit, non-wager, not banned
 *
 * For comparison the claimers count is also returned so the page can
 * render the full pie (claimers + 5 drop-off buckets = 100% of cohort).
 *
 * Buckets are mutually exclusive — the order above is the priority
 * (banned/locked checked first since a banned dormant user is "banned",
 * not "dormant", from a product-decision perspective).
 */

export type DropOffBreakdown = {
  cohortSize: number;
  claimers: number;
  dormant: number;
  depositedNoClaim: number;
  wageredNoClaim: number;
  bannedOrLocked: number;
  other: number;
};

async function computeDropOff(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DropOffBreakdown> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const signupDateFilter =
    days !== null
      ? `AND u.created_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  type Row = {
    cohort_size: string;
    claimers: string;
    dormant: string;
    deposited_no_claim: string;
    wagered_no_claim: string;
    banned_or_locked: string;
    other: string;
  };
  const rows = await db.$queryRawUnsafe<Row[]>(`
    WITH cohort AS (
      SELECT
        u.id AS user_id,
        u.is_banned,
        u.is_locked
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${signupDateFilter}
    ),
    has_claim AS (
      SELECT DISTINCT c.user_id
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type = 'balance_reward_claim'
    ),
    has_deposit AS (
      SELECT DISTINCT c.user_id
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type = 'deposit'
    ),
    has_wager AS (
      SELECT DISTINCT c.user_id
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type IN ${WAGER_TYPES_SQL}
    ),
    has_any_ledger AS (
      SELECT DISTINCT c.user_id
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
    ),
    flagged AS (
      SELECT
        c.user_id,
        CASE WHEN ch.user_id IS NULL THEN 0 ELSE 1 END AS has_claim,
        CASE WHEN hd.user_id IS NULL THEN 0 ELSE 1 END AS has_deposit,
        CASE WHEN hw.user_id IS NULL THEN 0 ELSE 1 END AS has_wager,
        CASE WHEN hal.user_id IS NULL THEN 0 ELSE 1 END AS has_any_ledger,
        CASE WHEN c.is_banned OR c.is_locked THEN 1 ELSE 0 END AS banned_or_locked
      FROM cohort c
      LEFT JOIN has_claim ch ON ch.user_id = c.user_id
      LEFT JOIN has_deposit hd ON hd.user_id = c.user_id
      LEFT JOIN has_wager hw ON hw.user_id = c.user_id
      LEFT JOIN has_any_ledger hal ON hal.user_id = c.user_id
    )
    SELECT
      COUNT(*)::text AS cohort_size,
      SUM(has_claim)::text AS claimers,
      SUM(CASE WHEN has_claim = 0 AND banned_or_locked = 1 THEN 1 ELSE 0 END)::text AS banned_or_locked,
      SUM(CASE WHEN has_claim = 0 AND banned_or_locked = 0 AND has_any_ledger = 0 THEN 1 ELSE 0 END)::text AS dormant,
      SUM(CASE WHEN has_claim = 0 AND banned_or_locked = 0 AND has_deposit = 1 THEN 1 ELSE 0 END)::text AS deposited_no_claim,
      SUM(CASE WHEN has_claim = 0 AND banned_or_locked = 0 AND has_deposit = 0 AND has_wager = 1 THEN 1 ELSE 0 END)::text AS wagered_no_claim,
      SUM(CASE WHEN has_claim = 0 AND banned_or_locked = 0 AND has_any_ledger = 1 AND has_deposit = 0 AND has_wager = 0 THEN 1 ELSE 0 END)::text AS other
    FROM flagged
  `);

  const row = rows[0];
  return {
    cohortSize: Number(row?.cohort_size ?? 0),
    claimers: Number(row?.claimers ?? 0),
    dormant: Number(row?.dormant ?? 0),
    depositedNoClaim: Number(row?.deposited_no_claim ?? 0),
    wageredNoClaim: Number(row?.wagered_no_claim ?? 0),
    bannedOrLocked: Number(row?.banned_or_locked ?? 0),
    other: Number(row?.other ?? 0),
  };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeDropOff(period, blacklistIds),
  ["insights-rewards-signup-drop-off-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeDropOff(period, blacklistIds),
  ["insights-rewards-signup-drop-off-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupDropOff(
  period: InsightsRewardsPeriod,
): Promise<DropOffBreakdown> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
