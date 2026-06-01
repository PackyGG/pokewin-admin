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
 * Battles profitability — aggregate totals, per-mode breakdown, and
 * top biggest pots / payouts for the selected period.
 *
 * Borrow-funded battles are dropped entirely (mirrors what
 * /analytics/pure-pnl does). Creator-on-stream wagers / payouts also
 * drop via the session_windows CTE.
 *
 * Per mode (1v1, 2v2, ...):
 *   • battles_played — count of distinct battles in the period
 *   • total_pot — sum of (bet_amount × playersTotal) across the
 *     battle. Each participant's bet adds to the pot; mode tells
 *     you the player count.
 *   • borrow_corrected_wager — sum of ABS(battle_bet ledger amounts)
 *     from participants in those battles
 *   • payouts — sum of value_at_obtained for cards delivered from
 *     those battles (filtered to non-borrow, non-creator-stream)
 *   • pnl = borrow_corrected_wager − payouts
 */

export type BattlesPerMode = {
  mode: string;
  battles: number;
  avgPotUsd: number;
  totalWager: number;
  totalPayout: number;
  pnl: number;
  marginPct: number;
};

export type BattleTopRow = {
  battleId: string;
  mode: string;
  playersTotal: number;
  betAmount: number;
  totalPot: number;
  totalPayout: number;
  housePnl: number;
  hitMultiplier: number | null;
  createdAt: string;
};

export type BattlesProfitabilityData = {
  period: GamesPeriod;
  totals: {
    battles: number;
    wager: number;
    payouts: number;
    pnl: number;
    marginPct: number;
    avgBetUsd: number;
  };
  byMode: BattlesPerMode[];
  topBattles: BattleTopRow[];
};

