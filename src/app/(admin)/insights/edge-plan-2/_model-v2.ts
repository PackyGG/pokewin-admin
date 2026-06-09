/**
 * Edge Plan 2.0 — projection model.
 *
 * Wraps the v1 pure projection engine (read-only import) and layers:
 *   • Shards economy (replaces raffles)
 *   • Balance-withdrawal + wager-requirement what-ifs
 *
 * Shared projection engine for Edge Plan 2.0. The v1 route was removed;
 * core types and math live here for reuse.
 */

import {
  type SystemEdgeBaseline,
  type PlannedLevers,
  type EdgePlanProjection,
  type GameTypeProjection,
  type LeverProjection,
  type RewardPackCatalogItem,
  type DailyPackLeverRow,
  type PackCardPreview,
  type GameTypeId,
  type RakebackCadenceId,
  type RakebackCadenceLever,
  defaultLevers,
  projectEdgePlan,
  computeNetEdgeScenarios,
  plannedBlendedHouseEdge,
  affiliateEdgeShareToWagerDrag,
  affiliateWagerDragToEdgeShare,
  clamp,
  PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
  PLANNED_BATTLES_EDGE_DEFAULT,
  PLANNED_UPGRADER_EDGE_DEFAULT,
  GAME_TYPE_IDS,
  removeWagerReqCommissionUplift,
  REMOVE_WAGER_REQ_COMMISSION_BASE_MULT,
  measuredPacksEdge,
  blendedPackBattleEdge,
  blendedGamingEdge,
  observedBlendedGamingEdge,
  effectiveProjectionTypeEdge,
  defaultPlannedEdge,
} from "../system-edge-plan/_model";

export {
  clamp,
  PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
  PLANNED_BATTLES_EDGE_DEFAULT,
  PLANNED_UPGRADER_EDGE_DEFAULT,
  defaultPlannedEdge,
  GAME_TYPE_IDS,
  gameTypeLabel,
  computeNetEdgeScenarios,
  plannedBlendedHouseEdge,
  affiliateEdgeShareToWagerDrag,
  affiliateWagerDragToEdgeShare,
  removeWagerReqCommissionUplift,
  measuredPacksEdge,
  blendedPackBattleEdge,
  blendedGamingEdge,
  observedBlendedGamingEdge,
  effectiveProjectionTypeEdge,
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

/** Reward channels that can fund wager recycled into rakeback accrual. */
export type RewardWagerSourceId =
  | "race"
  | "leaderboard"
  | "rain"
  | "rakeback"
  | "dailyPacks"
  | "affiliate"
  | "depositBonus"
  | "motha"
  | "shards"
  | "borrowed"
  | "other";

export const REWARD_WAGER_SOURCE_IDS: RewardWagerSourceId[] = [
  "race",
  "leaderboard",
  "rain",
  "rakeback",
  "dailyPacks",
  "affiliate",
  "depositBonus",
  "motha",
  "shards",
  "borrowed",
  "other",
];

export const REWARD_WAGER_SOURCE_LABELS: Record<RewardWagerSourceId, string> = {
  race: "Race prizes",
  leaderboard: "Leaderboard prizes",
  rain: "Rain",
  rakeback: "Rakeback claims",
  dailyPacks: "Daily / free packs",
  affiliate: "Affiliate commission",
  depositBonus: "Deposit bonus",
  motha: "Motha founder giveaways",
  shards: "Shard shop",
  borrowed: "Borrow-play (packs + battles)",
  other: "Other rewards",
};

export type UpgraderRakebackBucket = {
  label: string;
  minMultiplier: number;
  maxMultiplier: number | null;
  wager: number;
  winRate: number;
};

export type RewardWagerShareBreakdown = Record<RewardWagerSourceId, number>;

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
  /** Canonical headline wager before organic denominator override (30d). */
  totalWager: number;
  /** Pack/battle organic ledger wager (borrow + creator-session excluded). */
  ledgerOrganicWager: number;
  /** Upgrader wager (same organic scope as v1 baseline legs). */
  upgraderOrganicWager: number;
  /** Reconstructed prize cost used as shards redemption proxy (was raffles). */
  shardsRedemptionCost: number;
  /** Internal earn rate: shards per $1 wager (UI shows inverse as wager per gem). */
  shardsPerDollarWager: number;
  shardsDataSource: ShardsDataSource;
  shardShopRows: ShardShopPackRow[];
  /** Share of withdrawal volume exiting as balance (0..1). Planning default. */
  balanceWithdrawalShare: number;
  /** Estimated total withdrawal USD in window (for balance-withdrawal modeling). */
  estimatedWithdrawalVolumeUsd: number;
  /** Where withdrawal volume was sourced. */
  withdrawalVolumeSource: "ledger" | "estimate";
  /** Where balance-withdrawal share was sourced. */
  balanceWithdrawalShareSource: "ledger" | "estimate";
  /** True when headline metrics were recovered or planning defaults were used. */
  baselineSparse?: boolean;
  /** Per-channel motha founder giveaway split (30d window). */
  mothaBreakdown: {
    tips: number;
    rain: number;
    sponsorship: number;
    eventCount: number;
    activeDays: number;
  } | null;
  /** Upgrader target-multiplier buckets for min-bet eligibility modeling. */
  upgraderRakebackAnchor: {
    buckets: UpgraderRakebackBucket[];
    totalWager: number;
    winRate: number;
  } | null;
  /** Estimated share of total wager originating from each reward channel. */
  rewardWagerShare: RewardWagerShareBreakdown;
  packWagerBorrowed: number;
  battleWagerBorrowed: number;
};

