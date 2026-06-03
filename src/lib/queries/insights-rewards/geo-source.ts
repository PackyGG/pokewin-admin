import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";

/**
 * Geo + signup-source distribution of reward claimants.
 *
 * For the active window we surface two side-by-side breakdowns:
 *
 *   - Country : top 12 countries by reward $ paid to users in that
 *               country. Each row carries the ISO-2 code, the user
 *               count, the total reward $, and the share. Users with
 *               null `country_code` collapse to "??".
 *   - Source  : top 10 signup sources by reward $. Each row carries
 *               the provider id from the first `account` row per
 *               user (joined per the SignupExtras pattern), the
 *               user count, the total reward $, and the share.
 *
 * Per the existing patterns on this page, staff + blacklist are
 * excluded. Read-only sweep. Cached per window.
 */

const ALL_REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim',
  'rain_win','race_prize','balance_reward_claim','creator_tip',
  'waitlist_prize'
)`;

const COUNTRY_LIMIT = 12;
const SOURCE_LIMIT = 10;

export type GeoSourceRow = {
  key: string;
  label: string;
  userCount: number;
  total: number;
  share: number;
};

export type RewardsGeoSourceBreakdown = {
  countries: GeoSourceRow[];
  sources: GeoSourceRow[];
  /** Sum of reward $ across all claimants in window. Reference for share math. */
  totalRewardCost: number;
};

async function computeGeoSource(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RewardsGeoSourceBreakdown> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Country breakdown — JOIN ledger rows to users and group by their
  // country_code. Distinct user count via COUNT(DISTINCT user_id) per
  // country bucket.
  const [countryRows, sourceRows, totalRows] = await Promise.all([
    db.$queryRawUnsafe<
      { code: string; user_count: string; total: string }[]
    >(`
      SELECT
        COALESCE(u.country_code, '??') AS code,
        COUNT(DISTINCT lt.user_id)::text AS user_count,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${ALL_REWARD_TYPES_SQL}
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY COALESCE(u.country_code, '??')
      ORDER BY SUM(ABS(lt.amount::numeric)) DESC
      LIMIT ${COUNTRY_LIMIT}
    `),
    db.$queryRawUnsafe<
      { provider: string; user_count: string; total: string }[]
    >(`
      WITH claim_users AS (
        SELECT DISTINCT lt.user_id, lt.amount, lt.created_at
        FROM ledger_transactions lt
        JOIN "user" u ON u.id = lt.user_id
        WHERE lt.status = 'completed'
          AND lt.type::text IN ${ALL_REWARD_TYPES_SQL}
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
    db.$queryRawUnsafe<{ total: string }[]>(`
      SELECT COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${ALL_REWARD_TYPES_SQL}
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
    `),
  ]);

  const totalRewardCost = toNumber(totalRows[0]?.total);
  const countries: GeoSourceRow[] = countryRows.map((r) => {
    const total = toNumber(r.total);
    return {
      key: r.code,
      label: r.code,
      userCount: Number(r.user_count ?? 0),
      total,
      share: totalRewardCost > 0 ? (total / totalRewardCost) * 100 : 0,
    };
  });
  const sources: GeoSourceRow[] = sourceRows.map((r) => {
    const total = toNumber(r.total);
    return {
      key: r.provider,
      label: r.provider,
      userCount: Number(r.user_count ?? 0),
      total,
      share: totalRewardCost > 0 ? (total / totalRewardCost) * 100 : 0,
    };
  });

  return { countries, sources, totalRewardCost };
}

const cachedGeoSource = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeGeoSource(period, blacklistIds),
  ["insights-rewards-geo-source-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards"] },
);

const cachedGeoSourceLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeGeoSource(period, blacklistIds),
  ["insights-rewards-geo-source-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

export async function getRewardsGeoSourceBreakdown(
  period: InsightsRewardsPeriod,
): Promise<RewardsGeoSourceBreakdown> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedGeoSourceLifetime(period, sorted)
    : cachedGeoSource(period, sorted);
}
