import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { SIGNUP_CACHE_TAG } from "./_shared";

/**
 * Daily signup + claim series for the Overview tab on
 * /insights/rewards/signup.
 *
 * Returns one row per day across the window with:
 *
 *   - date    — YYYY-MM-DD
 *   - signups — distinct signups that day
 *   - claims  — `balance_reward_claim` rows that day from cohort
 *               users (the in-window signup cohort)
 *   - cost    — sum of ABS(amount) for those claim rows
 *
 * "Cohort" here means signed up inside the period window — same
 * definition every other helper in this folder uses, so the Overview
 * chart reconciles with the headline KPIs by construction.
 *
 * For "all" (lifetime) the series caps at the last 365 days so the
 * Overview chart stays readable on lifetime view.
 */

export type SignupDailyPoint = {
  date: string;
  signups: number;
  claims: number;
  cost: number;
};

async function computeDaily(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<SignupDailyPoint[]> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const effectiveDays = days !== null ? days : 365;
  const dateFilter = `AND u.created_at >= NOW() - INTERVAL '${effectiveDays} days'`;
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Two parallel daily series: signups by day + cohort claim rows by
  // day. Joined in JS so the SQL stays simple and PG doesn't have to
  // emit empty rows for days with zero claims.
  type SignupRow = { day: Date; cnt: string };
  type ClaimRow = { day: Date; cnt: string; volume: string };
  const [signupRows, claimRows] = await Promise.all([
    db.$queryRawUnsafe<SignupRow[]>(`
      SELECT DATE(u.created_at) AS day, COUNT(*)::text AS cnt
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY DATE(u.created_at)
      ORDER BY day ASC
    `),
    db.$queryRawUnsafe<ClaimRow[]>(`
      WITH cohort AS (
        SELECT u.id AS user_id
        FROM "user" u
        WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
          ${dateFilter}
      )
      SELECT
        DATE(lt.created_at) AS day,
        COUNT(*)::text AS cnt,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS volume
      FROM ledger_transactions lt
      JOIN cohort c ON c.user_id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type = 'balance_reward_claim'
      GROUP BY DATE(lt.created_at)
      ORDER BY day ASC
    `),
  ]);

  const byDate = new Map<string, SignupDailyPoint>();
  for (const r of signupRows) {
    const date = new Date(r.day).toISOString().split("T")[0];
    byDate.set(date, {
      date,
      signups: Number(r.cnt),
      claims: 0,
      cost: 0,
    });
  }
  for (const r of claimRows) {
    const date = new Date(r.day).toISOString().split("T")[0];
    const existing =
      byDate.get(date) ??
      { date, signups: 0, claims: 0, cost: 0 };
    existing.claims += Number(r.cnt);
    existing.cost += toNumber(r.volume);
    byDate.set(date, existing);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeDaily(period, blacklistIds),
  ["insights-rewards-signup-daily-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeDaily(period, blacklistIds),
  ["insights-rewards-signup-daily-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupDaily(
  period: InsightsRewardsPeriod,
): Promise<SignupDailyPoint[]> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
