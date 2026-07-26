import { blacklistNotInSql, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";
import {
  DEPOSIT_BONUS_CACHE_TAGS,
  getResolvedBlacklist,
  windowDateFilter,
} from "./_shared";

/**
 * Geo + signup-source distribution of DEPOSIT BONUS claimants.
 *
 * Reuses the same patterns as the cross-category `geo-source.ts` but
 * narrowed to `type = 'deposit_bonus'`. Surfaces:
 *
 *   - top 12 countries by bonus volume (ISO-2 code, claimant count, $)
 *   - top 10 signup sources by bonus volume (provider id from first
 *     `account` row per user, claimant count, $)
 *
 * Staff + blacklist excluded. Read-only.
 */

const COUNTRY_LIMIT = 12;
const SOURCE_LIMIT = 10;

export type GeoSourceRow = {
  /** ISO-2 code or "??" for unknown. */
  key: string;
  label: string;
  userCount: number;
  total: number;
  avgPerUser: number;
  share: number;
};

export type DepositBonusGeoSource = {
  countries: GeoSourceRow[];
  sources: GeoSourceRow[];
  /** Sum across all claimants — reference for share math. */
  totalCost: number;
};

async function computeGeoSource(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<DepositBonusGeoSource> {
  const db = await getDrizzleDb();
  const dateFilter = windowDateFilter(period);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  const [countryRows, sourceRows, totalRows] = await Promise.all([
    queryRows<
      { code: string; user_count: string; total: string }[]
    >(db, sql`
      SELECT
        COALESCE(u.country_code, '??') AS code,
        COUNT(DISTINCT lt.user_id)::text AS user_count,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY COALESCE(u.country_code, '??')
      ORDER BY SUM(ABS(lt.amount::numeric)) DESC
      LIMIT ${COUNTRY_LIMIT}
    `),
    queryRows<
      { provider: string; user_count: string; total: string }[]
    >(db, sql`
      WITH claim_users AS (
        SELECT lt.user_id, lt.amount
        FROM ledger_transactions lt
        JOIN "user" u ON u.id = lt.user_id
        WHERE lt.status = 'completed'
          AND lt.type::text = 'deposit_bonus'
          AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
          ${dateFilter}
      ),
      primary_provider AS (
        SELECT DISTINCT ON (a."userId")
          a."userId" AS user_id,
          a."providerId" AS provider
        FROM account a
        WHERE a."userId" IN (SELECT DISTINCT user_id FROM claim_users)
        ORDER BY a."userId", a.created_at ASC NULLS LAST
      )
      SELECT
        COALESCE(pp.provider, 'unknown') AS provider,
        COUNT(DISTINCT cu.user_id)::text AS user_count,
        COALESCE(SUM(ABS(cu.amount::numeric)), 0)::text AS total
      FROM claim_users cu
      LEFT JOIN primary_provider pp ON pp.user_id = cu.user_id
      GROUP BY COALESCE(pp.provider, 'unknown')
      ORDER BY SUM(ABS(cu.amount::numeric)) DESC
      LIMIT ${SOURCE_LIMIT}
    `),
    queryRows<{ total: string }[]>(db, sql`
      SELECT COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
    `),
  ]);

  const totalCost = toNumber(totalRows[0]?.total);

  const buildRow = (r: { key: string; userCount: number; total: number }): GeoSourceRow => ({
    key: r.key,
    label: r.key,
    userCount: r.userCount,
    total: r.total,
    avgPerUser: r.userCount > 0 ? r.total / r.userCount : 0,
    share: totalCost > 0 ? (r.total / totalCost) * 100 : 0,
  });

  const countries = countryRows.map((r) =>
    buildRow({
      key: r.code,
      userCount: Number(r.user_count ?? 0),
      total: toNumber(r.total),
    }),
  );
  const sources = sourceRows.map((r) =>
    buildRow({
      key: r.provider,
      userCount: Number(r.user_count ?? 0),
      total: toNumber(r.total),
    }),
  );

  return { countries, sources, totalCost };
}

const cachedGeoSource = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeGeoSource(period, blacklistIds),
  ["insights-rewards-deposit-bonus-geo-source-v1"],
  { revalidate: 60, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

const cachedGeoSourceLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeGeoSource(period, blacklistIds),
  ["insights-rewards-deposit-bonus-geo-source-lifetime-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusGeoSource(
  period: InsightsRewardsPeriod,
): Promise<DepositBonusGeoSource> {
  const blacklist = await getResolvedBlacklist();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedGeoSourceLifetime(period, blacklist)
    : cachedGeoSource(period, blacklist);
}
