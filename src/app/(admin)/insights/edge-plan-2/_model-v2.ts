/**
 * Edge Plan 2.0 — projection model.
 *
 * Wraps the v1 pure projection engine (read-only import) and layers:
 *   • Shards economy (replaces raffles)
 *   • Balance-withdrawal + wager-requirement what-ifs
 *
 * v1 `/insights/system-edge-plan` is never modified.
 */

import {
  type SystemEdgeBaseline,
  type PlannedLevers,
  type EdgePlanProjection,
  type LeverProjection,
  type RewardPackCatalogItem,
  type DailyPackLeverRow,
  type PackCardPreview,
  type GameTypeId,
  type RakebackCadenceId,
  defaultLevers,
  projectEdgePlan,
  computeNetEdgeScenarios,
  clamp,
  PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
  PLANNED_UPGRADER_EDGE_DEFAULT,
  GAME_TYPE_IDS,
} from "../system-edge-plan/_model";

export {
  clamp,
  PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
  PLANNED_UPGRADER_EDGE_DEFAULT,
  defaultPlannedEdge,
  GAME_TYPE_IDS,
  gameTypeLabel,
  computeNetEdgeScenarios,
  type GameTypeId,
  type PackCardPreview,
  type DailyPackLeverRow,
  type RewardPackCatalogItem,
  type EdgePlanProjection,
} from "../system-edge-plan/_model";

function breakageFactor(wagerReqMult: number): number {
  return clamp(1 / Math.max(0.25, wagerReqMult), 0.2, 1);
}

export type ShardsDataSource = "raffle_proxy" | "manual" | "backend";

/** One shard-shop pack the owner can plan EV for before prod packs exist. */
export type ShardShopPackRow = {
  packId: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  cardPreviews: PackCardPreview[];
  /** Planned shard price (planning default until backend ships). */
  shardPrice: number;
  /** Baseline redemptions in the window (0 when not live). */
  redemptionsBaseline: number;
  /** Measured / theoretical EV per redemption (USD house cost). */
  measuredEvUsd: number;
};

export type EdgePlanV2Baseline = SystemEdgeBaseline & {
  /** Reconstructed prize cost used as shards redemption proxy (was raffles). */
  shardsRedemptionCost: number;
  /** Estimated shards earned per $1 wager (planning default). */
  shardsPerDollarWager: number;
  shardsDataSource: ShardsDataSource;
  shardShopRows: ShardShopPackRow[];
  /** Share of withdrawal volume exiting as balance (0..1). Planning default. */
  balanceWithdrawalShare: number;
  /** Estimated total withdrawal USD in window (for balance-withdrawal modeling). */
  estimatedWithdrawalVolumeUsd: number;
  /** True when headline metrics were recovered or planning defaults were used. */
  baselineSparse?: boolean;
};

export type PlannedLeversV2 = Omit<
  PlannedLevers,
  "rafflePrizePoolMult" | "raffleFrequencyMult" | "raffleTicketCostMult"
> & {
  /** Shards earned per $1 wager at baseline (absolute, not mult). */
  shardsPerDollarWager: number;
  /** Scales shard earn rate vs baseline. */
  shardEarnMult: number;
  /** Game-type weights for shard earn (0..1). */
  shardPackBattleWeight: number;
  shardUpgraderWeight: number;
  /** Scales shard-shop redemptions / spend intensity. */
  shardRedemptionMult: number;
  /** Planned EV per shard-shop pack open (USD). */
  shardShopPackEvUsd: Record<string, number>;
  /** Share of withdrawals as balance (0..1). */
  balanceWithdrawalShare: number;
  /** Wager requirement multiplier (breakage model). */
  withdrawalWagerReqMult: number;
  /** Withdrawal wager weights (0..1). */
  withdrawalPackBattleWeight: number;
  withdrawalUpgraderWeight: number;
};

