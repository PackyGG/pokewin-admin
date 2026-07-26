import "server-only";

import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { WAGER_TYPES_SQL, GAMING_PAYOUT_TYPES_SQL } from "@/lib/metrics";
import { getCreatorSessionWindowsCte } from "./creator-session-windows";
import {
  realCustomersScopeSql,
  BORROW_FILTER_CTES,
  WAGER_NON_BORROW_FILTER,
  PAYOUT_NON_BORROW_FILTER,
} from "./insights-games/_shared";

/**
 * Top-performers leaderboards for /analytics Top Performers tab —
 * MIGRATED onto the canonical `@/lib/metrics` GGR/payout model.
 *
 * Six leaderboards:
 *   • top_depositors  — sum of completed deposit ledger rows in period
 *   • top_wagerers    — canonical borrow-corrected wager (pack + battle +
 *                       sponsorship from the ledger, upgrader from
 *                       `upgrader_games`)
 *   • top_losers      — highest house P&L against the user = canonical
 *                       wager − canonical gaming payout > 0
 *   • top_winners     — inverse of top_losers (most money taken OFF the
 *                       house; payout − wager > 0)
 *   • top_creators    — by wager volume driven by referred users (same
 *                       canonical WAGER set + scope) + commission earnings
 *   • top_countries   — by canonical GGR (wager − gaming payout) per
 *                       country
 *
 * CANONICAL MODEL (matches analytics.ts / dashboard / /ggr / insights-
 * games via `@/lib/metrics`):
 *   • wager  = Σ|ledger WAGER_TYPES| (pack_opening / battle_bet /
 *              battle_sponsorship), borrow plays dropped, PLUS
 *              `upgrader_games.bet_amount` (upgrader is NOT in the ledger).
 *   • payout = Σ `user_inventory.value_at_obtained` for source pack/battle
 *              (the dominant pack/battle payout — cards the user KEPT,
 *              borrow plays dropped) + Σ|battle_refund| (the only ledger
 *              cash gaming-payout leg) + `upgrader_games.won_amount`.
 *   • Card conversions (card_sale / card_exchange / voucher↔balance) are
 *              NEUTRAL — value the user already owns changing form — and
 *              are NEVER on the payout side. Ledger `upgrader_payout` is
 *              NEVER used (prod does not write it).
 *
 * Scope (every user-level / country leaderboard): real customers only
 * (admin / support / creator dropped + admin blacklist), borrow plays
 * excluded on BOTH the wager and payout side, creator-on-stream rows
 * dropped via the `session_windows` CTE — `realCustomersScopeSql` already
 * drops every creator wholesale, so the session-window filter is a
 * belt-and-suspenders match to the rest of the canonical surfaces and
 * keeps this consistent if the scope ever loosens.
 */

export type LeaderboardPeriod = "7d" | "30d" | "all";

// Lifetime (`all`) is capped at this lookback rather than an unbounded
// full-history scan — the unbounded-lifetime pattern CLAUDE.md
// ("Performance & Daten-Laden") forbids. Mirrors the reward-side
// `INSIGHTS_LIFETIME_LOOKBACK_DAYS` (365d); covers all currently-relevant
// leaderboard activity.
const LIFETIME_LOOKBACK_DAYS = 365;

function daysForPeriod(period: LeaderboardPeriod): number | null {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return LIFETIME_LOOKBACK_DAYS;
  }
}

export type UserLeaderRow = {
  userId: string;
  username: string | null;
  image: string | null;
  amount: number;
};

export type CreatorLeaderRow = {
  userId: string;
  username: string | null;
  code: string | null;
  wagerVolume: number;
  commission: number;
};

export type CountryLeaderRow = {
  country: string;
  countryCode: string | null;
  users: number;
  ggr: number;
};

const LIMIT = 20;
// Generous SQL-side cap so the per-user P&L pass always has enough
// candidates before in-memory filtering for the losers / winners
// leaderboards (same trick as insights-games/top-users.ts).
const CANDIDATE_LIMIT = 500;

function periodFilter(
  period: LeaderboardPeriod,
  column = "lt.created_at",
): string {
  const days = daysForPeriod(period);
  return days !== null ? `AND ${column} >= NOW() - INTERVAL '${days} days'` : "";
}