export async function getBattlesProfitability(
  period: GamesPeriod,
): Promise<BattlesProfitabilityData> {
  return withTiming("insights-games.battles", async () => {
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
    const bCutoff =
      hours !== null
        ? `AND b.created_at >= NOW() - INTERVAL '${hours} hours'`
        : "";

    type ModeRow = {
      mode: string;
      battles: string;
      wager: string;
      payouts: string;
      total_pot: string;
    };
    type TopRow = {
      battle_id: string;
      mode: string;
      players_total: string;
      bet_amount: string;
      total_pot: string;
      total_payout: string;
      created_at: Date;
    };

    // Per-mode aggregate:
    //   wager  = sum of ABS(amount) from battle_bet/sponsorship ledger
    //            rows in non-borrow battles, scoped to real customers
    //            and dropping creator on-stream rows.
    //   payout = sum of value_at_obtained for cards from those battles.
    //   pot    = SUM over battles of (bet_amount × playersTotal). One
    //            per battle (DISTINCT battle_id), so summing across
    //            participants would double-count.
    //
    // The top-N pull surfaces both the biggest pots and the biggest
    // payouts in one query — sorted by total payout DESC so the
    // headline list is "biggest realised pots paid out in the
    // period" (matches the user's intuition: "what hits did we
    // suffer this week").
    const [modeRows, topRows] = await Promise.all([
      db.$queryRawUnsafe<ModeRow[]>(
        `WITH ${sessionWindowsCte},
              non_borrow_battles AS (
           SELECT b.id, b.mode, b.bet_amount, b.teams, b.players_per_team
           FROM battles b
           WHERE COALESCE(b.borrow_percentage, 0) = 0
             AND b.status = 'completed'
             ${bCutoff}
         ),
         per_mode_wager AS (
           SELECT nb.mode,
                  COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS wager
           FROM ledger_transactions lt
           JOIN battle_participants bp ON bp.game_session_id = lt.game_session_id
           JOIN non_borrow_battles nb ON nb.id = bp.battle_id
           WHERE lt.type IN ('battle_bet','battle_sponsorship') AND lt.status = 'completed'
             AND lt.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
           GROUP BY nb.mode
         ),
         per_mode_payout AS (
           SELECT nb.mode,
                  COALESCE(SUM(ui.value_at_obtained::numeric), 0) AS payouts
           FROM user_inventory ui
           JOIN battle_participants bp ON bp.game_session_id = ui.source_id
           JOIN non_borrow_battles nb ON nb.id = bp.battle_id
           WHERE ui.source_type = 'battle'
             AND ui.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
           GROUP BY nb.mode
         ),
         per_mode_pot AS (
           SELECT mode,
                  COUNT(*) AS battles,
                  COALESCE(SUM(bet_amount::numeric * (teams * players_per_team)), 0) AS total_pot
           FROM non_borrow_battles
           GROUP BY mode
         )
         SELECT
           p.mode::text AS mode,
           p.battles::text AS battles,
           COALESCE(w.wager, 0)::text AS wager,
           COALESCE(pay.payouts, 0)::text AS payouts,
           p.total_pot::text AS total_pot
         FROM per_mode_pot p
         LEFT JOIN per_mode_wager w ON w.mode = p.mode
         LEFT JOIN per_mode_payout pay ON pay.mode = p.mode
         ORDER BY w.wager DESC NULLS LAST`,
      ),
      db.$queryRawUnsafe<TopRow[]>(
        `WITH ${sessionWindowsCte},
              non_borrow_battles AS (
           SELECT b.id, b.mode, b.bet_amount, b.teams, b.players_per_team, b.created_at
           FROM battles b
           WHERE COALESCE(b.borrow_percentage, 0) = 0
             AND b.status = 'completed'
             ${bCutoff}
         ),
         battle_payout AS (
           SELECT bp.battle_id,
                  COALESCE(SUM(ui.value_at_obtained::numeric), 0) AS total_payout
           FROM user_inventory ui
           JOIN battle_participants bp ON bp.game_session_id = ui.source_id
           WHERE ui.source_type = 'battle'
             AND ui.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
           GROUP BY bp.battle_id
         )
         SELECT
           nb.id::text AS battle_id,
           nb.mode::text AS mode,
           (nb.teams * nb.players_per_team)::text AS players_total,
           nb.bet_amount::text AS bet_amount,
           (nb.bet_amount::numeric * (nb.teams * nb.players_per_team))::text AS total_pot,
           COALESCE(bp.total_payout, 0)::text AS total_payout,
           nb.created_at AS created_at
         FROM non_borrow_battles nb
         LEFT JOIN battle_payout bp ON bp.battle_id = nb.id
         WHERE COALESCE(bp.total_payout, 0) > 0
         ORDER BY bp.total_payout DESC NULLS LAST
         LIMIT 25`,
      ),
    ]);

    let totalBattles = 0;
    let totalWager = 0;
    let totalPayout = 0;
    let totalPotSum = 0;

    const byMode: BattlesPerMode[] = modeRows.map((r) => {
      const battles = Number(r.battles);
      const wager = toNumber(r.wager);
      const payouts = toNumber(r.payouts);
      const totalPot = toNumber(r.total_pot);
      totalBattles += battles;
      totalWager += wager;
      totalPayout += payouts;
      totalPotSum += totalPot;
      const pnl = wager - payouts;
      const marginPct = wager > 0 ? (pnl / wager) * 100 : 0;
      const avgPotUsd = battles > 0 ? totalPot / battles : 0;
      return {
        mode: r.mode,
        battles,
        avgPotUsd,
        totalWager: wager,
        totalPayout: payouts,
        pnl,
        marginPct,
      };
    });

    const topBattles: BattleTopRow[] = topRows.map((r) => {
      const betAmount = toNumber(r.bet_amount);
      const playersTotal = Number(r.players_total);
      const totalPot = toNumber(r.total_pot);
      const totalPayout = toNumber(r.total_payout);
      const housePnl = totalPot - totalPayout;
      // Hit multiplier — per-player POV: what one buy-in walked
      // away with. Matches the `hitMultiplier` definition on the
      // /battles list. Null when bet_amount = 0 (sponsored 100%).
      const hitMultiplier =
        betAmount > 0 ? totalPayout / betAmount : null;
      return {
        battleId: r.battle_id,
        mode: r.mode,
        playersTotal,
        betAmount,
        totalPot,
        totalPayout,
        housePnl,
        hitMultiplier,
        createdAt: r.created_at.toISOString(),
      };
    });

    const totalPnl = totalWager - totalPayout;
    const marginPct = totalWager > 0 ? (totalPnl / totalWager) * 100 : 0;
    const avgBetUsd = totalBattles > 0 ? totalPotSum / totalBattles : 0;

    return {
      period,
      totals: {
        battles: totalBattles,
        wager: totalWager,
        payouts: totalPayout,
        pnl: totalPnl,
        marginPct,
        avgBetUsd,
      },
      byMode,
      topBattles,
    };
  });
}
