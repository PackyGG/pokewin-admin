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
 * Sync sibling of `blacklistSqlFragment` for call sites that already have
 * the excluded-ids array in hand (and use it for other things too), so
 * they don't pay a second `getExcludedUserIds()` round just to format
 * the clause.
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
 * Prisma where-fragment for a `user: {…}` relation. Use to replace
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
const STAFF_AND_CREATOR_ROLES = [...STAFF_ROLES, "creator"] as const;

/**
 * Creator-excluding sibling of {@link excludeStaffAndBlacklisted}: a
 * Prisma where-fragment for a `user: {…}` relation that drops staff
 * (admin/support) AND creators AND the blacklist. Use on money/analytics
 * aggregates where creator play must NOT inflate the figures.
 *
 *   where: { user: await excludeStaffCreatorsAndBlacklisted() }
 */
export async function excludeStaffCreatorsAndBlacklisted() {
  const ids = await getExcludedUserIds();
  return {
    role: { notIn: [...STAFF_AND_CREATOR_ROLES] },
    ...(ids.length > 0 ? { id: { notIn: ids } } : {}),
  };
}

/**
 * Prisma where-fragment when filtering the User entity directly
 * (no relation hop). Use to replace `role: { notIn: STAFF_ROLES }`
 * with a combined filter that ALSO drops blacklisted ids.
 *
 *   Before: where: { role: { notIn: STAFF_ROLES } }
 *   After:  where: await excludeStaffAndBlacklistedDirect()
 *
 * Spreads cleanly into an existing where: `where: { ..., ...await ...() }`.
 */
export async function excludeStaffAndBlacklistedDirect() {
  const ids = await getExcludedUserIds();
  return {
    role: { notIn: [...STAFF_ROLES] },
    ...(ids.length > 0 ? { id: { notIn: ids } } : {}),
  };
}

/**
 * Prisma `user_id` notIn fragment for tables that store user_id as a
 * plain column (no relation). Spread into a where:
 *
 *   where: { ..., ...await excludedUserIdNotIn() }
 *
 * Returns `{}` when nothing is blacklisted so the spread is a no-op.
 */
export async function excludedUserIdNotIn(): Promise<
  { user_id: { notIn: string[] } } | Record<string, never>
> {
  const ids = await getExcludedUserIds();
  if (ids.length === 0) return {};
  return { user_id: { notIn: ids } };
}

/**
 * Raw SQL fragment to AND-append to a WHERE clause that already
 * applies staff exclusion. Returns the empty string when the
 * blacklist is empty so the query stays valid without conditionals.
 *
 * `columnName` is the column to filter (default `user_id`), so call
 * sites can target an aliased column like `lt.user_id` or `u.id`.
 * IDs are inlined as quoted text literals — packy.gg user_ids are
 * already character-class restricted (alphanum), and we double-up
 * any embedded single quotes as defence-in-depth.
 */
export async function blacklistSqlFragment(
  columnName = "user_id",
): Promise<string> {
  const ids = await getExcludedUserIds();
  return blacklistNotInClause(columnName, ids);
}

/**
 * Raw SQL fragment to AND-append the staff + blacklist filter as a
 * subquery filter, matching the shape of `EXCLUDE_STAFF_SQL`. Use
 * when the call site needs a self-contained `user_id IN (...)`
 * fragment rather than a pair of separate ANDs.
 *
 *   Before: `... AND ${EXCLUDE_STAFF_SQL}`
 *   After:  `... AND ${await excludeStaffAndBlacklistedSql()}`
 *
 * Format: `user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','support') AND id NOT IN (...))`
 * — exactly the same shape as the existing helper, with the extra
 * NOT IN appended only when the blacklist is non-empty.
 */
export async function excludeStaffAndBlacklistedSql(): Promise<string> {
  const ids = await getExcludedUserIds();
  return excludeStaffAndBlacklistedSqlFromIds(ids);
}

/**
 * Same shape as {@link excludeStaffAndBlacklistedSql} when the caller
 * already resolved the blacklist (e.g. inside an `unstable_cache` fn
 * that keys on the sorted id list).
 */
export function excludeStaffAndBlacklistedSqlFromIds(ids: string[]): string {
  const blacklistTail =
    ids.length > 0 ? ` AND id NOT IN (${escapeBlacklistIds(ids)})` : "";
  return `user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','support')${blacklistTail})`;
}

/**
 * Creator-excluding sibling of {@link excludeStaffAndBlacklistedSql}.
 * Same self-contained `user_id IN (...)` shape, but the inner subquery
 * also drops `'creator'` — the canonical CUSTOMER-analytics population
 * (matches `realCustomersScopeSql()` / `getMetricsScope()`). Use on
 * money/analytics aggregates where creator play must NOT inflate figures.
 *
 *   Before: `... AND ${await excludeStaffAndBlacklistedSql()}`  (keeps creators)
 *   After:  `... AND ${await excludeStaffCreatorsAndBlacklistedSql()}`
 *
 * Format: `user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','support','creator') AND id NOT IN (...))`
 */
export async function excludeStaffCreatorsAndBlacklistedSql(): Promise<string> {
  const ids = await getExcludedUserIds();
  return excludeStaffCreatorsAndBlacklistedSqlFromIds(ids);
}

/**
 * Same shape as {@link excludeStaffCreatorsAndBlacklistedSql} when the
 * caller already resolved the blacklist (e.g. inside an `unstable_cache`
 * fn that keys on the sorted id list). Additive sibling of
 * {@link excludeStaffAndBlacklistedSqlFromIds} — the only difference is
 * the extra `'creator'` in the excluded-roles list.
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
