import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getCreatorSessionWindowsCte } from "../creator-session-windows";
import {
  type GamesPeriod,
  hoursForPeriod,
  realCustomersScopeSql,
  BORROW_FILTER_CTES,
} from "./_shared";

/**
 * Headline KPIs for /insights/games — aggregate across packs +
 * battles + upgrader for the selected period.
 *
 * Wager side:
 *   • pack_opening / battle_bet / battle_sponsorship → only rows
 *     from non-borrow plays count. Borrowed-cost portion is excluded
 *     because it never came out of the user's actual balance (it's
 *     house exposure, auto-resold back to the house).
 *   • upgrader_bet → always counts (no borrow concept on upgrader).
 *
 * Payout side:
 *   • Cards delivered from non-borrow pack/battle opens — the
 *     `value_at_obtained` is the realised value at the moment the
 *     row entered inventory (already net of any borrow auto-resale).
 *   • Upgrader payouts — `upgrader_games.won_amount` (gross payout
 *     on a win, 0 on a loss).
 *
 * Both sides drop wagers/payouts a creator made while live on a
 * deal/stream. Plus the real-customers scope (no admin/support/creator
 * blacklist).
 *
 * Day-bucketed time-series of the same wager / payout / pnl, so the
 * Overview tab can render a recharts chart of how the day progressed.
 */

export type GamesOverviewKpis = {
  totalWager: number;
  totalPayout: number;
  housePnl: number;
  rtpPct: number; // payout / wager * 100
  housePnlMarginPct: number; // pnl / wager * 100
  activeUsers: number;
  totalPlays: number;
  packPnl: number;
  battlePnl: number;
  upgraderPnl: number;
  packWager: number;
  battleWager: number;
  upgraderWager: number;
  packPayout: number;
  battlePayout: number;
  upgraderPayout: number;
};

export type GamesOverviewTimePoint = {
  /** ISO date / hour bucket — "YYYY-MM-DD" for day buckets, "YYYY-MM-DDTHH" for hour buckets */
  bucket: string;
  wager: number;
  payout: number;
  pnl: number;
};

export type GamesOverviewData = {
  period: GamesPeriod;
  kpis: GamesOverviewKpis;
  series: GamesOverviewTimePoint[];
  /** True when the period is short enough that we bucket by hour. */
  bucketByHour: boolean;
};

