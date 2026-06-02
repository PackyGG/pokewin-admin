import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getCreatorSessionWindowsCte } from "../creator-session-windows";
import { ggr as ggrFormula } from "@/lib/metrics/formulas";
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
  countryCode: string | null;
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
  /** Distinct country codes seen in the unfiltered scope — for filter dropdown. */
  countryCodes: string[];
};

export type GamesTopUsersFilters = {
  /** Restrict the wager+payout join to one product (or all). */
  game: "all" | "packs" | "battles" | "upgrader";
  /** Drop users whose total wager < min. */
  minWager: number;
  /** ISO 3166-1 alpha-2 country code, or null = all countries. */
  country: string | null;
};

const COUNTRY_RE = /^[A-Z]{2}$/;

export function parseTopUsersFilters(params: {
  game?: string | undefined;
  minWager?: string | undefined;
  country?: string | undefined;
}): GamesTopUsersFilters {
  let game: GamesTopUsersFilters["game"] = "all";
  if (
    params.game === "packs" ||
    params.game === "battles" ||
    params.game === "upgrader"
  ) {
    game = params.game;
  }
  let minWager = 0;
  if (params.minWager) {
    const parsed = Number(params.minWager);
    if (Number.isFinite(parsed) && parsed >= 0) minWager = parsed;
  }
  let country: string | null = null;
  if (params.country && COUNTRY_RE.test(params.country.toUpperCase())) {
    country = params.country.toUpperCase();
  }
  return { game, minWager, country };
}

