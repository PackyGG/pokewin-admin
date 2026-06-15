import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * ClickHouse twin of `@/lib/queries/map` `getUsersByCountry` — geographic
 * distribution of users + per-country deposit/wager money, read from the
 * `packy_prod` CDC mirror. Comparison-mode only.
 *
 * SCOPE mirrored EXACTLY from the PG twin:
 *   • role NOT IN ('admin','support') (creators KEPT) + excluded-users blacklist.
 *   • byCountry / totals / withoutLocation windowed on the USER's created_at;
 *     per-country financials windowed on the LEDGER row's created_at.
 *   • `today` = since UTC-midnight today; 7d/30d/90d = NOW()-N days; all = no
 *     window.
 *   • financials: deposits = Σ|amount| (type='deposit', completed); deposit_count
 *     = COUNT of same; wager = Σ|amount| of the 4-type wager set (completed).
 *
 * Ranked rows use a stable `count() DESC, country_code ASC` tie-break so the
 * top-N ordering is deterministic on ties (PG leaves ties unordered).
 */

export type Period = "today" | "7d" | "30d" | "90d" | "all";

export type CountryUserCountCh = {
  country_code: string;
  country: string | null;
  user_count: number;
  total_deposits: number;
  deposit_count: number;
  total_wager: number;
};

export type MapDataCh = {
  byCountry: CountryUserCountCh[];
  totalUsers: number;
  withoutLocation: number;
};

const periodToDays: Record<Exclude<Period, "all" | "today">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

function utcStartOfDay(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

const WAGER_MAP_TYPES =
  "('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')";

export async function getUsersByCountryFromClickHouse(
  period: Period,
  blacklist: string[],
  now: Date = new Date(),
): Promise<MapDataCh> {
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };

  // User-side + ledger-side window cutoffs share the same instant.
  let userDateFilter: (col: string) => string = () => "";
  if (period !== "all") {
    const cutoffDate =
      period === "today"
        ? utcStartOfDay(now)
        : new Date(now.getTime() - periodToDays[period] * 86_400_000);
    params.cutoff = chDateTime(cutoffDate);
    userDateFilter = (col: string) => `AND ${col} >= {cutoff:DateTime64(6)}`;
  }

  const blacklistClause = (col: string) =>
    hasBlacklist ? `AND ${col} NOT IN {blacklist:Array(String)}` : "";

  const userScope = `role NOT IN ('admin','support') ${blacklistClause("id")}`;

  const byCountrySql = `
    SELECT
      country_code,
      max(country)      AS country,
      toString(count()) AS user_count
    FROM ${CH_DB}.public_user FINAL
    WHERE _peerdb_is_deleted = 0
      AND ${userScope}
      AND country_code IS NOT NULL
      ${userDateFilter("created_at")}
    GROUP BY country_code
    ORDER BY count() DESC, country_code ASC`;

  const totalSql = `
    SELECT toString(count()) AS total
    FROM ${CH_DB}.public_user FINAL
    WHERE _peerdb_is_deleted = 0
      AND ${userScope}
      ${userDateFilter("created_at")}`;

  const withoutLocationSql = `
    SELECT toString(count()) AS total
    FROM ${CH_DB}.public_user FINAL
    WHERE _peerdb_is_deleted = 0
      AND ${userScope}
      AND country_code IS NULL
      ${userDateFilter("created_at")}`;

  // Per-country financials: INNER JOIN all in-window ledger rows of in-scope
  // users with a country_code, summing the deposit/wager legs conditionally.
  const financialsSql = `
    WITH real_users AS (
      SELECT id, country_code
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND ${userScope}
        AND country_code IS NOT NULL
    )
    SELECT
      u.country_code AS country_code,
      toString(sumIf(abs(lt.amount), lt.type = 'deposit' AND lt.status = 'completed')) AS total_deposits,
      toString(countIf(lt.type = 'deposit' AND lt.status = 'completed'))               AS deposit_count,
      toString(sumIf(abs(lt.amount), lt.type IN ${WAGER_MAP_TYPES} AND lt.status = 'completed')) AS total_wager
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    INNER JOIN real_users AS u ON u.id = lt.user_id
    WHERE lt._peerdb_is_deleted = 0
      ${userDateFilter("lt.created_at")}
    GROUP BY u.country_code`;

  const [byCountryRaw, financialsRaw, totalRaw, withoutLocationRaw] =
    await Promise.all([
      clickhouseRead.query<{
        country_code: string;
        country: string | null;
        user_count: string;
      }>({ queryName: "analytics.map.by_country", sql: byCountrySql, params }),
      clickhouseRead.query<{
        country_code: string;
        total_deposits: string;
        deposit_count: string;
        total_wager: string;
      }>({ queryName: "analytics.map.financials", sql: financialsSql, params }),
      clickhouseRead.query<{ total: string }>({
        queryName: "analytics.map.total",
        sql: totalSql,
        params,
      }),
      clickhouseRead.query<{ total: string }>({
        queryName: "analytics.map.without_location",
        sql: withoutLocationSql,
        params,
      }),
    ]);

  const financialsMap = new Map(
    financialsRaw.map((f) => [
      f.country_code,
      {
        total_deposits: toNumber(f.total_deposits),
        deposit_count: Number(f.deposit_count),
        total_wager: toNumber(f.total_wager),
      },
    ]),
  );

  return {
    byCountry: byCountryRaw.map((r) => {
      const fin = financialsMap.get(r.country_code);
      return {
        country_code: r.country_code,
        country: r.country,
        user_count: Number(r.user_count),
        total_deposits: fin?.total_deposits ?? 0,
        deposit_count: fin?.deposit_count ?? 0,
        total_wager: fin?.total_wager ?? 0,
      };
    }),
    totalUsers: Number(totalRaw[0]?.total ?? "0"),
    withoutLocation: Number(withoutLocationRaw[0]?.total ?? "0"),
  };
}
