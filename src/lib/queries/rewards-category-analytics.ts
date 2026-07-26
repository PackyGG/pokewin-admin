import { queryMainRows } from "@/lib/drizzle-query";
import { unstable_cache } from "next/cache";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import type { RewardsPeriod } from "./rewards-analytics";

/**
 * Generic per-category deep-stats helper for /rewards/analytics tabs.
 *
 * Each tab on the rewards-analytics page (Deposit Bonus / Rakeback /
 * Race / Affiliate / Sign Up) needs the same core shape:
 *   - total volume / count / avg / median / max for the period
 *   - distinct recipients
 *   - daily volume time series
 *   - top 10 users by volume
 *   - top 10 days by volume
 *
 * The only thing that varies per tab is WHICH ledger types the rollup
 * scans. This helper accepts a small list of ledger types (hardcoded
 * constants, NEVER user input) and returns the canonical
 * `CategoryAnalytics` shape. Each tab then composes any category-specific
 * extras (e.g. cap-hit rate for deposit bonus, distinct race count for
 * race prizes) on top via its own dedicated query.
 *
 * Source of truth: `ledger_transactions` rows with `type IN (...)` AND
 * `status = 'completed'`. Same staff + blacklist exclusion the rest of
 * `rewards-analytics.ts` uses so the per-tab totals reconcile with the
 * Overview tab's KPI strip.
 *
 * Per CLAUDE.md House-POV: every reward category is money the house
 * GIVES users → rose accent in the UI. Amounts are returned as positive
 * magnitudes via `ABS(amount)`.
 */

export type CategoryAnalytics = {
  /** Sum of ABS(amount) for the period — total volume paid out. */
  totalVolume: number;
  /** Number of ledger rows in the period. */
  count: number;
  /** Mean per claim — totalVolume / count, or 0 when count = 0. */
  avg: number;
  /** Median per claim via PERCENTILE_CONT(0.5). */
  median: number;
  /** Largest single amount in the period. */
  max: number;
  /** Distinct users who received at least one row in the period. */
  uniqueRecipients: number;
  /** Daily series sorted ASC by date for the time-series chart. */
  dailyVolume: Array<{ date: string; volume: number; count: number }>;
  /** Top 10 users by total volume in the period. */
  topUsers: Array<{
    userId: string;
    username: string | null;
    volume: number;
    count: number;
  }>;
  /** Top 10 days by volume in the period. */
  topDays: Array<{ date: string; volume: number; count: number }>;
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

const TOP_LIMIT = 10;

/**
 * Inline-quote a list of hardcoded ledger type strings into a SQL `IN
 * (...)` fragment. Inputs are NEVER user-supplied — they come from
 * compile-time category-to-types maps — so this is a simple
 * `.map(...).join(",")` with each value wrapped in single quotes.
 */
function typeListSql(types: readonly string[]): string {
  return `(${types.map((t) => `'${t}'`).join(",")})`;
}

/**
 * Inner uncached computation. Wrapped in `unstable_cache` by callers so
 * the blacklist id list participates in the cache key.
 */
async function computeCategoryAnalytics(
  period: RewardsPeriod,
  ledgerTypes: readonly string[],
  blacklistIds: string[],
): Promise<CategoryAnalytics> {
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const blacklistSubquery = blacklistNotInClause("id", blacklistIds);
  const blacklistJoinAlias = blacklistNotInClause("u.id", blacklistIds);
  const typesSql = typeListSql(ledgerTypes);

  // Same 4-query parallel shape as `deposit-bonus-analytics.ts`: rollup
  // + daily series + top users + top days. Each query uses the same
  // status + ledger-type + staff/blacklist filter so totals reconcile
  // across surfaces by construction.
  const [rollupRows, dailyRows, topUserRows, topDayRows] = await Promise.all([
    queryMainRows<
      {
        total: string;
        cnt: string;
        median: string | null;
        max_amount: string | null;
        unique_recipients: string;
      }[]
    >(`
      SELECT
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
        COUNT(*)::text AS cnt,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(lt.amount::numeric))::text AS median,
        MAX(ABS(lt.amount::numeric))::text AS max_amount,
        COUNT(DISTINCT lt.user_id)::text AS unique_recipients
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${typesSql}
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
        ${dateFilter}
    `),
    queryMainRows<
      { date: Date | string; volume: string; cnt: string }[]
    >(`
      SELECT
        DATE(lt.created_at) AS date,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS volume,
        COUNT(*)::text AS cnt
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${typesSql}
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
        ${dateFilter}
      GROUP BY DATE(lt.created_at)
      ORDER BY date ASC
    `),
    queryMainRows<
      {
        user_id: string;
        username: string | null;
        volume: string;
        cnt: string;
      }[]
    >(`
      SELECT
        u.id AS user_id,
        u.username,
        SUM(ABS(lt.amount::numeric))::text AS volume,
        COUNT(*)::text AS cnt
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${typesSql}
        AND u.role NOT IN ('admin', 'support') ${blacklistJoinAlias}
        ${dateFilter}
      GROUP BY u.id, u.username
      ORDER BY SUM(ABS(lt.amount::numeric)) DESC
      LIMIT ${TOP_LIMIT}
    `),
    queryMainRows<
      { date: Date | string; volume: string; cnt: string }[]
    >(`
      SELECT
        DATE(lt.created_at) AS date,
        SUM(ABS(lt.amount::numeric))::text AS volume,
        COUNT(*)::text AS cnt
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${typesSql}
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
        ${dateFilter}
      GROUP BY DATE(lt.created_at)
      ORDER BY SUM(ABS(lt.amount::numeric)) DESC
      LIMIT ${TOP_LIMIT}
    `),
  ]);

  const rollup = rollupRows[0];
  const totalVolume = toNumber(rollup?.total);
  const count = Number(rollup?.cnt ?? 0);
  const median = rollup?.median != null ? toNumber(rollup.median) : 0;
  const max = rollup?.max_amount != null ? toNumber(rollup.max_amount) : 0;
  const uniqueRecipients = Number(rollup?.unique_recipients ?? 0);
  const avg = count > 0 ? totalVolume / count : 0;

  const dailyVolume = dailyRows.map((r) => ({
    date: new Date(r.date).toISOString().split("T")[0],
    volume: toNumber(r.volume),
    count: Number(r.cnt),
  }));

  const topUsers = topUserRows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    volume: toNumber(r.volume),
    count: Number(r.cnt),
  }));

  const topDays = topDayRows.map((r) => ({
    date: new Date(r.date).toISOString().split("T")[0],
    volume: toNumber(r.volume),
    count: Number(r.cnt),
  }));

  return {
    totalVolume,
    count,
    avg,
    median,
    max,
    uniqueRecipients,
    dailyVolume,
    topUsers,
    topDays,
  };
}

