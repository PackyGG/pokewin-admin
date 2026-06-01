import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { SIGNUP_CACHE_TAG } from "./_shared";

/**
 * Top 25 lifetime signup-bonus recipients for /insights/rewards/signup.
 *
 * NOTE: this query is intentionally NOT cohort-restricted on the
 * signup-window — for the "top recipients" tab the value is the
 * leaderboard of WHO claimed the most across history (or the chosen
 * window). The window filter applies to the `lt.created_at` of the
 * claim rows, not the user's signup time.
 *
 * For each top-25 user:
 *   - userId + username
 *   - country_code
 *   - signed_up_at
 *   - claim_count
 *   - claim_volume (SUM ABS amount)
 *   - largest_claim
 *   - first_claim_at
 *   - last_claim_at
 *   - deposit_total (lifetime, for the leaderboard's profile lens)
 *
 * 25 rows is the spec; widen if needed by changing TOP_LIMIT.
 */

export type SignupTopRecipientRow = {
  userId: string;
  username: string | null;
  countryCode: string | null;
  signedUpAt: string;
  claimCount: number;
  claimVolume: number;
  largestClaim: number;
  firstClaimAt: string;
  lastClaimAt: string;
  depositTotal: number;
};

async function computeTopRecipients(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<SignupTopRecipientRow[]> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const dateFilter =
    days !== null
      ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  type Row = {
    user_id: string;
    username: string | null;
    country_code: string | null;
    signed_up_at: Date;
    claim_count: string;
    claim_volume: string;
    largest_claim: string;
    first_claim_at: Date;
    last_claim_at: Date;
    deposit_total: string;
  };

  const rows = await db.$queryRawUnsafe<Row[]>(`
    WITH claims AS (
      SELECT
        lt.user_id,
        COUNT(*) AS claim_count,
        SUM(ABS(lt.amount::numeric)) AS claim_volume,
        MAX(ABS(lt.amount::numeric)) AS largest_claim,
        MIN(lt.created_at) AS first_claim_at,
        MAX(lt.created_at) AS last_claim_at
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = 'balance_reward_claim'
        ${dateFilter}
      GROUP BY lt.user_id
    ),
    deposit_totals AS (
      SELECT lt.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS deposit_total
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type = 'deposit'
      GROUP BY lt.user_id
    )
    SELECT
      u.id AS user_id,
      u.username,
      u.country_code,
      u.created_at AS signed_up_at,
      c.claim_count::text AS claim_count,
      c.claim_volume::text AS claim_volume,
      c.largest_claim::text AS largest_claim,
      c.first_claim_at,
      c.last_claim_at,
      COALESCE(dt.deposit_total, 0)::text AS deposit_total
    FROM claims c
    JOIN "user" u ON u.id = c.user_id
    LEFT JOIN deposit_totals dt ON dt.user_id = c.user_id
    WHERE u.role NOT IN ('admin', 'support') ${blacklistJoin}
    ORDER BY c.claim_volume DESC
    LIMIT 25
  `);

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    countryCode: r.country_code,
    signedUpAt: new Date(r.signed_up_at).toISOString(),
    claimCount: Number(r.claim_count),
    claimVolume: toNumber(r.claim_volume),
    largestClaim: toNumber(r.largest_claim),
    firstClaimAt: new Date(r.first_claim_at).toISOString(),
    lastClaimAt: new Date(r.last_claim_at).toISOString(),
    depositTotal: toNumber(r.deposit_total),
  }));
}

const cachedShort = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTopRecipients(period, blacklistIds),
  ["insights-rewards-signup-top-recipients-v1"],
  { revalidate: 60, tags: [SIGNUP_CACHE_TAG] },
);

const cachedLong = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeTopRecipients(period, blacklistIds),
  ["insights-rewards-signup-top-recipients-lifetime-v1"],
  { revalidate: 300, tags: [SIGNUP_CACHE_TAG] },
);

export async function getSignupTopRecipients(
  period: InsightsRewardsPeriod,
): Promise<SignupTopRecipientRow[]> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return cacheTtlForInsightsPeriod(period) >= 300
    ? cachedLong(period, sorted)
    : cachedShort(period, sorted);
}