/**
 * `true` when the connected DB has the `upgrader_games` table. Upgrader
 * lives ONLY in that table (prod does not write `upgrader_*` to the
 * ledger). A `to_regclass` probe (the same graceful-degradation the
 * canonical `@/lib/metrics` `upgraderMetrics` uses) avoids a `42P01`
 * throw on a migration-lagged snapshot that predates upgrader.
 */
async function hasUpgraderGames(): Promise<boolean> {
  const db = await getDrizzleDb();
  const probe = await queryRows<{ exists: string | null }[]>(
    db,
    "SELECT to_regclass('public.upgrader_games')::text AS exists",
  );
  return probe[0]?.exists != null;
}

async function computeTopDepositors(
  period: LeaderboardPeriod,
  _blacklistKey: string[],
): Promise<UserLeaderRow[]> {
  void _blacklistKey; // cache-key dimension only; scope is fetched internally
  const db = await getDrizzleDb();
  const scope = await realCustomersScopeSql();
  const rows = await queryRows<
    {
      id: string;
      username: string | null;
      image: string | null;
      amount: string;
    }[]
  >(db, `
    SELECT u.id, u.username, u.image, SUM(ABS(lt.amount::numeric))::text AS amount
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed' AND lt.type::text = 'deposit'
      AND lt.user_id IN ${scope}
      ${periodFilter(period)}
    GROUP BY u.id, u.username, u.image
    ORDER BY SUM(ABS(lt.amount::numeric)) DESC
    LIMIT ${LIMIT}
  `);
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
  }));
}

async function computeTopWagerers(
  period: LeaderboardPeriod,
  _blacklistKey: string[],
): Promise<UserLeaderRow[]> {
  void _blacklistKey; // cache-key dimension only; scope is fetched internally
  const db = await getDrizzleDb();
  const scope = await realCustomersScopeSql();
  const sessionWindowsCte = await getCreatorSessionWindowsCte();
  const upgrader = await hasUpgraderGames();
  const days = daysForPeriod(period);
  const ltCutoff =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const ugCutoff =
    days !== null ? `AND ug.created_at >= NOW() - INTERVAL '${days} days'` : "";

  // Borrow-corrected canonical wager: ledger WAGER_TYPES (non-borrow,
  // non-on-stream) + upgrader_games.bet_amount.
  const rows = await queryRows<
    {
      user_id: string;
      username: string | null;
      image: string | null;
      amount: string;
    }[]
  >(db, `
    WITH ${sessionWindowsCte},
         ${BORROW_FILTER_CTES},
         wager_src AS (
           SELECT lt.user_id, ABS(lt.amount::numeric) AS amount
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.type::text IN ${WAGER_TYPES_SQL}
             AND lt.user_id IN ${scope}
             ${WAGER_NON_BORROW_FILTER}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
         )${
           upgrader
             ? `,
         upgrader_src AS (
           SELECT ug.user_id, ug.bet_amount::numeric AS amount
           FROM upgrader_games ug
           WHERE ug.user_id IN ${scope}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ug.user_id
                 AND ug.created_at >= sw.win_start
                 AND ug.created_at <  sw.win_end
             )
             ${ugCutoff}
         )`
             : ""
         }
    SELECT g.user_id::text AS user_id, u.username, u.image,
           SUM(g.amount)::text AS amount
    FROM (
      SELECT * FROM wager_src
      ${upgrader ? "UNION ALL SELECT * FROM upgrader_src" : ""}
    ) g
    JOIN "user" u ON u.id = g.user_id
    GROUP BY g.user_id, u.username, u.image
    HAVING SUM(g.amount) > 0
    ORDER BY SUM(g.amount) DESC
    LIMIT ${LIMIT}
  `);
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
  }));
}

/**
 * Per-user canonical wager + gaming-payout aggregate for the selected
 * period. Drives both the losers (house P&L > 0) and winners (user net >
 * 0) leaderboards from a single pass so the two are internally consistent
 * — the exact structure of insights-games/top-users.ts.
 */
type PnlRow = {
  userId: string;
  username: string | null;
  image: string | null;
  wager: number;
  payout: number;
};

