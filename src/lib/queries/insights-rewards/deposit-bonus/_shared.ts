import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";

/**
 * Shared helpers for every deposit-bonus query in this folder.
 *
 * The deposit-bonus insight page sweeps a lot of different lenses over
 * `ledger_transactions` filtered to `type = 'deposit_bonus'`. Every
 * helper here is read-only against the main DB, excludes staff +
 * blacklist, and ties cache invalidation to the
 * `insights-rewards-deposit-bonus` tag so the page can refresh in one
 * shot if needed.
 *
 * House-POV: deposit bonus is a payout the house GIVES users → rose
 * accent everywhere. ROI lens flips emerald when subsequent gameplay
 * GGR exceeds the cost. (Per CLAUDE.md.)
 */

/** Cache tag bucket every helper in this folder writes to. */
export const DEPOSIT_BONUS_CACHE_TAGS = [
  "rewards-analytics",
  "insights-rewards",
  "insights-rewards-deposit-bonus",
] as const;

/**
 * Window-start expression for an `InsightsRewardsPeriod`. Returns the
 * raw SQL fragment that resolves to the lower-bound timestamp the
 * window opens at, or `-infinity` when the period is lifetime.
 */
export function windowStartExpr(period: InsightsRewardsPeriod): string {
  const days = daysForInsightsPeriod(period);
  return days !== null
    ? `NOW() - INTERVAL '${days} days'`
    : `'-infinity'::timestamp`;
}

/**
 * AND-fragment that filters `ledger_transactions` to the active window.
 * Defaults to the alias `lt` since most queries use that. Returns the
 * empty string when the period is lifetime — every helper unconditionally
 * concatenates the result.
 */
export function windowDateFilter(
  period: InsightsRewardsPeriod,
  alias = "lt",
): string {
  const days = daysForInsightsPeriod(period);
  return days !== null
    ? `AND ${alias}.created_at >= NOW() - INTERVAL '${days} days'`
    : "";
}

/**
 * Resolved exclusion list — staff (admin / support) + dynamic blacklist
 * (`excluded_users` table). Returns the sorted id list so callers
 * participate in the cache key.
 */
export async function getResolvedBlacklist(): Promise<string[]> {
  const blacklist = await getExcludedUserIds();
  return [...blacklist].sort();
}

/**
 * AND-fragment that filters a user-id column down to non-staff +
 * non-blacklisted users. Mirrors the inline patterns in
 * `rewards-category-analytics.ts`.
 *
 *   - subqueryColumn   — id column of the table the subquery selects
 *                        FROM; defaults to `id` since the inner SELECT
 *                        already targets `"user"`.
 */
export function staffAndBlacklistSubquery(
  blacklistIds: string[],
  subqueryColumn = "id",
): string {
  const tail = blacklistNotInClause(subqueryColumn, blacklistIds);
  return `(SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${tail})`;
}

/** Cache TTL for a given period — re-exported for convenience. */
export { cacheTtlForInsightsPeriod };
