import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import type { RewardsPeriod } from "./rewards-analytics";

/**
 * Category-specific extras for the deep-stats tabs on
 * /rewards/analytics. The shared `rewards-category-analytics.ts` helper
 * gives every tab the same baseline (total / count / avg / median / max
 * / unique / daily / top users / top days). These extras are the
 * per-category nuances:
 *
 *   - Race      → distinct races, avg prize per race, largest single
 *                 prize, top race by total prize pool in the window
 *   - Affiliate → distinct affiliates paid + avg per affiliate (top
 *                 list comes from the shared helper since affiliate
 *                 claim rows are filed under the affiliate user_id)
 *   - Sign Up   → cohort = first-time `balance_reward_claim` per user
 *                 in the window. Median time-to-claim from signup,
 *                 24h / 7d claim share, drop-off share.
 *
 * Source of truth in every query is `ledger_transactions` with `status
 * = 'completed'` AND the category's ledger type — same shape as the
 * shared helper so the totals reconcile by construction.
 *
 * Each helper is cached with `unstable_cache` (60s revalidate, tag
 * `rewards-analytics`) so the per-tab swap stays cheap when admins
 * flip between Overview and a category.
 */

function daysForPeriod(period: RewardsPeriod): number | null {
  switch (period) {
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return null;
  }
}

// ── Race extras ───────────────────────────────────────────────────────

export type RaceExtras = {
  /** Distinct (race_type, race_period_start) pairs contributing prize-claim rows in the window. */
  distinctRaces: number;
  /** Average prize per race = totalVolume / distinctRaces (0 when no races). */
  avgPrizePerRace: number;
  /** Largest single prize payout in the window. */
  largestSinglePrize: number;
  /** Top race by total prize pool in the window — null when no races. */
  topRace: {
    raceType: string;
    periodStart: string;
    totalPrizePool: number;
    winnerCount: number;
  } | null;
};

