import "server-only";

import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { STAFF_ROLES } from "@/lib/queries/_exclude-staff";

/**
 * Filter helpers that combine the static staff-role exclusion with
 * the DB-backed blacklist (the `excluded_users` table managed by the
 * `/system/excluded-users` page).
 *
 * Both exclusions are conceptually the same — "drop these users
 * from dashboard / analytics / PnL aggregates" — so most call sites
 * want the COMBINED filter. The exception is race queries
 * (rakeback, race_claims, race_leaderboard_snapshots): they keep
 * counting blacklisted users so leaderboard positions don't shift
 * when an exclusion lands, per the user's explicit ask.
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
  if (ids.length === 0) return "";
  const list = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
  return `AND ${columnName} NOT IN (${list})`;
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
  const blacklistTail =
    ids.length > 0
      ? ` AND id NOT IN (${ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
      : "";
  return `user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','support')${blacklistTail})`;
}