export async function getGamesOverview(
  period: GamesPeriod,
): Promise<GamesOverviewData> {
  return withTiming("insights-games.overview", async () => {
    const db = await getDb();
    const scope = await realCustomersScopeSql();
    const sessionWindowsCte = await getCreatorSessionWindowsCte();
    const hours = hoursForPeriod(period);
    const bucketByHour = period === "24h";

    // Time predicates — applied both to filter the window and to
    // bucket the series. Held in variables so the four parallel
    // queries below stay in sync.
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

    // Series buckets — hour granularity for 24h so the chart shows
    // a real 24-point hourly curve; date granularity for everything
    // else.
    const seriesBucketExpr = bucketByHour
      ? "DATE_TRUNC('hour', src.ts)::text"
      : "DATE(src.ts)::text";

    type KpiRow = {
      pack_wager: string;
      battle_wager: string;
      upgrader_wager: string;
      active_users: string;
      total_plays: string;
    };
    type PayoutRow = {
      pack_payout: string;
      battle_payout: string;
      upgrader_payout: string;
    };
    type SeriesRow = { bucket: string; wager: string; payout: string };

    // Two parallel queries: KPI aggregate + day/hour buckets for the
    // chart. Both use the same scope + borrow filters so the totals
    // and the chart agree.
    //
    // The session_windows CTE comes from getCreatorSessionWindowsCte
    // (cached for 5 minutes — same as dashboard) and is appended in
    // front of every WITH so creator-on-stream rows drop on both
    // wager and payout sides.
    const [wagerRows, payoutRows, packBattleSeries, upgraderSeries] =
      await Promise.all([
        // ── Wager side (KPIs) ──
        db.$queryRawUnsafe<KpiRow[]>(
          `WITH ${sessionWindowsCte},
                ${BORROW_FILTER_CTES}
           SELECT
             COALESCE(SUM(CASE
               WHEN lt.type = 'pack_opening'
                    AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
                    AND NOT EXISTS (
                      SELECT 1 FROM session_windows sw
                      WHERE sw.uid = lt.user_id
                        AND lt.created_at >= sw.win_start
                        AND lt.created_at <  sw.win_end
                    )
               THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
             COALESCE(SUM(CASE
               WHEN lt.type IN ('battle_bet','battle_sponsorship')
                    AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions)
                    AND NOT EXISTS (
                      SELECT 1 FROM session_windows sw
                      WHERE sw.uid = lt.user_id
                        AND lt.created_at >= sw.win_start
                        AND lt.created_at <  sw.win_end
                    )
               THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS battle_wager,
             COALESCE(SUM(CASE
               WHEN lt.type = 'upgrader_bet'
                    AND NOT EXISTS (
                      SELECT 1 FROM session_windows sw
                      WHERE sw.uid = lt.user_id
                        AND lt.created_at >= sw.win_start
                        AND lt.created_at <  sw.win_end
                    )
               THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS upgrader_wager,
             COUNT(DISTINCT lt.user_id)::text AS active_users,
             COUNT(*)::text AS total_plays
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
             AND lt.user_id IN ${scope}
             ${ltCutoff}`,
        ),
        // ── Payout side (KPIs) ──
        // packs + battles: inventory rows from non-borrow sessions
        // (the borrowed portion is already auto-resold so
        // value_at_obtained is net keep). upgrader: won_amount.
        db.$queryRawUnsafe<PayoutRow[]>(
          `WITH ${sessionWindowsCte},
                ${BORROW_FILTER_CTES}
           SELECT
             (
               SELECT COALESCE(SUM(ui.value_at_obtained::numeric), 0)::text
               FROM user_inventory ui
               WHERE ui.source_type = 'pack'
                 AND ui.source_id IN (SELECT game_session_id FROM non_borrow_pack_sessions)
                 AND ui.user_id IN ${scope}
                 AND NOT EXISTS (
                   SELECT 1 FROM session_windows sw
                   WHERE sw.uid = ui.user_id
                     AND ui.obtained_at >= sw.win_start
                     AND ui.obtained_at <  sw.win_end
                 )
                 ${uiCutoff}
             ) AS pack_payout,
             (
               SELECT COALESCE(SUM(ui.value_at_obtained::numeric), 0)::text
               FROM user_inventory ui
               WHERE ui.source_type = 'battle'
                 AND ui.source_id IN (SELECT game_session_id FROM non_borrow_battle_sessions)
                 AND ui.user_id IN ${scope}
                 AND NOT EXISTS (
                   SELECT 1 FROM session_windows sw
                   WHERE sw.uid = ui.user_id
                     AND ui.obtained_at >= sw.win_start
                     AND ui.obtained_at <  sw.win_end
                 )
                 ${uiCutoff}
             ) AS battle_payout,
             (
               SELECT COALESCE(SUM(ug.won_amount::numeric), 0)::text
               FROM upgrader_games ug
               WHERE ug.user_id IN ${scope}
                 AND NOT EXISTS (
                   SELECT 1 FROM session_windows sw
                   WHERE sw.uid = ug.user_id
                     AND ug.created_at >= sw.win_start
                     AND ug.created_at <  sw.win_end
                 )
                 ${ugCutoff}
             ) AS upgrader_payout`,
        ),
        // ── Series: pack + battle wagers and payouts ──
        db.$queryRawUnsafe<SeriesRow[]>(
          `WITH ${sessionWindowsCte},
                ${BORROW_FILTER_CTES},
                wager_src AS (
             SELECT lt.created_at AS ts,
                    ABS(lt.amount::numeric) AS wager,
                    0::numeric AS payout
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
           payout_src AS (
             SELECT ui.obtained_at AS ts,
                    0::numeric AS wager,
                    ui.value_at_obtained::numeric AS payout
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
           )
           SELECT ${seriesBucketExpr} AS bucket,
                  COALESCE(SUM(src.wager), 0)::text AS wager,
                  COALESCE(SUM(src.payout), 0)::text AS payout
           FROM (SELECT * FROM wager_src UNION ALL SELECT * FROM payout_src) src
           GROUP BY ${seriesBucketExpr}
           ORDER BY 1`,
        ),
        // ── Series: upgrader (separate so we can union into series) ──
        db.$queryRawUnsafe<SeriesRow[]>(
          `WITH ${sessionWindowsCte},
                src AS (
             SELECT ug.created_at AS ts,
                    ug.bet_amount::numeric AS wager,
                    ug.won_amount::numeric AS payout
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
           SELECT ${seriesBucketExpr} AS bucket,
                  COALESCE(SUM(src.wager), 0)::text AS wager,
                  COALESCE(SUM(src.payout), 0)::text AS payout
           FROM src
           GROUP BY ${seriesBucketExpr}
           ORDER BY 1`,
        ),
      ]);

    const wagerRow = wagerRows[0];
    const payoutRow = payoutRows[0];

    // Note: `total_plays` is the count of WAGER ledger rows (one per
    // pack open / battle wager / upgrader bet) within the period and
    // scope. Battle plays count each participant's bet (not the
    // battle as a single play) which matches how packs/upgrader count
    // (one wager row = one play).
    const packWager = toNumber(wagerRow?.pack_wager);
    const battleWager = toNumber(wagerRow?.battle_wager);
    const upgraderWager = toNumber(wagerRow?.upgrader_wager);
    const packPayout = toNumber(payoutRow?.pack_payout);
    const battlePayout = toNumber(payoutRow?.battle_payout);
    const upgraderPayout = toNumber(payoutRow?.upgrader_payout);

    const totalWager = packWager + battleWager + upgraderWager;
    const totalPayout = packPayout + battlePayout + upgraderPayout;
    const housePnl = totalWager - totalPayout;
    const rtpPct = totalWager > 0 ? (totalPayout / totalWager) * 100 : 0;
    const housePnlMarginPct =
      totalWager > 0 ? (housePnl / totalWager) * 100 : 0;

    // Combine series buckets. packBattleSeries already has both
    // wager and payout rolled in; we just merge upgrader into the
    // same bucket map by bucket key (so a single time-bucket row
    // surfaces the combined wager / payout / pnl).
    const seriesMap = new Map<string, { wager: number; payout: number }>();
    const merge = (rows: SeriesRow[]) => {
      for (const r of rows) {
        const existing = seriesMap.get(r.bucket);
        const w = toNumber(r.wager);
        const p = toNumber(r.payout);
        if (existing) {
          existing.wager += w;
          existing.payout += p;
        } else {
          seriesMap.set(r.bucket, { wager: w, payout: p });
        }
      }
    };
    merge(packBattleSeries);
    merge(upgraderSeries);

    const series: GamesOverviewTimePoint[] = [...seriesMap.entries()]
      .map(([bucket, agg]) => ({
        bucket,
        wager: agg.wager,
        payout: agg.payout,
        pnl: agg.wager - agg.payout,
      }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));

    return {
      period,
      bucketByHour,
      kpis: {
        totalWager,
        totalPayout,
        housePnl,
        rtpPct,
        housePnlMarginPct,
        activeUsers: Number(wagerRow?.active_users ?? "0"),
        totalPlays: Number(wagerRow?.total_plays ?? "0"),
        packPnl: packWager - packPayout,
        battlePnl: battleWager - battlePayout,
        upgraderPnl: upgraderWager - upgraderPayout,
        packWager,
        battleWager,
        upgraderWager,
        packPayout,
        battlePayout,
        upgraderPayout,
      },
      series,
    };
  });
}
