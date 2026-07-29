import "server-only";

import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { STAFF_ROLES } from "@/lib/queries/_exclude-staff";

/**
 * Escape + quote a list of already-resolved excluded user_ids for inline
 * interpolation into a raw SQL `IN (...)` / `NOT IN (...)` list. Returns
 * a bare comma-separated list of quoted text literals WITHOUT the
 * surrounding parentheses, e.g. `'a','b'`. Empty input → empty string.
 *
 * packy.gg user_ids are character-class restricted (alphanumeric), and
 * we still double-up any embedded single quote as defence-in-depth — the
 * single canonical place that escaping lives, so the ~8 raw-SQL call
 * sites that used to re-implement `ids.map(id => '..replace..')` can't
 * drift apart.
 */
export function escapeBlacklistIds(ids: string[]): string {
  return ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
}

/**
 * Build an `AND <column> NOT IN ('id', …)` SQL fragment from an
 * already-resolved id list. Returns the empty string when nothing is
 * excluded so the fragment can be concatenated unconditionally into a
 * WHERE clause. `column` is inlined verbatim — pass only trusted,
 * hardcoded column identifiers (e.g. `"u.id"`, `"user_id"`).
 *
 * For call sites that already have the excluded-ids array in hand (and
 * use it for other things too), so they don't pay a second
 * `getExcludedUserIds()` round just to format the clause.
 */
export function blacklistNotInClause(column: string, ids: string[]): string {
  if (ids.length === 0) return "";
  return `AND ${column} NOT IN (${escapeBlacklistIds(ids)})`;
}

/**
 * Filter helpers that combine the static staff-role exclusion with
 * the DB-backed blacklist (the `excluded_users` table managed by the
 * `/system/excluded-users` page).
 *
 * Both exclusions are conceptually the same — "drop these users
 * from dashboard / analytics / PnL aggregates, transaction lists,
 * and every other admin surface" — so call sites want the COMBINED
 * filter unless they are explicitly scoped to a single known user
 * (e.g. /users/[id] detail).
 *
 * The blacklist is small (handful of IDs at most) and cached per
 * request via `cache()` in fetch.ts, so calling these helpers in
 * many places inside a single page render adds no extra DB load.
 */

/**
 * Legacy relation-filter fragment. Use to replace
 * `user: EXCLUDE_STAFF_USER_RELATION` with the combined filter.
 *
 *   Before: where: { user: EXCLUDE_STAFF_USER_RELATION }
 *   After:  where: { user: await excludeStaffAndBlacklisted() }
 */
export async function excludeStaffAndBlacklisted() {
  const ids = await getExcludedUserIds();
  return {
    role: { notIn: [...STAFF_ROLES] },
    ...(ids.length > 0 ? { id: { notIn: ids } } : {}),
  };
}

/**
 * Roles dropped by the CUSTOMER-analytics scope: staff (admin/support)
 * PLUS creators. This is the canonical money/analytics population — it
 * matches `getMetricsScope()` (`CUSTOMER_EXCLUDED_ROLES`) and
 * `realCustomersScopeSql()`. Creators wager + deposit like normal users,
 * but their play is house-funded promo activity, NOT real-customer
 * economics, so it is excluded WHOLESALE from GGR / NGR / P&L / reward
 * aggregates (canonical decision 2026-06-03).
 *
 * Kept LOCAL to this module on purpose — `STAFF_ROLES` in
 * `_exclude-staff.ts` deliberately means admin+support ONLY, and the
 * `excludeStaffAndBlacklisted*` helpers above intentionally KEEP creators
 * for the non-analytics callers that rely on that semantics. The
 * creator-excluding variants below are additive siblings; they never
 * change the existing helpers.
 */
/**
 * Self-contained `user_id IN (...)` raw SQL fragment for the caller that
 * already resolved the blacklist (e.g. inside an `unstable_cache` fn
 * that keys on the sorted id list).
 *
 * Format: `user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','support') AND id NOT IN (...))`
 */
export function excludeStaffAndBlacklistedSqlFromIds(ids: string[]): string {
  const blacklistTail =
    ids.length > 0 ? ` AND id NOT IN (${escapeBlacklistIds(ids)})` : "";
  return `user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','support')${blacklistTail})`;
}

/**
 * Same shape as {@link excludeStaffAndBlacklistedSqlFromIds} but the
 * inner subquery also drops `'creator'` — the canonical
 * CUSTOMER-analytics population (matches `realCustomersScopeSql()` /
 * `getMetricsScope()`). Use on money/analytics aggregates where
 * creator play must NOT inflate figures. Caller resolves the
 * blacklist first (e.g. inside an `unstable_cache` fn that keys on
 * the sorted id list).
 *
 * Format: `user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','support','creator') AND id NOT IN (...))`
 */
export function excludeStaffCreatorsAndBlacklistedSqlFromIds(
  ids: string[],
): string {
  const blacklistTail =
    ids.length > 0 ? ` AND id NOT IN (${escapeBlacklistIds(ids)})` : "";
  return `user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','support','creator')${blacklistTail})`;
}

/**
 * Inline subquery of real-customer user ids for raw SQL `IN (...)` clauses.
 * Pass a column name when filtering a non-`user_id` FK (e.g. `referred_user_id`).
 */
export function realCustomerIdsSubquery(blacklistIds: string[]): string {
  const tail = blacklistNotInClause("id", blacklistIds);
  return `(SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${tail})`;
}
