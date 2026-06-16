import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  WAGER_TYPES_SQL,
  GAMING_PAYOUT_TYPES_SQL,
} from "@/lib/metrics/ledger-sets";
import type {
  LeaderboardPeriod,
  UserLeaderRow,
  CreatorLeaderRow,
  CountryLeaderRow,
} from "@/lib/queries/analytics-top";

import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../_shared";

/**
 * ClickHouse twins of the /analytics → Top-performers leaderboards
 * (`src/lib/queries/analytics-top.ts`). Six boards: top depositors, top
 * wagerers, top losers (house P&L), top winners (user net), top creators by
 * referred volume, top countries by GGR.
 *
 * PARITY with the canonical Postgres definitions:
 *
 *   • wager  = Σ|ledger WAGER_TYPES| (pack_opening / battle_bet /
 *              battle_sponsorship), BORROW-EXCLUSIVE (pack opens whose
 *              description contains "borrow" dropped; battle_bet kept only for
 *              borrow_percentage=0 battles; battle_sponsorship counted
 *              directly), PLUS `upgrader_games.bet_amount`.
 *   • payout = Σ `user_inventory.value_at_obtained` for source pack/battle
 *              (same borrow gate, positive-membership in the non-borrow session
 *              sets) + Σ|GAMING_PAYOUT_TYPES| (battle_refund +
 *              battle_excess_to_voucher, unconditional) + upgrader won_amount.
 *
 * SCOPE (mirrors the PG twin EXACTLY): real customers — wholesale 3-role
 * exclusion `role NOT IN ('admin','support','creator')` + excluded-users
 * blacklist (`realCustomersScopeSql` → `customerScopeCte`). The PG twin layers a
 * creator-session-window NOT-EXISTS filter on top "belt-and-suspenders", but
 * `realCustomersScopeSql` already drops every creator wholesale, so the session
 * filter has nothing left to exclude — it is OMITTED here (same reasoning as
 * window-metrics.ts / dashboard-cashflow.ts). The creators board is the lone
 * exception: it scopes to `role = 'creator'` (no blacklist), like the PG twin.
 *
 * Periods: 7d / 30d / all (lifetime, no lower bound) — `LeaderboardPeriod`.
 *
 * §5c determinism: each ranked board adds a `user_id ASC` (or country) secondary
 * tie-break so equal sort keys break identically on both engines. The
 * losers/winners boards derive from a single per-user wager/payout pass with a
 * 500-row candidate cap (mirroring the PG twin's `CANDIDATE_LIMIT`); the PG cap
 * has no ORDER BY (arbitrary), so the CH pass orders by total gaming activity
 * before the cap — this captures both extremes deterministically and is exact
 * vs PG whenever the qualifying-user count ≤ 500.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on EVERY mirrored table
 * (incl. the borrow session sub-selects); money stays Decimal
 * (`toString(sum(...))` → `toNumber`), never Float; conditional zero is
 * `toDecimal128(0, 2)` so the cents scale is preserved (§5b). The blacklist is
 * passed in by the caller (no Postgres client imported here).
 */

const LIMIT = 20;
const CANDIDATE_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

// Lifetime (`all`) capped at 365d to match the PG twin (analytics-top.ts
// LIFETIME_LOOKBACK_DAYS) and the house INSIGHTS_LIFETIME_LOOKBACK_DAYS
// convention, so cutover/comparison stays bounded and consistent.
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

/**
 * Non-borrow pack session set — pack_opening ledger rows whose description does
 * NOT contain "borrow". Mirrors the PG `non_borrow_pack_sessions` CTE.
 */
const NON_BORROW_PACK_SESSIONS = `(
        SELECT game_session_id
        FROM ${CH_DB}.public_ledger_transactions FINAL
        WHERE _peerdb_is_deleted = 0
          AND type = 'pack_opening'
          AND status = 'completed'
          AND game_session_id IS NOT NULL
          AND (description IS NULL OR description NOT ILIKE '%borrow%')
      )`;

