import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

export type UserRewards = {
  openOneTimeCount: number;
  rakebackClaimableUsd: number;
  rakebackClaimedUsd: number;
};

export async function getUserRewards(userId: string): Promise<UserRewards> {
  // Each number was previously computed by fetching every row and
  // aggregating in JS. Push all three down to SQL so the payload stays
  // at O(1) regardless of the user's reward history size.
  const [openOneTimeCount, rakebackRows] = await Promise.all([
    db.user_rewards.count({
      where: {
        user_id: userId,
        opened_at: null,
        rewards: { type: "one_time" },
      },
    }),
    db.$queryRaw<{ claimable: string; claimed: string }[]>`
      SELECT
        COALESCE(SUM(CASE WHEN claimed_at IS NULL     THEN rakeback_amount_usd::numeric ELSE 0 END), 0)::text AS claimable,
        COALESCE(SUM(CASE WHEN claimed_at IS NOT NULL THEN rakeback_amount_usd::numeric ELSE 0 END), 0)::text AS claimed
      FROM rakeback_claims
      WHERE user_id = ${userId}
    `,
  ]);

  const rr = rakebackRows[0];

  return {
    openOneTimeCount,
    rakebackClaimableUsd: toNumber(rr?.claimable ?? 0),
    rakebackClaimedUsd: toNumber(rr?.claimed ?? 0),
  };
}
