import { queryMainRows } from "@/lib/drizzle-query";
import "server-only";

import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getCreatorSessionWindowsCte } from "../creator-session-windows";
import {
  ggr as ggrFormula,
  empiricalRtp,
  empiricalHouseEdge,
} from "@/lib/metrics/formulas";
import {
  type GamesPeriod,
  periodCutoffSqlCapped,
  realCustomersScopeSql,
} from "./_shared";
import { ratioToPct } from "./_metrics";

/**
 * Per-pack profitability for the selected period.
 *
 * For each pack:
 *   • opens — count of completed pack_opening + battle pack opens
 *     (non-borrow only, real customers, creators-on-stream excluded)
 *   • borrowCorrectedWager — sum of ABS(ledger.amount) for the pack's
 *     opens. This already IS the borrow-corrected figure because the
 *     borrow-funded portion never lands in the ledger row for the
 *     user; on a 90% borrow open the ledger row is the user's $100
 *     paid (not the $1k sticker price), per the spec.
 *   • stickerWager — opens × pack.price (sticker price reference;
 *     surfaces the "headline" exposure for the period).
 *   • payouts — sum of value_at_obtained for the cards delivered
 *     from non-borrow opens of this pack in the period.
 *   • pnl = borrowCorrectedWager − payouts (via the canonical
 *     `@/lib/metrics` GGR helper — no inline arithmetic).
 *   • rtpPct = empirical RTP × 100, and marginPct = empirical house
 *     edge × 100, BOTH from the canonical sample-guarded helpers
 *     (`empiricalRtp` / `empiricalHouseEdge`). A pack with fewer than
 *     `MIN_SAMPLE` opens in the period reports `null` (the UI renders
 *     "n/a — insufficient sample") instead of a small-sample
 *     >100% RTP / negative-edge figure — those were variance, not a
 *     formula bug. `opens` is the bet count fed to the guard.
 *
 * Battle pack opens count too: each battle_participant opens every
 * pack on `battles.pack_ids`. We join through battle_participants →
 * provably_fair_results → ledger_transactions (battle_bet rows) to
 * source the per-pack-per-open wager attribution. The wager amount
 * per battle pack open = battle_bet_amount / number_of_packs_on_battle
 * (each pack on a battle accounts for an equal slice of the bet).
 *
 * Sticker comparison: pack.price × opens. Useful as a "headline
 * exposure" — if a $1k pack was opened 100 times, the headline is
 * $100k even if half were 90% borrow ($50k actually paid).
 */

export type PackProfitRow = {
  packId: string;
  name: string;
  imageUrl: string | null;
  stickerPrice: number;
  opens: number;
  borrowCorrectedWager: number;
  stickerWager: number;
  payouts: number;
  pnl: number;
  /** Empirical RTP % — null below MIN_SAMPLE opens (insufficient sample). */
  rtpPct: number | null;
  /** Empirical house-edge margin % — null below MIN_SAMPLE opens. */
  marginPct: number | null;
};

export type PacksProfitabilityData = {
  period: GamesPeriod;
  packs: PackProfitRow[];
};