/**
 * Non-borrow battle session set — battle_participants whose linked battle has
 * borrow_percentage = 0. Mirrors the PG `non_borrow_battle_sessions` CTE.
 */
const NON_BORROW_BATTLE_SESSIONS = `(
        SELECT bp.game_session_id
        FROM ${CH_DB}.public_battle_participants AS bp FINAL
        INNER JOIN ${CH_DB}.public_battles AS b FINAL
          ON b.id = bp.battle_id AND b._peerdb_is_deleted = 0
        WHERE bp._peerdb_is_deleted = 0
          AND coalesce(b.borrow_percentage, 0) = 0
      )`;

/** Wager-side borrow gate (mirrors WAGER_NON_BORROW_FILTER, type already restricted to WAGER_TYPES). */
const WAGER_BORROW_GATE = `(
        (lt.type = 'pack_opening' AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%'))
        OR (lt.type = 'battle_bet' AND lt.game_session_id IN ${NON_BORROW_BATTLE_SESSIONS})
        OR lt.type = 'battle_sponsorship'
      )`;

/** Inventory-side borrow gate (mirrors PAYOUT_NON_BORROW_FILTER). */
const PAYOUT_BORROW_GATE = `(
        (ui.source_type = 'pack' AND ui.source_id IN ${NON_BORROW_PACK_SESSIONS})
        OR (ui.source_type = 'battle' AND ui.source_id IN ${NON_BORROW_BATTLE_SESSIONS})
      )`;

function buildCutoff(
  period: LeaderboardPeriod,
  now: Date,
): { cutoff: string | null } {
  const days = daysForPeriod(period);
  if (days === null) return { cutoff: null };
  return { cutoff: chDateTime(new Date(now.getTime() - days * DAY_MS)) };
}

type UserRow = {
  user_id: string;
  username: string | null;
  image: string | null;
  amount: string;
};

export async function getTopDepositorsFromClickHouse(
  period: LeaderboardPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<UserLeaderRow[]> {
  const hasBlacklist = blacklist.length > 0;
  const { cutoff } = buildCutoff(period, now);
  const params: Record<string, unknown> = { blacklist };
  if (cutoff !== null) params.cutoff = cutoff;
  const cutoffClause =
    cutoff !== null ? "AND lt.created_at >= {cutoff:DateTime64(6)}" : "";

  const rows = await clickhouseRead.query<UserRow>({
    queryName: "analytics.top.depositors",
    sql: `
      WITH ${customerScopeCte({ hasBlacklist })}
      SELECT
        lt.user_id                         AS user_id,
        u.username                         AS username,
        u.image                            AS image,
        toString(sum(abs(lt.amount)))      AS amount
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      INNER JOIN ${CH_DB}.public_user AS u FINAL
        ON u.id = lt.user_id AND u._peerdb_is_deleted = 0
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND lt.type = 'deposit'
        AND lt.user_id IN (SELECT id FROM real_users)
        ${cutoffClause}
      GROUP BY lt.user_id, u.username, u.image
      ORDER BY sum(abs(lt.amount)) DESC, lt.user_id ASC
      LIMIT ${LIMIT}`,
    params,
  });

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
  }));
}

