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
  /**
   * Configured per-race prize budget (sum of `race_prize_tiers` USD
   * across daily + weekly + monthly). Multiplied by `distinctRaces`
   * gives the total budget in the window — but races are typed and
   * a given window can contain a mix, so the headline shows just
   * the per-instance budget. UsageRate computes the actual share
   * spent against the right denominator.
   */
  perRaceBudget: number;
  /** SUM of `race_prize_tiers` USD restricted to races that actually had winners in the window. */
  budgetForRunRaces: number;
  /** distinctRaces' total prize volume / budgetForRunRaces, 0–1. */
  budgetUtilisation: number;
  /**
   * Average winner position across `race_claims` in the window.
   * Lower → top-heavy (top positions dominate prize spend). 0 when
   * no claims.
   */
  avgWinnerPosition: number;
  /**
   * Median winner position. Same lens as avgWinnerPosition but
   * resistant to a single big-position outlier.
   */
  medianWinnerPosition: number;
  /**
   * Position-bucket distribution. Top-3 / 4-10 / 11-25 / 26+ — each
   * bucket holds the prize-claim count and total USD volume. Bucket
   * boundaries match the typical race-tier configuration.
   */
  positionBuckets: Array<{ label: string; count: number; volume: number }>;
  /**
   * Repeat winners — users who won in MORE than one race in the
   * window. Returned as the count + the top 5 by total prize volume.
   */
  repeatWinnerCount: number;
  topRepeatWinners: Array<{
    userId: string;
    username: string | null;
    races: number;
    totalPrize: number;
  }>;
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

  // Per-race configured budget — SUM of `race_prize_tiers.prize_amount_usd`
  // per race_type, then summed across daily + weekly + monthly so the
  // headline is "what every full race CAN cost". Cheap one-row aggregate
  // (table has ≤ ~60 rows total).
  const budgetRows = await db.$queryRawUnsafe<{ total: string }[]>(`
    SELECT COALESCE(SUM(prize_amount_usd::numeric), 0)::text AS total
    FROM race_prize_tiers
  `);
  const perRaceBudget = toNumber(budgetRows[0]?.total);

  // Budget for races that actually had a winner in the window — sum
  // the tier budget per (race_type) for every distinct race instance
  // observed. Two-query approach: (1) get distinct race_type counts
  // in the window, (2) multiply by per-type budget.
  const typeCountRows = await db.$queryRawUnsafe<
    { race_type: string; instances: string; per_type_budget: string }[]
  >(`
    WITH distinct_in_window AS (
      SELECT
        rc.race_type::text AS race_type,
        COUNT(DISTINCT rc.race_period_start)::text AS instances
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY rc.race_type
    ),
    type_budget AS (
      SELECT race_type::text AS race_type, SUM(prize_amount_usd::numeric)::text AS budget
      FROM race_prize_tiers
      GROUP BY race_type
    )
    SELECT
      d.race_type,
      d.instances,
      COALESCE(t.budget, '0') AS per_type_budget
    FROM distinct_in_window d
    LEFT JOIN type_budget t USING (race_type)
  `);
  let budgetForRunRaces = 0;
  for (const r of typeCountRows) {
    budgetForRunRaces +=
      Number(r.instances) * toNumber(r.per_type_budget);
  }
  const budgetUtilisation =
    budgetForRunRaces > 0 ? totalVolume / budgetForRunRaces : 0;

  // Winner position spread — avg, median, bucket distribution.
  const positionRows = await db.$queryRawUnsafe<
    { position: number; prize: string }[]
  >(`
    SELECT
      rc.position,
      rc.prize_amount_usd::text AS prize
    FROM race_claims rc
    JOIN "user" u ON u.id = rc.user_id
    WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${dateFilter}
  `);
  const positions = positionRows
    .map((r) => Number(r.position))
    .filter((p) => Number.isFinite(p) && p > 0);
  const avgWinnerPosition =
    positions.length > 0
      ? positions.reduce((a, b) => a + b, 0) / positions.length
      : 0;
  const sortedPositions = [...positions].sort((a, b) => a - b);
  const medianWinnerPosition =
    sortedPositions.length === 0
      ? 0
      : sortedPositions.length % 2 === 1
        ? sortedPositions[(sortedPositions.length - 1) / 2]
        : (sortedPositions[sortedPositions.length / 2 - 1] +
            sortedPositions[sortedPositions.length / 2]) /
          2;

  // Position buckets — top 3 / 4-10 / 11-25 / 26+. Boundaries match
  // the typical race tier breakpoints (3 podium / first 10 / first 25
  // / overflow) so the distribution maps onto common race configs.
  const BUCKETS = ["Top 3", "4–10", "11–25", "26+"];
  const positionBuckets: RaceExtras["positionBuckets"] = BUCKETS.map(
    (label) => ({ label, count: 0, volume: 0 }),
  );
  for (let i = 0; i < positionRows.length; i++) {
    const pos = Number(positionRows[i].position);
    const prize = toNumber(positionRows[i].prize);
    let idx: number;
    if (!Number.isFinite(pos) || pos <= 0) continue;
    if (pos <= 3) idx = 0;
    else if (pos <= 10) idx = 1;
    else if (pos <= 25) idx = 2;
    else idx = 3;
    positionBuckets[idx].count += 1;
    positionBuckets[idx].volume += prize;
  }

  // Repeat winners — users with claims across multiple distinct
  // (race_type, race_period_start) instances. Returned as count + top
  // 5 by total prize volume so the UI can spotlight the heavy hitters.
  const repeatRows = await db.$queryRawUnsafe<
    {
      user_id: string;
      username: string | null;
      races: string;
      total_prize: string;
    }[]
  >(`
    WITH per_user AS (
      SELECT
        rc.user_id,
        COUNT(DISTINCT (rc.race_type, rc.race_period_start))::int AS races,
        SUM(rc.prize_amount_usd::numeric) AS total_prize
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY rc.user_id
      HAVING COUNT(DISTINCT (rc.race_type, rc.race_period_start)) > 1
    )
    SELECT
      pu.user_id,
      u.username,
      pu.races::text,
      pu.total_prize::text AS total_prize
    FROM per_user pu
    JOIN "user" u ON u.id = pu.user_id
    ORDER BY pu.total_prize DESC
    LIMIT 5
  `);
  const repeatCountRows = await db.$queryRawUnsafe<{ cnt: string }[]>(`
    WITH per_user AS (
      SELECT rc.user_id, COUNT(DISTINCT (rc.race_type, rc.race_period_start))::int AS races
      FROM race_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
      GROUP BY rc.user_id
    )
    SELECT COUNT(*)::text AS cnt FROM per_user WHERE races > 1
  `);
  const repeatWinnerCount = Number(repeatCountRows[0]?.cnt ?? 0);
  const topRepeatWinners = repeatRows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    races: Number(r.races),
    totalPrize: toNumber(r.total_prize),
  }));

  return {
    distinctRaces,
    avgPrizePerRace,
    largestSinglePrize,
    topRace,
    perRaceBudget,
    budgetForRunRaces,
    budgetUtilisation,
    avgWinnerPosition,
    medianWinnerPosition,
    positionBuckets,
    repeatWinnerCount,
    topRepeatWinners,
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

// ── Rakeback extras ──────────────────────────────────────────────────

/**
 * Rakeback extras for the deep-stats tab.
 *
 * Source of truth here is `rakeback_claims` (NOT `ledger_transactions`)
 * because the dedicated table carries `wagered_amount_usd` AND
 * `rakeback_amount_usd` per claim — the SAME numbers the ledger payout
 * uses but with the originating wager pre-attached. That means the
 * "% of wager" cohort lens is a direct ratio, no expensive sweep over
 * the wager-ledger needed.
 *
 * Per the user spec the rakeback tab gets:
 *   - avgRakebackPctOfWager   — SUM(rakeback) / SUM(wager) across the
 *                               period (volume-weighted; one number).
 *   - medianRakebackPctOfWager — per-claim ratio's median (gives a feel
 *                                for the "typical" claim instead of the
 *                                blended total which gets dragged by
 *                                whales).
 *   - rateBuckets             — distribution of per-claim ratios in
 *                               buckets matching the daily/weekly/
 *                               monthly rakeback-tier defaults.
 *   - rakebackTypeSpread      — per `rakeback_type` (daily / weekly /
 *                               monthly): count, volume, share.
 *   - claimsPerUser           — distinct claimants (== uniqueRecipients
 *                               in the baseline) + avg claims per user
 *                               + median per-user-claim count.
 *   - lapsedClaimants         — users who claimed in the prior window
 *                               of equal length but NOT in the current
 *                               window. Returned as a count only (top-N
 *                               leaderboard would need user metadata
 *                               we don't pre-cache here).
 *   - medianHoursBetweenClaims — across users with ≥2 claims in the
 *                                window, median gap in hours.
 *
 * PROPOSED (skipped this pass):
 *   - Streak distribution. Daily/weekly streak detection needs a
 *     date-bucketed sweep per user with consecutive-run accounting —
 *     possible in SQL but would dominate the tab's query cost. Better
 *     as a popover or its own page.
 *   - metadata.rake_rate spread. rakeback_claims has no metadata
 *     column for the rate — only the resolved USD amounts. Rate per
 *     tier is in `rakeback_config` but isn't joined to individual
 *     claims, so a per-tier rate spread would be config-only, not a
 *     historical observation. PROPOSED.
 */
export type RakebackExtras = {
  /** SUM(rakeback) / SUM(wager) across the window, 0–1. */
  avgRakebackPctOfWager: number;
  /** Median of per-claim (rakeback / wager), 0–1. */
  medianRakebackPctOfWager: number;
  /** Distribution buckets of per-claim ratio (0–1) → count + volume. */
  rateBuckets: Array<{ label: string; count: number; volume: number }>;
  /** Per-rakeback-type slice (daily / weekly / monthly). */
  rakebackTypeSpread: Array<{
    type: "daily" | "weekly" | "monthly";
    count: number;
    volume: number;
    share: number;
  }>;
  /** Distinct claimants in the window. */
  distinctClaimants: number;
  /** Avg claims per claimant = count / distinctClaimants. */
  avgClaimsPerUser: number;
  /** Median claims per user (integer-valued). */
  medianClaimsPerUser: number;
  /**
   * Median gap in hours between consecutive claims, per user. Across
   * users with ≥2 claims in the window. 0 when no qualifying user.
   */
  medianHoursBetweenClaims: number;
  /**
   * Users who claimed in the prior-equal window but NOT in the
   * current window. `null` when the period is "all" (no prior window
   * defined for all-time).
   */
  lapsedClaimants: number | null;
};

async function computeRakebackExtras(
  period: RewardsPeriod,
  blacklistIds: string[],
): Promise<RakebackExtras> {
  const db = await getDb();
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null
      ? `AND rc.claimed_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Rollup: total wager + total rakeback + count + distinct claimants.
  // `rakeback_claims` has both wager and rakeback per row, so this is
  // a single aggregate, no ledger sweep.
  const rollupRows = await db.$queryRawUnsafe<
    {
      total_wager: string | null;
      total_rakeback: string | null;
      cnt: string;
      distinct_users: string;
    }[]
  >(`
    SELECT
      COALESCE(SUM(rc.wagered_amount_usd::numeric), 0)::text AS total_wager,
      COALESCE(SUM(rc.rakeback_amount_usd::numeric), 0)::text AS total_rakeback,
      COUNT(*)::text AS cnt,
      COUNT(DISTINCT rc.user_id)::text AS distinct_users
    FROM rakeback_claims rc
    JOIN "user" u ON u.id = rc.user_id
    WHERE rc.claimed_at IS NOT NULL
      AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${dateFilter}
  `);
  const rollup = rollupRows[0];
  const totalWager = toNumber(rollup?.total_wager);
  const totalRakeback = toNumber(rollup?.total_rakeback);
  const count = Number(rollup?.cnt ?? 0);
  const distinctClaimants = Number(rollup?.distinct_users ?? 0);
  const avgRakebackPctOfWager = totalWager > 0 ? totalRakeback / totalWager : 0;
  const avgClaimsPerUser = distinctClaimants > 0 ? count / distinctClaimants : 0;

  // Per-claim ratio distribution + median. Rakeback rate ceiling in
  // `rakeback_config` defaults are sub-5%, but we widen the buckets
  // here so legitimate top-tier configurations don't crash off the
  // last bin.
  const ratioRows = await db.$queryRawUnsafe<
    { ratio: string; rakeback: string }[]
  >(`
    SELECT
      (rc.rakeback_amount_usd::numeric / NULLIF(rc.wagered_amount_usd::numeric, 0))::text AS ratio,
      rc.rakeback_amount_usd::text AS rakeback
    FROM rakeback_claims rc
    JOIN "user" u ON u.id = rc.user_id
    WHERE rc.claimed_at IS NOT NULL
      AND rc.wagered_amount_usd::numeric > 0
      AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${dateFilter}
  `);
  const ratios = ratioRows.map((r) => Number(r.ratio)).filter(Number.isFinite);
  ratios.sort((a, b) => a - b);
  const medianRakebackPctOfWager =
    ratios.length === 0
      ? 0
      : ratios.length % 2 === 1
        ? ratios[(ratios.length - 1) / 2]
        : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;

  // 0–0.5% / 0.5–1% / 1–2% / 2–5% / 5%+ — buckets sized so most rows
  // land in the lower three under typical configurations, while the
  // 5%+ catch-all flags promo-coupled outliers.
  const BUCKET_LABELS = ["0–0.5%", "0.5–1%", "1–2%", "2–5%", "5%+"];
  const buckets: RakebackExtras["rateBuckets"] = BUCKET_LABELS.map((label) => ({
    label,
    count: 0,
    volume: 0,
  }));
  for (let i = 0; i < ratioRows.length; i++) {
    const rTimes100 = Number(ratioRows[i].ratio) * 100;
    const rakeUsd = toNumber(ratioRows[i].rakeback);
    let idx: number;
    if (!Number.isFinite(rTimes100)) continue;
    if (rTimes100 < 0.5) idx = 0;
    else if (rTimes100 < 1) idx = 1;
    else if (rTimes100 < 2) idx = 2;
    else if (rTimes100 < 5) idx = 3;
    else idx = 4;
    buckets[idx].count += 1;
    buckets[idx].volume += rakeUsd;
  }

  // Rakeback type spread (daily / weekly / monthly).
  const typeRows = await db.$queryRawUnsafe<
    { rakeback_type: string; cnt: string; volume: string }[]
  >(`
    SELECT
      rc.rakeback_type::text AS rakeback_type,
      COUNT(*)::text AS cnt,
      COALESCE(SUM(rc.rakeback_amount_usd::numeric), 0)::text AS volume
    FROM rakeback_claims rc
    JOIN "user" u ON u.id = rc.user_id
    WHERE rc.claimed_at IS NOT NULL
      AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${dateFilter}
    GROUP BY rc.rakeback_type
  `);
  const TYPES: Array<"daily" | "weekly" | "monthly"> = [
    "daily",
    "weekly",
    "monthly",
  ];
  const typeByName = new Map<string, { count: number; volume: number }>();
  for (const r of typeRows) {
    typeByName.set(r.rakeback_type, {
      count: Number(r.cnt),
      volume: toNumber(r.volume),
    });
  }
  const rakebackTypeSpread = TYPES.map((t) => {
    const row = typeByName.get(t) ?? { count: 0, volume: 0 };
    return {
      type: t,
      count: row.count,
      volume: row.volume,
      share: totalRakeback > 0 ? (row.volume / totalRakeback) * 100 : 0,
    };
  });

  // Per-user claim count distribution → median.
  const perUserRows = await db.$queryRawUnsafe<{ cnt: string }[]>(`
    SELECT COUNT(*)::text AS cnt
    FROM rakeback_claims rc
    JOIN "user" u ON u.id = rc.user_id
    WHERE rc.claimed_at IS NOT NULL
      AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
      ${dateFilter}
    GROUP BY rc.user_id
  `);
  const perUserCounts = perUserRows
    .map((r) => Number(r.cnt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const medianClaimsPerUser =
    perUserCounts.length === 0
      ? 0
      : perUserCounts.length % 2 === 1
        ? perUserCounts[(perUserCounts.length - 1) / 2]
        : (perUserCounts[perUserCounts.length / 2 - 1] +
            perUserCounts[perUserCounts.length / 2]) /
          2;

  // Median gap (hours) between consecutive claims per user — pulled
  // server-side via LAG so the round-trip is one query. Median taken
  // in JS over the user-mean gaps to avoid a per-user median CTE.
  const gapRows = await db.$queryRawUnsafe<
    { user_id: string; mean_gap_h: string }[]
  >(`
    WITH ordered AS (
      SELECT
        rc.user_id,
        rc.claimed_at,
        LAG(rc.claimed_at) OVER (PARTITION BY rc.user_id ORDER BY rc.claimed_at) AS prev_claim
      FROM rakeback_claims rc
      JOIN "user" u ON u.id = rc.user_id
      WHERE rc.claimed_at IS NOT NULL
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${dateFilter}
    )
    SELECT
      user_id,
      AVG(EXTRACT(EPOCH FROM (claimed_at - prev_claim)) / 3600)::text AS mean_gap_h
    FROM ordered
    WHERE prev_claim IS NOT NULL
    GROUP BY user_id
  `);
  const userGapsH = gapRows
    .map((r) => Number(r.mean_gap_h))
    .filter((h) => Number.isFinite(h) && h >= 0)
    .sort((a, b) => a - b);
  const medianHoursBetweenClaims =
    userGapsH.length === 0
      ? 0
      : userGapsH.length % 2 === 1
        ? userGapsH[(userGapsH.length - 1) / 2]
        : (userGapsH[userGapsH.length / 2 - 1] +
            userGapsH[userGapsH.length / 2]) /
          2;

  // Lapsed claimants — users who claimed in the prior-equal window
  // but not the current one. Only meaningful when `period !== all`.
  let lapsedClaimants: number | null = null;
  if (days !== null) {
    const lapsedRows = await db.$queryRawUnsafe<{ cnt: string }[]>(`
      WITH current_users AS (
        SELECT DISTINCT rc.user_id
        FROM rakeback_claims rc
        JOIN "user" u ON u.id = rc.user_id
        WHERE rc.claimed_at IS NOT NULL
          AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
          AND rc.claimed_at >= NOW() - INTERVAL '${days} days'
      ),
      prior_users AS (
        SELECT DISTINCT rc.user_id
        FROM rakeback_claims rc
        JOIN "user" u ON u.id = rc.user_id
        WHERE rc.claimed_at IS NOT NULL
          AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
          AND rc.claimed_at >= NOW() - INTERVAL '${days * 2} days'
          AND rc.claimed_at < NOW() - INTERVAL '${days} days'
      )
      SELECT COUNT(*)::text AS cnt
      FROM prior_users p
      WHERE NOT EXISTS (SELECT 1 FROM current_users c WHERE c.user_id = p.user_id)
    `);
    lapsedClaimants = Number(lapsedRows[0]?.cnt ?? 0);
  }

  return {
    avgRakebackPctOfWager,
    medianRakebackPctOfWager,
    rateBuckets: buckets,
    rakebackTypeSpread,
    distinctClaimants,
    avgClaimsPerUser,
    medianClaimsPerUser,
    medianHoursBetweenClaims,
    lapsedClaimants,
  };
}

const cachedRakebackExtras = unstable_cache(
  async (period: RewardsPeriod, blacklistIds: string[]) =>
    computeRakebackExtras(period, blacklistIds),
  ["rewards-rakeback-extras-v1"],
  { revalidate: 60, tags: ["rewards-analytics"] },
);

export async function getRakebackExtras(
  period: RewardsPeriod,
): Promise<RakebackExtras> {
  const blacklist = await getExcludedUserIds();
  return cachedRakebackExtras(period, [...blacklist].sort());
}
