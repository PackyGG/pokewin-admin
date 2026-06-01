import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getCreatorSessionWindowsCte } from "../creator-session-windows";
import {
  type GamesPeriod,
  hoursForPeriod,
  realCustomersScopeSql,
} from "./_shared";

/**
 * Per-user games leaderboards for the selected period.
 *
 *   • topWagerers    — biggest borrow-corrected wager (what the user
 *                       actually paid out of balance)
 *   • topWinners     — biggest net WIN (payout − wager > 0, ordered
 *                       by net DESC)
 *   • topLosers      — biggest net LOSS (wager − payout > 0,
 *                       ordered by house win DESC)
 *
 * Same scope as the rest of the page: real customers only (no
 * staff, no creators), borrow-funded plays excluded from wager AND
 * payout, creator-on-stream rows excluded both sides.
 *
 * The three leaderboards share one CTE pass — a single per-user
 * wager + payout aggregate — and just sort/filter differently. Caps
 * the LIMIT generously at the SQL boundary so we always have N>25
 * candidates before in-memory filtering.
 */

export type GamesLeaderboardRow = {
  userId: string;
  username: string | null;
  image: string | null;
  wager: number;
  payouts: number;
  pnl: number;
  plays: number;
};

export type GamesTopUsersData = {
  period: GamesPeriod;
  topWagerers: GamesLeaderboardRow[];
  topWinners: GamesLeaderboardRow[];
  topLosers: GamesLeaderboardRow[];
};

export async function getGamesTopUsers(
  period: GamesPeriod,
): Promise<GamesTopUsersData> {
  return withTiming("insights-games.topUsers", async () => {
    const db = await getDb();
    const scope = await realCustomersScopeSql();
    const sessionWindowsCte = await getCreatorSessionWindowsCte();
    const hours = hoursForPeriod(period);

    const ltCutoff =
      hours !== null
        ? `AND lt.created_at >= NOW() - INTERVAL '${hours} hours'`
        : "";
    const uiCutoff =
      hours !== null
        ? `AND ui.obtained_at >= NOW() - INTERVAL '${hours} hours'`
        : "";
    const ugCutoff =
      hours !== null
        ? `AND ug.created_at >= NOW() - INTERVAL '${hours} hours'`
        : "";

    type Row = {
      user_id: string;
      username: string | null;
      image: string | null;
      wager: string;
      payouts: string;
      plays: string;
    };

    // Per-user pass:
    //   wager  = pack/battle ledger amounts (non-borrow,
    //            non-on-stream) + upgrader_games.bet_amount
    //   payout = user_inventory.value_at_obtained from non-borrow
    //            pack/battle opens + upgrader_games.won_amount
    //
    // The two sides are unioned into one CTE keyed by user_id so a
    // single GROUP BY produces the three leaderboards at once.
    // Limited to 100 rows by either wager or |pnl| — caps in-memory
    // sort cost while keeping enough candidates for any of the 25-row
    // leaderboards.
    const rows = await db.$queryRawUnsafe<Row[]>(
      `WITH ${sessionWindowsCte},
            non_borrow_pack_sessions AS (
         SELECT game_session_id FROM ledger_transactions
         WHERE type = 'pack_opening' AND status = 'completed'
           AND game_session_id IS NOT NULL
           AND (description IS NULL OR description NOT ILIKE '%borrow%')
       ),
       non_borrow_battle_sessions AS (
         SELECT bp.game_session_id FROM battle_participants bp
         JOIN battles b ON b.id = bp.battle_id
         WHERE COALESCE(b.borrow_percentage, 0) = 0
       ),
       wager_src AS (
         SELECT lt.user_id,
                ABS(lt.amount::numeric) AS wager,
                0::numeric AS payouts,
                1::int AS play
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
           AND lt.user_id IN ${scope}
           AND (
             (lt.type = 'pack_opening' AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%'))
             OR (lt.type IN ('battle_bet','battle_sponsorship') AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
             OR (lt.type = 'upgrader_bet')
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_windows sw
             WHERE sw.uid = lt.user_id
               AND lt.created_at >= sw.win_start
               AND lt.created_at <  sw.win_end
           )
           ${ltCutoff}
       ),
       inv_payout_src AS (
         SELECT ui.user_id,
                0::numeric AS wager,
                ui.value_at_obtained::numeric AS payouts,
                0::int AS play
         FROM user_inventory ui
         WHERE ui.source_type IN ('pack','battle')
           AND ui.user_id IN ${scope}
           AND (
             (ui.source_type = 'pack' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_pack_sessions))
             OR (ui.source_type = 'battle' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_windows sw
             WHERE sw.uid = ui.user_id
               AND ui.obtained_at >= sw.win_start
               AND ui.obtained_at <  sw.win_end
           )
           ${uiCutoff}
       ),
       upgrader_payout_src AS (
         SELECT ug.user_id,
                0::numeric AS wager,
                ug.won_amount::numeric AS payouts,
                0::int AS play
         FROM upgrader_games ug
         WHERE ug.user_id IN ${scope}
           AND NOT EXISTS (
             SELECT 1 FROM session_windows sw
             WHERE sw.uid = ug.user_id
               AND ug.created_at >= sw.win_start
               AND ug.created_at <  sw.win_end
           )
           ${ugCutoff}
       )
       SELECT
         g.user_id::text AS user_id,
         u.username AS username,
         u.image AS image,
         SUM(g.wager)::text AS wager,
         SUM(g.payouts)::text AS payouts,
         SUM(g.play)::text AS plays
       FROM (
         SELECT * FROM wager_src
         UNION ALL
         SELECT * FROM inv_payout_src
         UNION ALL
         SELECT * FROM upgrader_payout_src
       ) g
       JOIN "user" u ON u.id = g.user_id
       GROUP BY g.user_id, u.username, u.image
       HAVING SUM(g.wager) > 0 OR SUM(g.payouts) > 0
       LIMIT 250`,
    );

    const enriched: GamesLeaderboardRow[] = rows.map((r) => {
      const wager = toNumber(r.wager);
      const payouts = toNumber(r.payouts);
      return {
        userId: r.user_id,
        username: r.username,
        image: r.image,
        wager,
        payouts,
        pnl: wager - payouts,
        plays: Number(r.plays),
      };
    });

    const topWagerers = [...enriched]
      .sort((a, b) => b.wager - a.wager)
      .slice(0, 25);
    // Top winners: user net win = payouts − wager > 0; sorted by
    // user-net DESC so the biggest winners (= biggest house losses)
    // come first.
    const topWinners = [...enriched]
      .filter((r) => r.payouts - r.wager > 0)
      .sort((a, b) => b.payouts - b.wager - (a.payouts - a.wager))
      .slice(0, 25);
    // Top losers: wager − payouts > 0; sorted DESC by house win.
    const topLosers = [...enriched]
      .filter((r) => r.wager - r.payouts > 0)
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 25);

    return {
      period,
      topWagerers,
      topWinners,
      topLosers,
    };
  });
}
