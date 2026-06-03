import "server-only";

import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getCreatorSessionWindowsCte } from "@/lib/queries/creator-session-windows";

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
 *   3. The row is NOT a creator-on-session row — its timestamp does not
 *      fall inside one of that creator's deal/stream session windows
 *      (`getCreatorSessionWindowsCte`). This predicate is now REDUNDANT
 *      with (1) — once every creator is dropped wholesale, no creator row
 *      survives to (3) anyway — but it is kept (harmless, a no-op for the
 *      now-excluded creators) so the CTE-injection contract the consumers
 *      rely on (`sessionWindowsCte` + `notInCreatorSession`) stays intact
 *      and the borrow/blacklist plumbing is untouched. It still guards the
 *      best-effort caveat below for any non-creator edge case.
 *   4. Borrow plays are excluded on both sides — handled by the borrow
 *      fragments in `queries.ts` (`NON_BORROW_*`), not here, because
 *      borrow correction is per-game-session, not per-user.
 *
 * BEST-EFFORT CAVEAT (inherited from `getCreatorSessionWindowsCte`): the
 * session windows are fetched from the backend creators API and cached
 * 5 min; on a backend failure the helper yields an EMPTY relation, so the
 * creator-on-session exclusion (3) degrades to a NO-OP. This used to mean
 * creator on-stream play could leak in until the backend recovered — but
 * that leak is now CLOSED because the wholesale creator drop in (1) is the
 * primary exclusion and is NOT best-effort: it always applies (a plain
 * `role NOT IN (...)` on `"user"`, no backend dependency). The
 * staff + creator + blacklist drop in (1)/(2) always holds; (3) is the
 * now-redundant belt-and-braces layer.
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
export const STAFF_ROLES = ["admin", "support"] as const;

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
 * Extract the inner relation expression from the
 * `session_windows(uid, win_start, win_end) AS (<BODY>)` CTE string that
 * `getCreatorSessionWindowsCte` returns, so it can be inlined as a
 * sub-relation in a `NOT EXISTS`. Returns `<BODY>` (either a `VALUES ...`
 * list or the empty-relation `SELECT … WHERE false`).
 *
 * Defensive: if the prefix/suffix ever change shape, fall back to the
 * empty relation (exclusion becomes a no-op rather than producing invalid
 * SQL — same fail-open posture as the backend-down case).
 */
const CTE_PREFIX = "session_windows(uid, win_start, win_end) AS (";
const EMPTY_INNER = "SELECT NULL::text, NULL::timestamptz, NULL::timestamptz WHERE false";

function sessionWindowsInner(cte: string): string {
  const trimmed = cte.trim();
  if (trimmed.startsWith(CTE_PREFIX) && trimmed.endsWith(")")) {
    return trimmed.slice(CTE_PREFIX.length, -1);
  }
  return EMPTY_INNER;
}

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
   * creator-on-session row, i.e. there is no session window for that user
   * covering the row's timestamp. Non-creator users never match a window,
   * so they are always kept.
   *
   * `userCol` / `tsCol` are inlined verbatim — pass only hardcoded,
   * trusted identifiers (`lt.user_id`, `ui.obtained_at`, …).
   */
  notInCreatorSession: (userCol: string, tsCol: string) => string;
  /**
   * Self-contained scope fragment for flat queries: drops staff +
   * blacklist AND creator-on-session rows in one `AND …` string, WITHOUT
   * needing a CTE (the session windows are inlined as a sub-relation).
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
 * Resolve the canonical metric scope ONCE (blacklist + creator session
 * windows). Cheap to call repeatedly: `getExcludedUserIds` is
 * React-`cache()`d and `getCreatorSessionWindowsCte` is 5-min
 * cross-request cached.
 */
export async function getMetricsScope(): Promise<MetricsScope> {
  const [excluded, sessionWindowsCte] = await Promise.all([
    getExcludedUserIds(),
    getCreatorSessionWindowsCte(),
  ]);
  const blacklist = blacklistNotInClause("u.id", excluded);
  // Customer scope: drop staff + creators wholesale (+ blacklist). The
  // creator drop here is what keeps creators' off-stream, house-funded
  // "for content" play out of customer GGR/NGR/P&L on BOTH sides (wager
  // and inventory wins) — the session-window predicate below is now a
  // redundant no-op for creators but is left intact (harmless).
  const userScopeSql = `(SELECT id FROM "user" u WHERE u.role NOT IN ${CUSTOMER_EXCLUDED_ROLES_SQL} ${blacklist})`;
  const inner = sessionWindowsInner(sessionWindowsCte);

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