export type PlannedLeversV2 = Omit<
  PlannedLevers,
  "rafflePrizePoolMult" | "raffleFrequencyMult" | "raffleTicketCostMult"
> & {
  /** Internal earn rate: shards per $1 wager (UI: wager per gem). */
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
  /** Per-game-type rakeback accrual weight (0..1). */
  rakebackPacksWeight: number;
  rakebackBattlesWeight: number;
  /** Only upgrader bets at or above this target multiplier count (1.0 = all). */
  rakebackUpgraderMinMultiplier: number;
  /** Cap winning upgrader bet amount that accrues rakeback (0..1). */
  rakebackUpgraderMaxWinPct: number;
  /** How much wager from each reward source counts toward rakeback (0..1). */
  rakebackRewardWagerWeights: RewardWagerShareBreakdown;
};

export type EdgePlanV2Projection = EdgePlanProjection & {
  shardsIssuancePlanned: number;
  shardsRedemptionPlanned: number;
  withdrawalFrictionAdjUsd: number;
};

const DEFAULT_SHARDS_PER_DOLLAR = 0.1;
/** Planning turnover: $1 reward spend → ~$X wager before exit. */
const REWARD_WAGER_TURNOVER = 2.5;
const LEADERBOARD_AFFILIATE_COST_SHARE = 0.12;

/** Split bundled affiliate rollup into commission vs leaderboard prize pool. */
export function splitAffiliateCostBundle(totalCost: number): {
  commission: number;
  leaderboard: number;
} {
  const total = Math.max(0, totalCost);
  const leaderboard = total * LEADERBOARD_AFFILIATE_COST_SHARE;
  return { commission: total - leaderboard, leaderboard };
}

/** Top affiliate tier edge share (worst-case single-tier planning). */
export function topAffiliateTierEdgeShare(
  baseline: Pick<SystemEdgeBaseline, "affiliateTiers">,
  levers: Pick<PlannedLeversV2, "affiliateRates">,
): number {
  const tiers = [...baseline.affiliateTiers].sort((a, b) => a.level - b.level);
  const top = tiers[tiers.length - 1];
  if (!top) return 0;
  return Math.max(0, levers.affiliateRates[top.level] ?? top.currentRate);
}

/**
 * Worst-case affiliate edge erosion for planning: top tier edge share × planned
 * blended house edge (each affiliate has one tier — not realized cost ÷ wager).
 */
export function affiliateWorstCaseEdgeDrag(
  baseline: EdgePlanV2Baseline,
  levers: PlannedLeversV2,
): number {
  const houseEdge = plannedBlendedHouseEdgeV2(baseline, levers);
  const edgeShare = topAffiliateTierEdgeShare(baseline, levers);
  return affiliateEdgeShareToWagerDrag(edgeShare, houseEdge);
}

/** Commission-only affiliate projection (excludes leaderboard prizes). */
function projectAffiliateCommissionV2(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): { current: number; planned: number } {
  const { commission: current } = splitAffiliateCostBundle(baseline.affiliateCost);
  if (current <= 0) return { current: 0, planned: 0 };

  const tiers = baseline.affiliateTiers;
  if (tiers.length === 0) return { current, planned: current };

  const mean = (xs: number[]) =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  const currentBlend = mean(tiers.map((t) => t.currentRate));
  const plannedBlend = mean(
    tiers.map((t) => Math.max(0, planned.affiliateRates[t.level] ?? t.currentRate)),
  );
  const rateRatio = currentBlend > 0 ? plannedBlend / currentBlend : 1;
  const reqMult = planned.removeAffiliateWagerReq
    ? REMOVE_WAGER_REQ_COMMISSION_BASE_MULT
    : 1;

  return {
    current,
    planned: Math.max(0, current * rateRatio * reqMult),
  };
}

