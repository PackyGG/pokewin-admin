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
import { WAGER_TYPES_SQL } from "@/lib/queries/_wager-payout-types";
import { SIGNUP_CACHE_TAG } from "./_shared";

/**
 * Top-15 country distribution for /insights/rewards/signup.
 *
 * Per country in the in-window signup cohort:
 *   - signups
 *   - claimants (cohort users with ≥1 balance_reward_claim)
 *   - claim rate (claimants / signups)
 *   - claim volume (SUM of ABS(amount) for cohort claim rows from that country)
 *   - avg per claim
 *   - 7d retention share (cohort users with any wager/deposit ≤ signup_at + 7d)
 *
 * Countries are keyed on `user.country_code` (ISO-2). NULL country
 * collapses to "??" so the row still surfaces — admins want to know
 * how many "no country" signups exist.
 *
 * Top 15 by signup count + an "Other" bucket for everything else, so
 * the chart fits on one screen without losing the long tail.
 *
 * Also returns a continent rollup (continent_code) for an at-a-glance
 * regional read above the per-country list.
 */

export type SignupCountryRow = {
  code: string;
  signups: number;
  claimants: number;
  claimRate: number;
  claimVolume: number;
  avgPerClaim: number;
  retention7dShare: number | null;
};

export type SignupContinentRow = {
  code: string;
  signups: number;
  claimants: number;
  claimRate: number;
};

export type SignupCountryBreakdown = {
  countries: SignupCountryRow[];
  continents: SignupContinentRow[];
  totalSignups: number;
};

async function computeCountry(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<SignupCountryBreakdown> {
  const db = await getReadDrizzleDb();
  const days = daysForInsightsPeriod(period);
  const signupDateFilter = daysAgoFilter("u.created_at", days);
  const blacklistJoin = blacklistNotInSql("u.id", blacklistIds);

  type CountryRow = {
    code: string;
    signups: string;
    claimants: string;
    claim_volume: string;
    retained_7d: string;
  };
  const countryRows = await queryRows<CountryRow[]>(db, sql`
    WITH cohort AS (
      SELECT
        u.id AS user_id,
        u.created_at AS signed_up_at,
        COALESCE(u.country_code, '??') AS code
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${signupDateFilter}
    ),
    claim_users AS (
      SELECT DISTINCT c.user_id, c.code
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'balance_reward_claim'
    ),
    claim_volume AS (
      SELECT c.code, SUM(ABS(lt.amount::numeric)) AS volume
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'balance_reward_claim'
      GROUP BY c.code
    ),
    retained_7d AS (
      SELECT c.code, COUNT(DISTINCT c.user_id) AS retained
      FROM cohort c
      WHERE EXISTS (
        SELECT 1 FROM ledger_transactions lt
        WHERE lt.user_id = c.user_id
          AND lt.status = 'completed'
          AND (lt.type::text = 'deposit' OR lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)})
          AND lt.created_at <= c.signed_up_at + INTERVAL '7 days'
      )
      GROUP BY c.code
    )
    SELECT
      c.code,
      COUNT(*)::text AS signups,
      (SELECT COUNT(*) FROM claim_users cu WHERE cu.code = c.code)::text AS claimants,
      COALESCE((SELECT volume FROM claim_volume cv WHERE cv.code = c.code), 0)::text AS claim_volume,
      COALESCE((SELECT retained FROM retained_7d rt WHERE rt.code = c.code), 0)::text AS retained_7d
    FROM cohort c
    GROUP BY c.code
    ORDER BY COUNT(*) DESC
  `);

  const totalSignups = countryRows.reduce(
    (a, r) => a + Number(r.signups),
    0,
  );

  const TOP_LIMIT = 15;
  const top = countryRows.slice(0, TOP_LIMIT);
  const tail = countryRows.slice(TOP_LIMIT);

  const build = (r: CountryRow): SignupCountryRow => {
    const signups = Number(r.signups);
    const claimants = Number(r.claimants);
    const claimVolume = toNumber(r.claim_volume);
    const retained = Number(r.retained_7d);
    return {
      code: r.code,
      signups,
      claimants,
      claimRate: signups > 0 ? claimants / signups : 0,
      claimVolume,
      avgPerClaim: claimants > 0 ? claimVolume / claimants : 0,
      retention7dShare: signups > 0 ? retained / signups : null,
    };
  };

  const countries: SignupCountryRow[] = top.map(build);
  if (tail.length > 0) {
    const tailSignups = tail.reduce((a, r) => a + Number(r.signups), 0);
    const tailClaimants = tail.reduce(
      (a, r) => a + Number(r.claimants),
      0,
    );
    const tailVolume = tail.reduce(
      (a, r) => a + toNumber(r.claim_volume),
      0,
    );
    const tailRetained = tail.reduce(
      (a, r) => a + Number(r.retained_7d),
      0,
    );
    countries.push({
      code: "Other",
      signups: tailSignups,
      claimants: tailClaimants,
      claimRate: tailSignups > 0 ? tailClaimants / tailSignups : 0,
      claimVolume: tailVolume,
      avgPerClaim:
        tailClaimants > 0 ? tailVolume / tailClaimants : 0,
      retention7dShare:
        tailSignups > 0 ? tailRetained / tailSignups : null,
    });
  }

  // ── Continent rollup ───────────────────────────────────────────────
  // continent_code defaults to "NA" per schema (not nullable). Same
  // cohort, just a coarser grain — useful banner above the country
  // table.
  type ContinentRow = {
    code: string;
    signups: string;
    claimants: string;
  };
  const continentRows = await queryRows<ContinentRow[]>(db, sql`
    WITH cohort AS (
      SELECT u.id AS user_id, u.continent_code AS code
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${signupDateFilter}
    ),
    claim_users AS (
      SELECT DISTINCT c.user_id, c.code
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type::text = 'balance_reward_claim'
    )
    SELECT
      c.code,
      COUNT(*)::text AS signups,
      (SELECT COUNT(*) FROM claim_users cu WHERE cu.code = c.code)::text AS claimants
    FROM cohort c
    GROUP BY c.code
    ORDER BY COUNT(*) DESC
  `);
  const continents: SignupContinentRow[] = continentRows.map((r) => {
    const signups = Number(r.signups);
    const claimants = Number(r.claimants);
    return {
      code: r.code,
      signups,
      claimants,
      claimRate: signups > 0 ? claimants / signups : 0,
    };
  });

  return { countries, continents, totalSignups };
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCountry(period, blacklistIds),
  ["insights-rewards-signup-country-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCountry(period, blacklistIds),
  ["insights-rewards-signup-country-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupCountryBreakdown(
  period: InsightsRewardsPeriod,
): Promise<SignupCountryBreakdown> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const data = await (cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted));
  return data;
}
