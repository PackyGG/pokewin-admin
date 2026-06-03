import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getCreatorSessionWindowsCte } from "../creator-session-windows";
import {
  ggr as ggrFormula,
  empiricalRtp,
  empiricalHouseEdge,
  type EmpiricalRatio,
} from "@/lib/metrics/formulas";
import {
  type GamesPeriod,
  periodCutoffSqlCapped,
  realCustomersScopeSql,
  BORROW_FILTER_CTES,
} from "./_shared";
import { REWARD_PACK_SESSIONS } from "@/lib/metrics/gaming-sql";
import { ratioToPct } from "./_metrics";

/**
 * Headline KPIs for /insights/games — aggregate across packs +
 * battles + upgrader for the selected period.
 *
 * Wager side (CANONICAL gaming legs — agrees with @/lib/metrics):
 *   • pack_opening → only NON-BORROW opens count, AND reward/daily packs
 *     (`packs.pack_type='reward'`, ≈$0) are EXCLUDED — they are a house
 *     giveaway tracked in /insights/rewards (daily-packs.ts), not gaming.
 *     The reward-pack session set is the shared `REWARD_PACK_SESSIONS`
 *     predicate from `@/lib/metrics/gaming-sql` (same join daily-packs.ts
 *     uses) so this surface drops the exact same opens.
 *   • battle_bet → borrow-gated by its game_session (borrowed battles
 *     drop on both wager + payout sides).
 *   • battle_sponsorship → counted DIRECTLY, with NO borrow gate. Its
 *     ledger rows have `game_session_id = NULL`, so the
 *     `game_session_id IN (non_borrow_battle_sessions)` gate silently
 *     DROPPED every sponsorship row (NULL IN (...) → NULL → excluded) —
 *     the bug that made the headline GGR omit sponsorship while the
 *     dashboard "Total Wager" tile counted it. All sponsored battles are
 *     `borrow_percentage = 0` (owner-confirmed), so no gate is needed.
 *   • upgrader → `upgrader_games.bet_amount`. Upgrader is NOT booked to
 *     the ledger (the canonical `UPGRADER_IN_LEDGER` switch is `false`):
 *     `upgrader_bet` / `upgrader_payout` ledger rows are not written by
 *     prod, so BOTH the wager and the payout come from `upgrader_games`
 *     (verified source of truth). No borrow concept on upgrader.
 *
 * Payout side:
 *   • Cards delivered from non-borrow pack/battle opens — the
 *     `value_at_obtained` is the realised value at the moment the
 *     row entered inventory (already net of any borrow auto-resale).
 *   • Upgrader payouts — `upgrader_games.won_amount` (gross payout
 *     on a win, 0 on a loss).
 *
 * GGR / RTP / house-edge are NOT computed inline here — they route
 * through the canonical `@/lib/metrics/formulas` helpers (`ggr`,
 * `empiricalRtp`, `empiricalHouseEdge`) so this surface agrees with
 * every other metric surface by construction. The empirical RTP / edge
 * carry the canonical `MIN_SAMPLE` guard (rendered as `null` below the
 * threshold) — the headline aggregate clears it in any real period, but
 * routing it through the same helper keeps the contract uniform.
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
  /** Empirical RTP % (payout / wager × 100), or null below MIN_SAMPLE. */
  rtpPct: number | null;
  /** Empirical house-edge margin % (pnl / wager × 100), or null below MIN_SAMPLE. */
  housePnlMarginPct: number | null;
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
  /** Per-product empirical RTP % (sample-guarded → null below MIN_SAMPLE). */
  packRtpPct: number | null;
  battleRtpPct: number | null;
  upgraderRtpPct: number | null;
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
    const bucketByHour = period === "24h";

    // Time predicates — applied both to filter the window and to
    // bucket the series. Held in variables so the four parallel
    // queries below stay in sync.
    //
    // Lifetime (`all`) is CAPPED to GAMES_LIFETIME_LOOKBACK_HOURS (365d)
    // via periodCutoffSqlCapped so the heavy ledger / inventory /
    // upgrader scans never run unbounded (CLAUDE.md "Performance &
    // Daten-Laden" — Lifetime-Fenster bounden). Finite windows are
    // unchanged.
    const ltCutoff = periodCutoffSqlCapped("lt.created_at", period);
    const uiCutoff = periodCutoffSqlCapped("ui.obtained_at", period);
    const ugCutoff = periodCutoffSqlCapped("ug.created_at", period);

    // Series buckets — hour granularity for 24h so the chart shows
    // a real 24-point hourly curve; date granularity for everything
    // else.
    const seriesBucketExpr = bucketByHour
      ? "DATE_TRUNC('hour', src.ts)::text"
      : "DATE(src.ts)::text";

    // Pack/battle wager KPIs come from the ledger; the upgrader leg is
    // sourced from `upgrader_games` (canonical: upgrader is not on the
    // ledger). `pack_plays` / `battle_plays` are the ledger wager-row
    // counts; the upgrader play count comes from `upgrader_games`. The
    // distinct active-customer count is taken from a UNION of both
    // sources (separate query) so a user who plays both products is
    // counted exactly once.
    type KpiRow = {
      pack_wager: string;
      battle_wager: string;
      pack_plays: string;
      battle_plays: string;
    };
    type PayoutRow = {
      pack_payout: string;
      battle_payout: string;
      upgrader_wager: string;
      upgrader_payout: string;
      upgrader_plays: string;
    };
    type ActiveUsersRow = { active_users: string };
    type SeriesRow = { bucket: string; wager: string; payout: string };

    // Two parallel queries: KPI aggregate + day/hour buckets for the
    // chart. Both use the same scope + borrow filters so the totals
    // and the chart agree.
    //
    // The session_windows CTE comes from getCreatorSessionWindowsCte
    // (cached for 5 minutes — same as dashboard) and is appended in
    // front of every WITH so creator-on-stream rows drop on both
    // wager and payout sides.
    const [wagerRows, payoutRows, activeUsersRows, packBattleSeries, upgraderSeries] =
      await Promise.all([
        // ── Wager side (KPIs) — pack + battle only (upgrader is sourced
        //    from upgrader_games in the payout query below) ──
        db.$queryRawUnsafe<KpiRow[]>(
          `WITH ${sessionWindowsCte},
                ${BORROW_FILTER_CTES}
           SELECT
             COALESCE(SUM(CASE
               WHEN lt.type::text = 'pack_opening'
                    AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
                    AND (lt.game_session_id IS NULL OR lt.game_session_id NOT IN ${REWARD_PACK_SESSIONS})
                    AND NOT EXISTS (
                      SELECT 1 FROM session_windows sw
                      WHERE sw.uid = lt.user_id
                        AND lt.created_at >= sw.win_start
                        AND lt.created_at <  sw.win_end
                    )
               THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
             COALESCE(SUM(CASE
               WHEN (
                      (lt.type::text = 'battle_bet'
                       AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
                      OR lt.type::text = 'battle_sponsorship'
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM session_windows sw
                      WHERE sw.uid = lt.user_id
                        AND lt.created_at >= sw.win_start
                        AND lt.created_at <  sw.win_end
                    )
               THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS battle_wager,
             COALESCE(SUM(CASE
               WHEN lt.type::text = 'pack_opening'
                    AND (lt.game_session_id IS NULL OR lt.game_session_id NOT IN ${REWARD_PACK_SESSIONS})
               THEN 1 ELSE 0 END), 0)::text AS pack_plays,
             COALESCE(SUM(CASE WHEN lt.type::text IN ('battle_bet','battle_sponsorship') THEN 1 ELSE 0 END), 0)::text AS battle_plays
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship')
             AND lt.user_id IN ${scope}
             ${ltCutoff}`,
        ),
        // ── Payout side (KPIs) ──
        // packs + battles: inventory rows from non-borrow sessions
        // (the borrowed portion is already auto-resold so
        // value_at_obtained is net keep). upgrader: bet_amount +
        // won_amount + play count from `upgrader_games` (the canonical
        // upgrader source — it is NOT booked to the ledger).
        db.$queryRawUnsafe<PayoutRow[]>(
          `WITH ${sessionWindowsCte},
                ${BORROW_FILTER_CTES}
           SELECT
             (
               SELECT COALESCE(SUM(ui.value_at_obtained::numeric), 0)::text
               FROM user_inventory ui
               WHERE ui.source_type = 'pack'
                 AND ui.source_id IN (SELECT game_session_id FROM non_borrow_pack_sessions)
                 -- Drop reward/daily-pack won cards (Fix 2) so the giveaway
                 -- is not counted as a gaming payout — keyed on source_id
                 -- (the originating game_session_id).
                 AND (ui.source_id IS NULL OR ui.source_id NOT IN ${REWARD_PACK_SESSIONS})
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
                 AND (ui.source_id IS NULL OR ui.source_id NOT IN ${REWARD_PACK_SESSIONS})
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
               SELECT COALESCE(SUM(ug.bet_amount::numeric), 0)::text
               FROM upgrader_games ug
               WHERE ug.user_id IN ${scope}
                 AND NOT EXISTS (
                   SELECT 1 FROM session_windows sw
                   WHERE sw.uid = ug.user_id
                     AND ug.created_at >= sw.win_start
                     AND ug.created_at <  sw.win_end
                 )
                 ${ugCutoff}
             ) AS upgrader_wager,
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
             ) AS upgrader_payout,
             (
               SELECT COUNT(*)::text
               FROM upgrader_games ug
               WHERE ug.user_id IN ${scope}
                 AND NOT EXISTS (
                   SELECT 1 FROM session_windows sw
                   WHERE sw.uid = ug.user_id
                     AND ug.created_at >= sw.win_start
                     AND ug.created_at <  sw.win_end
                 )
                 ${ugCutoff}
             ) AS upgrader_plays`,
        ),
        // ── Active customers — distinct user ids across pack/battle
        //    ledger wagers AND upgrader_games, UNIONed so a user who
        //    plays both products is counted exactly once. (Upgrader is
        //    no longer in the ledger wager rows, so it must be unioned
        //    in explicitly here.) ──
        db.$queryRawUnsafe<ActiveUsersRow[]>(
          `WITH ${sessionWindowsCte}
           SELECT COUNT(*)::text AS active_users
           FROM (
             SELECT DISTINCT lt.user_id AS uid
             FROM ledger_transactions lt
             WHERE lt.status = 'completed'
               AND lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship')
               -- Reward/daily-pack opens are not gaming (Fix 2) — a user
               -- whose only activity is a reward pack is not a gaming
               -- customer, so drop those pack_opening rows here too.
               AND (lt.type::text <> 'pack_opening'
                    OR lt.game_session_id IS NULL
                    OR lt.game_session_id NOT IN ${REWARD_PACK_SESSIONS})
               AND lt.user_id IN ${scope}
               AND NOT EXISTS (
                 SELECT 1 FROM session_windows sw
                 WHERE sw.uid = lt.user_id
                   AND lt.created_at >= sw.win_start
                   AND lt.created_at <  sw.win_end
               )
               ${ltCutoff}
             UNION
             SELECT DISTINCT ug.user_id AS uid
             FROM upgrader_games ug
             WHERE ug.user_id IN ${scope}
               AND NOT EXISTS (
                 SELECT 1 FROM session_windows sw
                 WHERE sw.uid = ug.user_id
                   AND ug.created_at >= sw.win_start
                   AND ug.created_at <  sw.win_end
               )
               ${ugCutoff}
           ) distinct_players`,
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
               AND lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship')
               AND lt.user_id IN ${scope}
               AND (
                 (lt.type::text = 'pack_opening'
                  AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
                  AND (lt.game_session_id IS NULL OR lt.game_session_id NOT IN ${REWARD_PACK_SESSIONS}))
                 OR (lt.type::text = 'battle_bet' AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
                 OR lt.type::text = 'battle_sponsorship'
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
               AND (ui.source_id IS NULL OR ui.source_id NOT IN ${REWARD_PACK_SESSIONS})
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

    // Note: `totalPlays` is the count of pack/battle wager ledger rows
    // (one per pack open / battle wager — each participant's bet counts)
    // plus the upgrader play count from `upgrader_games`. Battle plays
    // count each participant's bet (not the battle as a single play)
    // which matches how packs/upgrader count (one wager = one play).
    // Reward/daily-pack opens are NOT counted in pack_plays (Fix 2) so
    // the RTP sample size matches the gaming wager population.
    const packWager = toNumber(wagerRow?.pack_wager);
    const battleWager = toNumber(wagerRow?.battle_wager);
    const upgraderWager = toNumber(payoutRow?.upgrader_wager);
    const packPayout = toNumber(payoutRow?.pack_payout);
    const battlePayout = toNumber(payoutRow?.battle_payout);
    const upgraderPayout = toNumber(payoutRow?.upgrader_payout);

    const packPlays = Number(wagerRow?.pack_plays ?? "0");
    const battlePlays = Number(wagerRow?.battle_plays ?? "0");
    const upgraderPlays = Number(payoutRow?.upgrader_plays ?? "0");
    const totalPlays = packPlays + battlePlays + upgraderPlays;

    const totalWager = packWager + battleWager + upgraderWager;
    const totalPayout = packPayout + battlePayout + upgraderPayout;

    // GGR / RTP / house-edge route through the canonical metric layer —
    // no inline `wager − payout` / `payout / wager` arithmetic. The
    // empirical RTP / edge carry the canonical MIN_SAMPLE guard (null
    // below threshold); `totalPlays` is the bet count fed to the guard.
    const housePnl = ggrFormula({ wager: totalWager, gamingPayout: totalPayout });
    const rtp: EmpiricalRatio = empiricalRtp({
      gamingPayout: totalPayout,
      wager: totalWager,
      bets: totalPlays,
    });
    const houseEdge: EmpiricalRatio = empiricalHouseEdge({
      wager: totalWager,
      ggr: housePnl,
      bets: totalPlays,
    });
    const rtpPct = ratioToPct(rtp);
    const housePnlMarginPct = ratioToPct(houseEdge);

    const packPnl = ggrFormula({ wager: packWager, gamingPayout: packPayout });
    const battlePnl = ggrFormula({
      wager: battleWager,
      gamingPayout: battlePayout,
    });
    const upgraderPnl = ggrFormula({
      wager: upgraderWager,
      gamingPayout: upgraderPayout,
    });

    // Per-product RTP via the canonical sample-guarded helper (null
    // below MIN_SAMPLE) so the per-product tiles re-derive from a
    // payload field instead of recomputing `payout / wager` inline.
    const packRtpPct = ratioToPct(
      empiricalRtp({ gamingPayout: packPayout, wager: packWager, bets: packPlays }),
    );
    const battleRtpPct = ratioToPct(
      empiricalRtp({
        gamingPayout: battlePayout,
        wager: battleWager,
        bets: battlePlays,
      }),
    );
    const upgraderRtpPct = ratioToPct(
      empiricalRtp({
        gamingPayout: upgraderPayout,
        wager: upgraderWager,
        bets: upgraderPlays,
      }),
    );

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
        pnl: ggrFormula({ wager: agg.wager, gamingPayout: agg.payout }),
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
        activeUsers: Number(activeUsersRows[0]?.active_users ?? "0"),
        totalPlays,
        packPnl,
        battlePnl,
        upgraderPnl,
        packWager,
        battleWager,
        upgraderWager,
        packPayout,
        battlePayout,
        upgraderPayout,
        packRtpPct,
        battleRtpPct,
        upgraderRtpPct,
      },
      series,
    };
  });
}
