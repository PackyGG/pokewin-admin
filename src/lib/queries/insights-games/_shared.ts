import "server-only";

/**
 * Shared types + helpers used by every /insights/games query module.
 *
 * The page lets admins ask "how much did we make off games in the past
 * 24h / 3d / 7d / 30d / 90d / lifetime" with the EXACT scope a real
 * casino would report:
 *
 *   • Borrow-corrected wager — when a user opens a "$1k pack" with 90%
 *     borrow, only the $100 they actually paid out of their balance
 *     counts as wager. The borrowed $900 is house exposure, not user
 *     money — it cancels out on the payout side too (the borrowed
 *     portion is auto-resold to the house before the inventory row
 *     lands, so `user_inventory.value_at_obtained` already reflects
 *     net keep).
 *
 *     CRITICAL — the user spec says: "if it is a 1k pack and 90%
 *     borrow he only paid 100 etc." So we report the $100 figure for
 *     wager, NOT the $1000 sticker. This matches what
 *     `analytics-packs.ts` / `pnl.ts` / dashboard already do
 *     internally; the names are aligned so admins reading multiple
 *     pages don't get confused.
 *
 *   • Creator-on-stream exclusion — wagers a creator makes while live
 *     on a deal/stream are house-funded promo play, NOT real customer
 *     bets. Same `session_windows` CTE pattern that the GGR fix in
 *     commit 7390363 introduced and the dashboard's headline GGR
 *     aggregate uses; lifted via `getCreatorSessionWindowsCte()`.
 *
 *     Applied SYMMETRICALLY: wager side AND payout side both drop the
 *     same rows. An asymmetric filter would inflate/deflate P&L by the
 *     surviving leg.
 *
 * The two exclusions are independent — borrow correction happens for
 * normal real customers too, creator-stream exclusion happens
 * regardless of borrow. Both are applied to every aggregate on this
 * page.
 */

export type GamesPeriod = "24h" | "3d" | "7d" | "30d" | "90d" | "all";

export function parseGamesPeriod(value: string | undefined): GamesPeriod {
  switch (value) {
    case "24h":
    case "3d":
    case "7d":
    case "30d":
    case "90d":
    case "all":
      return value;
    default:
      return "7d";
  }
}

/**
 * Hours of look-back for each period. `null` = lifetime (no lower
 * bound). Returned as hours not days so the 24h window fits naturally
 * alongside the multi-day options.
 */
export function hoursForPeriod(period: GamesPeriod): number | null {
  switch (period) {
    case "24h":
      return 24;
    case "3d":
      return 24 * 3;
    case "7d":
      return 24 * 7;
    case "30d":
      return 24 * 30;
    case "90d":
      return 24 * 90;
    case "all":
      return null;
  }
}

/**
 * SQL fragment that resolves to TRUE when the row's `<col>` (a
 * timestamp) is inside the selected period — i.e. >= NOW() − interval.
 * Returns the empty string for lifetime (no lower bound).
 *
 * `column` is inlined verbatim — pass only trusted, hardcoded
 * identifiers (`lt.created_at`, `ui.obtained_at`, etc.). The interval
 * value is a hardcoded number, never user-supplied.
 */
export function periodCutoffSql(
  column: string,
  period: GamesPeriod,
): string {
  const hours = hoursForPeriod(period);
  if (hours === null) return "";
  return `AND ${column} >= NOW() - INTERVAL '${hours} hours'`;
}

/**
 * Pretty label for the selected period — used in UI captions and
 * tooltips so the figures always read with their scope attached.
 */
export function labelForPeriod(period: GamesPeriod): string {
  switch (period) {
    case "24h":
      return "past 24h";
    case "3d":
      return "past 3 days";
    case "7d":
      return "past 7 days";
    case "30d":
      return "past 30 days";
    case "90d":
      return "past 90 days";
    case "all":
      return "lifetime";
  }
}

/**
 * Shared real-customers scope:
 *   • Drops staff (admin / support / creator)
 *   • Drops the admin-managed excluded-users blacklist
 *
 * Creator wagers are dropped wholesale here — even off-stream creator
 * play isn't representative of a real customer's economics. Matches the
 * scope `analytics/pure-pnl` / `getPackBattlePurePnl` uses for the
 * same reason.
 *
 * Returns the SQL fragment: `(SELECT id FROM "user" u WHERE role NOT
 * IN (...) ${blacklistNotInClause})`. Use as `user_id IN ${scope}`.
 */
import { blacklistNotInClause } from "../_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

export async function realCustomersScopeSql(): Promise<string> {
  const excluded = await getExcludedUserIds();
  const blacklist = blacklistNotInClause("u.id", excluded);
  return `(SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklist})`;
}