async function getUserGamingPnl(
  period: LeaderboardPeriod,
): Promise<PnlRow[]> {
  const db = await getDrizzleDb();
  const scope = await realCustomersScopeSql();
  const sessionWindowsCte = await getCreatorSessionWindowsCte();
  const upgrader = await hasUpgraderGames();
  const days = daysForPeriod(period);
  const ltCutoff =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const uiCutoff =
    days !== null
      ? `AND ui.obtained_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const ugCutoff =
    days !== null ? `AND ug.created_at >= NOW() - INTERVAL '${days} days'` : "";

  // wager  = ledger WAGER_TYPES (non-borrow, non-on-stream) + upgrader bet
  // payout = inventory keep (pack/battle, non-borrow, non-on-stream)
  //          + |battle_refund| (the ledger cash gaming-payout leg)
  //          + upgrader won_amount
  // Card conversions are NEUTRAL → never on the payout side.
  const rows = await queryRows<
    {
      user_id: string;
      username: string | null;
      image: string | null;
      wager: string;
      payout: string;
    }[]
  >(db, `
    WITH ${sessionWindowsCte},
         ${BORROW_FILTER_CTES},
         wager_src AS (
           SELECT lt.user_id,
                  ABS(lt.amount::numeric) AS wager,
                  0::numeric AS payout
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.type::text IN ${WAGER_TYPES_SQL}
             AND lt.user_id IN ${scope}
             ${WAGER_NON_BORROW_FILTER}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
         ),
         refund_src AS (
           SELECT lt.user_id,
                  0::numeric AS wager,
                  ABS(lt.amount::numeric) AS payout
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.type::text IN ${GAMING_PAYOUT_TYPES_SQL}
             AND lt.user_id IN ${scope}
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
                  ui.value_at_obtained::numeric AS payout
           FROM user_inventory ui
           WHERE ui.source_type IN ('pack','battle')
             AND ui.user_id IN ${scope}
             ${PAYOUT_NON_BORROW_FILTER}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
         )${
           upgrader
             ? `,
         upgrader_src AS (
           SELECT ug.user_id,
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
         )`
             : ""
         }
    SELECT g.user_id::text AS user_id, u.username, u.image,
           SUM(g.wager)::text AS wager,
           SUM(g.payout)::text AS payout
    FROM (
      SELECT * FROM wager_src
      UNION ALL SELECT * FROM refund_src
      UNION ALL SELECT * FROM inv_payout_src
      ${upgrader ? "UNION ALL SELECT * FROM upgrader_src" : ""}
    ) g
    JOIN "user" u ON u.id = g.user_id
    GROUP BY g.user_id, u.username, u.image
    HAVING SUM(g.wager) > 0 OR SUM(g.payout) > 0
    LIMIT ${CANDIDATE_LIMIT}
  `);

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    image: r.image,
    wager: toNumber(r.wager),
    payout: toNumber(r.payout),
  }));
}

/**
 * Top losers = users we made the most gross gaming revenue from. High
 * positive house P&L (canonical wager − canonical gaming payout) per user.
 */
async function computeTopLosers(
  period: LeaderboardPeriod,
  _blacklistKey: string[],
): Promise<UserLeaderRow[]> {
  void _blacklistKey; // cache-key dimension only; scope is fetched internally
  const rows = await getUserGamingPnl(period);
  return rows
    .map((r) => ({
      userId: r.userId,
      username: r.username,
      image: r.image,
      amount: r.wager - r.payout, // house P&L
    }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, LIMIT);
}

/**
 * Top winners = users who have taken the most money off the house. User
 * net (payout − wager) > 0; the amount shown is that positive magnitude.
 */
async function computeTopWinners(
  period: LeaderboardPeriod,
  _blacklistKey: string[],
): Promise<UserLeaderRow[]> {
  void _blacklistKey; // cache-key dimension only; scope is fetched internally
  const rows = await getUserGamingPnl(period);
  return rows
    .map((r) => ({
      userId: r.userId,
      username: r.username,
      image: r.image,
      amount: r.payout - r.wager, // user net win
    }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, LIMIT);
}

async function computeTopCreatorsByVolume(
  period: LeaderboardPeriod,
  _blacklistKey: string[],
): Promise<CreatorLeaderRow[]> {
  void _blacklistKey; // cache-key dimension only; scope is fetched internally
  const db = await getDrizzleDb();
  const days = daysForPeriod(period);
  const refWindow =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const commissionWindow =
    days !== null ? `AND cl.created_at >= NOW() - INTERVAL '${days} days'` : "";

  // Referred-user wager volume uses the canonical WAGER_TYPES set so it
  // matches the wager definition everywhere else. (Borrow correction is
  // intentionally NOT applied here — this is gross referred-volume the
  // creator drove, the same affiliate-attribution mechanism creators-pnl
  // reports, not a real-money gaming-margin figure.)
  const rows = await queryRows<
    {
      user_id: string;
      username: string | null;
      affiliate_code: string | null;
      wager_volume: string;
      commission: string;
    }[]
  >(db, `
    WITH creators AS (
      SELECT id AS user_id, username, affiliate_code
      FROM "user"
      WHERE role = 'creator'
    ),
    wager_volume AS (
      SELECT acu.affiliate_user_id AS creator_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS vol
      FROM affiliate_code_usages acu
      JOIN ledger_transactions lt ON lt.user_id = acu.referred_user_id
      WHERE lt.status = 'completed' AND lt.type::text IN ${WAGER_TYPES_SQL}
        ${refWindow}
      GROUP BY acu.affiliate_user_id
    ),
    commissions AS (
      SELECT cl.user_id AS creator_id, COALESCE(SUM(ABS(cl.amount::numeric)), 0)::text AS amt
      FROM ledger_transactions cl
      WHERE cl.status = 'completed' AND cl.type::text = 'affiliate_claim'
        ${commissionWindow}
      GROUP BY cl.user_id
    )
    SELECT
      c.user_id,
      c.username,
      c.affiliate_code,
      COALESCE(w.vol, '0') AS wager_volume,
      COALESCE(com.amt, '0') AS commission
    FROM creators c
    LEFT JOIN wager_volume w ON w.creator_id = c.user_id
    LEFT JOIN commissions com ON com.creator_id = c.user_id
    ORDER BY COALESCE(w.vol::numeric, 0) DESC
    LIMIT ${LIMIT}
  `);
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    code: r.affiliate_code,
    wagerVolume: toNumber(r.wager_volume),
    commission: toNumber(r.commission),
  }));
}

async function computeTopCountries(
  period: LeaderboardPeriod,
  _blacklistKey: string[],
): Promise<CountryLeaderRow[]> {
  void _blacklistKey; // cache-key dimension only; scope is fetched internally
  const db = await getDrizzleDb();
  const scope = await realCustomersScopeSql();
  const sessionWindowsCte = await getCreatorSessionWindowsCte();
  const upgrader = await hasUpgraderGames();
  const days = daysForPeriod(period);
  const ltCutoff =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const uiCutoff =
    days !== null
      ? `AND ui.obtained_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const ugCutoff =
    days !== null ? `AND ug.created_at >= NOW() - INTERVAL '${days} days'` : "";

  // Per-country canonical GGR = Σ wager − Σ gaming payout, same legs as
  // the per-user pass, grouped by the user's country. Distinct users per
  // country come from the wager+payout participants (anyone with gaming
  // activity in the window).
  const rows = await queryRows<
    {
      country: string;
      country_code: string | null;
      users: string;
      wager: string;
      payout: string;
    }[]
  >(db, `
    WITH ${sessionWindowsCte},
         ${BORROW_FILTER_CTES},
         wager_src AS (
           SELECT lt.user_id,
                  ABS(lt.amount::numeric) AS wager,
                  0::numeric AS payout
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.type::text IN ${WAGER_TYPES_SQL}
             AND lt.user_id IN ${scope}
             ${WAGER_NON_BORROW_FILTER}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = lt.user_id
                 AND lt.created_at >= sw.win_start
                 AND lt.created_at <  sw.win_end
             )
             ${ltCutoff}
         ),
         refund_src AS (
           SELECT lt.user_id,
                  0::numeric AS wager,
                  ABS(lt.amount::numeric) AS payout
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.type::text IN ${GAMING_PAYOUT_TYPES_SQL}
             AND lt.user_id IN ${scope}
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
                  ui.value_at_obtained::numeric AS payout
           FROM user_inventory ui
           WHERE ui.source_type IN ('pack','battle')
             AND ui.user_id IN ${scope}
             ${PAYOUT_NON_BORROW_FILTER}
             AND NOT EXISTS (
               SELECT 1 FROM session_windows sw
               WHERE sw.uid = ui.user_id
                 AND ui.obtained_at >= sw.win_start
                 AND ui.obtained_at <  sw.win_end
             )
             ${uiCutoff}
         )${
           upgrader
             ? `,
         upgrader_src AS (
           SELECT ug.user_id,
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
         )`
             : ""
         }
    SELECT
      COALESCE(u.country, 'Unknown') AS country,
      u.country_code,
      COUNT(DISTINCT g.user_id)::text AS users,
      SUM(g.wager)::text AS wager,
      SUM(g.payout)::text AS payout
    FROM (
      SELECT * FROM wager_src
      UNION ALL SELECT * FROM refund_src
      UNION ALL SELECT * FROM inv_payout_src
      ${upgrader ? "UNION ALL SELECT * FROM upgrader_src" : ""}
    ) g
    JOIN "user" u ON u.id = g.user_id
    GROUP BY COALESCE(u.country, 'Unknown'), u.country_code
    HAVING SUM(g.wager) > 0 OR SUM(g.payout) > 0
    ORDER BY (SUM(g.wager) - SUM(g.payout)) DESC
    LIMIT ${LIMIT}
  `);
  return rows.map((r) => ({
    country: r.country,
    countryCode: r.country_code,
    users: Number(r.users),
    ggr: toNumber(r.wager) - toNumber(r.payout),
  }));
}

