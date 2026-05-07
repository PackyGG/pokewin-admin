/**
 * Roles excluded from global stats (dashboard, analytics, P&L,
 * leaderboards) because they are internal/non-customer accounts and
 * would skew aggregate metrics next to real customers.
 *
 * IMPORTANT: Creators are NOT in this list. They wager + deposit
 * like normal users (for streaming, give-aways, their own play) and
 * those numbers are real revenue/payouts that belong in P&L.
 *
 * `admin` and `support` ARE excluded — admins are dev/QA accounts and
 * support is platform staff. Both showed up on the user-facing
 * leaderboards (e.g. void on /analytics top performers as a support
 * account) which the user flagged on 2026-05-07. Adding `support`
 * here makes the canonical helper match the implicit intent of every
 * caller that was using `role != 'admin'` as the staff filter.
 *
 * The constant + helper names stay stable; "STAFF" now means
 * admin + support.
 */
export const STAFF_ROLES: Array<"admin" | "support"> = ["admin", "support"];

/**
 * Prisma where-filter for tables that have a `user` relation to User.
 * Use like: `where: { ...otherFilters, user: EXCLUDE_STAFF_USER_RELATION }`
 */
export const EXCLUDE_STAFF_USER_RELATION = {
  role: { notIn: STAFF_ROLES },
};

/**
 * Raw SQL fragment (as a string) that can be interpolated into queries where
 * we need to exclude staff. Assumes a column named `user_id` (varchar)
 * referencing `"user".id`.
 *
 * IMPORTANT: The $queryRaw tagged template does parameter binding, so this
 * string is injected via $queryRawUnsafe or string concatenation. Since we
 * only use hardcoded role names, no injection risk.
 */
export const EXCLUDE_STAFF_SQL = `user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','support'))`;