/**
 * SQL fragment that drops a ledger row when the user is a creator AND
 * the row's created_at falls inside one of that creator's stream
 * sessions (the `session_windows` CTE that must be present in the
 * query — inject `${sessionWindowsCte}` ahead of WITH).
 *
 * NOTE: the `realCustomersScopeSql` already drops every creator row
 * regardless of session. This helper exists for queries that DO
 * include creators (e.g. an "off-stream creator play" breakdown) — on
 * this page nothing needs it, but it's kept here so future code
 * doesn't reinvent the predicate.
 *
 * `userCol` and `tsCol` are inlined verbatim — pass only hardcoded
 * identifiers.
 */
export function notInCreatorSessionSql(
  userCol: string,
  tsCol: string,
): string {
  return `NOT EXISTS (
    SELECT 1 FROM session_windows sw
    WHERE sw.uid = ${userCol}
      AND ${tsCol} >= sw.win_start
      AND ${tsCol} <  sw.win_end
  )`;
}

/**
 * Borrow-correction filter for the WAGER side: drops rows where the
 * play was funded by borrow (so the surviving wagers represent only
 * what the user actually paid out of their balance).
 *
 *   • pack_opening:  ledger row's description carries "X% borrowed"
 *     when the open used borrow mode (verified pattern, used in
 *     analytics.ts + dashboard-live.ts). The check matches
 *     "borrow" anywhere in the description so it survives label
 *     drift.
 *   • battle_bet: the linked battle's `borrow_percentage` column is
 *     > 0 when the battle was on borrow. Borrow on a battle is set at
 *     battle-create time and applies to every participant — exclude
 *     the whole battle's wager rows.
 *   • battle_sponsorship: counted DIRECTLY (no borrow gate). Its ledger
 *     rows have `game_session_id = NULL`, so a
 *     `game_session_id IN (non_borrow_battle_sessions)` gate would
 *     silently DROP every sponsorship row (NULL IN (...) → NULL →
 *     excluded) — the bug that made GGR omit sponsorship while the
 *     dashboard wager tile counted it. Verified (owner-confirmed): ALL
 *     sponsored battles have borrow_percentage = 0, so no borrow gate is
 *     needed; sponsorship is real customer wager and is summed directly.
 *   • upgrader_bet: borrow doesn't apply to upgrader plays (no field
 *     on the schema, no convention) so this filter is a no-op for
 *     them — every upgrader row passes.
 *
 * The fragment expects:
 *   • the ledger row alias is `lt` with columns
 *     `type`, `description`, `game_session_id`
 *   • a CTE `non_borrow_battle_sessions(game_session_id)` is in
 *     scope, listing game_session_ids whose battle has
 *     borrow_percentage = 0
 *
 * Returns the AND-clause to append to WHERE.
 */
export const WAGER_NON_BORROW_FILTER = `
  AND (
    (lt.type::text = 'pack_opening' AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%'))
    OR (lt.type::text = 'battle_bet' AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
    OR lt.type::text = 'battle_sponsorship'
    OR (lt.type::text NOT IN ('pack_opening','battle_bet','battle_sponsorship'))
  )
`;

/**
 * Inventory-side mirror of WAGER_NON_BORROW_FILTER — drops cards
 * obtained from a borrow play, so the payout side matches what we
 * counted on the wager side.
 *
 * Expects the alias `ui` with `source_type`, `source_id`. The
 * `non_borrow_pack_sessions` + `non_borrow_battle_sessions` CTEs must
 * be in scope.
 */
export const PAYOUT_NON_BORROW_FILTER = `
  AND (
    (ui.source_type = 'pack' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_pack_sessions))
    OR (ui.source_type = 'battle' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
  )
`;

/**
 * CTE definitions for the borrow exclusion. Inject ahead of the
 * caller's CTEs. Built as plain string fragments because both pack /
 * battle sets are also used as subqueries against the filters above.
 *
 *   • non_borrow_pack_sessions: every game_session_id for a solo
 *     pack open whose ledger row's description doesn't contain
 *     "borrow". The session is the link between the ledger wager row
 *     and the user_inventory payout rows.
 *   • non_borrow_battle_sessions: every battle_participant's
 *     game_session_id whose battle has borrow_percentage = 0.
 */
export const BORROW_FILTER_CTES = `
  non_borrow_pack_sessions AS (
    SELECT game_session_id
    FROM ledger_transactions
    WHERE type::text = 'pack_opening' AND status = 'completed'
      AND game_session_id IS NOT NULL
      AND (description IS NULL OR description NOT ILIKE '%borrow%')
  ),
  non_borrow_battle_sessions AS (
    SELECT bp.game_session_id
    FROM battle_participants bp
    JOIN battles b ON b.id = bp.battle_id
    WHERE COALESCE(b.borrow_percentage, 0) = 0
  )
`;
