import "server-only";

import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { EMPTY_CREATOR_SESSION_WINDOWS_CTE } from "@/lib/queries/creator-session-windows";

/**
 * scope.ts — the SINGLE canonical "real customer" scope for the metric
 * layer, exported so every surface that reports gaming-margin numbers
 * applies the EXACT same population. "One scope, fixed once."
 *
 * ─── THE SCOPE (verified, house-POV gaming economics) ────────────────
 *
 * A row counts toward the canonical metrics iff ALL of:
 *   1. The user is NOT staff AND NOT a creator —
 *      `role NOT IN ('admin','support','creator')`. Creators are dropped
 *      WHOLESALE (like staff): a creator's play — even OFF-stream,
 *      house-funded "for content" play (e.g. an admin-adjustment balance
 *      they gamble on stream) — is NOT real customer revenue and must not
 *      enter customer GGR/NGR/P&L on EITHER side (their wager AND their
 *      inventory wins are excluded). This REVERSES the earlier
 *      "creators kept as real customers" decision, per the owner's
 *      current direction (2026-06-03): a creator who got house-funded
 *      balance to play for content was inflating the dashboard GGR
 *      breakdown (won ~$20.6k of cards off a ~$3.4k wager ≈ 600%), which
 *      is content, not customer gambling.
 *   2. The user is NOT on the admin-managed excluded-users blacklist.
 *   3. (INERT) The row is NOT a creator-on-session row. This predicate is
 *      PERMANENTLY a no-op: (1) already drops every creator wholesale, so
 *      `getMetricsScope` injects the EMPTY session-windows relation
 *      (`EMPTY_CREATOR_SESSION_WINDOWS_CTE`) — no backend fetch ever runs
 *      here — and the `NOT EXISTS` matches nothing. The CTE-injection
 *      contract the consumers rely on (`sessionWindowsCte` +
 *      `notInCreatorSession`) is kept so their SQL stays structurally
 *      unchanged.
 *   4. Borrow correction is handled by the shared leg fragments in
 *      `gaming-sql.ts`, not here (the current basis is borrow-net-
 *      INCLUSIVE — see queries.ts), because it is per-game-session, not
 *      per-user.
 *
 * INERT SESSION-WINDOW STUB: earlier revisions fetched real creator
 * deal/stream windows via `getCreatorSessionWindowsCte` (backend creators
 * API, 5-min cached, best-effort). Since the wholesale creator drop in
 * (1) — a plain `role NOT IN (...)` on `"user"` with no backend
 * dependency — that fetch became pointless, so this scope now always
 * injects the empty relation and never talks to the backend. There is no
 * best-effort leak window. If per-session scoping is ever needed again,
 * wire `getCreatorSessionWindowsCte()` back in here.
 *
 * ─── TWO CONSUMPTION SHAPES ──────────────────────────────────────────
 *
 *   • CTE style (queries that build their own SQL with a WITH clause):
 *     inject `sessionWindowsCte` ahead of the other CTEs and add the
 *     `notInCreatorSession(userCol, tsCol)` predicate to the WHERE, with
 *     `user_id IN ${userScopeSql}`. Used by `queries.ts` and
 *     `dashboard.ts getGgrTopContributors`.
 *   • Inline-fragment style (flat queries that only append a WHERE
 *     fragment and cannot carry a CTE): use `exclStaffSessionFrag()`,
 *     which returns a self-contained `AND user_id IN (...) AND NOT EXISTS
 *     (... inline session windows ...)` fragment — the session windows
 *     are inlined as a sub-relation so no CTE is needed. Used by
 *     `analytics.ts buildExclStaffFrag`.
 *
 * Both shapes resolve from the SAME `getMetricsScope()` snapshot, so they
 * can never drift.
 */

/**
 * Staff roles dropped wholesale from the canonical scope. Kept as the
 * "staff" concept (used by callers that mean strictly admin/support).
 */
const STAFF_ROLES = ["admin", "support"] as const;

/**
 * Roles dropped wholesale from the CUSTOMER scope = staff PLUS `creator`.
 * Creators are now excluded entirely (not just on-session): a creator's
 * play — including off-stream, house-funded "for content" play — is not
 * real customer revenue, so it must not count in customer GGR/NGR/P&L on
 * either the wager or the payout side. `role` (the scalar `user_role`
 * enum on `"user"`) is the canonical, cheap creator signal; the codebase
 * already uses `role NOT IN ('admin','support','creator')` for the
 * upgrader-leg scope, so this brings the ledger/inventory legs in line.
 */
export const CUSTOMER_EXCLUDED_ROLES = ["admin", "support", "creator"] as const;

const CUSTOMER_EXCLUDED_ROLES_SQL = `(${CUSTOMER_EXCLUDED_ROLES.map(
  (r) => `'${r}'`,
).join(", ")})`;