export async function getTopWagerersFromClickHouse(
  period: LeaderboardPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<UserLeaderRow[]> {
  const hasBlacklist = blacklist.length > 0;
  const { cutoff } = buildCutoff(period, now);
  const params: Record<string, unknown> = { blacklist };
  if (cutoff !== null) params.cutoff = cutoff;
  const ltCutoff =
    cutoff !== null ? "AND lt.created_at >= {cutoff:DateTime64(6)}" : "";
  const ugCutoff =
    cutoff !== null ? "AND ug.created_at >= {cutoff:DateTime64(6)}" : "";

  const rows = await clickhouseRead.query<UserRow>({
    queryName: "analytics.top.wagerers",
    sql: `
      WITH ${customerScopeCte({ hasBlacklist })}
      SELECT
        g.user_id                  AS user_id,
        u.username                 AS username,
        u.image                    AS image,
        toString(sum(g.amount))    AS amount
      FROM (
        SELECT lt.user_id AS user_id, abs(lt.amount) AS amount
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type IN ${WAGER_TYPES_SQL}
          AND lt.user_id IN (SELECT id FROM real_users)
          AND ${WAGER_BORROW_GATE}
          ${ltCutoff}
        UNION ALL
        SELECT ug.user_id AS user_id, ug.bet_amount AS amount
        FROM ${CH_DB}.public_upgrader_games AS ug FINAL
        WHERE ug._peerdb_is_deleted = 0
          AND ug.user_id IN (SELECT id FROM real_users)
          ${ugCutoff}
      ) g
      INNER JOIN ${CH_DB}.public_user AS u FINAL
        ON u.id = g.user_id AND u._peerdb_is_deleted = 0
      GROUP BY g.user_id, u.username, u.image
      HAVING sum(g.amount) > 0
      ORDER BY sum(g.amount) DESC, g.user_id ASC
      LIMIT ${LIMIT}`,
    params,
  });

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    image: r.image,
    amount: toNumber(r.amount),
  }));
}

export type GamingPnlRowCh = {
  userId: string;
  username: string | null;
  image: string | null;
  wager: number;
  payout: number;
};

/**
 * Per-user canonical wager + gaming-payout aggregate for the period. Drives both
 * the losers (house P&L > 0) and winners (user net > 0) boards from one pass,
 * exactly like the PG `getUserGamingPnl`.
 */
export async function getUserGamingPnlFromClickHouse(
  period: LeaderboardPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<GamingPnlRowCh[]> {
  const hasBlacklist = blacklist.length > 0;
  const { cutoff } = buildCutoff(period, now);
  const params: Record<string, unknown> = { blacklist };
  if (cutoff !== null) params.cutoff = cutoff;
  const ltCutoff =
    cutoff !== null ? "AND lt.created_at >= {cutoff:DateTime64(6)}" : "";
  const uiCutoff =
    cutoff !== null ? "AND ui.obtained_at >= {cutoff:DateTime64(6)}" : "";
  const ugCutoff =
    cutoff !== null ? "AND ug.created_at >= {cutoff:DateTime64(6)}" : "";

  type Row = {
    user_id: string;
    username: string | null;
    image: string | null;
    wager: string;
    payout: string;
  };

  const rows = await clickhouseRead.query<Row>({
    queryName: "analytics.top.userGamingPnl",
    sql: `
      WITH ${customerScopeCte({ hasBlacklist })}
      SELECT
        g.user_id               AS user_id,
        u.username              AS username,
        u.image                 AS image,
        toString(sum(g.wager))  AS wager,
        toString(sum(g.payout)) AS payout
      FROM (
        SELECT lt.user_id AS user_id, abs(lt.amount) AS wager, toDecimal128(0, 2) AS payout
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type IN ${WAGER_TYPES_SQL}
          AND lt.user_id IN (SELECT id FROM real_users)
          AND ${WAGER_BORROW_GATE}
          ${ltCutoff}
        UNION ALL
        SELECT lt.user_id AS user_id, toDecimal128(0, 2) AS wager, abs(lt.amount) AS payout
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type IN ${GAMING_PAYOUT_TYPES_SQL}
          AND lt.user_id IN (SELECT id FROM real_users)
          ${ltCutoff}
        UNION ALL
        SELECT ui.user_id AS user_id, toDecimal128(0, 2) AS wager, ui.value_at_obtained AS payout
        FROM ${CH_DB}.public_user_inventory AS ui FINAL
        WHERE ui._peerdb_is_deleted = 0
          AND ui.source_type IN ('pack','battle')
          AND ui.user_id IN (SELECT id FROM real_users)
          AND ${PAYOUT_BORROW_GATE}
          ${uiCutoff}
        UNION ALL
        SELECT ug.user_id AS user_id, ug.bet_amount AS wager, ug.won_amount AS payout
        FROM ${CH_DB}.public_upgrader_games AS ug FINAL
        WHERE ug._peerdb_is_deleted = 0
          AND ug.user_id IN (SELECT id FROM real_users)
          ${ugCutoff}
      ) g
      INNER JOIN ${CH_DB}.public_user AS u FINAL
        ON u.id = g.user_id AND u._peerdb_is_deleted = 0
      GROUP BY g.user_id, u.username, u.image
      HAVING sum(g.wager) > 0 OR sum(g.payout) > 0
      ORDER BY (sum(g.wager) + sum(g.payout)) DESC, g.user_id ASC
      LIMIT ${CANDIDATE_LIMIT}`,
    params,
  });

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    image: r.image,
    wager: toNumber(r.wager),
    payout: toNumber(r.payout),
  }));
}

