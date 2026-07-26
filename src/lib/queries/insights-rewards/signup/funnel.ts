import { blacklistNotInSql, daysAgoFilter, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { WAGER_TYPES_SQL } from "@/lib/queries/_wager-payout-types";
import { SIGNUP_CACHE_TAG } from "./_shared";

/**
 * 5-stage signup → repeat-wager conversion funnel for
 * /insights/rewards/signup.
 *
 * Cohort: in-window signups. Each stage is a STRICT SUBSET of the
 * previous, so the bars narrow as drop-off compounds:
 *
 *   1. signup       — all signups in the window
 *   2. claim        — made at least one `balance_reward_claim`
 *   3. firstDeposit — made at least one `deposit`
 *   4. firstWager   — made at least one wager (ANY pack_opening /
 *                     battle_bet / battle_sponsorship ledger row)
 *   5. repeatDeposit — made 2+ `deposit` rows
 *
 * The 5-stage shape extends the 4-stage funnel inside
 * `getSignupExtras` so admins on /insights/rewards/signup see the
 * wager step the per-category page doesn't surface. Drop-off % between
 * stages is computed in the UI (one source of truth — raw counts).
 *
 * Wager ledger types are pulled from the existing wager-bucket
 * definition in `_wager-payout-types.ts` so the "wager" count
 * reconciles with the rest of the analytics stack.
 */

export type SignupFunnel = {
  signups: number;
  claimed: number;
  firstDeposit: number;
  firstWager: number;
  repeatDeposit: number;
};

async function computeFunnel(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<SignupFunnel> {
  const db = await getDrizzleDb();
  const days = daysForInsightsPeriod(period);
  const signupDateFilter = daysAgoFilter("u.created_at", days);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // Single CTE-driven sweep: every stage joins the same cohort with a
  // type-narrow filter on `ledger_transactions`. DISTINCT user_id per
  // stage keeps each stage cardinality at "users who did ≥1 of X".
  //
  // Wager-stage type list comes from the shared `WAGER_TYPES_SQL`
  // constant so the funnel's wager count reconciles with the rest of
  // the analytics stack (dashboard GGR, per-pack lens, etc.).
  type Row = {
    signups: string;
    claimed: string;
    first_deposit: string;
    first_wager: string;
    repeat_deposit: string;
  };
  const rows = await queryRows<Row[]>(db, sql`
    WITH cohort AS (
      SELECT u.id AS user_id
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
    ),
    deposit_users AS (
      SELECT
        c.user_id,
        COUNT(*) AS dep_count
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'deposit'
      GROUP BY c.user_id
    ),
    wager_users AS (
      SELECT DISTINCT c.user_id
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)}
    )
    SELECT
      (SELECT COUNT(*) FROM cohort)::text AS signups,
      (SELECT COUNT(*) FROM claim_users)::text AS claimed,
      (SELECT COUNT(*) FROM deposit_users)::text AS first_deposit,
      (SELECT COUNT(*) FROM wager_users)::text AS first_wager,
      (SELECT COUNT(*) FROM deposit_users WHERE dep_count >= 2)::text AS repeat_deposit
  `);
  const row = rows[0];
  return {
    signups: Number(row?.signups ?? 0),
    claimed: Number(row?.claimed ?? 0),
    firstDeposit: Number(row?.first_deposit ?? 0),
    firstWager: Number(row?.first_wager ?? 0),
    repeatDeposit: Number(row?.repeat_deposit ?? 0),
  };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeFunnel(period, blacklistIds),
  ["insights-rewards-signup-funnel-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeFunnel(period, blacklistIds),
  ["insights-rewards-signup-funnel-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupFunnel(
  period: InsightsRewardsPeriod,
): Promise<SignupFunnel> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const data = await (cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted));
  return data;
}