/**
 * Cross-request cache for the six Top-performers leaderboards. `/analytics`
 * → Top tab re-runs on every 5-minute `AutoRefresh` tick for every viewer;
 * without a shared cache each heavy borrow-corrected wager / per-user P&L /
 * per-country GGR scan re-ran per tick per viewer. Each board gets a 60s
 * (finite window) + 300s (lifetime) `unstable_cache` pair keyed on `(period,
 * sortedBlacklist)`. The compute functions fetch their canonical scope
 * (`realCustomersScopeSql`) internally — which already reflects the
 * blacklist — so the sorted-blacklist argument is purely a cache-key
 * dimension (an excluded-users edit → a new key → fresh aggregate). Logic is
 * byte-for-byte identical to each `computeTop*`; mirrors the
 * `getAnalyticsData` cache idiom in `analytics.ts`.
 *
 * NOTE: the `all` window is still an UNBOUNDED lifetime scan on every board
 * (money-exact leaderboard amounts — capping would change displayed numbers,
 * so it is left for owner sign-off). The cache + the caller's `safeQuery`
 * timeout keep a cold lifetime fill from hanging the segment.
 */
function makeCachedLeaderboard<T>(
  fn: (period: LeaderboardPeriod, blacklistKey: string[]) => Promise<T>,
  baseKey: string,
): (period: LeaderboardPeriod) => Promise<T> {
  const short = unstable_cache(fn, [`${baseKey}-v1`], {
    revalidate: 60,
    tags: ["analytics"],
  });
  const lifetime = unstable_cache(fn, [`${baseKey}-lifetime-v1`], {
    revalidate: 300,
    tags: ["analytics"],
  });
  return async (period: LeaderboardPeriod): Promise<T> => {
    const blacklist = await getExcludedUserIds();
    const sorted = [...blacklist].sort();
    return period === "all" ? lifetime(period, sorted) : short(period, sorted);
  };
}

export const getTopDepositors = makeCachedLeaderboard(
  computeTopDepositors,
  "analytics-top-depositors",
);
export const getTopWagerers = makeCachedLeaderboard(
  computeTopWagerers,
  "analytics-top-wagerers",
);
export const getTopLosers = makeCachedLeaderboard(
  computeTopLosers,
  "analytics-top-losers",
);
export const getTopWinners = makeCachedLeaderboard(
  computeTopWinners,
  "analytics-top-winners",
);
export const getTopCreatorsByVolume = makeCachedLeaderboard(
  computeTopCreatorsByVolume,
  "analytics-top-creators",
);
export const getTopCountries = makeCachedLeaderboard(
  computeTopCountries,
  "analytics-top-countries",
);
