import { blacklistNotInSql, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";

/**
 * Creator-funded withdrawal volume for the Overview tab of
 * /insights/rewards — the dollar total + count of completed/shipped
 * `card_withdrawal_requests` made by users with role = 'creator' in the
 * active window. A creator cashing out their balance is money leaving
 * the house → House-POV rose on the surfacing tile.
 *
 * SOURCE OF TRUTH — mirrors the dashboard's `creatorWithdrawals` /
 * `creatorWithdrawalsCount` exactly (see the `withdrawals` CTE in
 * getPeriodAggregates, src/lib/queries/dashboard.ts):
 *
 *   • table   = card_withdrawal_requests (NOT a ledger sum — some
 *               pre-Fireblocks completions never flipped their ledger
 *               row to 'completed', so the request table is the
 *               authoritative "money left the house" record)
 *   • status  IN ('completed', 'shipped')
 *   • amount  = total_value_usd::numeric
 *   • when    = COALESCE(completed_at, shipped_at)  (shipped rows use
 *               shipped_at as the money-out timestamp when completed_at
 *               is not yet set; completed rows fall back to completed_at)
 *   • who     = requesting user's role = 'creator'
 *
 * The ONLY difference from the dashboard is the window: the dashboard
 * keys on its own `periodToCutoff` (DashboardPeriod), this page keys on
 * the insights rolling-N-days window (InsightsRewardsPeriod) — same as
 * every other figure on /insights/rewards. For the windows the two
 * pages share (24h / 3d / 7d / 30d / all) the number matches the
 * dashboard's Creator Withdrawals card by construction.
 *
 * Staff (admin/support) + the excluded-users blacklist are dropped from
 * the candidate set before the role = 'creator' filter, identical to
 * the dashboard's `real_users` CTE — a blacklisted creator is excluded
 * here too. Read-only sweep over card_withdrawal_requests joined to
 * "user" for the role.
 */

export type CreatorWithdrawalsSummary = {
  /** Sum of total_value_usd across creator-role completed/shipped requests. */
  total: number;
  /** Count of those requests. */
  count: number;
};

async function computeCreatorWithdrawals(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<CreatorWithdrawalsSummary> {
  const db = await getDrizzleDb();
  const days = daysForInsightsPeriod(period);
  // Blacklist fragment applied to the user table inside the real_users
  // CTE (column `id`), matching the dashboard's real_users scope.
  const blacklistSubquery = blacklistNotInSql("id", blacklistIds);

  // Rolling window on the effective "money out" timestamp. `all` →
  // no lower bound (every request counts). Mirrors the cross-category
  // summary's `NOW() - INTERVAL 'N days'` convention so this tile's
  // window lines up with the rest of the page.
  const dateClause =
    days !== null
      ? sql`AND COALESCE(cwr.completed_at, cwr.shipped_at) >=
            NOW() - (${days} * INTERVAL '1 day')`
      : sql.raw("");

  const rows = await queryRows<
    { total: string; count: string }[]
  >(db, sql`
    WITH real_users AS (
      SELECT id, role FROM "user"
      WHERE role NOT IN ('admin', 'support') ${blacklistSubquery}
    )
    SELECT
      COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS total,
      COUNT(*)::text AS count
    FROM card_withdrawal_requests cwr
    JOIN real_users ru ON ru.id = cwr.user_id
    WHERE cwr.status IN ('completed', 'shipped')
      AND ru.role = 'creator'
      ${dateClause}
  `);

  const row = rows[0];
  return {
    total: toNumber(row?.total),
    count: Number(row?.count ?? 0),
  };
}

/**
 * Cached entry-point. Cache key carries the period + the sorted
 * blacklist signature so admin edits to the excluded-users list bust
 * stale aggregates on the next tick. 60s revalidate for finite windows,
 * 5m for lifetime — same cadence as the cross-category summary so both
 * tiles on the Overview tab refresh together.
 */
const cachedCreatorWithdrawals = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCreatorWithdrawals(period, blacklistIds),
  ["insights-rewards-creator-withdrawals-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards"] },
);

const cachedCreatorWithdrawalsLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCreatorWithdrawals(period, blacklistIds),
  ["insights-rewards-creator-withdrawals-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

export async function getCreatorWithdrawalsSummary(
  period: InsightsRewardsPeriod,
): Promise<CreatorWithdrawalsSummary> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedCreatorWithdrawalsLifetime(period, sorted)
    : cachedCreatorWithdrawals(period, sorted);
}