export type EdgePlanV2Projection = EdgePlanProjection & {
  shardsRedemptionPlanned: number;
  withdrawalFrictionAdjUsd: number;
};

const DEFAULT_SHARDS_PER_DOLLAR = 0.1;

function toV1Baseline(baseline: EdgePlanV2Baseline): SystemEdgeBaseline {
  return { ...baseline, raffleCost: 0 };
}

function toV1Levers(planned: PlannedLeversV2): PlannedLevers {
  return {
    ...planned,
    rafflePrizePoolMult: 1,
    raffleFrequencyMult: 1,
    raffleTicketCostMult: 1,
  };
}

function computeShardsRedemption(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): { current: number; planned: number } {
  const hasRows = baseline.shardShopRows.length > 0;
  const currentFromRows = baseline.shardShopRows.reduce(
    (s, p) => s + p.measuredEvUsd * p.redemptionsBaseline,
    0,
  );
  const current = hasRows ? currentFromRows : baseline.shardsRedemptionCost;

  const redemptionMult = Math.max(0, planned.shardRedemptionMult);
  const plannedFromRows = hasRows
    ? baseline.shardShopRows.reduce((s, p) => {
        const ev = Math.max(
          0,
          planned.shardShopPackEvUsd[p.packId] ?? p.measuredEvUsd,
        );
        return s + ev * p.redemptionsBaseline;
      }, 0) * redemptionMult
    : baseline.shardsRedemptionCost * redemptionMult;

  return { current, planned: plannedFromRows };
}

/** Modeled reduction in effective withdrawal outflow from wager req breakage. */
function computeWithdrawalAdjustment(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): number {
  const volume =
    baseline.estimatedWithdrawalVolumeUsd * planned.balanceWithdrawalShare;
  if (volume <= 0) return 0;
  const baseBreak = breakageFactor(1);
  const plannedBreak = breakageFactor(planned.withdrawalWagerReqMult);
  return volume * (baseBreak - plannedBreak) * 0.25;
}

export function defaultLeversV2(baseline: EdgePlanV2Baseline): PlannedLeversV2 {
  const v1 = defaultLevers(baseline);
  const shardShopPackEvUsd: Record<string, number> = {};
  for (const p of baseline.shardShopRows) {
    shardShopPackEvUsd[p.packId] = Math.max(0, p.measuredEvUsd);
  }
  for (const p of baseline.rewardPackCatalog) {
    if (shardShopPackEvUsd[p.packId] == null) {
      shardShopPackEvUsd[p.packId] = Math.max(0, p.theoreticalEvUsd);
    }
  }

  const { rafflePrizePoolMult: _a, raffleFrequencyMult: _b, raffleTicketCostMult: _c, ...rest } =
    v1;

  return {
    ...rest,
    shardsPerDollarWager: baseline.shardsPerDollarWager,
    shardEarnMult: 1,
    shardPackBattleWeight: 1,
    shardUpgraderWeight: 1,
    shardRedemptionMult: 1,
    shardShopPackEvUsd,
    balanceWithdrawalShare: baseline.balanceWithdrawalShare,
    withdrawalWagerReqMult: 1,
    withdrawalPackBattleWeight: 1,
    withdrawalUpgraderWeight: 1,
  };
}