/**
 * Build a per-category cached helper. Each tab gets its own cache key
 * + cache-tag bucket so a manual `revalidateTag('rewards-analytics')`
 * invalidates them together with the rest of the rewards data on the
 * page. Cache key carries the period + sorted blacklist signature so
 * admins editing the excluded-users list see the new aggregate on the
 * next tick without manual cache busting.
 */
function buildCachedCategoryHelper(
  cacheKey: string,
  ledgerTypes: readonly string[],
) {
  const cached = unstable_cache(
    async (period: RewardsPeriod, blacklistIds: string[]) =>
      computeCategoryAnalytics(period, ledgerTypes, blacklistIds),
    [cacheKey],
    { revalidate: 60, tags: ["rewards-analytics"] },
  );
  return async (period: RewardsPeriod): Promise<CategoryAnalytics> => {
    const blacklist = await getExcludedUserIds();
    const sorted = [...blacklist].sort();
    return cached(period, sorted);
  };
}

// ── Per-category public entry points ──────────────────────────────────
// Each tab on /rewards/analytics calls into one of these. The ledger
// types match the same `CATEGORY_TO_TYPES` map in `rewards-analytics.ts`
// so the per-tab totals reconcile with the Overview tab's KPI strip by
// construction (same status filter, same staff/blacklist exclusion,
// same ledger types).

export const getDepositBonusCategoryAnalytics = buildCachedCategoryHelper(
  "rewards-category-deposit-bonus-v1",
  ["deposit_bonus"],
);

export const getRakebackAnalytics = buildCachedCategoryHelper(
  "rewards-category-rakeback-v1",
  ["rakeback_claim"],
);

export const getRaceAnalytics = buildCachedCategoryHelper(
  "rewards-category-race-v1",
  ["race_prize"],
);

export const getAffiliateAnalytics = buildCachedCategoryHelper(
  "rewards-category-affiliate-v1",
  ["affiliate_claim"],
);

// Sign Up — uses `balance_reward_claim`. The platform has no dedicated
// `signup_bonus` ledger type; all signup pack / welcome reward claims
// land here (the rewards definition stores `type` in metadata, but the
// ledger row itself is generic). This makes the headline tile equal to
// the existing "Signup / Balance Rewards" bucket in `CATEGORY_TO_TYPES`.
// Sign-up-specific stats (time-to-claim, drop-off) are layered on top
// in a dedicated query below.
export const getSignupAnalytics = buildCachedCategoryHelper(
  "rewards-category-signup-v1",
  ["balance_reward_claim"],
);
