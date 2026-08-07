import { blacklistNotInSql, daysAgoFilter, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getReadDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Geo + signup-source breakdown for rakeback claimants.
 *
 * Side-by-side breakdowns:
 *   - Country : top 12 countries by rakeback $ paid to claimants. Each
 *               row: ISO-2 code (NULL → "??"), user count, total $, share.
 *   - Source  : top 10 signup sources by rakeback $. `account.providerId`
 *               of each claimant's primary (first-created) account row
 *               drives the provider bucket.
 *
 * Source: `rakeback_claims`. Staff + blacklist excluded.
 */

const COUNTRY_LIMIT = 12;
const SOURCE_LIMIT = 10;

type RakebackGeoSourceRow = {
  key: string;
  label: string;
  userCount: number;
  total: number;
  share: number;
};

export type RakebackGeoSource = {
  countries: RakebackGeoSourceRow[];
  sources: RakebackGeoSourceRow[];
  /** Total rakeback $ in window — reference for share math. */
  totalRakeback: number;
};

async function computeGeoSource(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RakebackGeoSource> {
  const db = await getReadDrizzleDb();
  const days = daysForInsightsPeriod(period);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);
  const dateFilter = daysAgoFilter("rc.claimed_at", days);

  const [countryRows, sourceRows, totalRows] = await Promise.all([
    queryRows<
      { code: string; user_count: string; total: string }[]
    >(db, sql`
      SELECT
        COALESCE(u.country_code, '??') AS code,
        COUNT(DISTINCT rc.user_id)::text AS user_count,
        COALESCE(SUM(rc.rakeback_amount_usd::numeric), 0)::text AS total
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
        ${dateFilter}
      GROUP BY COALESCE(u.country_code, '??')
      ORDER BY SUM(rc.rakeback_amount_usd::numeric) DESC
      LIMIT ${COUNTRY_LIMIT}
    `),
    queryRows<
      { provider: string; user_count: string; total: string }[]
    >(db, sql`
      WITH claim_agg AS (
        SELECT
          rc.user_id,
          SUM(rc.rakeback_amount_usd::numeric) AS rakeback
        FROM rakeback_claims rc
        JOIN "user" u ON u.id = rc.user_id
        WHERE rc.claimed_at IS NOT NULL
          AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
          ${dateFilter}
        GROUP BY rc.user_id
      ),
      primary_provider AS (
        SELECT DISTINCT ON (a."userId")
          a."userId" AS user_id,
          a."providerId" AS provider
        FROM account a
        JOIN claim_agg c ON c.user_id = a."userId"
        ORDER BY a."userId", a.created_at ASC NULLS LAST
      )
      SELECT
        COALESCE(pp.provider, 'unknown') AS provider,
        COUNT(DISTINCT c.user_id)::text AS user_count,
        COALESCE(SUM(c.rakeback), 0)::text AS total
      FROM claim_agg c
      LEFT JOIN primary_provider pp ON pp.user_id = c.user_id
      GROUP BY COALESCE(pp.provider, 'unknown')
      ORDER BY SUM(c.rakeback) DESC
      LIMIT ${SOURCE_LIMIT}
    `),
    queryRows<{ total: string }[]>(db, sql`
      SELECT COALESCE(SUM(rc.rakeback_amount_usd::numeric), 0)::text AS total
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
        ${dateFilter}
    `),
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

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeGeoSource(period, blacklistIds),
  ["insights-rewards-rakeback-geo-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeGeoSource(period, blacklistIds),
  ["insights-rewards-rakeback-geo-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards-rakeback"] },
);

export async function getRakebackGeoSource(
  period: InsightsRewardsPeriod,
): Promise<RakebackGeoSource> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
