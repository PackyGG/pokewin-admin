import "server-only";

import { getSystemEdgeBaseline } from "../system-edge-plan/_baseline";
import type { InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";

import type { EdgePlanV2Baseline, ShardShopPackRow, ShardsDataSource } from "./_model-v2";

const DEFAULT_SHARDS_PER_DOLLAR = 0.1;

/**
 * Assemble the Edge Plan 2.0 baseline from the v1 baseline reader (read-only)
 * plus v2-specific shards / withdrawal planning fields.
 */
export async function getEdgePlanV2Baseline(
  period: InsightsRewardsPeriod,
): Promise<EdgePlanV2Baseline> {
  const v1 = await getSystemEdgeBaseline(period);

  const shardsRedemptionCost = v1.raffleCost;
  const shardsDataSource: ShardsDataSource =
    shardsRedemptionCost > 0 ? "raffle_proxy" : "manual";

  const shardShopRows: ShardShopPackRow[] = v1.rewardPackCatalog.map((p) => ({
    packId: p.packId,
    name: p.name,
    slug: p.slug,
    imageUrl: p.imageUrl,
    cardPreviews: p.cardPreviews,
    shardPrice: 100,
    redemptionsBaseline: 0,
    measuredEvUsd: p.theoreticalEvUsd,
  }));

  return {
    ...v1,
    shardsRedemptionCost,
    shardsPerDollarWager: DEFAULT_SHARDS_PER_DOLLAR,
    shardsDataSource,
    shardShopRows,
    balanceWithdrawalShare: 0.35,
    estimatedWithdrawalVolumeUsd: Math.max(0, v1.wager * 0.08),
  };
}