export function defaultRakebackRewardWagerWeights(): RewardWagerShareBreakdown {
  return Object.fromEntries(
    REWARD_WAGER_SOURCE_IDS.map((id) => [id, 1]),
  ) as RewardWagerShareBreakdown;
}

function cadenceWeight(
  cadence: RakebackCadenceLever,
  all: RakebackCadenceLever[],
): number {
  const enabled = all.filter((c) => c.enabled);
  if (enabled.length === 0) return cadence.enabled ? 1 : 0;
  return cadence.enabled ? 1 / enabled.length : 0;
}

function blendedPackBattleRakebackWeight(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): number {
  const packs = baseline.gameTypes.find((g) => g.type === "packs")?.wager ?? 0;
  const battles = baseline.gameTypes.find((g) => g.type === "battles")?.wager ?? 0;
  const pb = packs + battles;
  if (pb <= 0) {
    return (planned.rakebackPacksWeight + planned.rakebackBattlesWeight) / 2;
  }
  return (
    (packs * planned.rakebackPacksWeight + battles * planned.rakebackBattlesWeight) /
    pb
  );
}

/** Share of upgrader wager eligible at a minimum target multiplier. */
export function upgraderMinMultiplierEligibleShare(
  anchor: EdgePlanV2Baseline["upgraderRakebackAnchor"],
  minMultiplier: number,
): number {
  if (!anchor || anchor.totalWager <= 0) return 1;
  const min = Math.max(1, minMultiplier);
  if (min <= 1) return 1;

  let eligible = 0;
  for (const b of anchor.buckets) {
    const lo = b.minMultiplier;
    const hi = b.maxMultiplier;
    if (hi != null && min >= hi) continue;
    if (min <= lo) {
      eligible += b.wager;
      continue;
    }
    if (hi == null) {
      eligible += b.wager;
      continue;
    }
    const span = hi - lo;
    if (span > 0) {
      eligible += b.wager * ((hi - min) / span);
    }
  }
  return clamp(eligible / anchor.totalWager, 0, 1);
}

function gameTypeRakebackWeightFactor(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): number {
  const packs = baseline.gameTypes.find((g) => g.type === "packs")?.wager ?? 0;
  const battles = baseline.gameTypes.find((g) => g.type === "battles")?.wager ?? 0;
  const upg = baseline.gameTypes.find((g) => g.type === "upgrader")?.wager ?? 0;
  const total = packs + battles + upg;
  if (total <= 0) return 1;

  const minMultShare = upgraderMinMultiplierEligibleShare(
    baseline.upgraderRakebackAnchor,
    planned.rakebackUpgraderMinMultiplier,
  );
  const winRate = baseline.upgraderRakebackAnchor?.winRate ?? 0;
  const maxWinPct = clamp(planned.rakebackUpgraderMaxWinPct, 0, 1);
  const winCapFactor = 1 - winRate + winRate * maxWinPct;
  const upgFactor =
    clamp(planned.rakebackUpgraderWeight, 0, 1) * minMultShare * winCapFactor;

  return (
    (packs * clamp(planned.rakebackPacksWeight, 0, 1) +
      battles * clamp(planned.rakebackBattlesWeight, 0, 1) +
      upg * upgFactor) /
    total
  );
}

function rewardWagerRecyclingFactor(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): number {
  const totalWager = baseline.wager;
  if (totalWager <= 0) return 1;

  const borrowedWager = Math.max(
    0,
    baseline.packWagerBorrowed + baseline.battleWagerBorrowed,
  );
  const borrowedShare = clamp(borrowedWager / totalWager, 0, 1);

  let recycledShare = 0;
  for (const id of REWARD_WAGER_SOURCE_IDS) {
    if (id === "borrowed") continue;
    recycledShare += baseline.rewardWagerShare[id] ?? 0;
  }
  recycledShare = clamp(recycledShare, 0, Math.max(0, 1 - borrowedShare));

  let depositShare = 1 - borrowedShare - recycledShare;
  if (depositShare < 0) {
    const scale = 1 / (borrowedShare + recycledShare);
    depositShare = 0;
    recycledShare *= scale;
  }

  let weightedRecycled = 0;
  for (const id of REWARD_WAGER_SOURCE_IDS) {
    if (id === "borrowed") continue;
    const share = baseline.rewardWagerShare[id] ?? 0;
    if (share <= 0) continue;
    weightedRecycled +=
      share * clamp(planned.rakebackRewardWagerWeights[id] ?? 1, 0, 1);
  }

  const borrowedWeight = clamp(
    planned.rakebackRewardWagerWeights.borrowed ?? 1,
    0,
    1,
  );

  return (
    depositShare +
    borrowedShare * borrowedWeight +
    weightedRecycled
  );
}

