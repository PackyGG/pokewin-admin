import "server-only";

import { getWindowMetrics, type MetricWindow } from "@/lib/metrics/queries";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { GameTypeBaseline, SystemEdgeBaseline } from "../system-edge-plan/_model";
import { getSystemEdgeBaseline } from "../system-edge-plan/_baseline";

import type { EdgePlanV2Baseline, ShardShopPackRow, ShardsDataSource } from "./_model-v2";

/** Edge Plan 2.0 always anchors on the last 30 days of production data. */
export const EDGE_PLAN_V2_PERIOD: InsightsRewardsPeriod = "30d";

const DEFAULT_SHARDS_PER_DOLLAR = 0.1;

function windowFor30d(): MetricWindow {
  const days = daysForInsightsPeriodCapped(EDGE_PLAN_V2_PERIOD);
  return { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
}

function mergeHeadlineMetrics(
  baseline: SystemEdgeBaseline,
  metrics: {
    wager: number;
    gamingPayout: number;
    houseEdge: number | null;
    bets: number;
  },
): SystemEdgeBaseline {
  if (baseline.wager > 0) return baseline;

  const wager = metrics.wager;
  const payout = metrics.gamingPayout;
  const ggr = wager - payout;
  const edge = metrics.houseEdge ?? (wager > 0 ? ggr / wager : null);

  const anchorType = (type: GameTypeBaseline["type"]): GameTypeBaseline => ({
    type,
    wager: type === "packs" ? wager : 0,
    payout: type === "packs" ? payout : 0,
    ggr: type === "packs" ? ggr : 0,
    edge: type === "packs" ? edge : null,
    bets: type === "packs" ? metrics.bets : 0,
    dataAvailable: type === "packs" && wager > 0,
  });

  return {
    ...baseline,
    wager,
    gamingPayout: payout,
    ggr,
    houseEdge: edge,
    bets: metrics.bets,
    gameTypes: [anchorType("packs"), anchorType("battles"), anchorType("upgrader")],
  };
}

function totalRewardCost(b: SystemEdgeBaseline): number {
  return (
    b.rakebackCost +
    b.affiliateCost +
    b.depositBonusCost +
    b.raceCost +
    b.raffleCost +
    b.dailyPacksCost +
    b.signupPacksCost +
    b.rainCost +
    b.mothaCost +
    b.otherRewardCost
  );
}

/** Last resort so the planner always has something to model against. */
function applyPlanningFallback(baseline: SystemEdgeBaseline): SystemEdgeBaseline {
  if (baseline.wager > 0) return baseline;

  const rewardTotal = totalRewardCost(baseline);
  const impliedWager =
    rewardTotal > 0 ? Math.max(100_000, rewardTotal / 0.05) : 1_000_000;
  const edge = 0.1;
  const ggr = impliedWager * edge;
  const payout = impliedWager - ggr;

  return mergeHeadlineMetrics(baseline, {
    wager: impliedWager,
    gamingPayout: payout,
    houseEdge: edge,
    bets: 0,
  });
}

async function recoverHeadlineMetrics(): Promise<{
  wager: number;
  gamingPayout: number;
  houseEdge: number | null;
  bets: number;
} | null> {
  const { data } = await safeQuery(
    () => getWindowMetrics({ window: windowFor30d() }),
    null,
    "edge-plan-v2.metrics-recovery",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (data == null || data.wager <= 0) return null;
  return {
    wager: data.wager,
    gamingPayout: data.gamingPayout,
    houseEdge: data.houseEdge,
    bets: data.bets,
  };
}

/**
 * Assemble the Edge Plan 2.0 baseline from the v1 baseline reader (read-only)
 * plus v2-specific shards / withdrawal planning fields.
 *
 * Always uses the last 30 days. If the cached v1 assembly returns zero wager,
 * retries a direct headline metrics read, then falls back to planning anchors
 * so the planner is never blocked.
 */
export async function getEdgePlanV2Baseline(): Promise<EdgePlanV2Baseline> {
  let v1 = await getSystemEdgeBaseline(EDGE_PLAN_V2_PERIOD);

  if (v1.wager <= 0) {
    const recovered = await recoverHeadlineMetrics();
    if (recovered) {
      v1 = mergeHeadlineMetrics(v1, recovered);
    }
  }

  if (v1.wager <= 0) {
    v1 = applyPlanningFallback(v1);
  }

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

  const baselineSparse =
    v1.gameTypes.every((g) => !g.dataAvailable) ||
    v1.rakebackCost + v1.affiliateCost + v1.dailyPacksCost === 0;

  return {
    ...v1,
    periodLabel: insightsRewardsPeriodLabel(EDGE_PLAN_V2_PERIOD),
    periodDays: Math.max(1, daysForInsightsPeriodCapped(EDGE_PLAN_V2_PERIOD)),
    shardsRedemptionCost,
    shardsPerDollarWager: DEFAULT_SHARDS_PER_DOLLAR,
    shardsDataSource,
    shardShopRows,
    balanceWithdrawalShare: 0.35,
    estimatedWithdrawalVolumeUsd: Math.max(0, v1.wager * 0.08),
    baselineSparse,
  };
}
