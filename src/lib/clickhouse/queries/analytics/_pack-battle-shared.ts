import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime } from "../_shared";
import type {
  BattleModeStats,
  PackPopularityStats,
} from "@/lib/queries/analytics";

/**
 * Shared ClickHouse builders for the battle-mode / pack-popularity aggregates
 * that BOTH the /analytics OVERVIEW tab (`getAnalyticsData`) and the PACKS tab
 * (`getPackAndBattleStats`) render. The Postgres twins duplicate this SQL
 * verbatim across `computeAnalyticsData` and `computePackAndBattleStats`; these
 * helpers centralise the CH version so the two surfaces can never drift.
 *
 * SCOPE (mirrors the PG twins EXACTLY):
 *   • Battle stats: `role != 'admin'` only (support + creators KEPT), NO
 *     blacklist — exactly the PG `battleStaffExcl`.
 *   • Top packs: real-customer scope on the opener. OVERVIEW drops creators
 *     wholesale (`role NOT IN ('admin','support','creator')`); the PACKS slim
 *     variant keeps creators (`role NOT IN ('admin','support')`). Both apply the
 *     blacklist. The `excludeCreators` flag selects which, per leg.
 *
 * Windows: `today` anchors at midnight UTC of the current day; `7d`/`30d`/`90d`
 * are rolling N-day from `now`; `all` has no lower bound (matches
 * `battleSinceFragment` / `periodToDateFilter`).
 */

export type PackBattlePeriod = "today" | "7d" | "30d" | "90d" | "all";

