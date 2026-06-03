/**
 * gaming-sql.ts — the pure, client-safe SQL FRAGMENT builders for the
 * canonical gaming legs (wager + inventory payout).
 *
 * These are plain string fragments (no DB import, no `server-only`) so
 * BOTH the server-only query builders in `queries.ts` AND the pure
 * `__checks__/run.ts` script can import them. Centralising them here lets
 * the checks assert the two owner-confirmed fixes at the SQL-shape level
 * without running the DB:
 *
 *   • Fix 1 — `battle_sponsorship` is counted as customer WAGER directly,
 *     WITHOUT the `game_session_id IN (non_borrow_battle_sessions)` borrow
 *     gate. Sponsorship ledger rows have `game_session_id = NULL`, so that
 *     gate (NULL IN (...) → NULL → excluded) silently dropped every
 *     sponsorship row — the bug that made GGR omit sponsorship while the
 *     dashboard "Total Wager" tile counted it. All sponsored battles are
 *     `borrow_percentage = 0` (owner-confirmed), so no borrow gate is
 *     needed; `battle_bet` keeps the gate (its battle may be on borrow).
 *
 *   • Fix 2 — reward/daily packs (`packs.pack_type = 'reward'`, price 0)
 *     are EXCLUDED from gaming GGR on BOTH sides. They are $0-wager
 *     real-card giveaways tracked as a reward cost in `/insights/rewards`
 *     (daily-packs.ts); counting their won cards as a gaming payout
 *     double-counts the giveaway and shows the pack as a straight loss.
 *     `pack_opening` rows carry no `pack_type`, so reward packs are
 *     resolved via the `game_type='pack' → packs.pack_type='reward'` join
 *     (the SAME one daily-packs.ts uses) and excluded by
 *     `game_session_id` / `source_id`.
 *
 * SAFETY: every identifier here is a hardcoded SQL literal — no external
 * input is interpolated, so these fragments are injection-free by
 * construction. They are exported as constants/functions, not built from
 * arguments.
 */

// ─── Borrow-exclusion session sets (mirror insights-games/_shared.ts) ─

/**
 * Pack `game_session_id`s whose open was NOT borrow-funded (description
 * does not contain "borrow"). The session links the ledger wager row to
 * the `user_inventory` payout rows.
 */
export const NON_BORROW_PACK_SESSIONS = `(
  SELECT game_session_id FROM ledger_transactions
  WHERE type::text = 'pack_opening' AND status = 'completed'
    AND game_session_id IS NOT NULL
    AND (description IS NULL OR description NOT ILIKE '%borrow%')
)`;

/**
 * Battle-participant `game_session_id`s whose battle has
 * `borrow_percentage = 0` (no borrow). Borrow is set at battle-create time
 * and applies to every participant, so the whole battle's wager rows drop
 * when it is on borrow.
 */
export const NON_BORROW_BATTLE_SESSIONS = `(
  SELECT bp.game_session_id FROM battle_participants bp
  JOIN battles b ON b.id = bp.battle_id
  WHERE COALESCE(b.borrow_percentage, 0) = 0
)`;

// ─── Reward-pack session set (mirror insights-rewards/daily-packs.ts) ─

/**
 * `game_session.id`s for reward/daily-pack opens
 * (`game_type='pack'` → `packs.pack_type='reward'`). Used to drop these
 * $0-wager giveaway opens from BOTH the wager leg (their
 * `game_session_id`) and the won-card inventory leg (their `source_id`,
 * across BOTH `source_type='pack'` AND `'reward'`). See Fix 2 above.
 */
export const REWARD_PACK_SESSIONS = `(
  SELECT gs.id FROM game_sessions gs
  JOIN packs p ON p.id = gs.game_id AND p.pack_type = 'reward'
  WHERE gs.game_type = 'pack'
)`;

// ─── Composed predicate builders ─────────────────────────────────────

/**
 * The canonical WAGER-side borrow/reward predicate for the gaming legs,
 * to AND into a `WHERE status = 'completed' AND type IN (WAGER_TYPES) …`
 * ledger query (unaliased columns: `type`, `description`,
 * `game_session_id`).
 *
 *   • pack_opening   → non-borrow AND not a reward/daily pack (Fix 2)
 *   • battle_bet     → borrow-gated by its `game_session_id`
 *   • battle_sponsorship → counted DIRECTLY, no borrow gate (Fix 1)
 *   • any other type → passes (the `type NOT IN (...)` arm)
 *
 * The `game_session_id IS NULL OR …` guard on the pack arm keeps a
 * NULL-session pack_opening (definitionally not a reward pack — reward
 * opens always spin a session) counted, instead of letting
 * `NULL NOT IN (...)` drop it.
 */
export const WAGER_LEG_FILTER = `(
  type::text NOT IN ('pack_opening','battle_bet','battle_sponsorship')
  OR (type::text = 'pack_opening'
      AND (description IS NULL OR description NOT ILIKE '%borrow%')
      AND (game_session_id IS NULL OR game_session_id NOT IN ${REWARD_PACK_SESSIONS}))
  OR (type::text = 'battle_bet' AND game_session_id IN ${NON_BORROW_BATTLE_SESSIONS})
  OR type::text = 'battle_sponsorship'
)`;

/**
 * The canonical INVENTORY-PAYOUT-side borrow/reward predicate for the
 * gaming legs, to AND into a `WHERE source_type IN ('pack','battle') …`
 * `user_inventory` query (unaliased columns: `source_type`, `source_id`).
 * Non-borrow on both pack and battle, then reward-pack opens excluded
 * (Fix 2) — keyed on `source_id` (the originating `game_session_id`).
 */
export const PAYOUT_LEG_FILTER = `(
  (source_type = 'pack' AND source_id IN ${NON_BORROW_PACK_SESSIONS})
  OR (source_type = 'battle' AND source_id IN ${NON_BORROW_BATTLE_SESSIONS})
) AND (source_id IS NULL OR source_id NOT IN ${REWARD_PACK_SESSIONS})`;
