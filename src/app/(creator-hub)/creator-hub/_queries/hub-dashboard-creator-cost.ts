import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";
import { hubPeriodToInterval } from "./hub-period-sql";

/**
 * Windowed creator cost for the Creator Hub dashboard — the SAME three
 * house-cost legs as `dashboard-creator-costs-today.ts`, re-scoped to the
 * active `DashboardPeriod` chip instead of calendar-today:
 *
 *   • Creator deal-payout withdrawals (creator_fill_conversion +
 *     creator_multiplier_payout vouchers on completed/shipped cwr).
 *   • House-funded creator tips (`creator_fill_spend_tip`).
 *   • Full affiliate leaderboard prize gross (`affiliate_leaderboard_prize`).
 *
 * `unstable_cache` keyed on the period label; cutoff computed at fill time
 * via `NOW() - INTERVAL` (same cache-key pattern as net GGR scans).
 */

const cachedHubCreatorCost = unstable_cache(
  async (period: DashboardPeriod): Promise<number> => {
    return withTiming("creator-hub.creatorCost", async () => {
      const db = await getDb();
      const interval = hubPeriodToInterval(period);
      const since = `NOW() - INTERVAL '${interval}'`;

      type WithdrawalRow = { creator_withdrawals: string };
      const withdrawalRows = await db.$queryRawUnsafe<WithdrawalRow[]>(
        `WITH creator_deal_payouts AS (
           SELECT DISTINCT
             cwr.id AS request_id,
             v.id   AS voucher_id,
             v.value::numeric AS amount,
             COALESCE(cwr.completed_at, cwr.shipped_at) AS effective_at
           FROM card_withdrawal_requests cwr
           JOIN vouchers v ON v.id = ANY(cwr.voucher_ids)
           WHERE cwr.status IN ('completed', 'shipped')
             AND v.origin::text IN ('creator_fill_conversion', 'creator_multiplier_payout')
         )
         SELECT COALESCE(SUM(CASE WHEN effective_at >= ${since} THEN amount ELSE 0 END), 0)::text AS creator_withdrawals
         FROM creator_deal_payouts`,
      );
      const creatorWithdrawals = toNumber(withdrawalRows[0]?.creator_withdrawals);

      type TipsRow = { tips: string };
      const tipsRows = await db.$queryRawUnsafe<TipsRow[]>(
        `SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS tips
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text = 'creator_fill_spend_tip'
           AND created_at >= ${since}`,
      );
      const tips = toNumber(tipsRows[0]?.tips);

      type LeaderboardRow = { gross: string };
      const leaderboardRows = await db.$queryRawUnsafe<LeaderboardRow[]>(
        `SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS gross
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text = 'affiliate_leaderboard_prize'
           AND created_at >= ${since}`,
      );
      const leaderboardGross = toNumber(leaderboardRows[0]?.gross);

      return creatorWithdrawals + tips + leaderboardGross;
    });
  },
  ["hub-creator-cost-v1"],
  { revalidate: 60, tags: ["creator-hub"] },
);

export async function getHubCreatorCostUsd(
  period: DashboardPeriod,
): Promise<number> {
  return cachedHubCreatorCost(period);
}