export function packBattleCutoff(
  period: PackBattlePeriod,
  now: Date,
): Date | null {
  if (period === "all") return null;
  if (period === "today") {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

type ModeRow = { mode: string; count: string };
type SettingRow = { setting: string; count: string };
type FlagRow = {
  total_battles: string;
  borrow_count: string;
  sponsored_count: string;
  private_count: string;
};
type FormatRow = { teams: number; players_per_team: number; count: string };
type TopBattlePackRow = { id: string; name: string; count: string };
type TopPackRow = {
  id: string;
  name: string;
  opens_total: string;
  opens_borrowed: string;
};

export async function getBattleStatsFromClickHouse(
  period: PackBattlePeriod,
  now: Date = new Date(),
): Promise<BattleModeStats> {
  const cutoff = packBattleCutoff(period, now);
  const params: Record<string, unknown> = {};
  if (cutoff !== null) params.cutoff = chDateTime(cutoff);
  const bCutoff =
    cutoff !== null ? "AND b.created_at >= {cutoff:DateTime64(6)}" : "";

  const nonAdmin = `non_admin AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role != 'admin'
    )`;

  const modeSql = `
    WITH ${nonAdmin}
    SELECT toString(b.mode) AS mode, toString(count()) AS count
    FROM ${CH_DB}.public_battles AS b FINAL
    WHERE b._peerdb_is_deleted = 0
      AND b.user_id IN (SELECT id FROM non_admin)
      ${bCutoff}
    GROUP BY b.mode
    ORDER BY count() DESC, mode ASC`;

  const settingSql = `
    WITH ${nonAdmin}
    SELECT setting AS setting, toString(count()) AS count
    FROM (
      SELECT arrayJoin(b.additional_settings) AS setting
      FROM ${CH_DB}.public_battles AS b FINAL
      WHERE b._peerdb_is_deleted = 0
        AND b.user_id IN (SELECT id FROM non_admin)
        ${bCutoff}
    )
    GROUP BY setting
    ORDER BY count() DESC, setting ASC`;

  const flagSql = `
    WITH ${nonAdmin}
    SELECT
      toString(count()) AS total_battles,
      toString(countIf(b.borrow_percentage > 0)) AS borrow_count,
      toString(countIf(b.sponsorship_percentage > 0)) AS sponsored_count,
      toString(countIf(b.password IS NOT NULL)) AS private_count
    FROM ${CH_DB}.public_battles AS b FINAL
    WHERE b._peerdb_is_deleted = 0
      AND b.user_id IN (SELECT id FROM non_admin)
      ${bCutoff}`;

  const formatSql = `
    WITH ${nonAdmin}
    SELECT b.teams AS teams, b.players_per_team AS players_per_team, toString(count()) AS count
    FROM ${CH_DB}.public_battles AS b FINAL
    WHERE b._peerdb_is_deleted = 0
      AND b.user_id IN (SELECT id FROM non_admin)
      ${bCutoff}
    GROUP BY b.teams, b.players_per_team
    ORDER BY count() DESC, teams ASC, players_per_team ASC`;

  const topBattlePacksSql = `
    WITH ${nonAdmin}
    SELECT p.id AS id, p.name AS name, toString(ej.cnt) AS count
    FROM (
      SELECT arrayJoin(b.pack_ids) AS pid, count() AS cnt
      FROM ${CH_DB}.public_battles AS b FINAL
      WHERE b._peerdb_is_deleted = 0
        AND b.user_id IN (SELECT id FROM non_admin)
        ${bCutoff}
      GROUP BY pid
    ) ej
    INNER JOIN ${CH_DB}.public_packs AS p FINAL
      ON toString(p.id) = ej.pid AND p._peerdb_is_deleted = 0
    ORDER BY ej.cnt DESC, p.id ASC
    LIMIT 10`;

  const [modeRows, settingRows, flagRows, formatRows, topBattlePackRows] =
    await Promise.all([
      clickhouseRead.query<ModeRow>({ queryName: "analytics.packBattle.mode", sql: modeSql, params }),
      clickhouseRead.query<SettingRow>({ queryName: "analytics.packBattle.setting", sql: settingSql, params }),
      clickhouseRead.query<FlagRow>({ queryName: "analytics.packBattle.flags", sql: flagSql, params }),
      clickhouseRead.query<FormatRow>({ queryName: "analytics.packBattle.format", sql: formatSql, params }),
      clickhouseRead.query<TopBattlePackRow>({ queryName: "analytics.packBattle.topBattlePacks", sql: topBattlePacksSql, params }),
    ]);

  return {
    totalBattles: Number(flagRows[0]?.total_battles ?? 0),
    byMode: modeRows.map((r) => ({ mode: r.mode, count: Number(r.count) })),
    bySetting: settingRows.map((r) => ({
      setting: r.setting,
      count: Number(r.count),
    })),
    byFormat: formatRows.map((r) => ({
      format:
        Number(r.teams) === 2 && Number(r.players_per_team) === 1
          ? "1v1"
          : Array(Number(r.teams))
              .fill(String(Number(r.players_per_team)))
              .join("v"),
      count: Number(r.count),
    })),
    borrowCount: Number(flagRows[0]?.borrow_count ?? 0),
    sponsoredCount: Number(flagRows[0]?.sponsored_count ?? 0),
    privateCount: Number(flagRows[0]?.private_count ?? 0),
    topBattlePacks: topBattlePackRows.map((r) => ({
      id: r.id,
      name: r.name,
      count: Number(r.count),
    })),
  };
}

export async function getPackPopularityFromClickHouse(
  period: PackBattlePeriod,
  blacklist: string[],
  excludeCreators: boolean,
  now: Date = new Date(),
): Promise<PackPopularityStats> {
  const cutoff = packBattleCutoff(period, now);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  if (cutoff !== null) params.cutoff = chDateTime(cutoff);
  const ltCutoff =
    cutoff !== null ? "AND lt.created_at >= {cutoff:DateTime64(6)}" : "";

  const roleFilter = excludeCreators
    ? "role NOT IN ('admin','support','creator')"
    : "role NOT IN ('admin','support')";
  const realUsers = `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND ${roleFilter}
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;

  const topPacksSql = `
    WITH ${realUsers}
    SELECT
      toString(p.id) AS id,
      p.name AS name,
      toString(count()) AS opens_total,
      toString(countIf(lt.description ILIKE '%borrow%')) AS opens_borrowed
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    INNER JOIN ${CH_DB}.public_game_sessions AS gs FINAL
      ON gs.id = lt.game_session_id AND gs._peerdb_is_deleted = 0 AND gs.game_type = 'pack'
    INNER JOIN ${CH_DB}.public_packs AS p FINAL
      ON p.id = gs.game_id AND p._peerdb_is_deleted = 0
    WHERE lt._peerdb_is_deleted = 0
      AND lt.type = 'pack_opening'
      AND lt.status = 'completed'
      AND lt.user_id IN (SELECT id FROM real_users)
      ${ltCutoff}
    GROUP BY p.id, p.name
    ORDER BY count() DESC, p.id ASC
    LIMIT 20`;

  const rows = await clickhouseRead.query<TopPackRow>({
    queryName: "analytics.packBattle.topPacks",
    sql: topPacksSql,
    params,
  });

  return {
    topPacks: rows.map((r) => {
      const total = Number(r.opens_total);
      const borrowed = Number(r.opens_borrowed);
      return {
        id: r.id,
        name: r.name,
        opensTotal: total,
        opensBorrowed: borrowed,
        opensNormal: total - borrowed,
      };
    }),
    topBorrowedPacks: rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        opensBorrowed: Number(r.opens_borrowed),
        opensTotal: Number(r.opens_total),
      }))
      .filter((p) => p.opensBorrowed > 0)
      .sort((a, b) => b.opensBorrowed - a.opensBorrowed)
      .slice(0, 10),
  };
}