async function computeRaceExtras(
  period: RewardsPeriod,
  blacklistIds: string[],
): Promise<RaceExtras> {
  const db = await getDb();
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND rc.claimed_at >= NOW() - INTERVAL '${days} days'` : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // race_claims is the canonical source for prize wins — links the
  // user, the race instance (race_type + period_start), and the prize
  // amount. We sweep it instead of `ledger_transactions` so the
  // (race_type, period_start) grouping is direct without parsing
  // metadata. Staff + blacklist excluded via JOIN to user.
  const [rollupRows, topRaceRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        distinct_races: string;
        largest_prize: string | null;
      }[]
    >(`
      SELECT
        COUNT(DISTINCT (rc.race_type, rc.race_period_start))::text AS distinct_races,
        MAX(rc.prize_amount_usd::numeric)::text AS largest_prize
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
    `),
    db.$queryRawUnsafe<
      {
        race_type: string;
        period_start: Date;
        total_pool: string;
        winner_count: string;
      }[]
    >(`
      SELECT
        rc.race_type::text AS race_type,
        rc.race_period_start AS period_start,
        SUM(rc.prize_amount_usd::numeric)::text AS total_pool,
        COUNT(*)::text AS winner_count
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY rc.race_type, rc.race_period_start
      ORDER BY SUM(rc.prize_amount_usd::numeric) DESC
      LIMIT 1
    `),
  ]);

  const rollup = rollupRows[0];
  const distinctRaces = Number(rollup?.distinct_races ?? 0);
  const largestSinglePrize =
    rollup?.largest_prize != null ? toNumber(rollup.largest_prize) : 0;

  // Re-derive total prize volume from the same race_claims source so
  // the avgPrizePerRace ratio is internally consistent (it pairs with
  // the count we already have here). Cheap separate aggregate.
  const totalRows = await db.$queryRawUnsafe<{ total: string }[]>(`
    SELECT COALESCE(SUM(rc.prize_amount_usd::numeric), 0)::text AS total
    FROM race_claims rc
    JOIN "user" u ON u.id = rc.user_id
    WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${dateFilter}
  `);
  const totalVolume = toNumber(totalRows[0]?.total);
  const avgPrizePerRace = distinctRaces > 0 ? totalVolume / distinctRaces : 0;

  const topRaceRow = topRaceRows[0];
  const topRace = topRaceRow
    ? {
        raceType: topRaceRow.race_type,
        periodStart: new Date(topRaceRow.period_start)
          .toISOString()
          .split("T")[0],
        totalPrizePool: toNumber(topRaceRow.total_pool),
        winnerCount: Number(topRaceRow.winner_count),
      }
    : null;

  return {
    distinctRaces,
    avgPrizePerRace,
    largestSinglePrize,
    topRace,
  };
}

const cachedRaceExtras = unstable_cache(
  async (period: RewardsPeriod, blacklistIds: string[]) =>
    computeRaceExtras(period, blacklistIds),
  ["rewards-race-extras-v1"],
  { revalidate: 60, tags: ["rewards-analytics"] },
);

export async function getRaceExtras(
  period: RewardsPeriod,
): Promise<RaceExtras> {
  const blacklist = await getExcludedUserIds();
  return cachedRaceExtras(period, [...blacklist].sort());
}

// ── Affiliate extras ──────────────────────────────────────────────────

export type AffiliateExtras = {
  /** Distinct affiliate accounts that received at least one payout. */
  distinctAffiliates: number;
  /** Average payout per affiliate = totalVolume / distinctAffiliates. */
  avgPayoutPerAffiliate: number;
};

async function computeAffiliateExtras(
  period: RewardsPeriod,
  blacklistIds: string[],
): Promise<AffiliateExtras> {
  const db = await getDb();
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const blacklistSubquery = blacklistNotInClause("id", blacklistIds);

  // `affiliate_claim` rows file under the affiliate's user_id, so the
  // distinct count IS the number of paid affiliates in the window.
  // Staff + blacklist excluded via the same user_id subquery the
  // shared helper uses.
  const rows = await db.$queryRawUnsafe<
    { affiliates: string; total: string }[]
  >(`
    SELECT
      COUNT(DISTINCT lt.user_id)::text AS affiliates,
      COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type = 'affiliate_claim'
      AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
      ${dateFilter}
  `);

  const row = rows[0];
  const distinctAffiliates = Number(row?.affiliates ?? 0);
  const total = toNumber(row?.total);
  const avgPayoutPerAffiliate =
    distinctAffiliates > 0 ? total / distinctAffiliates : 0;

  return { distinctAffiliates, avgPayoutPerAffiliate };
}

const cachedAffiliateExtras = unstable_cache(
  async (period: RewardsPeriod, blacklistIds: string[]) =>
    computeAffiliateExtras(period, blacklistIds),
  ["rewards-affiliate-extras-v1"],
  { revalidate: 60, tags: ["rewards-analytics"] },
);

export async function getAffiliateExtras(
  period: RewardsPeriod,
): Promise<AffiliateExtras> {
  const blacklist = await getExcludedUserIds();
  return cachedAffiliateExtras(period, [...blacklist].sort());
}

// ── Sign Up extras ────────────────────────────────────────────────────

export type SignupExtras = {
  /** Total users who signed up in the window (the cohort denominator). */
  cohortSignups: number;
  /** Distinct first-time balance_reward_claim users in the window (cohort numerator). */
  newClaimants: number;
  /** Median time-to-claim from signup for the cohort in hours, 0 when empty. */
  medianHoursToClaim: number;
  /** Share of the cohort who claimed within 24h of signup (0–1). */
  shareClaimWithin24h: number;
  /** Share of the cohort who claimed within 7d of signup (0–1). */
  shareClaimWithin7d: number;
  /**
   * Drop-off share — fraction of users who signed up in the window but
   * never made a balance_reward_claim (0–1, signup-window-only).
   */
  dropOffShare: number;
};

async function computeSignupExtras(
  period: RewardsPeriod,
  blacklistIds: string[],
): Promise<SignupExtras> {
  const db = await getDb();
  const days = daysForPeriod(period);
  const signupDateFilter =
    days !== null
      ? `AND u.created_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Cohort = users who signed up inside the window AND made at least
  // one `balance_reward_claim` (their first one is the claim event we
  // care about). For each cohort user we compute the gap between
  // their signup and their first claim, then derive the median and
  // 24h / 7d cumulative shares from that single sweep.
  //
  // The drop-off metric pairs distinct signups in the window against
  // distinct claimants from the same signup cohort — so the
  // denominator is the signup count, not the all-users count.
  const rows = await db.$queryRawUnsafe<
    {
      hours_diff: string;
      claimed_within_24h: number;
      claimed_within_7d: number;
    }[]
  >(`
    WITH cohort AS (
      SELECT u.id AS user_id, u.created_at AS signed_up_at
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${signupDateFilter}
    ),
    first_claim AS (
      SELECT
        c.user_id,
        c.signed_up_at,
        MIN(lt.created_at) AS first_claim_at
      FROM cohort c
      JOIN ledger_transactions lt
        ON lt.user_id = c.user_id
       AND lt.status = 'completed'
       AND lt.type = 'balance_reward_claim'
      GROUP BY c.user_id, c.signed_up_at
    )
    SELECT
      EXTRACT(EPOCH FROM (first_claim_at - signed_up_at)) / 3600 AS hours_diff,
      CASE WHEN first_claim_at <= signed_up_at + INTERVAL '24 hours' THEN 1 ELSE 0 END AS claimed_within_24h,
      CASE WHEN first_claim_at <= signed_up_at + INTERVAL '7 days' THEN 1 ELSE 0 END AS claimed_within_7d
    FROM first_claim
  `);

  // Cohort signup count drives the drop-off denominator. Cheap
  // separate aggregate keeps the main CTE focused on claimants.
  const cohortCountRows = await db.$queryRawUnsafe<{ cnt: string }[]>(`
    SELECT COUNT(*)::text AS cnt
    FROM "user" u
    WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${signupDateFilter}
  `);
  const cohortSignups = Number(cohortCountRows[0]?.cnt ?? 0);

  const claimantCount = rows.length;
  const hours = rows
    .map((r) => Number(r.hours_diff))
    .filter((h) => Number.isFinite(h) && h >= 0);
  hours.sort((a, b) => a - b);
  const medianHoursToClaim =
    hours.length === 0
      ? 0
      : hours.length % 2 === 1
        ? hours[(hours.length - 1) / 2]
        : (hours[hours.length / 2 - 1] + hours[hours.length / 2]) / 2;

  const within24h = rows.filter((r) => Number(r.claimed_within_24h) === 1).length;
  const within7d = rows.filter((r) => Number(r.claimed_within_7d) === 1).length;
  const shareClaimWithin24h = claimantCount > 0 ? within24h / claimantCount : 0;
  const shareClaimWithin7d = claimantCount > 0 ? within7d / claimantCount : 0;
  const dropOffShare =
    cohortSignups > 0 ? (cohortSignups - claimantCount) / cohortSignups : 0;

  return {
    cohortSignups,
    newClaimants: claimantCount,
    medianHoursToClaim,
    shareClaimWithin24h,
    shareClaimWithin7d,
    dropOffShare,
  };
}

const cachedSignupExtras = unstable_cache(
  async (period: RewardsPeriod, blacklistIds: string[]) =>
    computeSignupExtras(period, blacklistIds),
  ["rewards-signup-extras-v1"],
  { revalidate: 60, tags: ["rewards-analytics"] },
);

export async function getSignupExtras(
  period: RewardsPeriod,
): Promise<SignupExtras> {
  const blacklist = await getExcludedUserIds();
  return cachedSignupExtras(period, [...blacklist].sort());
}