export async function getTopLosersFromClickHouse(
  period: LeaderboardPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<UserLeaderRow[]> {
  const rows = await getUserGamingPnlFromClickHouse(period, blacklist, now);
  return rows
    .map((r) => ({
      userId: r.userId,
      username: r.username,
      image: r.image,
      amount: r.wager - r.payout,
    }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, LIMIT);
}

export async function getTopWinnersFromClickHouse(
  period: LeaderboardPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<UserLeaderRow[]> {
  const rows = await getUserGamingPnlFromClickHouse(period, blacklist, now);
  return rows
    .map((r) => ({
      userId: r.userId,
      username: r.username,
      image: r.image,
      amount: r.payout - r.wager,
    }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, LIMIT);
}

export async function getTopCreatorsByVolumeFromClickHouse(
  period: LeaderboardPeriod,
  now: Date = new Date(),
): Promise<CreatorLeaderRow[]> {
  const { cutoff } = buildCutoff(period, now);
  const params: Record<string, unknown> = {};
  if (cutoff !== null) params.cutoff = cutoff;
  const refWindow =
    cutoff !== null ? "AND lt.created_at >= {cutoff:DateTime64(6)}" : "";
  const commissionWindow =
    cutoff !== null ? "AND cl.created_at >= {cutoff:DateTime64(6)}" : "";

  type Row = {
    user_id: string;
    username: string | null;
    affiliate_code: string | null;
    wager_volume: string;
    commission: string;
  };

  // Mirrors the PG twin: creators by referred-user wager volume (canonical
  // WAGER_TYPES, no borrow correction — gross referred volume) + affiliate
  // commission paid. No customer scope / blacklist (creators are the subject).
  const rows = await clickhouseRead.query<Row>({
    queryName: "analytics.top.creators",
    sql: `
      WITH
        creators AS (
          SELECT id AS user_id, username, affiliate_code
          FROM ${CH_DB}.public_user FINAL
          WHERE _peerdb_is_deleted = 0 AND role = 'creator'
        ),
        wager_volume AS (
          SELECT acu.affiliate_user_id AS creator_id,
                 sum(abs(lt.amount))   AS vol
          FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
          INNER JOIN ${CH_DB}.public_ledger_transactions AS lt FINAL
            ON lt.user_id = acu.referred_user_id AND lt._peerdb_is_deleted = 0
          WHERE acu._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type IN ${WAGER_TYPES_SQL}
            ${refWindow}
          GROUP BY acu.affiliate_user_id
        ),
        commissions AS (
          SELECT cl.user_id AS creator_id, sum(abs(cl.amount)) AS amt
          FROM ${CH_DB}.public_ledger_transactions AS cl FINAL
          WHERE cl._peerdb_is_deleted = 0
            AND cl.status = 'completed'
            AND cl.type = 'affiliate_claim'
            ${commissionWindow}
          GROUP BY cl.user_id
        )
      SELECT
        c.user_id                                       AS user_id,
        c.username                                      AS username,
        c.affiliate_code                                AS affiliate_code,
        toString(coalesce(w.vol, toDecimal128(0, 2)))   AS wager_volume,
        toString(coalesce(com.amt, toDecimal128(0, 2))) AS commission
      FROM creators AS c
      LEFT JOIN wager_volume AS w ON w.creator_id = c.user_id
      LEFT JOIN commissions AS com ON com.creator_id = c.user_id
      ORDER BY coalesce(w.vol, toDecimal128(0, 2)) DESC, c.user_id ASC
      LIMIT ${LIMIT}`,
    params,
  });

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    code: r.affiliate_code,
    wagerVolume: toNumber(r.wager_volume),
    commission: toNumber(r.commission),
  }));
}

export async function getTopCountriesFromClickHouse(
  period: LeaderboardPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<CountryLeaderRow[]> {
  const hasBlacklist = blacklist.length > 0;
  const { cutoff } = buildCutoff(period, now);
  const params: Record<string, unknown> = { blacklist };
  if (cutoff !== null) params.cutoff = cutoff;
  const ltCutoff =
    cutoff !== null ? "AND lt.created_at >= {cutoff:DateTime64(6)}" : "";
  const uiCutoff =
    cutoff !== null ? "AND ui.obtained_at >= {cutoff:DateTime64(6)}" : "";
  const ugCutoff =
    cutoff !== null ? "AND ug.created_at >= {cutoff:DateTime64(6)}" : "";

  type Row = {
    country: string;
    country_code: string | null;
    users: string;
    wager: string;
    payout: string;
  };

  const rows = await clickhouseRead.query<Row>({
    queryName: "analytics.top.countries",
    sql: `
      WITH ${customerScopeCte({ hasBlacklist })}
      SELECT
        coalesce(u.country, 'Unknown')   AS country,
        u.country_code                   AS country_code,
        toString(uniqExact(g.user_id))   AS users,
        toString(sum(g.wager))           AS wager,
        toString(sum(g.payout))          AS payout
      FROM (
        SELECT lt.user_id AS user_id, abs(lt.amount) AS wager, toDecimal128(0, 2) AS payout
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type IN ${WAGER_TYPES_SQL}
          AND lt.user_id IN (SELECT id FROM real_users)
          AND ${WAGER_BORROW_GATE}
          ${ltCutoff}
        UNION ALL
        SELECT lt.user_id AS user_id, toDecimal128(0, 2) AS wager, abs(lt.amount) AS payout
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        WHERE lt._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type IN ${GAMING_PAYOUT_TYPES_SQL}
          AND lt.user_id IN (SELECT id FROM real_users)
          ${ltCutoff}
        UNION ALL
        SELECT ui.user_id AS user_id, toDecimal128(0, 2) AS wager, ui.value_at_obtained AS payout
        FROM ${CH_DB}.public_user_inventory AS ui FINAL
        WHERE ui._peerdb_is_deleted = 0
          AND ui.source_type IN ('pack','battle')
          AND ui.user_id IN (SELECT id FROM real_users)
          AND ${PAYOUT_BORROW_GATE}
          ${uiCutoff}
        UNION ALL
        SELECT ug.user_id AS user_id, ug.bet_amount AS wager, ug.won_amount AS payout
        FROM ${CH_DB}.public_upgrader_games AS ug FINAL
        WHERE ug._peerdb_is_deleted = 0
          AND ug.user_id IN (SELECT id FROM real_users)
          ${ugCutoff}
      ) g
      INNER JOIN ${CH_DB}.public_user AS u FINAL
        ON u.id = g.user_id AND u._peerdb_is_deleted = 0
      GROUP BY coalesce(u.country, 'Unknown'), u.country_code
      HAVING sum(g.wager) > 0 OR sum(g.payout) > 0
      ORDER BY (sum(g.wager) - sum(g.payout)) DESC, country ASC
      LIMIT ${LIMIT}`,
    params,
  });

  return rows.map((r) => ({
    country: r.country,
    countryCode: r.country_code,
    users: Number(r.users),
    ggr: toNumber(r.wager) - toNumber(r.payout),
  }));
}
