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

// Canonical reward set. `creator_tip` EXCLUDED (RESIDUAL user→user
// pass-through, $0 net house cost) so it does not fabricate reward $ in
// the geo/source distribution. `rain_tip` included so each group's rain
// house slice can be netted (`GREATEST(0, Σrain_win − Σrain_tip)`); it is
// never counted as a reward itself. Matches the corrected
// cross-category-summary / category-spend-breakdown on this page.
const ALL_REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim',
  'rain_win','rain_tip','race_prize','balance_reward_claim',
  'waitlist_prize'
)`;

// Per-group netted reward $ expression: non-rain reward legs + the rain
// house slice (GREATEST(0, Σ|rain_win| − Σ|rain_tip|)). `col` is the
// ABS(amount) column reference (inlined, trusted). Used identically in the
// SELECT and ORDER BY of each grouped query so the ordering matches the
// displayed total. rain_tip never adds to the total (funding leg).
const NETTED_REWARD_SQL = (typeCol: string, amtCol: string): string =>
  `COALESCE(SUM(CASE WHEN ${typeCol} NOT IN ('rain_win','rain_tip') THEN ABS(${amtCol}::numeric) ELSE 0 END), 0)
   + GREATEST(
       0,
       COALESCE(SUM(CASE WHEN ${typeCol} = 'rain_win' THEN ABS(${amtCol}::numeric) ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN ${typeCol} = 'rain_tip' THEN ABS(${amtCol}::numeric) ELSE 0 END), 0)
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
        -- Distinct claimants exclude rain_tip-only rows (funding leg is
        -- not a reward claim).
        COUNT(DISTINCT CASE WHEN lt.type::text <> 'rain_tip' THEN lt.user_id END)::text AS user_count,
        (${NETTED_REWARD_SQL("lt.type::text", "lt.amount")})::text AS total
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${ALL_REWARD_TYPES_SQL}
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY COALESCE(u.country_code, '??')
      ORDER BY (${NETTED_REWARD_SQL("lt.type::text", "lt.amount")}) DESC
      LIMIT ${COUNTRY_LIMIT}
    `),
    db.$queryRawUnsafe<
      { provider: string; user_count: string; total: string }[]
    >(`
      WITH claim_users AS (
        -- Carry the row id + type so the per-provider rain netting below
        -- can distinguish rain legs. id keeps DISTINCT one-row-per-ledger.
        SELECT DISTINCT lt.id, lt.user_id, lt.type::text AS type, lt.amount
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
        COUNT(DISTINCT CASE WHEN cu.type <> 'rain_tip' THEN cu.user_id END)::text AS user_count,
        (${NETTED_REWARD_SQL("cu.type", "cu.amount")})::text AS total
      FROM claim_users cu
      LEFT JOIN primary_provider pp ON pp.user_id = cu.user_id
      GROUP BY COALESCE(pp.provider, 'unknown')
      ORDER BY (${NETTED_REWARD_SQL("cu.type", "cu.amount")}) DESC
      LIMIT ${SOURCE_LIMIT}
    `),
    db.$queryRawUnsafe<{ total: string }[]>(`
      SELECT (${NETTED_REWARD_SQL("lt.type::text", "lt.amount")})::text AS total
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
