/**
 * Staff/non-user roles that should be excluded from global stats
 * (dashboard, analytics, etc.) because their balances/wagers/deposits
 * are test/internal and would skew aggregate metrics.
 */
export const STAFF_ROLES: Array<"admin" | "creator"> = [
  "admin",
  "creator",
];

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
export const EXCLUDE_STAFF_SQL = `user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin','creator'))`;
