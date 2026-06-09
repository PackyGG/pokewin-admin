import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getWindowMetrics, type MetricWindow } from "@/lib/metrics/queries";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { GameTypeBaseline, SystemEdgeBaseline } from "../system-edge-plan/_model";
import { getSystemEdgeBaseline } from "../system-edge-plan/_baseline";
import { getMothaGiveawayOverview } from "@/lib/queries/insights-rewards/motha/overview";

import type { EdgePlanV2Baseline, ShardShopPackRow, ShardsDataSource, UpgraderRakebackBucket } from "./_model-v2";
import { estimateRewardWagerShares } from "./_model-v2";
import { getUpgraderProfitability } from "@/lib/queries/insights-games/upgrader";

/** Edge Plan 2.0 always anchors on the last 30 days of production data. */
export const EDGE_PLAN_V2_PERIOD: InsightsRewardsPeriod = "30d";

const DEFAULT_SHARDS_PER_DOLLAR = 0.1;
const DEFAULT_BALANCE_WITHDRAWAL_SHARE = 0.35;

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

/** Derive shard earn rate proxy from historical raffle cost ÷ wager. */
function getShardsBaselineStub(v1: SystemEdgeBaseline): {
  shardsPerDollarWager: number;
  shardsDataSource: ShardsDataSource;
} {
  if (v1.raffleCost > 0 && v1.wager > 0) {
    const estimate = clampShardsRate((v1.raffleCost / v1.wager) * 2);
    return { shardsPerDollarWager: estimate, shardsDataSource: "raffle_proxy" };
  }
  return {
    shardsPerDollarWager: DEFAULT_SHARDS_PER_DOLLAR,
    shardsDataSource: "manual",
  };
}

function clampShardsRate(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SHARDS_PER_DOLLAR;
  return Math.min(10, Math.max(0.01, n));
}

function parseBucketMultiplierBounds(label: string): {
  minMultiplier: number;
  maxMultiplier: number | null;
} {
  const cleaned = label.replace(/×/g, "").trim();
  if (cleaned.startsWith("<")) {
    return { minMultiplier: 0, maxMultiplier: Number.parseFloat(cleaned.slice(1)) || 2 };
  }
  if (cleaned.endsWith("+")) {
    return { minMultiplier: Number.parseFloat(cleaned.slice(0, -1)) || 100, maxMultiplier: null };
  }
  const parts = cleaned.split(/[–-]/);
  if (parts.length >= 2) {
    return {
      minMultiplier: Number.parseFloat(parts[0]) || 0,
      maxMultiplier: Number.parseFloat(parts[1]) || null,
    };
  }
  return { minMultiplier: 0, maxMultiplier: null };
}

function mapUpgraderBuckets(
  rows: Awaited<ReturnType<typeof getUpgraderProfitability>>["buckets"],
): UpgraderRakebackBucket[] {
  return rows.map((b) => {
    const bounds = parseBucketMultiplierBounds(b.label);
    return {
      label: b.label,
      minMultiplier: bounds.minMultiplier,
      maxMultiplier: bounds.maxMultiplier,
      wager: b.totalWager,
      winRate: b.bets > 0 ? b.hitRatePct / 100 : 0,
    };
  });
}