function projectRakebackV2(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): { current: number; planned: number } {
  const current = baseline.rakebackCost;
  if (current <= 0) return { current: 0, planned: 0 };

  const cadences = baseline.rakebackCadences;
  const currentBlend = cadences.reduce(
    (s, c) => s + c.currentRate * cadenceWeight(c, cadences),
    0,
  );
  const plannedBlend = cadences.reduce(
    (s, c) =>
      s +
      Math.max(0, planned.rakebackRates[c.cadence] ?? c.currentRate) *
        cadenceWeight(c, cadences),
    0,
  );
  const rateRatio = currentBlend > 0 ? plannedBlend / currentBlend : 1;

  const gameWeight = gameTypeRakebackWeightFactor(baseline, planned);
  const rewardFactor = rewardWagerRecyclingFactor(baseline, planned);

  const adoption = clamp(planned.rakebackInstantAdoption, 0, 1);
  const payoutPct = clamp(planned.rakebackInstantPayoutPct, 0, 1);
  const instantFactor = 1 - adoption + adoption * payoutPct;

  return {
    current,
    planned: Math.max(0, current * rateRatio * gameWeight * rewardFactor * instantFactor),
  };
}

/** Effective rakeback wager multiplier for UI readouts (1.0 = full accrual). */
export function rakebackEffectiveWagerMult(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): {
  gameWeight: number;
  rewardRecycling: number;
  upgraderEligibleShare: number;
  combined: number;
} {
  const gameWeight = gameTypeRakebackWeightFactor(baseline, planned);
  const rewardRecycling = rewardWagerRecyclingFactor(baseline, planned);
  const upgraderEligibleShare = upgraderMinMultiplierEligibleShare(
    baseline.upgraderRakebackAnchor,
    planned.rakebackUpgraderMinMultiplier,
  );
  return {
    gameWeight,
    rewardRecycling,
    upgraderEligibleShare,
    combined: gameWeight * rewardRecycling,
  };
}

export function estimateRewardWagerShares(
  baseline: Pick<
    EdgePlanV2Baseline,
    | "wager"
    | "raceCost"
    | "affiliateCost"
    | "rainCost"
    | "rakebackCost"
    | "dailyPacksCost"
    | "depositBonusCost"
    | "mothaCost"
    | "shardsRedemptionCost"
    | "otherRewardCost"
    | "signupPacksCost"
    | "packWagerBorrowed"
    | "battleWagerBorrowed"
  >,
): RewardWagerShareBreakdown {
  const shares = defaultRakebackRewardWagerWeights();
  const totalWager = baseline.wager;
  if (totalWager <= 0) return shares;

  const borrowedWager = Math.max(
    0,
    baseline.packWagerBorrowed + baseline.battleWagerBorrowed,
  );
  shares.borrowed = clamp(borrowedWager / totalWager, 0, 0.5);

  const leaderboardCost = baseline.affiliateCost * LEADERBOARD_AFFILIATE_COST_SHARE;
  const affiliateCommissionCost = baseline.affiliateCost - leaderboardCost;

  const costBySource: Record<Exclude<RewardWagerSourceId, "borrowed">, number> = {
    race: baseline.raceCost,
    leaderboard: leaderboardCost,
    rain: baseline.rainCost,
    rakeback: baseline.rakebackCost,
    dailyPacks: baseline.dailyPacksCost,
    affiliate: affiliateCommissionCost,
    depositBonus: baseline.depositBonusCost,
    motha: baseline.mothaCost,
    shards: baseline.shardsRedemptionCost,
    other: baseline.otherRewardCost + baseline.signupPacksCost,
  };

  const recycledWagerCap = Math.max(0, 1 - shares.borrowed) * 0.55;
  const totalRewardCost = Object.values(costBySource).reduce((s, v) => s + Math.max(0, v), 0);
  const recycledWagerUsd = Math.min(
    totalWager * recycledWagerCap,
    totalRewardCost * REWARD_WAGER_TURNOVER,
  );

  if (totalRewardCost > 0 && recycledWagerUsd > 0) {
    for (const id of REWARD_WAGER_SOURCE_IDS) {
      if (id === "borrowed") continue;
      shares[id] = (costBySource[id] / totalRewardCost) * (recycledWagerUsd / totalWager);
    }
  }

  return shares;
}

function toV1Baseline(baseline: EdgePlanV2Baseline): SystemEdgeBaseline {
  return { ...baseline, raffleCost: 0 };
}

function toV1Levers(planned: PlannedLeversV2, baseline: EdgePlanV2Baseline): PlannedLevers {
  return {
    ...planned,
    rakebackPackBattleWeight: blendedPackBattleRakebackWeight(baseline, planned),
    rafflePrizePoolMult: 1,
    raffleFrequencyMult: 1,
    raffleTicketCostMult: 1,
  };
}

