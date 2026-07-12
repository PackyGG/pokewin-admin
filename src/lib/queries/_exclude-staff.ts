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