export async function getGamesTopUsers(
  period: GamesPeriod,
  filters: GamesTopUsersFilters = { game: "all", minWager: 0, country: null },
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
      country_code: string | null;
      wager: string;
      payouts: string;
      plays: string;
    };
    type CountryRow = { country_code: string };

    // Country filter — applied via JOIN; only ISO-validated alpha-2
    // strings pass parseTopUsersFilters so direct inlining is safe.
    const countryFilter = filters.country
      ? `AND u.country_code = '${filters.country}'`
      : "";

    // Game-type filter — narrows wager_src and the matching payout_src
    // arms. Each arm is conditional on the game filter via its TYPE
    // predicate; the payout sources match the wager sources so the P&L
    // is internally consistent.
    const includeOnPacks = filters.game === "all" || filters.game === "packs";
    const includeOnBattles = filters.game === "all" || filters.game === "battles";
    const includeOnUpgrader = filters.game === "all" || filters.game === "upgrader";

    // Ledger wager arm covers pack/battle ONLY — the upgrader wager is
    // sourced from upgrader_games (canonical: upgrader is not on the
    // ledger), folded in via `upgrader_src` below when the filter
    // includes upgrader.
    const wagerTypes: string[] = [];
    if (includeOnPacks) wagerTypes.push("'pack_opening'");
    if (includeOnBattles) wagerTypes.push("'battle_bet'", "'battle_sponsorship'");
    // Defensive: an empty types tuple is unreachable for the pack/battle
    // filters but a one-char placeholder keeps SQL well-formed when the
    // filter is upgrader-only (ledger wager arm contributes nothing then).
    const wagerTypeIn = wagerTypes.length > 0 ? wagerTypes.join(", ") : "''";

    const wagerSrcPredicates: string[] = [];
    if (includeOnPacks) {
      wagerSrcPredicates.push(
        "(lt.type = 'pack_opening' AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%'))",
      );
    }
    if (includeOnBattles) {
      // Fix 1 — battle_sponsorship is counted DIRECTLY (no borrow gate).
      // Its ledger rows have game_session_id = NULL, so the
      // `game_session_id IN (non_borrow_battle_sessions)` gate would drop
      // every sponsorship row (NULL IN (...) → NULL → excluded). All
      // sponsored battles are borrow_percentage=0 (owner-confirmed), so no
      // gate is needed; battle_bet keeps the borrow gate. Mirrors the
      // canonical WAGER_NON_BORROW_FILTER / gaming-sql WAGER_LEG_FILTER.
      wagerSrcPredicates.push(
        "(lt.type = 'battle_bet' AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))",
        "lt.type = 'battle_sponsorship'",
      );
    }
    const wagerOrPredicate = wagerSrcPredicates.length > 0
      ? `AND (${wagerSrcPredicates.join(" OR ")})`
      : "AND false";

    // Inventory payout: include packs/battles arms only when their
    // wager side is also in.
    const invSourceTypes: string[] = [];
    if (includeOnPacks) invSourceTypes.push("'pack'");
    if (includeOnBattles) invSourceTypes.push("'battle'");
    const invSourceIn = invSourceTypes.length > 0 ? invSourceTypes.join(", ") : "''";
    const invPredicates: string[] = [];
    if (includeOnPacks) {
      invPredicates.push(
        "(ui.source_type = 'pack' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_pack_sessions))",
      );
    }
    if (includeOnBattles) {
      invPredicates.push(
        "(ui.source_type = 'battle' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))",
      );
    }
    const invOrPredicate = invPredicates.length > 0
      ? `AND (${invPredicates.join(" OR ")})`
      : "AND false";

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
    const [rows, countryRows] = await Promise.all([
      db.$queryRawUnsafe<Row[]>(
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
             AND lt.type IN (${wagerTypeIn})
             AND lt.user_id IN ${scope}
             ${wagerOrPredicate}
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
           WHERE ui.source_type IN (${invSourceIn})
             AND ui.user_id IN ${scope}
             ${invOrPredicate}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
         )
         ${includeOnUpgrader ? `,
         upgrader_src AS (
           -- Upgrader wager + payout from upgrader_games (canonical
           -- source — both legs come from here, NOT the ledger). One row
           -- per game = one play.
           SELECT ug.user_id,
                  ug.bet_amount::numeric AS wager,
                  ug.won_amount::numeric AS payouts,
                  1::int AS play
           FROM upgrader_games ug
           WHERE ug.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ug.user_id
                 AND ug.created_at >= sw.win_start
                 AND ug.created_at <  sw.win_end
             )
             ${ugCutoff}
         )` : ""}
         SELECT
           g.user_id::text AS user_id,
           u.username AS username,
           u.image AS image,
           u.country_code AS country_code,
           SUM(g.wager)::text AS wager,
           SUM(g.payouts)::text AS payouts,
           SUM(g.play)::text AS plays
         FROM (
           SELECT * FROM wager_src
           UNION ALL
           SELECT * FROM inv_payout_src
           ${includeOnUpgrader ? "UNION ALL SELECT * FROM upgrader_src" : ""}
         ) g
         JOIN "user" u ON u.id = g.user_id
         WHERE 1 = 1 ${countryFilter}
         GROUP BY g.user_id, u.username, u.image, u.country_code
         HAVING SUM(g.wager) > 0 OR SUM(g.payouts) > 0
         LIMIT 500`,
      ),
      // Distinct country codes seen in the unfiltered period scope —
      // populates the country filter dropdown. Tracks the period
      // window so the dropdown only shows countries with activity.
      // Pack/battle ledger players UNION upgrader_games players (upgrader
      // is not on the ledger, so it must be unioned in explicitly).
      db.$queryRawUnsafe<CountryRow[]>(
        `SELECT DISTINCT u.country_code AS country_code
         FROM "user" u
         WHERE u.country_code IS NOT NULL
           AND (
             u.id IN (
               SELECT lt.user_id
               FROM ledger_transactions lt
               WHERE lt.status = 'completed'
                 AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship')
                 AND lt.user_id IN ${scope}
                 ${ltCutoff}
             )
             OR u.id IN (
               SELECT ug.user_id
               FROM upgrader_games ug
               WHERE ug.user_id IN ${scope}
                 ${ugCutoff}
             )
           )
         ORDER BY country_code`,
      ),
    ]);

    let enriched: GamesLeaderboardRow[] = rows.map((r) => {
      const wager = toNumber(r.wager);
      const payouts = toNumber(r.payouts);
      return {
        userId: r.user_id,
        username: r.username,
        image: r.image,
        countryCode: r.country_code,
        wager,
        payouts,
        // House-POV P&L via the canonical GGR helper (wager − payout).
        pnl: ggrFormula({ wager, gamingPayout: payouts }),
        plays: Number(r.plays),
      };
    });

    // Min-wager filter — applied in JS so the same dataset can drive
    // all three leaderboards without rerunning SQL.
    if (filters.minWager > 0) {
      enriched = enriched.filter((r) => r.wager >= filters.minWager);
    }

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

    const countryCodes = countryRows.map((c) => c.country_code).filter(Boolean);

    return {
      period,
      topWagerers,
      topWinners,
      topLosers,
      countryCodes,
    };
  });
}
