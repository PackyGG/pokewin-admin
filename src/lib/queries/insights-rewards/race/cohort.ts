import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";

/**
 * Demographics for race-prize winners on /insights/rewards/race.
 *
 * Three breakdowns based on winners (users with at least one
 * `race_claims` row) in the active window:
 *
 *   - countries       — top 8 ISO-2 country codes by winner count + share
 *   - sources         — signup provider distribution (account.providerId)
 *   - signupCohorts   — winners grouped by signup recency:
 *                       0–7d / 7–30d / 30–90d / 90–180d / 180d+ / older
 *
 * Each row carries the count, prize $ won, and share. Staff + blacklist
 * excluded. Cached per (period × blacklist).
 */

const COUNTRY_LIMIT = 8;
const SOURCE_LIMIT = 8;

export type RaceCohortRow = {
  key: string;
  label: string;
  winnerCount: number;
  totalPrize: number;
  share: number;
};

export type RaceCohortResult = {
  countries: RaceCohortRow[];
  sources: RaceCohortRow[];
  signupCohorts: RaceCohortRow[];
};

async function computeCohort(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RaceCohortResult> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter =
    days !== null
      ? `AND rc.claimed_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  const [countryRows, sourceRows, cohortRows, totalRows] = await Promise.all([
    db.$queryRawUnsafe<
      { code: string; winners: string; prize: string }[]
    >(`
      SELECT
        COALESCE(u.country_code, '??') AS code,
        COUNT(DISTINCT rc.user_id)::text AS winners,
        COALESCE(SUM(rc.prize_amount_usd::numeric), 0)::text AS prize
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY COALESCE(u.country_code, '??')
      ORDER BY SUM(rc.prize_amount_usd::numeric) DESC
      LIMIT ${COUNTRY_LIMIT}
    `),
    db.$queryRawUnsafe<
      { provider: string; winners: string; prize: string }[]
    >(`
      WITH winners AS (
        SELECT DISTINCT rc.user_id
        FROM race_claims rc
        JOIN "user" u ON u.id = rc.user_id
        WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
          ${dateFilter}
      ),
      prize_by_user AS (
        SELECT rc.user_id, SUM(rc.prize_amount_usd::numeric) AS total
        FROM race_claims rc
        JOIN winners w ON w.user_id = rc.user_id
        WHERE 1=1 ${dateFilter}
        GROUP BY rc.user_id
      ),
      primary_provider AS (
        SELECT DISTINCT ON (a."userId")
          a."userId" AS user_id,
          a."providerId" AS provider
        FROM account a
        JOIN winners w ON w.user_id = a."userId"
        ORDER BY a."userId", a.created_at ASC NULLS LAST
      )
      SELECT
        COALESCE(pp.provider, 'unknown') AS provider,
        COUNT(DISTINCT w.user_id)::text AS winners,
        COALESCE(SUM(pbu.total), 0)::text AS prize
      FROM winners w
      LEFT JOIN primary_provider pp ON pp.user_id = w.user_id
      LEFT JOIN prize_by_user pbu ON pbu.user_id = w.user_id
      GROUP BY COALESCE(pp.provider, 'unknown')
      ORDER BY COUNT(DISTINCT w.user_id) DESC
      LIMIT ${SOURCE_LIMIT}
    `),
    // Signup-recency buckets — age of the winner's account at the time
    // of their first in-window claim. Buckets keep clean breakpoints
    // common across the rest of the rewards-insights module so the
    // page reads consistently against the other rewards sub-pages.
    db.$queryRawUnsafe<
      { bucket: string; winners: string; prize: string }[]
    >(`
      WITH winner_first_claim AS (
        SELECT
          rc.user_id,
          MIN(rc.claimed_at) AS first_claim_at,
          SUM(rc.prize_amount_usd::numeric) AS prize_total
        FROM race_claims rc
        JOIN "user" u ON u.id = rc.user_id
        WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
          ${dateFilter}
        GROUP BY rc.user_id
      ),
      bucketed AS (
        SELECT
          CASE
            WHEN EXTRACT(EPOCH FROM (wfc.first_claim_at - u.created_at)) / 86400 < 7 THEN '0_7d'
            WHEN EXTRACT(EPOCH FROM (wfc.first_claim_at - u.created_at)) / 86400 < 30 THEN '7_30d'
            WHEN EXTRACT(EPOCH FROM (wfc.first_claim_at - u.created_at)) / 86400 < 90 THEN '30_90d'
            WHEN EXTRACT(EPOCH FROM (wfc.first_claim_at - u.created_at)) / 86400 < 180 THEN '90_180d'
            WHEN EXTRACT(EPOCH FROM (wfc.first_claim_at - u.created_at)) / 86400 < 365 THEN '180_365d'
            ELSE '365d_plus'
          END AS bucket,
          wfc.user_id,
          wfc.prize_total
        FROM winner_first_claim wfc
        JOIN "user" u ON u.id = wfc.user_id
      )
      SELECT
        bucket,
        COUNT(DISTINCT user_id)::text AS winners,
        COALESCE(SUM(prize_total), 0)::text AS prize
      FROM bucketed
      GROUP BY bucket
    `),
    db.$queryRawUnsafe<{ winners: string }[]>(`
      SELECT COUNT(DISTINCT rc.user_id)::text AS winners
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
    `),
  ]);

  const totalWinners = Number(totalRows[0]?.winners ?? 0);

  const COUNTRY_LABEL = (code: string) =>
    code === "??" ? "Unknown" : code;
  const countries: RaceCohortRow[] = countryRows.map((r) => ({
    key: r.code,
    label: COUNTRY_LABEL(r.code),
    winnerCount: Number(r.winners),
    totalPrize: toNumber(r.prize),
    share: totalWinners > 0 ? (Number(r.winners) / totalWinners) * 100 : 0,
  }));

  const sources: RaceCohortRow[] = sourceRows.map((r) => ({
    key: r.provider,
    label: r.provider,
    winnerCount: Number(r.winners),
    totalPrize: toNumber(r.prize),
    share: totalWinners > 0 ? (Number(r.winners) / totalWinners) * 100 : 0,
  }));

  const BUCKET_LABEL: Record<string, string> = {
    "0_7d": "0–7 days",
    "7_30d": "7–30 days",
    "30_90d": "30–90 days",
    "90_180d": "90–180 days",
    "180_365d": "180–365 days",
    "365d_plus": "1 year+",
  };
  const BUCKET_ORDER = [
    "0_7d",
    "7_30d",
    "30_90d",
    "90_180d",
    "180_365d",
    "365d_plus",
  ];
  const cohortByKey = new Map<
    string,
    { winnerCount: number; totalPrize: number }
  >();
  for (const r of cohortRows) {
    cohortByKey.set(r.bucket, {
      winnerCount: Number(r.winners),
      totalPrize: toNumber(r.prize),
    });
  }
  const signupCohorts: RaceCohortRow[] = BUCKET_ORDER.map((key) => {
    const row = cohortByKey.get(key) ?? { winnerCount: 0, totalPrize: 0 };
    return {
      key,
      label: BUCKET_LABEL[key] ?? key,
      winnerCount: row.winnerCount,
      totalPrize: row.totalPrize,
      share: totalWinners > 0 ? (row.winnerCount / totalWinners) * 100 : 0,
    };
  });

  return { countries, sources, signupCohorts };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCohort(period, blacklistIds),
  ["insights-rewards-race-cohort-v1"],
  { revalidate: 60, tags: ["insights-rewards-race"] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCohort(period, blacklistIds),
  ["insights-rewards-race-cohort-lifetime-v1"],
  { revalidate: 300, tags: ["insights-rewards-race"] },
);

export async function getRaceInsightsCohort(
  period: InsightsRewardsPeriod,
): Promise<RaceCohortResult> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300 ? cachedLong(period, sorted) : cachedShort(period, sorted);
}