function neutralLeversV2(): PlannedLeversV2 {
  return {
    edges: {
      packs: PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
      battles: PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
      upgrader: PLANNED_UPGRADER_EDGE_DEFAULT,
    },
    rakebackRates: { daily: 0, weekly: 0, monthly: 0 },
    rakebackPackBattleWeight: 1,
    rakebackUpgraderWeight: 1,
    rakebackInstantPayoutPct: 1,
    rakebackInstantAdoption: 0,
    affiliateRates: {},
    removeAffiliateWagerReq: false,
    depositBonusMatchMult: 1,
    depositBonusCapMult: 1,
    depositBonusMinDepositMult: 1,
    depositBonusWagerReqMult: 1,
    racePrizePoolMult: 1,
    raceFrequencyMult: 1,
    raceEntryCostMult: 1,
    dailyPackEvUsd: {},
    dailyPacksFrequencyMult: 1,
    signupGrantUsd: 0,
    rainCostMult: 1,
    otherRewardCostMult: 1,
    mothaCostMult: 1,
    shardsPerDollarWager: DEFAULT_SHARDS_PER_DOLLAR,
    shardEarnMult: 1,
    shardPackBattleWeight: 1,
    shardUpgraderWeight: 1,
    shardRedemptionMult: 1,
    shardShopPackEvUsd: {},
    balanceWithdrawalShare: 0,
    withdrawalWagerReqMult: 1,
    withdrawalPackBattleWeight: 1,
    withdrawalUpgraderWeight: 1,
  };
}

export function sanitizeLeversV2(input: unknown): PlannedLeversV2 {
  const base = neutralLeversV2();
  if (input == null || typeof input !== "object") return base;
  const src = input as Record<string, unknown>;

  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  if (src.edges != null && typeof src.edges === "object") {
    const e = src.edges as Record<string, unknown>;
    for (const t of GAME_TYPE_IDS) {
      base.edges[t] = clamp(num(e[t], base.edges[t]), 0, 1);
    }
  }

  if (src.rakebackRates != null && typeof src.rakebackRates === "object") {
    const r = src.rakebackRates as Record<string, unknown>;
    for (const c of ["daily", "weekly", "monthly"] as RakebackCadenceId[]) {
      base.rakebackRates[c] = clamp(num(r[c], base.rakebackRates[c]), 0, 1);
    }
  }

  base.rakebackPackBattleWeight = clamp(num(src.rakebackPackBattleWeight, 1), 0, 1);
  base.rakebackUpgraderWeight = clamp(num(src.rakebackUpgraderWeight, 1), 0, 1);
  base.rakebackInstantPayoutPct = clamp(num(src.rakebackInstantPayoutPct, 1), 0, 1);
  base.rakebackInstantAdoption = clamp(num(src.rakebackInstantAdoption, 0), 0, 1);

  if (src.affiliateRates != null && typeof src.affiliateRates === "object") {
    const a = src.affiliateRates as Record<string, unknown>;
    for (const [k, v] of Object.entries(a)) {
      const lvl = Number(k);
      if (!Number.isFinite(lvl)) continue;
      base.affiliateRates[lvl] = clamp(num(v, 0), 0, 1);
    }
  }

  base.removeAffiliateWagerReq = src.removeAffiliateWagerReq === true;
  base.depositBonusMatchMult = clamp(num(src.depositBonusMatchMult, 1), 0, 5);
  base.depositBonusCapMult = clamp(num(src.depositBonusCapMult, 1), 0, 5);
  base.depositBonusMinDepositMult = clamp(num(src.depositBonusMinDepositMult, 1), 0, 5);
  base.depositBonusWagerReqMult = clamp(num(src.depositBonusWagerReqMult, 1), 0, 5);
  base.racePrizePoolMult = clamp(num(src.racePrizePoolMult, 1), 0, 5);
  base.raceFrequencyMult = clamp(num(src.raceFrequencyMult, 1), 0, 5);
  base.raceEntryCostMult = clamp(num(src.raceEntryCostMult, 1), 0, 5);
  base.dailyPacksFrequencyMult = clamp(num(src.dailyPacksFrequencyMult, 1), 0, 5);
  base.rainCostMult = clamp(num(src.rainCostMult, 1), 0, 5);
  base.otherRewardCostMult = clamp(num(src.otherRewardCostMult, 1), 0, 5);
  base.mothaCostMult = clamp(num(src.mothaCostMult, 1), 0, 5);
  base.signupGrantUsd = Math.max(0, num(src.signupGrantUsd, 0));

  if (src.dailyPackEvUsd != null && typeof src.dailyPackEvUsd === "object") {
    const d = src.dailyPackEvUsd as Record<string, unknown>;
    for (const [packId, v] of Object.entries(d)) {
      if (typeof packId !== "string" || !packId) continue;
      base.dailyPackEvUsd[packId] = Math.max(0, num(v, 0));
    }
  }

  base.shardsPerDollarWager = clamp(num(src.shardsPerDollarWager, DEFAULT_SHARDS_PER_DOLLAR), 0, 10);
  base.shardEarnMult = clamp(num(src.shardEarnMult, 1), 0, 5);
  base.shardPackBattleWeight = clamp(num(src.shardPackBattleWeight, 1), 0, 1);
  base.shardUpgraderWeight = clamp(num(src.shardUpgraderWeight, 1), 0, 1);
  base.shardRedemptionMult = clamp(num(src.shardRedemptionMult, 1), 0, 5);
  base.balanceWithdrawalShare = clamp(num(src.balanceWithdrawalShare, 0), 0, 1);
  base.withdrawalWagerReqMult = clamp(num(src.withdrawalWagerReqMult, 1), 0, 5);
  base.withdrawalPackBattleWeight = clamp(
    num(src.withdrawalPackBattleWeight, 1),
    0,
    1,
  );
  base.withdrawalUpgraderWeight = clamp(num(src.withdrawalUpgraderWeight, 1), 0, 1);

  if (src.shardShopPackEvUsd != null && typeof src.shardShopPackEvUsd === "object") {
    const s = src.shardShopPackEvUsd as Record<string, unknown>;
    for (const [packId, v] of Object.entries(s)) {
      if (typeof packId !== "string" || !packId) continue;
      base.shardShopPackEvUsd[packId] = Math.max(0, num(v, 0));
    }
  }

  return base;
}

