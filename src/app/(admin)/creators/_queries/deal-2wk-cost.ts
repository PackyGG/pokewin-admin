import "server-only";

import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";

const WINDOW_DAYS = 14;

// How many times a per-deal leaderboard can pay out inside a 14-day
// window, by the deal's configured frequency. "Max cost" framing — a
// monthly board can land at most once in any given 2-week window.
const LB_OCCURRENCES: Record<string, number> = {
  weekly: 2,
  biweekly: 1,
  monthly: 1,
};

/**
 * Per-creator "2-week max cost" from their ACTIVE creator_deals.
 *
 * For each active deal:
 *   withdrawal ceiling = currency_limit_amount × ceil(14 / reset_days)
 *       — the most the creator can withdraw against the deal's limit
 *         over 14 days. A non-resetting limit (no reset_days) counts
 *         once.
 *   per-deal leaderboard = leaderboard_prize_pool × leaderboard_our_share
 *         × occurrences(leaderboard_frequency)
 *
 *   deal 2-week max = withdrawal ceiling + per-deal leaderboard
 *
 * Summed across all of a creator's active deals. Creators with no
 * active deal are absent from the returned map — callers render "—".
 */
export async function getDeal2wkCostByUser(
  userIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (userIds.length === 0) return out;

  const deals = await adminDb.creator_deals.findMany({
    where: { target_user_id: { in: userIds }, status: "active" },
    select: {
      target_user_id: true,
      currency_limit_amount: true,
      currency_limit_reset_days: true,
      leaderboard_prize_pool: true,
      leaderboard_our_share: true,
      leaderboard_frequency: true,
    },
  });

  for (const d of deals) {
    // Withdrawal ceiling, scaled to the 14-day window.
    const limit = toNumber(d.currency_limit_amount);
    const resetDays = d.currency_limit_reset_days ?? 0;
    const periods = resetDays > 0 ? Math.ceil(WINDOW_DAYS / resetDays) : 1;
    const withdrawalCeiling = limit > 0 ? limit * periods : 0;

    // Per-deal leaderboard. our_share defaults to 100% (house covers
    // it all — the worst case) when a pool is set but the share isn't.
    const pool = toNumber(d.leaderboard_prize_pool);
    let leaderboardPart = 0;
    if (pool > 0) {
      const share =
        d.leaderboard_our_share != null
          ? toNumber(d.leaderboard_our_share)
          : 1;
      const occ = d.leaderboard_frequency
        ? (LB_OCCURRENCES[d.leaderboard_frequency] ?? 1)
        : 1;
      leaderboardPart = pool * share * occ;
    }

    const dealCost = withdrawalCeiling + leaderboardPart;
    out.set(
      d.target_user_id,
      (out.get(d.target_user_id) ?? 0) + dealCost,
    );
  }

  return out;
}
