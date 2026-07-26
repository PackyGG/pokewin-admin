import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  blacklistNotInSql,
  daysAgoFilter,
  sql,
} from "@/lib/queries/insights-rewards/_drizzle-query";
import type { SQL } from "drizzle-orm";
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
export function windowStartExpr(period: InsightsRewardsPeriod): SQL {
  const days = daysForInsightsPeriod(period);
  return days !== null
    ? sql`NOW() - (${days} * INTERVAL '1 day')`
    : sql`'-infinity'::timestamp`;
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
): SQL {
  const days = daysForInsightsPeriod(period);
  return daysAgoFilter(`${alias}.created_at`, days);
}

/**
 * Lifetime lookback cap (days) for the heavy deposit↔bonus balance-pairing
 * queries. On the `all` window the plain {@link windowDateFilter} returns
 * no bound, which makes the correlated LATERAL pairing scan the entire
 * `ledger_transactions` deposit history — the single most expensive plan
 * on this surface. Bounding the deposit side to the last year keeps the
 * pairing tractable while still covering effectively all currently-relevant
 * bonus activity. Mirrors the 365-day guard already used on the wager side
 * in `suspicious.ts`.
 */
export const LIFETIME_PAIRING_LOOKBACK_DAYS = 365;

/**
 * Like {@link windowDateFilter}, but on the lifetime (`all`) window the
 * filter is bounded to {@link LIFETIME_PAIRING_LOOKBACK_DAYS} instead of
 * being unbounded. Use this for the deposit-side scan of any helper that
 * runs the heavy balance-pairing LATERAL join (cohort / cap / time-to-claim
 * / daily attach-rate) so a lifetime view doesn't trigger a full-history
 * table scan. Finite windows behave identically to `windowDateFilter`.
 */
export function windowDateFilterCapped(
  period: InsightsRewardsPeriod,
  alias = "lt",
): SQL {
  const days = daysForInsightsPeriod(period);
  const bound = days ?? LIFETIME_PAIRING_LOOKBACK_DAYS;
  return daysAgoFilter(`${alias}.created_at`, bound);
}

/**
 * Like {@link windowDateFilterCapped}, but extends the lower bound back by
 * an extra `tailDays`. Used for a SECONDARY scan whose rows must cover a
 * retention/forward tail AFTER each in-window row — e.g. the cohort
 * comparison checks whether a deposit's user wagered up to 30 days LATER,
 * so the wager scan must reach `windowStart − 0` … `now`, i.e. include
 * activity up to `tailDays` past the deposit window's lower bound is NOT
 * what we need (the tail is forward, not backward) — but bounding the
 * wager scan to `days + tailDays` keeps it tractable while guaranteeing
 * every wager that can satisfy a `≤ deposit + tailDays` predicate for an
 * in-window deposit is present. Finite windows get `days + tailDays`;
 * lifetime gets {@link LIFETIME_PAIRING_LOOKBACK_DAYS}` + tailDays`.
 *
 * The bound is intentionally generous (a small constant tail on top of the
 * already-capped window) so it never drops a qualifying retention wager,
 * yet still excludes the bulk of historical wager rows that can't pair
 * with any in-window deposit.
 */
export function windowDateFilterCappedTail(
  period: InsightsRewardsPeriod,
  alias: string,
  tailDays: number,
): SQL {
  const days = daysForInsightsPeriod(period) ?? LIFETIME_PAIRING_LOOKBACK_DAYS;
  const bound = days + tailDays;
  return daysAgoFilter(`${alias}.created_at`, bound);
}

/**
 * Resolved exclusion list — staff (admin / support), creators, + dynamic blacklist
 * (`excluded_users` table). Returns the sorted id list so callers
 * participate in the cache key.
 */
export async function getResolvedBlacklist(): Promise<string[]> {
  const blacklist = await getExcludedUserIds();
  return [...blacklist].sort();
}

/**
 * AND-fragment that filters a user-id column to non-staff, non-creator,
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
): SQL {
  const tail = blacklistNotInSql(subqueryColumn, blacklistIds);
  return sql`(SELECT id FROM "user" WHERE role NOT IN ('admin', 'support', 'creator') ${tail})`;
}

/** Cache TTL for a given period — re-exported for convenience. */
export { cacheTtlForInsightsPeriod };
