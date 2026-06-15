import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type {
  RakebackGeoSource,
  RakebackGeoSourceRow,
} from "@/lib/queries/insights-rewards/rakeback/geo-source";

import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getRakebackGeoSource`
 * (`src/lib/queries/insights-rewards/rakeback/geo-source.ts`).
 *
 * PARITY: side-by-side country (top 12) + signup-source (top 10) breakdowns of
 * rakeback $ paid to claimants, plus the grand-total denominator. The signup
 * source is each claimant's PRIMARY (earliest-created) account provider — PG's
 * `DISTINCT ON (userId) ORDER BY created_at ASC NULLS LAST` is reproduced with
 * `argMin(providerId, created_at)` (CH `argMin` ignores NULL ordering values,
 * matching NULLS LAST). Share % is derived in TS off the grand total, identical
 * to the PG twin.
 *
 * SCOPE (mirrors PG EXACTLY): `role NOT IN ('admin','support','creator')` +
 * blacklist — `customerScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every mirror table,
 * `uniqExact` for distinct user counts, money Decimal (`toString(sum(...))`),
 * scale-matched `toDecimal128(0, 2)` zero-branch.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTRY_LIMIT = 12;
const SOURCE_LIMIT = 10;

type CodeRow = { code: string; user_count: string; total: string };
type ProviderRow = { provider: string; user_count: string; total: string };
type TotalRow = { total: string };

export async function getRakebackGeoSourceFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RakebackGeoSource> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = customerScopeCte({ hasBlacklist });

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND rc.claimed_at >= {cutoff:DateTime64(6)}";
  }

  const [countryRows, sourceRows, totalRows] = await Promise.all([
    clickhouseRead.query<CodeRow>({
      queryName: "insights.rewards.rakeback.geo.country",
      sql: `
        WITH ${scope}
        SELECT
          coalesce(u.country_code, '??')        AS code,
          toString(uniqExact(rc.user_id))       AS user_count,
          toString(sum(rc.rakeback_amount_usd)) AS total
        FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
        INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = rc.user_id
        WHERE rc._peerdb_is_deleted = 0
          AND u._peerdb_is_deleted = 0
          AND rc.claimed_at IS NOT NULL
          AND rc.user_id IN (SELECT id FROM real_users)
          ${dateClause}
        GROUP BY coalesce(u.country_code, '??')
        ORDER BY sum(rc.rakeback_amount_usd) DESC
        LIMIT ${COUNTRY_LIMIT}`,
      params,
    }),
    clickhouseRead.query<ProviderRow>({
      queryName: "insights.rewards.rakeback.geo.source",
      sql: `
        WITH
          ${scope},
          claim_agg AS (
            SELECT
              rc.user_id AS user_id,
              sum(rc.rakeback_amount_usd) AS rakeback
            FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
            WHERE rc._peerdb_is_deleted = 0
              AND rc.claimed_at IS NOT NULL
              AND rc.user_id IN (SELECT id FROM real_users)
              ${dateClause}
            GROUP BY rc.user_id
          ),
          primary_provider AS (
            SELECT
              a.userId AS user_id,
              argMin(a.providerId, a.created_at) AS provider
            FROM ${CH_DB}.public_account AS a FINAL
            WHERE a._peerdb_is_deleted = 0
              AND a.userId IN (SELECT user_id FROM claim_agg)
            GROUP BY a.userId
          )
        SELECT
          coalesce(pp.provider, 'unknown') AS provider,
          toString(uniqExact(c.user_id))   AS user_count,
          toString(sum(c.rakeback))        AS total
        FROM claim_agg AS c
        LEFT JOIN primary_provider AS pp ON pp.user_id = c.user_id
        GROUP BY coalesce(pp.provider, 'unknown')
        ORDER BY sum(c.rakeback) DESC
        LIMIT ${SOURCE_LIMIT}`,
      params,
    }),
    clickhouseRead.query<TotalRow>({
      queryName: "insights.rewards.rakeback.geo.total",
      sql: `
        WITH ${scope}
        SELECT toString(sum(rc.rakeback_amount_usd)) AS total
        FROM ${CH_DB}.public_rakeback_claims AS rc FINAL
        WHERE rc._peerdb_is_deleted = 0
          AND rc.claimed_at IS NOT NULL
          AND rc.user_id IN (SELECT id FROM real_users)
          ${dateClause}`,
      params,
    }),
  ]);

  const totalRakeback = toNumber(totalRows[0]?.total);
  const countries: RakebackGeoSourceRow[] = countryRows.map((r) => {
    const total = toNumber(r.total);
    return {
      key: r.code,
      label: r.code,
      userCount: Number(r.user_count),
      total,
      share: totalRakeback > 0 ? (total / totalRakeback) * 100 : 0,
    };
  });
  const sources: RakebackGeoSourceRow[] = sourceRows.map((r) => {
    const total = toNumber(r.total);
    return {
      key: r.provider,
      label: r.provider,
      userCount: Number(r.user_count),
      total,
      share: totalRakeback > 0 ? (total / totalRakeback) * 100 : 0,
    };
  });

  return { countries, sources, totalRakeback };
}
