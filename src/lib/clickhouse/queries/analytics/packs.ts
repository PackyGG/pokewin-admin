import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../_shared";
import {
  getBattleStatsFromClickHouse,
  getPackPopularityFromClickHouse,
  type PackBattlePeriod,
} from "./_pack-battle-shared";
import type {
  BattleModeStats,
  PackPopularityStats,
} from "@/lib/queries/analytics";
import type {
  PacksPeriod,
  PacksProfitData,
  PackProfitRow,
  BattlePackProfitRow,
  TopPack24hRow,
} from "@/lib/queries/analytics-packs";

/**
 * ClickHouse twins of the /analytics PACKS tab (`@/lib/queries/analytics-packs`
 * + the slim `getPackAndBattleStats` from `@/lib/queries/analytics`):
 *
 *   • getPackProfitabilityFromClickHouse  — the per-pack + per-battle-pack
 *     profitability deep-dive (`getPackProfitability`).
 *   • getTopOpenedPacks24hFromClickHouse  — the rolling-24h most-opened-packs
 *     leaderboard (`getTopOpenedPacks24h`).
 *   • getPackAndBattleStatsFromClickHouse — the slim battle-mode + pack-
 *     popularity bundle (`getPackAndBattleStats`), reusing the shared helpers.
 *
 * PAYOUT MODEL (mirrors the verified inventory-delta model in the PG twin):
 * a pack/battle open writes ONE ledger row = the gross stake
 * (`pack_opening` / `battle_bet` / `battle_sponsorship`); the WIN is NOT a
 * ledger row — it lands ONLY in `user_inventory.value_at_obtained`
 * (`source_type IN ('pack','battle')`, keyed by `obtained_at`). Card sales /
 * exchanges are NEUTRAL disposals and never sit on the payout side.
 *
 * SCOPE (mirrors the PG twin per leg):
 *   • Profitability: real-customer scope = `role NOT IN
 *     ('admin','support','creator')` (creators dropped) + blacklist; borrow
 *     plays excluded SYMMETRICALLY on wager AND payout.
 *   • Top-24h: `role NOT IN ('admin','support')` (creators KEPT) + blacklist;
 *     reward packs (`pack_type = 'reward'`) excluded.
 *   • Pack & battle stats: see `_pack-battle-shared` (battle stats `role !=
 *     'admin'`; pack popularity 2-role + blacklist, creators kept).
 *
 * Windows: profitability is rolling N-day from `now` on `lt.created_at`
 * (wager) and `ui.obtained_at` (payout) — `all` has no lower bound; the
 * top-24h leaderboard is the rolling last 24 hours from `now`.
 *
 * ClickHouse correctness: FINAL + `_peerdb_is_deleted = 0` on EVERY mirrored
 * table; money stays Decimal end-to-end. The even-split divisor
 * (`|stake| / packsOnBattle`) is computed in Decimal128 at scale 10 — the CH
 * analogue of PG's high-precision `numeric` division — so the summed slices
 * stay within half a cent of Postgres. The blacklist is passed in by the
 * caller (no Postgres client imported here).
 */

const WAGER_TYPES_SQL = `('pack_opening','battle_bet','battle_sponsorship')`;

function daysForPacksPeriod(period: PacksPeriod): number | null {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return null;
  }
}

type PackRow = {
  id: string;
  name: string;
  opens: string;
  revenue: string;
  payouts: string;
};
type BattleRow = {
  id: string;
  name: string;
  battles_played: string;
  revenue: string;
  payouts: string;
};

