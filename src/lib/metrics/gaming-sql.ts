/**
 * gaming-sql.ts — the pure, client-safe SQL FRAGMENT builders for the
 * canonical gaming legs (wager + inventory payout).
 *
 * These are plain string fragments (no DB import, no `server-only`) so
 * BOTH the server-only query builders in `queries.ts` AND the pure
 * `__checks__/run.ts` script can import them. Centralising them here lets
 * the checks assert the canonical leg shape at the SQL level without
 * running the DB.
 *
 * ── Borrow-net-INCLUSIVE basis (owner decision, 2026-06-13) ──
 *
 * Borrow plays are COUNTED at their REAL (non-borrowed) net cash on BOTH
 * sides — they are NOT dropped. This is the owner-locked basis and the one
 * that makes the headline GGR strongly positive (≈ +$513K) instead of the
 * impossible −$73K the old borrow-DROP basis produced.
 *
 * Why borrow-DROP was wrong: `battle_bet`'s ledger `amount` is ALREADY
 * booked NET of borrow (a $88.74 bet at 90% borrow records $8.87), and a
 * borrow battle's winnings are ALSO net — `user_inventory.value_at_obtained`
 * plus `battle_excess_to_voucher.amount` (its metadata `expected_value` =
 * card value + voucher value = the winner's net winnings). The old basis
 * dropped borrow plays from the WAGER leg and the won-CARD (inventory) leg,
 * but the ledger GAMING_PAYOUT legs (`battle_refund` and especially
 * `battle_excess_to_voucher`, 91% of which comes from borrow battles) are
 * summed UNCONDITIONALLY (`battle_excess_to_voucher` rows have no
 * `game_session_id`, so they could not be borrow-filtered the same way).
 * That asymmetry counted borrow-battle winnings with no matching wager →
 * BATTLES showed RTP 159% (impossible). Counting the net-cash wager on both
 * sides removes the asymmetry: each leg now agrees with the unconditional
 * GAMING_PAYOUT legs, and "only the non-borrowed portion counts" holds
 * (`battle_bet` IS that non-borrowed portion).
 *
 * The ONE remaining exclusion on both sides:
 *
 *   • Reward/daily packs (`packs.pack_type = 'reward'`, price 0) are
 *     EXCLUDED from gaming GGR on BOTH sides. They are $0-wager real-card
 *     giveaways tracked as a reward cost in `/insights/rewards`
 *     (daily-packs.ts); counting their won cards as a gaming payout
 *     double-counts the giveaway and shows the pack as a straight loss.
 *     `pack_opening` rows carry no `pack_type`, so reward packs are
 *     resolved via the `game_type='pack' → packs.pack_type='reward'` join
 *     (the SAME one daily-packs.ts uses) and excluded by
 *     `game_session_id` / `source_id`.
 *
 *   • `battle_sponsorship` is still counted as customer WAGER directly (a
 *     bare OR arm). Sponsorship ledger rows have `game_session_id = NULL`,
 *     and all sponsored battles are `borrow_percentage = 0`.
 *
 * NOTE: the `/ggr` borrow tab analyses borrow vs non-borrow explicitly via
 * its OWN fragments (`insights-games/_shared.ts` `BORROW_FILTER_CTES`) —
 * that is a separate, intentional analysis and is NOT affected by this
 * headline-leg basis.
 *
 * SAFETY: every identifier here is a hardcoded SQL literal — no external
 * input is interpolated, so these fragments are injection-free by
 * construction. They are exported as constants/functions, not built from
 * arguments.
 */

// ─── Borrow-exclusion session sets (mirror insights-games/_shared.ts) ─
//
// RETAINED for OTHER consumers (e.g. `insights/edge-plan-2/_baseline-v2.ts`)
// that model borrow vs non-borrow explicitly. The CANONICAL metrics-layer
// legs below (`WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER`) no longer reference
// these — borrow plays are counted at their net cash (owner decision, see
// the file header), so the headline legs only exclude reward/daily packs.

/**
 * Pack `game_session_id`s whose open was NOT borrow-funded (description
 * does not contain "borrow"). The session links the ledger wager row to
 * the `user_inventory` payout rows.
 */
const NON_BORROW_PACK_SESSIONS = `(
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
const NON_BORROW_BATTLE_SESSIONS = `(
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
const REWARD_PACK_SESSIONS = `(
  SELECT gs.id FROM game_sessions gs
  JOIN packs p ON p.id = gs.game_id AND p.pack_type = 'reward'
  WHERE gs.game_type = 'pack'
)`;

// ─── Composed predicate builders ─────────────────────────────────────

/**
 * The canonical WAGER-side predicate for the gaming legs, to AND into a
 * `WHERE status = 'completed' AND type IN (WAGER_TYPES) …` ledger query
 * (unaliased columns: `type`, `game_session_id`).
 *
 * Borrow-net-INCLUSIVE (owner decision — see the file header): borrow plays
 * are counted at their net cash, so there is NO borrow gate on either
 * gaming wager arm. The only exclusion is reward/daily packs.
 *
 *   • pack_opening       → counted unless it is a reward/daily pack
 *   • battle_bet         → counted UNCONDITIONALLY (its `amount` is already
 *                          net of borrow; the borrow gate is removed)
 *   • battle_sponsorship → counted DIRECTLY (bare OR arm; its
 *                          `game_session_id` is NULL, all sponsored battles
 *                          are borrow_percentage=0)
 *   • any other type     → passes (the `type NOT IN (...)` arm)
 *
 * The `game_session_id IS NULL OR …` guard on the pack arm keeps a
 * NULL-session pack_opening (definitionally not a reward pack — reward
 * opens always spin a session) counted, instead of letting
 * `NULL NOT IN (...)` drop it.
 */
export const WAGER_LEG_FILTER = `(
  type::text NOT IN ('pack_opening','battle_bet','battle_sponsorship')
  OR (type::text = 'pack_opening'
      AND (game_session_id IS NULL OR game_session_id NOT IN ${REWARD_PACK_SESSIONS}))
  OR type::text = 'battle_bet'
  OR type::text = 'battle_sponsorship'
)`;

/**
 * The canonical INVENTORY-PAYOUT-side predicate for the gaming legs, to
 * AND into a `WHERE source_type IN ('pack','battle') …` `user_inventory`
 * query (unaliased columns: `source_type`, `source_id`).
 *
 * Borrow-net-INCLUSIVE (owner decision — see the file header): borrow-won
 * cards are kept (their `value_at_obtained` is the net card value), so
 * there is NO borrow gate. The only exclusion is reward/daily-pack won
 * cards — keyed on `source_id` (the originating `game_session_id`), AND'd
 * across BOTH source types so the 'pack'-typed reward cards are caught.
 */
export const PAYOUT_LEG_FILTER = `(
  source_type IN ('pack','battle')
) AND (source_id IS NULL OR source_id NOT IN ${REWARD_PACK_SESSIONS})`;
