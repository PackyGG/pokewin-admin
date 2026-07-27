import { blacklistNotInSql, daysAgoFilter, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { readDrizzleForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { SIGNUP_CACHE_TAG } from "./_shared";

/**
 * Overview KPIs for /insights/rewards/signup.
 *
 * Returns the top-line numbers admins need to read the page at a
 * glance:
 *   - signups in window
 *   - signup-bonus claims (cohort users who made ≥1 balance_reward_claim)
 *   - claim conversion % (claimants / signups)
 *   - total cost (sum of ABS(amount) for those cohort claim rows)
 *   - avg cost per claim
 *   - avg cost per signup
 *   - distinct first-depositors in the cohort
 *   - first-deposit conversion %
 *   - median time-to-claim from signup, in hours
 *   - prior-window delta for signups + claimants + cost (null on "all")
 *
 * Cohort definition: in-window signups. Claims are "any time" so a user
 * who signs up today and claims tomorrow still counts (the spec — every
 * signup who ever claimed). There is NO dedicated `signup_bonus` ledger
 * type; all signup pack claims flow through `balance_reward_claim`.
 *
 * All amounts are positive magnitudes via ABS(amount). House-POV: signup
 * bonuses are house cost → rose in the UI; this helper returns raw
 * magnitudes and the page chooses the tint.
 */

export type SignupOverview = {
  signups: number;
  claimants: number;
  conversionPct: number;
  totalCost: number;
  avgPerClaim: number;
  avgPerSignup: number;
  firstDepositors: number;
  firstDepositConversionPct: number;
  /** Median time-to-claim from signup in hours. 0 when no claims. */
  medianHoursToClaim: number;
  window: InsightsRewardsPeriod;
  priorWindow: {
    signupDelta: number | null;
    claimantDelta: number | null;
    costDelta: number | null;
  } | null;
};

async function computeOverview(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
  env: DbEnv,
): Promise<SignupOverview> {
  const db = readDrizzleForEnv(env);
  const days = daysForInsightsPeriod(period);
  const signupDateFilter = daysAgoFilter("u.created_at", days);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  // ── Window aggregate ──────────────────────────────────────────────
  // Two-stage CTE: cohort = in-window signups; claim_first = each
  // cohort user's first balance_reward_claim row (if any). Counts
  // claimants + cost + median time-to-claim in one sweep.
  type WindowRow = {
    signups: string;
    claimants: string;
    total_cost: string;
    median_hours: string | null;
  };
  const windowRows = await queryRows<WindowRow[]>(db, sql`
    WITH cohort AS (
      SELECT u.id AS user_id, u.created_at AS signed_up_at
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${signupDateFilter}
    ),
    claim_first AS (
      SELECT
        c.user_id,
        c.signed_up_at,
        MIN(lt.created_at) AS first_claim_at,
        SUM(ABS(lt.amount::numeric)) AS total_cost
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'balance_reward_claim'
      GROUP BY c.user_id, c.signed_up_at
    )
    SELECT
      (SELECT COUNT(*) FROM cohort)::text AS signups,
      COUNT(*)::text AS claimants,
      COALESCE(SUM(total_cost), 0)::text AS total_cost,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (first_claim_at - signed_up_at)) / 3600
      )::text AS median_hours
    FROM claim_first
  `);
  const row = windowRows[0];
  const signups = Number(row?.signups ?? 0);
  const claimants = Number(row?.claimants ?? 0);
  const totalCost = toNumber(row?.total_cost);
  const medianHoursToClaim =
    row?.median_hours != null ? toNumber(row.median_hours) : 0;
  const conversionPct = signups > 0 ? (claimants / signups) * 100 : 0;
  const avgPerClaim = claimants > 0 ? totalCost / claimants : 0;
  const avgPerSignup = signups > 0 ? totalCost / signups : 0;

  // First depositors in the signup cohort — distinct users in the
  // cohort who made ≥1 `deposit` ledger row at any time. Counts users
  // who actually completed a deposit, not just those who initiated one.
  const firstDepRows = await queryRows<{ cnt: string }[]>(db, sql`
    SELECT COUNT(DISTINCT lt.user_id)::text AS cnt
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed'
      AND lt.type::text = 'deposit'
      AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${signupDateFilter}
  `);
  const firstDepositors = Number(firstDepRows[0]?.cnt ?? 0);
  const firstDepositConversionPct =
    signups > 0 ? (firstDepositors / signups) * 100 : 0;

  // ── Prior-window deltas ───────────────────────────────────────────
  // Only meaningful when `period !== 'all'`. Same shape as the current
  // window — signups + claimants + cost — for the same length window
  // shifted back by one window.
  let priorWindow: SignupOverview["priorWindow"] = null;
  if (days !== null) {
    type PriorRow = {
      signups: string;
      claimants: string;
      total_cost: string;
    };
    const priorRows = await queryRows<PriorRow[]>(db, sql`
      WITH cohort AS (
        SELECT u.id AS user_id
        FROM "user" u
        WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
          AND u.created_at >= NOW() - (${days * 2} * INTERVAL '1 day')
          AND u.created_at < NOW() - (${days} * INTERVAL '1 day')
      ),
      claim_first AS (
        SELECT
          c.user_id,
          SUM(ABS(lt.amount::numeric)) AS total_cost
        FROM cohort c
        JOIN ledger_transactions lt
          ON lt.user_id = c.user_id
         AND lt.status = 'completed'
         AND lt.type::text = 'balance_reward_claim'
        GROUP BY c.user_id
      )
      SELECT
        (SELECT COUNT(*) FROM cohort)::text AS signups,
        COUNT(*)::text AS claimants,
        COALESCE(SUM(total_cost), 0)::text AS total_cost
      FROM claim_first
    `);
    const pr = priorRows[0];
    const priorSignups = Number(pr?.signups ?? 0);
    const priorClaimants = Number(pr?.claimants ?? 0);
    const priorCost = toNumber(pr?.total_cost);
    const ratio = (cur: number, prv: number): number | null => {
      if (prv <= 0) return null;
      return (cur - prv) / prv;
    };
    priorWindow = {
      signupDelta: ratio(signups, priorSignups),
      claimantDelta: ratio(claimants, priorClaimants),
      costDelta: ratio(totalCost, priorCost),
    };
  }

  return {
    signups,
    claimants,
    conversionPct,
    totalCost,
    avgPerClaim,
    avgPerSignup,
    firstDepositors,
    firstDepositConversionPct,
    medianHoursToClaim,
    window: period,
    priorWindow,
  };
}

// Two cache layers — short (60s) for finite windows that change as new
// signups + claims land, long (5m) for the lifetime sweep that barely
// moves second-to-second. Mirrors the cross-category-summary.ts pattern.
const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeOverview(period, blacklistIds, "prod"),
  ["insights-rewards-signup-overview-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeOverview(period, blacklistIds, "prod"),
  ["insights-rewards-signup-overview-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupOverview(
  period: InsightsRewardsPeriod,
): Promise<SignupOverview> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const env = await readDbEnv();
  if (env !== "prod") return computeOverview(period, sorted, env);
  const data = await (cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted));
  return data;
}