export async function getPackProfitabilityFromClickHouse(
  period: PacksPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<PacksProfitData> {
  const days = daysForPacksPeriod(period);
  const cutoff =
    days !== null ? new Date(now.getTime() - days * 24 * 60 * 60 * 1000) : null;
  const hasBlacklist = blacklist.length > 0;
  const realUsers = customerScopeCte({ hasBlacklist });

  const params: Record<string, unknown> = { blacklist };
  if (cutoff !== null) params.cutoff = chDateTime(cutoff);
  const ltWhere =
    cutoff !== null ? "AND lt.created_at >= {cutoff:DateTime64(6)}" : "";
  const uiWhere =
    cutoff !== null ? "AND ui.obtained_at >= {cutoff:DateTime64(6)}" : "";

  const nonBorrowPackSessions = `non_borrow_pack_sessions AS (
      SELECT game_session_id
      FROM ${CH_DB}.public_ledger_transactions FINAL
      WHERE _peerdb_is_deleted = 0
        AND type = 'pack_opening'
        AND status = 'completed'
        AND game_session_id IS NOT NULL
        AND description NOT ILIKE '%borrow%'
    )`;

  const packSql = `
    WITH ${realUsers},
    ${nonBorrowPackSessions},
    pack_opens AS (
      SELECT
        gs.game_id AS pack_id,
        count() AS opens,
        sum(abs(lt.amount)) AS revenue
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      INNER JOIN ${CH_DB}.public_game_sessions AS gs FINAL
        ON gs.id = lt.game_session_id AND gs._peerdb_is_deleted = 0 AND gs.game_type = 'pack'
      WHERE lt._peerdb_is_deleted = 0
        AND lt.type = 'pack_opening'
        AND lt.status = 'completed'
        AND lt.description NOT ILIKE '%borrow%'
        AND lt.user_id IN (SELECT id FROM real_users)
        ${ltWhere}
      GROUP BY gs.game_id
    ),
    pack_payouts AS (
      SELECT
        gs.game_id AS pack_id,
        sum(ui.value_at_obtained) AS payouts
      FROM ${CH_DB}.public_user_inventory AS ui FINAL
      INNER JOIN ${CH_DB}.public_game_sessions AS gs FINAL
        ON gs.id = ui.source_id AND gs._peerdb_is_deleted = 0 AND gs.game_type = 'pack'
      WHERE ui._peerdb_is_deleted = 0
        AND ui.source_type = 'pack'
        AND ui.user_id IN (SELECT id FROM real_users)
        AND ui.source_id IN (SELECT game_session_id FROM non_borrow_pack_sessions)
        ${uiWhere}
      GROUP BY gs.game_id
    )
    SELECT
      toString(p.id) AS id,
      p.name AS name,
      toString(po.opens) AS opens,
      toString(po.revenue) AS revenue,
      toString(pp.payouts) AS payouts
    FROM pack_opens AS po
    INNER JOIN ${CH_DB}.public_packs AS p FINAL
      ON p.id = po.pack_id AND p._peerdb_is_deleted = 0
    LEFT JOIN pack_payouts AS pp ON pp.pack_id = po.pack_id
    ORDER BY po.revenue DESC, p.id ASC
    LIMIT 20`;

  const battleSql = `
    WITH ${realUsers},
    battle_wager AS (
      SELECT
        arrayJoin(pack_ids) AS pack_id,
        battle_id,
        abs(toDecimal128(amount, 10)) / greatest(length(pack_ids), 1) AS wager
      FROM (
        SELECT
          b.pack_ids AS pack_ids,
          bp.battle_id AS battle_id,
          lt.amount AS amount
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        INNER JOIN ${CH_DB}.public_battle_participants AS bp FINAL
          ON bp.game_session_id = lt.game_session_id AND bp._peerdb_is_deleted = 0
        INNER JOIN ${CH_DB}.public_battles AS b FINAL
          ON b.id = bp.battle_id AND b._peerdb_is_deleted = 0
        WHERE lt._peerdb_is_deleted = 0
          AND lt.type IN ${WAGER_TYPES_SQL}
          AND lt.status = 'completed'
          AND b.borrow_percentage = 0
          AND lt.user_id IN (SELECT id FROM real_users)
          ${ltWhere}
      )
    ),
    battle_wager_agg AS (
      SELECT
        pack_id,
        toString(uniqExact(battle_id)) AS battles_played,
        toString(sum(wager)) AS revenue
      FROM battle_wager
      GROUP BY pack_id
    ),
    battle_payouts AS (
      SELECT pack_id, sum(payout_split) AS payouts
      FROM (
        SELECT
          arrayJoin(pack_ids) AS pack_id,
          toDecimal128(value_at_obtained, 10) / greatest(length(pack_ids), 1) AS payout_split
        FROM (
          SELECT
            b.pack_ids AS pack_ids,
            ui.value_at_obtained AS value_at_obtained
          FROM ${CH_DB}.public_user_inventory AS ui FINAL
          INNER JOIN ${CH_DB}.public_battle_participants AS bp FINAL
            ON bp.game_session_id = ui.source_id AND bp._peerdb_is_deleted = 0
          INNER JOIN ${CH_DB}.public_battles AS b FINAL
            ON b.id = bp.battle_id AND b._peerdb_is_deleted = 0
          WHERE ui._peerdb_is_deleted = 0
            AND ui.source_type = 'battle'
            AND b.borrow_percentage = 0
            AND ui.user_id IN (SELECT id FROM real_users)
            ${uiWhere}
        )
      )
      GROUP BY pack_id
    )
    SELECT
      toString(p.id) AS id,
      p.name AS name,
      ba.battles_played AS battles_played,
      ba.revenue AS revenue,
      toString(bpay.payouts) AS payouts
    FROM battle_wager_agg AS ba
    INNER JOIN ${CH_DB}.public_packs AS p FINAL
      ON toString(p.id) = ba.pack_id AND p._peerdb_is_deleted = 0
    LEFT JOIN battle_payouts AS bpay ON bpay.pack_id = ba.pack_id
    ORDER BY toDecimal128(ba.revenue, 10) DESC, p.id ASC
    LIMIT 20`;

  const [packRows, battleRows] = await Promise.all([
    clickhouseRead.query<PackRow>({ queryName: "analytics.packs.profit.solo", sql: packSql, params }),
    clickhouseRead.query<BattleRow>({ queryName: "analytics.packs.profit.battle", sql: battleSql, params }),
  ]);

  const packs: PackProfitRow[] = packRows.map((r) => {
    const revenue = toNumber(r.revenue);
    const payouts = toNumber(r.payouts);
    const grossMargin = revenue - payouts;
    const marginPct = revenue > 0 ? grossMargin / revenue : 0;
    return {
      id: r.id,
      name: r.name,
      opens: Number(r.opens),
      revenue,
      payouts,
      grossMargin,
      marginPct,
    };
  });

  const battles: BattlePackProfitRow[] = battleRows.map((r) => {
    const revenue = toNumber(r.revenue);
    const payouts = toNumber(r.payouts);
    const grossMargin = revenue - payouts;
    const marginPct = revenue > 0 ? grossMargin / revenue : 0;
    return {
      id: r.id,
      name: r.name,
      battlesPlayed: Number(r.battles_played),
      revenue,
      payouts,
      grossMargin,
      marginPct,
    };
  });

  return { period, packs, battles };
}

type Top24hRow = {
  id: string;
  name: string;
  image_url: string | null;
  opens: string;
};

export async function getTopOpenedPacks24hFromClickHouse(
  limit = 20,
  blacklist: string[] = [],
  now: Date = new Date(),
): Promise<TopPack24hRow[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = {
    blacklist,
    cutoff: chDateTime(cutoff),
    lim: safeLimit,
  };

  const realUsers = `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;

  const sql = `
    WITH ${realUsers},
    solo_opens AS (
      SELECT gs.game_id AS pack_id, count() AS opens
      FROM ${CH_DB}.public_game_sessions AS gs FINAL
      WHERE gs._peerdb_is_deleted = 0
        AND gs.game_type = 'pack'
        AND gs.created_at >= {cutoff:DateTime64(6)}
        AND gs.user_id IN (SELECT id FROM real_users)
      GROUP BY gs.game_id
    ),
    battle_opens AS (
      SELECT pack_id, count() AS opens
      FROM (
        SELECT arrayJoin(pack_ids) AS pack_id
        FROM (
          SELECT b.pack_ids AS pack_ids
          FROM ${CH_DB}.public_battle_participants AS bp FINAL
          INNER JOIN ${CH_DB}.public_battles AS b FINAL
            ON b.id = bp.battle_id AND b._peerdb_is_deleted = 0
          WHERE bp._peerdb_is_deleted = 0
            AND bp.created_at >= {cutoff:DateTime64(6)}
            AND bp.user_id IS NOT NULL
            AND bp.user_id IN (SELECT id FROM real_users)
        )
      )
      GROUP BY pack_id
    ),
    total_opens AS (
      SELECT pack_id, sum(opens) AS opens
      FROM (
        SELECT toString(pack_id) AS pack_id, opens FROM solo_opens
        UNION ALL
        SELECT pack_id AS pack_id, opens FROM battle_opens
      )
      GROUP BY pack_id
    )
    SELECT
      toString(p.id) AS id,
      p.name AS name,
      p.image_url AS image_url,
      toString(t.opens) AS opens
    FROM total_opens AS t
    INNER JOIN ${CH_DB}.public_packs AS p FINAL
      ON toString(p.id) = t.pack_id AND p._peerdb_is_deleted = 0
    WHERE p.pack_type != 'reward'
    ORDER BY t.opens DESC, p.id ASC
    LIMIT {lim:UInt32}`;

  const rows = await clickhouseRead.query<Top24hRow>({
    queryName: "analytics.packs.top24h",
    sql,
    params,
  });

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    imageUrl: r.image_url ?? null,
    opens: Number(r.opens),
  }));
}

export async function getPackAndBattleStatsFromClickHouse(
  period: PackBattlePeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<{ battleStats: BattleModeStats; packStats: PackPopularityStats }> {
  const [battleStats, packStats] = await Promise.all([
    getBattleStatsFromClickHouse(period, now),
    getPackPopularityFromClickHouse(period, blacklist, false, now),
  ]);
  return { battleStats, packStats };
}