export async function getPacksProfitability(
  period: GamesPeriod,
): Promise<PacksProfitabilityData> {
  return withTiming("insights-games.packs", async () => {
    const scope = await realCustomersScopeSql();
    const sessionWindowsCte = await getCreatorSessionWindowsCte();

    // Lifetime (`all`) capped to 365d via periodCutoffSqlCapped so the
    // per-pack ledger + inventory scan never runs unbounded (CLAUDE.md
    // "Performance & Daten-Laden"). Finite windows are unchanged.
    const ltCutoff = periodCutoffSqlCapped("lt.created_at", period);
    const uiCutoff = periodCutoffSqlCapped("ui.obtained_at", period);

    type Row = {
      pack_id: string;
      name: string;
      image_url: string | null;
      price: string;
      opens: string;
      borrow_corrected_wager: string;
      sticker_wager: string;
      payouts: string;
    };

    // The SQL fans across the three contributing sources:
    //   • solo_opens   — game_sessions with game_type='pack', joined
    //                    to the bet ledger row for the wager value
    //   • battle_opens — for each battle: pack_ids unnested per
    //                    participant, joined to the battle_bet ledger
    //                    row to source the wager (split evenly across
    //                    the packs on the battle)
    //   • payouts      — user_inventory rows from non-borrow plays
    //                    that came out of the pack
    //
    // All three use the creator-on-stream session_windows CTE to
    // drop creator stream plays from BOTH the wager and payout
    // sides. Pack id is the natural join key — `solo_opens.pack_id`
    // is `game_sessions.game_id`; `battle_opens.pack_id` is the
    // UNNESTed `battles.pack_ids` element; `payouts.pack_id` is the
    // joined-through `game_sessions.game_id` (and for battle opens,
    // the battle's pack list).
    const rows = await queryMainRows<Row[]>(
      `WITH ${sessionWindowsCte},
            solo_opens AS (
        -- Solo pack opens: one row per ledger pack_opening tx, joined
        -- to game_sessions so we know which pack id. Borrow-funded
        -- opens (description ILIKE '%borrow%') drop here so the
        -- wager/payout figures match. The ledger amount is the user's
        -- ACTUAL paid amount (the borrow leg never gets billed
        -- through the ledger).
        SELECT
          gs.game_id AS pack_id,
          COUNT(*) AS opens,
          COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS wager_paid
        FROM ledger_transactions lt
        JOIN game_sessions gs ON gs.id = lt.game_session_id AND gs.game_type = 'pack'
        WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed'
          AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
          AND lt.user_id IN ${scope}
          AND NOT EXISTS (
            SELECT 1 FROM session_windows sw
            WHERE sw.uid = lt.user_id
              AND lt.created_at >= sw.win_start
              AND lt.created_at <  sw.win_end
          )
          ${ltCutoff}
        GROUP BY gs.game_id
      ),
      battle_opens AS (
        -- Battle pack opens: for each (battle_participant × battle's
        -- pack_ids element). The wager is the participant's battle_bet
        -- ledger row, split evenly across the packs on the battle (a
        -- 2-pack battle = half the bet per pack). Only non-borrow
        -- battles count.
        SELECT
          pid::uuid AS pack_id,
          COUNT(*) AS opens,
          COALESCE(SUM(ABS(lt.amount::numeric) / GREATEST(array_length(b.pack_ids, 1), 1)), 0) AS wager_paid
        FROM ledger_transactions lt
        JOIN battle_participants bp ON bp.game_session_id = lt.game_session_id
        JOIN battles b ON b.id = bp.battle_id
        CROSS JOIN LATERAL UNNEST(b.pack_ids::uuid[]) AS pid
        WHERE lt.type::text IN ('battle_bet','battle_sponsorship') AND lt.status = 'completed'
          AND COALESCE(b.borrow_percentage, 0) = 0
          AND lt.user_id IN ${scope}
          AND NOT EXISTS (
            SELECT 1 FROM session_windows sw
            WHERE sw.uid = lt.user_id
              AND lt.created_at >= sw.win_start
              AND lt.created_at <  sw.win_end
          )
          ${ltCutoff}
        GROUP BY pid
      ),
      pack_opens AS (
        SELECT pack_id, SUM(opens) AS opens, SUM(wager_paid) AS wager_paid
        FROM (SELECT * FROM solo_opens UNION ALL SELECT * FROM battle_opens) x
        GROUP BY pack_id
      ),
      solo_payouts AS (
        -- Cards delivered from non-borrow solo opens. user_inventory
        -- source_type='pack' + source_id is the originating
        -- game_session_id. Join to game_sessions to map to pack id,
        -- then filter to non-borrow + non-session as on the wager
        -- side.
        SELECT gs.game_id AS pack_id,
               COALESCE(SUM(ui.value_at_obtained::numeric), 0) AS payouts
        FROM user_inventory ui
        JOIN game_sessions gs ON gs.id = ui.source_id AND gs.game_type = 'pack'
        WHERE ui.source_type = 'pack'
          AND ui.user_id IN ${scope}
          AND ui.source_id IN (
            SELECT lt.game_session_id FROM ledger_transactions lt
            WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed'
              AND lt.game_session_id IS NOT NULL
              AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
          )
          AND NOT EXISTS (
            SELECT 1 FROM session_windows sw
            WHERE sw.uid = ui.user_id
              AND ui.obtained_at >= sw.win_start
              AND ui.obtained_at <  sw.win_end
          )
          ${uiCutoff}
        GROUP BY gs.game_id
      ),
      battle_payouts AS (
        -- Cards from non-borrow battle opens: source_id is the
        -- participant's game_session_id; map to battle_id via
        -- battle_participants, then to the battle's pack_ids via
        -- UNNEST. value split equally across the packs on the
        -- battle (matches the wager split convention).
        SELECT pid::uuid AS pack_id,
               COALESCE(SUM(ui.value_at_obtained::numeric / GREATEST(array_length(b.pack_ids, 1), 1)), 0) AS payouts
        FROM user_inventory ui
        JOIN battle_participants bp ON bp.game_session_id = ui.source_id
        JOIN battles b ON b.id = bp.battle_id
        CROSS JOIN LATERAL UNNEST(b.pack_ids::uuid[]) AS pid
        WHERE ui.source_type = 'battle'
          AND ui.user_id IN ${scope}
          AND COALESCE(b.borrow_percentage, 0) = 0
          AND NOT EXISTS (
            SELECT 1 FROM session_windows sw
            WHERE sw.uid = ui.user_id
              AND ui.obtained_at >= sw.win_start
              AND ui.obtained_at <  sw.win_end
          )
          ${uiCutoff}
        GROUP BY pid
      ),
      pack_payouts AS (
        SELECT pack_id, SUM(payouts) AS payouts
        FROM (SELECT * FROM solo_payouts UNION ALL SELECT * FROM battle_payouts) x
        GROUP BY pack_id
      )
      SELECT
        p.id::text AS pack_id,
        p.name AS name,
        p.image_url AS image_url,
        p.price::text AS price,
        COALESCE(po.opens, 0)::text AS opens,
        COALESCE(po.wager_paid, 0)::text AS borrow_corrected_wager,
        (COALESCE(po.opens, 0) * p.price)::text AS sticker_wager,
        COALESCE(pp.payouts, 0)::text AS payouts
      FROM packs p
      LEFT JOIN pack_opens po ON po.pack_id = p.id
      LEFT JOIN pack_payouts pp ON pp.pack_id = p.id
      WHERE p.pack_type <> 'reward'
        AND COALESCE(po.opens, 0) > 0
      ORDER BY COALESCE(po.wager_paid, 0) DESC
      LIMIT 50`,
    );

    const packs: PackProfitRow[] = rows.map((r) => {
      const opens = Number(r.opens);
      const borrowCorrectedWager = toNumber(r.borrow_corrected_wager);
      const stickerWager = toNumber(r.sticker_wager);
      const payouts = toNumber(r.payouts);
      // GGR + sample-guarded empirical RTP / edge from the canonical
      // metric layer. `opens` is the per-pack bet count; below
      // MIN_SAMPLE the helpers return null so a lucky/unlucky thin
      // period renders the insufficient-sample sentinel, not a fake
      // >100% RTP / negative edge.
      const pnl = ggrFormula({
        wager: borrowCorrectedWager,
        gamingPayout: payouts,
      });
      const rtpPct = ratioToPct(
        empiricalRtp({
          gamingPayout: payouts,
          wager: borrowCorrectedWager,
          bets: opens,
        }),
      );
      const marginPct = ratioToPct(
        empiricalHouseEdge({
          wager: borrowCorrectedWager,
          ggr: pnl,
          bets: opens,
        }),
      );
      return {
        packId: r.pack_id,
        name: r.name,
        imageUrl: r.image_url,
        stickerPrice: toNumber(r.price),
        opens,
        borrowCorrectedWager,
        stickerWager,
        payouts,
        pnl,
        rtpPct,
        marginPct,
      };
    });

    return { period, packs };
  });
}