export function projectEdgePlanV2(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): EdgePlanV2Projection {
  const core = projectEdgePlan(toV1Baseline(baseline), toV1Levers(planned));
  const shards = computeShardsRedemption(baseline, planned);
  const withdrawalFrictionAdjUsd = computeWithdrawalAdjustment(baseline, planned);

  const levers: LeverProjection[] = core.levers
    .filter((l) => l.key !== "raffles")
    .concat([
      {
        key: "shards",
        label: "Shard shop redemptions",
        currentCost: shards.current,
        plannedCost: shards.planned,
        deltaCost: shards.planned - shards.current,
        dataAvailable:
          shards.current > 0 || baseline.shardShopRows.length > 0,
      },
      {
        key: "withdrawals",
        label: "Withdrawal wager friction (adj.)",
        currentCost: 0,
        plannedCost: -withdrawalFrictionAdjUsd,
        deltaCost: -withdrawalFrictionAdjUsd,
        dataAvailable: baseline.estimatedWithdrawalVolumeUsd > 0,
      },
    ]);

  const rewardCostDelta =
    core.plannedRewardCost -
    core.currentRewardCost +
    (shards.planned - shards.current) -
    withdrawalFrictionAdjUsd;

  const plannedNgr =
    core.plannedNgr - (shards.planned - shards.current) + withdrawalFrictionAdjUsd;
  const profitDelta = plannedNgr - core.currentNgr;
  const monthlyProfitDelta =
    baseline.periodDays > 0 ? (profitDelta / baseline.periodDays) * 30 : profitDelta;
  const annualProfitDelta =
    baseline.periodDays > 0 ? (profitDelta / baseline.periodDays) * 365 : profitDelta;

  return {
    ...core,
    levers,
    plannedRewardCost:
      core.plannedRewardCost + (shards.planned - shards.current),
    currentRewardCost: core.currentRewardCost + shards.current,
    rewardCostDelta,
    plannedNgr,
    profitDelta,
    monthlyProfitDelta,
    annualProfitDelta,
    shardsRedemptionPlanned: shards.planned,
    withdrawalFrictionAdjUsd,
  };
}