async function getBorrowedWagerTotals(): Promise<{
  packWagerBorrowed: number;
  battleWagerBorrowed: number;
} | null> {
  const since = windowFor30d().since;
  if (!since) return null;

  const { data } = await safeQuery(
    async () => {
      const db = await getDb();
      const rows = await db.$queryRawUnsafe<
        { pack_wager_borrowed: string; battle_wager_borrowed: string }[]
      >(
        `SELECT
           COALESCE(SUM(CASE WHEN lt.type::text = 'pack_opening'
                             AND lt.description ILIKE '%borrow%'
                            THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS pack_wager_borrowed,
           COALESCE(SUM(CASE WHEN lt.type::text = 'battle_entry'
                             AND lt.description ILIKE '%borrow%'
                            THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS battle_wager_borrowed
         FROM ledger_transactions lt
         WHERE lt.status = 'completed'
           AND lt.created_at >= $1
           AND lt.user_id IN (
             SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support')
           )`,
        since,
      );
      return {
        packWagerBorrowed: toNumber(rows[0]?.pack_wager_borrowed),
        battleWagerBorrowed: toNumber(rows[0]?.battle_wager_borrowed),
      };
    },
    null,
    "edge-plan-v2.borrowed-wager",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return data;
}

/**
 * Read balance vs card/inventory withdrawal split from the ledger for the 30d
 * window. Returns null when the query fails or volume is zero.
 */
async function getWithdrawalBaselineFromLedger(): Promise<{
  volumeUsd: number;
  balanceShare: number;
} | null> {
  const since = windowFor30d().since;
  if (!since) return null;

  const { data } = await safeQuery(
    async () => {
      const db = await getDb();
      const [ledger, card] = await Promise.all([
        db.$queryRawUnsafe<{ manual_wd: string }[]>(
          `SELECT COALESCE(SUM(CASE WHEN lt.type::text = 'admin_balance_adjustment'
                                    AND lt.balance_after < lt.balance_before
                                    AND lt.description ILIKE 'Manual withdrawal:%'
                                   THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS manual_wd
           FROM ledger_transactions lt
           WHERE lt.status = 'completed'
             AND lt.created_at >= $1
             AND lt.user_id IN (
               SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support')
             )`,
          since,
        ),
        db.$queryRawUnsafe<{ card_wd: string }[]>(
          `SELECT COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS card_wd
           FROM card_withdrawal_requests cwr
           WHERE cwr.status IN ('completed', 'shipped')
             AND COALESCE(cwr.shipped_at, cwr.completed_at) >= $1
             AND cwr.user_id IN (
               SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support')
             )`,
          since,
        ),
      ]);
      const manualUsd = toNumber(ledger[0]?.manual_wd);
      const cardUsd = toNumber(card[0]?.card_wd);
      const volumeUsd = manualUsd + cardUsd;
      if (volumeUsd <= 0) return null;
      return {
        volumeUsd,
        balanceShare: manualUsd / volumeUsd,
      };
    },
    null,
    "edge-plan-v2.withdrawal-split",
    REWARD_QUERY_TIMEOUT_MS,
  );

  return data;
}

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

  const shardsStub = getShardsBaselineStub(v1);
  const shardsRedemptionCost = v1.raffleCost;

  const withdrawalLedger = await getWithdrawalBaselineFromLedger();
  const mothaOverview = await safeQuery(
    () => getMothaGiveawayOverview(EDGE_PLAN_V2_PERIOD),
    null,
    "edge-plan-v2.motha-breakdown",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const upgraderData = await safeQuery(
    () => getUpgraderProfitability("30d"),
    null,
    "edge-plan-v2.upgrader-buckets",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const borrowedWager = await getBorrowedWagerTotals();

  const estimatedWithdrawalVolumeUsd =
    withdrawalLedger?.volumeUsd ?? Math.max(0, v1.wager * 0.08);
  const balanceWithdrawalShare =
    withdrawalLedger?.balanceShare ?? DEFAULT_BALANCE_WITHDRAWAL_SHARE;

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

  const packWagerBorrowed = borrowedWager?.packWagerBorrowed ?? 0;
  const battleWagerBorrowed = borrowedWager?.battleWagerBorrowed ?? 0;

  const partialForShares = {
    wager: v1.wager,
    raceCost: v1.raceCost,
    affiliateCost: v1.affiliateCost,
    rainCost: v1.rainCost,
    rakebackCost: v1.rakebackCost,
    dailyPacksCost: v1.dailyPacksCost,
    depositBonusCost: v1.depositBonusCost,
    mothaCost: v1.mothaCost,
    shardsRedemptionCost,
    otherRewardCost: v1.otherRewardCost,
    signupPacksCost: v1.signupPacksCost,
    packWagerBorrowed,
    battleWagerBorrowed,
  };

  return {
    ...v1,
    periodLabel: insightsRewardsPeriodLabel(EDGE_PLAN_V2_PERIOD),
    periodDays: Math.max(1, daysForInsightsPeriodCapped(EDGE_PLAN_V2_PERIOD)),
    shardsRedemptionCost,
    shardsPerDollarWager: shardsStub.shardsPerDollarWager,
    shardsDataSource: shardsStub.shardsDataSource,
    shardShopRows,
    balanceWithdrawalShare,
    estimatedWithdrawalVolumeUsd,
    withdrawalVolumeSource: withdrawalLedger ? "ledger" : "estimate",
    balanceWithdrawalShareSource: withdrawalLedger ? "ledger" : "estimate",
    baselineSparse,
    mothaBreakdown: mothaOverview.data
      ? {
          tips: mothaOverview.data.byChannel.tips,
          rain: mothaOverview.data.byChannel.rain,
          sponsorship: mothaOverview.data.byChannel.sponsorship,
          eventCount: mothaOverview.data.count,
          activeDays: mothaOverview.data.uniqueClaimants,
        }
      : null,
    upgraderRakebackAnchor: upgraderData.data
      ? {
          buckets: mapUpgraderBuckets(upgraderData.data.buckets),
          totalWager: upgraderData.data.totals.wager,
          winRate:
            upgraderData.data.totals.bets > 0
              ? upgraderData.data.totals.wins / upgraderData.data.totals.bets
              : 0,
        }
      : null,
    rewardWagerShare: estimateRewardWagerShares(partialForShares),
    packWagerBorrowed,
    battleWagerBorrowed,
  };
}
