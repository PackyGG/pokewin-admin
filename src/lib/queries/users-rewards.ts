import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

export type UserRewards = {
  openOneTimeCount: number;
  rakebackClaimableUsd: number;
  rakebackClaimedUsd: number;
};

export async function getUserRewards(userId: string): Promise<UserRewards> {
  const [userRewards, rakebackRows] = await Promise.all([
    db.user_rewards.findMany({
      where: { user_id: userId },
      include: {
        rewards: { select: { type: true } },
      },
    }),
    db.rakeback_claims.findMany({
      where: { user_id: userId },
      select: { rakeback_amount_usd: true, claimed_at: true },
    }),
  ]);

  // Open one-time rewards = those that haven't been opened yet
  let openOneTimeCount = 0;
  for (const ur of userRewards) {
    if (ur.rewards.type === "one_time" && ur.opened_at == null) {
      openOneTimeCount++;
    }
  }

  // Rakeback split (claimed vs claimable)
  let rakebackClaimableUsd = 0;
  let rakebackClaimedUsd = 0;
  for (const r of rakebackRows) {
    const amt = toNumber(r.rakeback_amount_usd);
    if (r.claimed_at) rakebackClaimedUsd += amt;
    else rakebackClaimableUsd += amt;
  }

  return {
    openOneTimeCount,
    rakebackClaimableUsd,
    rakebackClaimedUsd,
  };
}