/** Planned blended house edge for v2 levers (wraps v1 helper). */
export function plannedBlendedHouseEdgeV2(
  baseline: EdgePlanV2Baseline,
  levers: PlannedLeversV2,
): number {
  return plannedBlendedHouseEdge(baseline, toV1Levers(levers, baseline));
}

/** Wager-weighted blend of pack/battle vs upgrader weights (0..1 each). */
function wagerTypeBlend(
  baseline: EdgePlanV2Baseline,
  packBattleWeight: number,
  upgraderWeight: number,
): number {
  const packs = baseline.gameTypes.find((g) => g.type === "packs")?.wager ?? 0;
  const battles = baseline.gameTypes.find((g) => g.type === "battles")?.wager ?? 0;
  const upg = baseline.gameTypes.find((g) => g.type === "upgrader")?.wager ?? 0;
  const pb = packs + battles;
  const total = pb + upg;
  if (total <= 0) return (packBattleWeight + upgraderWeight) / 2;
  return (pb * packBattleWeight + upg * upgraderWeight) / total;
}

function computeShardsIssuance(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): { current: number; planned: number } {
  const baseRate = Math.max(0.001, baseline.shardsPerDollarWager);
  const currentBlend = wagerTypeBlend(baseline, 1, 1);
  const plannedBlend = wagerTypeBlend(
    baseline,
    planned.shardPackBattleWeight,
    planned.shardUpgraderWeight,
  );
  const earnIntensity =
    (planned.shardsPerDollarWager / baseRate) *
    Math.max(0, planned.shardEarnMult) *
    plannedBlend;
  const blendRatio =
    currentBlend > 0 ? plannedBlend / currentBlend : plannedBlend;

  const anchor =
    baseline.shardsRedemptionCost > 0
      ? baseline.shardsRedemptionCost * 0.5
      : baseline.wager * baseRate * currentBlend * 0.01;

  if (anchor <= 0) return { current: 0, planned: 0 };

  return {
    current: anchor,
    planned: anchor * (planned.shardsPerDollarWager / baseRate) * planned.shardEarnMult * blendRatio,
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
  const baseWeight = wagerTypeBlend(baseline, 1, 1);
  const plannedWeight = wagerTypeBlend(
    baseline,
    planned.withdrawalPackBattleWeight,
    planned.withdrawalUpgraderWeight,
  );
  const weightScale =
    baseWeight > 0 ? plannedWeight / baseWeight : Math.max(0, plannedWeight);
  return volume * (baseBreak - plannedBreak) * 0.25 * weightScale;
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
    rakebackPacksWeight: 1,
    rakebackBattlesWeight: 1,
    rakebackUpgraderMinMultiplier: 1,
    rakebackUpgraderMaxWinPct: 1,
    rakebackRewardWagerWeights: defaultRakebackRewardWagerWeights(),
  };
}

function sanitizeRewardWagerWeights(
  input: unknown,
  fallback: RewardWagerShareBreakdown,
): RewardWagerShareBreakdown {
  const out = { ...fallback };
  if (input == null || typeof input !== "object") return out;
  const src = input as Record<string, unknown>;
  for (const id of REWARD_WAGER_SOURCE_IDS) {
    const n = Number(src[id]);
    if (Number.isFinite(n)) out[id] = clamp(n, 0, 1);
  }
  return out;
}