/**
 * Inner relation of the (always-empty) session-windows stub — inlined by
 * `exclStaffSessionFrag` for flat queries that cannot carry a CTE. A
 * static constant: `getMetricsScope` always injects the empty CTE (see
 * the INERT SESSION-WINDOW STUB note above), so there is nothing to
 * parse out of a dynamic window list anymore. Must stay shape-identical
 * to the body of `EMPTY_CREATOR_SESSION_WINDOWS_CTE`.
 */
const EMPTY_INNER = "SELECT NULL::text, NULL::timestamptz, NULL::timestamptz WHERE false";

export type MetricsScope = {
  /**
   * `(SELECT id FROM "user" u WHERE role NOT IN ('admin','support','creator')
   * <blacklist>)` — staff + creator + blacklist dropped wholesale. Use as
   * `user_id IN ${userScopeSql}`. The session-window predicate below is
   * now redundant (no creator row survives) but kept harmless.
   */
  userScopeSql: string;
  /**
   * The `session_windows(uid, win_start, win_end) AS (...)` CTE
   * definition — inject ahead of a query's other CTEs (after `WITH`).
   * Then reference it via `notInCreatorSession(userCol, tsCol)`.
   */
  sessionWindowsCte: string;
  /**
   * Per-row predicate (for CTE-style queries that injected
   * `sessionWindowsCte`): resolves TRUE when the row is NOT a
   * creator-on-session row. With the inert empty stub this is ALWAYS
   * true — kept so consumer SQL stays structurally unchanged.
   *
   * `userCol` / `tsCol` are inlined verbatim — pass only hardcoded,
   * trusted identifiers (`lt.user_id`, `ui.obtained_at`, …).
   */
  notInCreatorSession: (userCol: string, tsCol: string) => string;
  /**
   * Self-contained scope fragment for flat queries: drops staff +
   * creators + blacklist in one `AND …` string, WITHOUT needing a CTE.
   * The retained session-window predicate is inert because its inline
   * relation is always empty.
   *
   * Defaults: `userCol = 'user_id'`, `tsCol = 'created_at'` (the shape of
   * the `ledger_transactions` aggregates in `analytics.ts`). Pass
   * explicit identifiers for other shapes. Identifiers are inlined
   * verbatim — hardcoded/trusted only.
   *
   * Returns e.g.:
   *   ` AND user_id IN (SELECT id FROM "user" u WHERE …)
   *     AND NOT EXISTS (SELECT 1 FROM (<windows>) sw(uid,win_start,win_end)
   *       WHERE sw.uid = user_id AND created_at >= sw.win_start
   *         AND created_at < sw.win_end)`
   */
  exclStaffSessionFrag: (opts?: { userCol?: string; tsCol?: string }) => string;
};

/**
 * Resolve the canonical metric scope ONCE (blacklist + the inert
 * session-window stub). Cheap to call repeatedly: `getExcludedUserIds`
 * is React-`cache()`d and the session-windows CTE is a static empty
 * constant — no backend or extra DB round-trip happens here.
 */
export async function getMetricsScope(): Promise<MetricsScope> {
  const excluded = await getExcludedUserIds();
  // The customer relation below excludes creators wholesale, so no creator
  // can match a session window. Keep the CTE shape without a backend fan-out.
  const sessionWindowsCte = EMPTY_CREATOR_SESSION_WINDOWS_CTE;
  const blacklist = blacklistNotInClause("u.id", excluded);
  // Customer scope: drop staff + creators wholesale (+ blacklist). The
  // creator drop here is what keeps creators' off-stream, house-funded
  // "for content" play out of customer GGR/NGR/P&L on BOTH sides (wager
  // and inventory wins) — the session-window predicate below is an inert
  // no-op left intact for the CTE contract (harmless).
  const userScopeSql = `(SELECT id FROM "user" u WHERE u.role NOT IN ${CUSTOMER_EXCLUDED_ROLES_SQL} ${blacklist})`;
  const inner = EMPTY_INNER;

  const notInCreatorSession = (userCol: string, tsCol: string): string =>
    `NOT EXISTS (
       SELECT 1 FROM session_windows sw
       WHERE sw.uid = ${userCol}
         AND ${tsCol} >= sw.win_start
         AND ${tsCol} <  sw.win_end
     )`;

  const exclStaffSessionFrag = (opts?: {
    userCol?: string;
    tsCol?: string;
  }): string => {
    const userCol = opts?.userCol ?? "user_id";
    const tsCol = opts?.tsCol ?? "created_at";
    return ` AND ${userCol} IN ${userScopeSql}
      AND NOT EXISTS (
        SELECT 1 FROM (${inner}) sw(uid, win_start, win_end)
        WHERE sw.uid = ${userCol}
          AND ${tsCol} >= sw.win_start
          AND ${tsCol} <  sw.win_end
      )`;
  };

  return {
    userScopeSql,
    sessionWindowsCte,
    notInCreatorSession,
    exclStaffSessionFrag,
  };
}