function neutralLeversV2(): PlannedLeversV2 {
  return {
    edges: {
      packs: PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
      battles: PLANNED_BATTLES_EDGE_DEFAULT,
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
    rakebackPacksWeight: 1,
    rakebackBattlesWeight: 1,
    rakebackUpgraderMinMultiplier: 1,
    rakebackUpgraderMaxWinPct: 1,
    rakebackRewardWagerWeights: defaultRakebackRewardWagerWeights(),
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
    base.edges.battles = PLANNED_BATTLES_EDGE_DEFAULT;
  }

  if (src.rakebackRates != null && typeof src.rakebackRates === "object") {
    const r = src.rakebackRates as Record<string, unknown>;
    for (const c of ["daily", "weekly", "monthly"] as RakebackCadenceId[]) {
      base.rakebackRates[c] = clamp(num(r[c], base.rakebackRates[c]), 0, 1);
    }
  }

  base.rakebackPackBattleWeight = clamp(num(src.rakebackPackBattleWeight, 1), 0, 1);
  base.rakebackUpgraderWeight = clamp(num(src.rakebackUpgraderWeight, 1), 0, 1);
  base.rakebackPacksWeight = clamp(
    num(src.rakebackPacksWeight, base.rakebackPacksWeight),
    0,
    1,
  );
  base.rakebackBattlesWeight = clamp(
    num(src.rakebackBattlesWeight, base.rakebackBattlesWeight),
    0,
    1,
  );
  base.rakebackUpgraderMinMultiplier = clamp(
    num(src.rakebackUpgraderMinMultiplier, 1),
    1,
    10,
  );
  base.rakebackUpgraderMaxWinPct = clamp(
    num(src.rakebackUpgraderMaxWinPct, 1),
    0,
    1,
  );
  base.rakebackInstantPayoutPct = clamp(num(src.rakebackInstantPayoutPct, 1), 0, 1);
  base.rakebackInstantAdoption = clamp(num(src.rakebackInstantAdoption, 0), 0, 1);
  base.rakebackRewardWagerWeights = sanitizeRewardWagerWeights(
    src.rakebackRewardWagerWeights,
    base.rakebackRewardWagerWeights,
  );

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

  if (src.wagerPerGemUsd != null) {
    const wpg = num(src.wagerPerGemUsd, 1 / DEFAULT_SHARDS_PER_DOLLAR);
    base.shardsPerDollarWager =
      !Number.isFinite(wpg) || wpg >= 1000
        ? 0
        : wpg <= 0.1
          ? 10
          : clamp(1 / wpg, 0, 10);
  } else {
    base.shardsPerDollarWager = clamp(
      num(src.shardsPerDollarWager, DEFAULT_SHARDS_PER_DOLLAR),
      0,
      10,
    );
  }
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

/**
 * Edge Plan 2 planning UI: per-type GGR is planned edge × wager only.
 * Deltas compare the active sliders to planning defaults — not measured edge.
 */
function applyPlanningGameProjections(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
  core: EdgePlanProjection,
): Pick<EdgePlanProjection, "gameTypes" | "ggrDelta"> {
  const defaults = defaultLeversV2(baseline);
  const refEdge = plannedBlendedHouseEdgeV2(baseline, defaults);
  const refGgr = refEdge * baseline.wager;

  const gameTypes: GameTypeProjection[] = core.gameTypes.map((g) => {
    if (g.type === "battles") {
      return {
        ...g,
        currentEdge: PLANNED_BATTLES_EDGE_DEFAULT,
        plannedEdge: PLANNED_BATTLES_EDGE_DEFAULT,
        currentGgr: 0,
        plannedGgr: 0,
        ggrDelta: 0,
      };
    }
    const plannedEdge = clamp(
      planned.edges[g.type] ?? defaultPlannedEdge(g.type),
      0,
      1,
    );
    const plannedGgrType = plannedEdge * g.wager;
    const defaultEdge = clamp(
      defaults.edges[g.type] ?? defaultPlannedEdge(g.type),
      0,
      1,
    );
    const referenceGgr = defaultEdge * g.wager;
    return {
      ...g,
      currentEdge: plannedEdge,
      currentGgr: plannedGgrType,
      plannedEdge,
      plannedGgr: plannedGgrType,
      ggrDelta: plannedGgrType - referenceGgr,
    };
  });

  return {
    gameTypes,
    ggrDelta: core.plannedGgr - refGgr,
  };
}

export function projectEdgePlanV2(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): EdgePlanV2Projection {
  const core = projectEdgePlan(toV1Baseline(baseline), toV1Levers(planned, baseline));
  const planningGgr = applyPlanningGameProjections(baseline, planned, core);
  const rakeback = projectRakebackV2(baseline, planned);
  const coreRakeback = core.levers.find((l) => l.key === "rakeback");
  const rakebackDelta =
    coreRakeback != null ? rakeback.planned - coreRakeback.plannedCost : 0;

  const issuance = computeShardsIssuance(baseline, planned);
  const redemption = computeShardsRedemption(baseline, planned);
  const withdrawalFrictionAdjUsd = computeWithdrawalAdjustment(baseline, planned);

  const shardsCurrent = issuance.current + redemption.current;
  const shardsPlanned = issuance.planned + redemption.planned;

  const affiliateCommission = projectAffiliateCommissionV2(baseline, planned);
  const { leaderboard: affiliateLeaderboardCurrent } = splitAffiliateCostBundle(
    baseline.affiliateCost,
  );

  const levers: LeverProjection[] = core.levers
    .filter((l) => l.key !== "raffles")
    .map((l) => {
      if (l.key === "rakeback") {
        return {
          ...l,
          plannedCost: rakeback.planned,
          deltaCost: rakeback.planned - rakeback.current,
        };
      }
      if (l.key === "affiliate") {
        return {
          ...l,
          label: "Affiliate commission",
          currentCost: affiliateCommission.current,
          plannedCost: affiliateCommission.planned,
          deltaCost: affiliateCommission.planned - affiliateCommission.current,
        };
      }
      return l;
    })
    .concat([
      ...(affiliateLeaderboardCurrent > 0
        ? [
            {
              key: "leaderboard",
              label: "Affiliate leaderboard prizes",
              currentCost: affiliateLeaderboardCurrent,
              plannedCost: affiliateLeaderboardCurrent,
              deltaCost: 0,
              dataAvailable: true,
            } satisfies LeverProjection,
          ]
        : []),
      {
        key: "shards-earn",
        label: "Shard earn (issuance liability)",
        currentCost: issuance.current,
        plannedCost: issuance.planned,
        deltaCost: issuance.planned - issuance.current,
        dataAvailable:
          issuance.current > 0 || baseline.wager > 0 || baseline.shardsRedemptionCost > 0,
      },
      {
        key: "shards",
        label: "Shard shop redemptions",
        currentCost: redemption.current,
        plannedCost: redemption.planned,
        deltaCost: redemption.planned - redemption.current,
        dataAvailable:
          redemption.current > 0 || baseline.shardShopRows.length > 0,
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

  const coreAffiliate = core.levers.find((l) => l.key === "affiliate");
  const affiliatePlannedTotal =
    affiliateCommission.planned + affiliateLeaderboardCurrent;
  const affiliateAdjustment =
    coreAffiliate != null ? affiliatePlannedTotal - coreAffiliate.plannedCost : 0;

  const rewardCostDelta =
    core.plannedRewardCost -
    core.currentRewardCost +
    rakebackDelta +
    (shardsPlanned - shardsCurrent) +
    affiliateAdjustment -
    withdrawalFrictionAdjUsd;

  const plannedNgr =
    core.plannedNgr -
    rakebackDelta -
    (shardsPlanned - shardsCurrent) +
    withdrawalFrictionAdjUsd -
    affiliateAdjustment;
  const profitDelta = plannedNgr - core.currentNgr;
  const monthlyProfitDelta =
    baseline.periodDays > 0 ? (profitDelta / baseline.periodDays) * 30 : profitDelta;
  const annualProfitDelta =
    baseline.periodDays > 0 ? (profitDelta / baseline.periodDays) * 365 : profitDelta;

  return {
    ...core,
    ...planningGgr,
    levers,
    plannedRewardCost:
      core.plannedRewardCost +
      rakebackDelta +
      (shardsPlanned - shardsCurrent) +
      affiliateAdjustment,
    currentRewardCost: core.currentRewardCost + shardsCurrent,
    rewardCostDelta,
    plannedNgr,
    profitDelta,
    monthlyProfitDelta,
    annualProfitDelta,
    shardsIssuancePlanned: issuance.planned,
    shardsRedemptionPlanned: redemption.planned,
    withdrawalFrictionAdjUsd,
  };
}

/** Per-reward lever drag as a fraction of total wager (for edge waterfall UI). */
export type EdgeAfterRewardsLeverDrag = {
  key: string;
  label: string;
  plannedCostUsd: number;
  /** Positive = erodes edge; negative = adds back (e.g. withdrawal friction). */
  dragPct: number;
  /** Optional planning note (e.g. affiliate worst-case vs realized spend). */
  dragNote?: string;
};

export type EdgeAfterRewardsContext = {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  /** Override organic wager for what-if drag dilution (null = baseline organic). */
  scenarioWagerUsd?: number | null;
};

/** Gross → reward drag → net edge remaining on the planned config. */
export type EdgeAfterRewardsSummary = {
  /** Scenario wager used for planned drag / net edge (USD). */
  wager: number;
  /** Observed organic wager baseline (USD). */
  baseWager: number;
  /** scenarioWager ÷ baseWager (1 = observed volume). */
  wagerScenarioMult: number;
  grossEdge: number;
  plannedRewardDrag: number;
  netEdgeAfterRewards: number;
  currentGrossEdge: number;
  currentRewardDrag: number;
  currentNetEdge: number;
  netEdgeDelta: number;
  leverDrags: EdgeAfterRewardsLeverDrag[];
};

/** UI state for the edge-after-rewards wager scenario control. */
export type WagerScenarioState = {
  /** Multiplier on baseline organic wager (1 = baseline). */
  presetMult: number;
};

export const WAGER_SCENARIO_PRESET_MULTS = [1, 2, 3, 4, 5] as const;

export function resolveScenarioWagerUsd(
  baseWager: number,
  scenario: WagerScenarioState,
): number {
  return Math.max(0, baseWager * scenario.presetMult);
}

/** Reward levers whose planned $ cost scales with wager at constant rates. */
const WAGER_PROPORTIONAL_LEVER_KEYS = new Set([
  "rakeback",
  "affiliate",
  "shards-earn",
]);

function scenarioLeverCostUsd(
  leverKey: string,
  plannedCostUsd: number,
  baseWager: number,
  scenarioWager: number,
): number {
  if (baseWager <= 0 || scenarioWager <= 0) return plannedCostUsd;
  if (WAGER_PROPORTIONAL_LEVER_KEYS.has(leverKey)) {
    return plannedCostUsd * (scenarioWager / baseWager);
  }
  return plannedCostUsd;
}

function resolveObservedCurrentGrossEdge(
  projection: EdgePlanV2Projection,
  baseline?: EdgePlanV2Baseline,
): number {
  if (baseline) return observedBlendedGamingEdge(baseline);
  if (projection.currentEdge > 0.00001) return projection.currentEdge;
  const baseWager = Math.max(0, projection.plannedWager || projection.currentWager);
  return baseWager > 0 ? projection.currentGgr / baseWager : 0;
}

function formatDragRatePct(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  const v = rate * 100;
  const s = v.toFixed(2).replace(/\.?0+$/, "");
  return `${s}%`;
}

export function computeEdgeAfterRewards(
  projection: EdgePlanV2Projection,
  ctx?: EdgeAfterRewardsContext,
): EdgeAfterRewardsSummary {
  const baseWager = Math.max(0, projection.plannedWager || projection.currentWager);
  const scenarioWager =
    ctx?.scenarioWagerUsd != null && ctx.scenarioWagerUsd > 0
      ? ctx.scenarioWagerUsd
      : baseWager;
  const wagerScenarioMult = baseWager > 0 ? scenarioWager / baseWager : 1;

  const grossEdge =
    ctx?.baseline && ctx?.levers
      ? plannedBlendedHouseEdgeV2(ctx.baseline, ctx.levers)
      : projection.plannedEdge;
  const currentGrossEdge = resolveObservedCurrentGrossEdge(
    projection,
    ctx?.baseline,
  );

  let scenarioPlannedRewardCost = 0;
  for (const l of projection.levers) {
    if (Math.abs(l.plannedCost) <= 0.005) continue;
    scenarioPlannedRewardCost += scenarioLeverCostUsd(
      l.key,
      l.plannedCost,
      baseWager,
      scenarioWager,
    );
  }

  const scenarioPlannedGgr = grossEdge * scenarioWager;
  const plannedRewardDrag =
    scenarioWager > 0 ? Math.max(0, scenarioPlannedRewardCost / scenarioWager) : 0;
  const netEdgeAfterRewards =
    scenarioWager > 0
      ? (scenarioPlannedGgr - scenarioPlannedRewardCost) / scenarioWager
      : 0;

  const currentGgr = currentGrossEdge * baseWager;
  const currentRewardCost = projection.currentRewardCost;
  const currentRewardDrag =
    baseWager > 0 ? Math.max(0, currentRewardCost / baseWager) : 0;
  const currentNetEdge =
    baseWager > 0 ? (currentGgr - currentRewardCost) / baseWager : 0;

  const leverDrags: EdgeAfterRewardsLeverDrag[] = projection.levers
    .filter((l) => Math.abs(l.plannedCost) > 0.005)
    .map((l) => {
      const scenarioCost = scenarioLeverCostUsd(
        l.key,
        l.plannedCost,
        baseWager,
        scenarioWager,
      );
      const realizedDrag =
        scenarioWager > 0 ? scenarioCost / scenarioWager : 0;
      if (l.key === "affiliate" && ctx) {
        const edgeShare = topAffiliateTierEdgeShare(ctx.baseline, ctx.levers);
        const worstCaseDrag = affiliateWorstCaseEdgeDrag(ctx.baseline, ctx.levers);
        return {
          key: l.key,
          label: l.label,
          plannedCostUsd: scenarioCost,
          dragPct: worstCaseDrag,
          dragNote:
            scenarioWager > 0
              ? `Top tier ${formatDragRatePct(edgeShare)} of edge (planning); realized spend ${formatDragRatePct(realizedDrag)} of wager`
              : undefined,
        };
      }
      return {
        key: l.key,
        label: l.label,
        plannedCostUsd: scenarioCost,
        dragPct: realizedDrag,
      };
    })
    .sort((a, b) => b.dragPct - a.dragPct);

  return {
    wager: scenarioWager,
    baseWager,
    wagerScenarioMult,
    grossEdge,
    plannedRewardDrag,
    netEdgeAfterRewards,
    currentGrossEdge,
    currentRewardDrag,
    currentNetEdge,
    netEdgeDelta: netEdgeAfterRewards - currentNetEdge,
    leverDrags,
  };
}
