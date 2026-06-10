/**
 * Edge Plan 2.0 — projection model.
 *
 * Wraps the v1 pure projection engine (read-only import) and layers:
 *   • Raffle levers (reused from v1 on real reconstructed raffle prize cost)
 *   • A real affiliate commission / leaderboard split
 *   • Balance-withdrawal + wager-requirement DISPLAY context (no fabricated
 *     projection — every number is real production data or it is dropped)
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
  type RakebackCadenceId,
  type RakebackCadenceLever,
  defaultLevers,
  projectEdgePlan,
  plannedBlendedHouseEdge,
  plannedMarginBearingHouseEdge,
  affiliateEdgeShareToWagerDrag,
  clamp,
  PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
  PLANNED_BATTLES_EDGE_DEFAULT,
  PLANNED_UPGRADER_EDGE_DEFAULT,
  GAME_TYPE_IDS,
  REMOVE_WAGER_REQ_COMMISSION_BASE_MULT,
  marginBearingWager,
  computeBlendedEdgeBreakdown,
  defaultPlannedEdge,
  type BlendedEdgeBreakdown,
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
  plannedMarginBearingHouseEdge,
  affiliateEdgeShareToWagerDrag,
  affiliateWagerDragToEdgeShare,
  removeWagerReqCommissionUplift,
  measuredPacksEdge,
  blendedPackBattleEdge,
  blendedGamingEdge,
  marginBearingBlendedGamingEdge,
  observedBlendedGamingEdge,
  observedMarginBearingGamingEdge,
  computeBlendedEdgeBreakdown,
  effectiveProjectionTypeEdge,
  type BlendedEdgeBreakdown,
  type BlendedEdgeLine,
  type GameTypeId,
  type PackCardPreview,
  type DailyPackLeverRow,
  type RewardPackCatalogItem,
  type EdgePlanProjection,
} from "../system-edge-plan/_model";

/** Labeled enumeration of house-funded reward channels (display/grouping). */
export type RewardWagerSourceId =
  | "race"
  | "leaderboard"
  | "rain"
  | "rakeback"
  | "dailyPacks"
  | "affiliate"
  | "depositBonus"
  | "motha"
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

export type EdgePlanV2Baseline = SystemEdgeBaseline & {
  /** Canonical headline wager before organic denominator override (30d). */
  totalWager: number;
  /** Ledger organic stake (no creator code; on-stream excluded; borrow incl.). */
  ledgerOrganicWager: number;
  /** Upgrader stake from non-creator-coded users. */
  upgraderOrganicWager: number;
  /**
   * Real affiliate COMMISSION cost over the window (Σ|affiliate_claim|), from
   * `getAffiliateOverview().totalCommissionPaid`. The commission leg only — the
   * leaderboard prize leg is tracked separately. Falls back to the bundled
   * `affiliateCost` when the affiliate overview query is null.
   */
  affiliateCommissionCost: number;
  /**
   * Real affiliate LEADERBOARD prize cost over the window
   * (Σ|affiliate_leaderboard_prize|), from
   * `getAffiliateOverview().leaderboardPrizePaid`. A SEPARATE canonical affiliate
   * reward leg that the commission figure does not include. 0 when the query is
   * null (the bundled total is then treated as all commission).
   */
  affiliateLeaderboardCost: number;
  /** Where the affiliate commission/leaderboard split was sourced. */
  affiliateSplitSource: "overview" | "fallback";
  /** Share of withdrawal volume exiting as balance (0..1). Real ledger split. */
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
  /** Real borrow-play stake (packs / battles) over the window — display context. */
  packWagerBorrowed: number;
  battleWagerBorrowed: number;
};

export type PlannedLeversV2 = PlannedLevers & {
  /** Share of withdrawals as balance (0..1) — UI what-if knob (no $ projection). */
  balanceWithdrawalShare: number;
  /** Wager requirement multiplier — UI what-if knob (no $ projection). */
  withdrawalWagerReqMult: number;
  /** Withdrawal wager weights (0..1) — UI what-if knobs (no $ projection). */
  withdrawalPackBattleWeight: number;
  withdrawalUpgraderWeight: number;
  /** Per-game-type rakeback accrual weight (0..1). */
  rakebackPacksWeight: number;
  rakebackBattlesWeight: number;
  /** Only upgrader bets at or above this target multiplier count (1.0 = all). */
  rakebackUpgraderMinMultiplier: number;
  /** Cap winning upgrader bet amount that accrues rakeback (0..1). */
  rakebackUpgraderMaxWinPct: number;
};

export type EdgePlanV2Projection = EdgePlanProjection;

/**
 * Default split of the bundled affiliate rollup into commission vs leaderboard
 * prize pool. This is ONLY the null-query fallback used when the real affiliate
 * overview (`getAffiliateOverview` → `totalCommissionPaid` + `leaderboardPrizePaid`)
 * could not be read. The real split is threaded through the baseline instead
 * (see `affiliateCommissionCost` / `affiliateLeaderboardCost` on the baseline).
 *
 * When the bundled total is the only thing available, assume it is entirely
 * commission (the canonical `affiliateCost` already sums both legs, and the
 * leaderboard leg is frequently $0), so the fallback neither fabricates a
 * leaderboard figure nor drops commission.
 */
export function splitAffiliateCostBundle(totalCost: number): {
  commission: number;
  leaderboard: number;
} {
  const total = Math.max(0, totalCost);
  return { commission: total, leaderboard: 0 };
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
  const houseEdge = plannedMarginBearingHouseEdgeV2(baseline, levers);
  const edgeShare = topAffiliateTierEdgeShare(baseline, levers);
  return affiliateEdgeShareToWagerDrag(edgeShare, houseEdge);
}

/** Commission-only affiliate projection (excludes leaderboard prizes). */
function projectAffiliateCommissionV2(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): { current: number; planned: number } {
  const current = Math.max(0, baseline.affiliateCommissionCost);
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

  // Direct rakeback cost: real config × real wager × real game-type / upgrader
  // weighting. The fabricated reward-wager recycling uplift (2.5× turnover /
  // 0.55 cap) was removed — rakeback now scales only on grounded inputs.
  const gameWeight = gameTypeRakebackWeightFactor(baseline, planned);

  const adoption = clamp(planned.rakebackInstantAdoption, 0, 1);
  const payoutPct = clamp(planned.rakebackInstantPayoutPct, 0, 1);
  const instantFactor = 1 - adoption + adoption * payoutPct;

  return {
    current,
    planned: Math.max(0, current * rateRatio * gameWeight * instantFactor),
  };
}

/** Effective rakeback wager multiplier for UI readouts (1.0 = full accrual). */
export function rakebackEffectiveWagerMult(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): {
  gameWeight: number;
  upgraderEligibleShare: number;
  combined: number;
} {
  const gameWeight = gameTypeRakebackWeightFactor(baseline, planned);
  const upgraderEligibleShare = upgraderMinMultiplierEligibleShare(
    baseline.upgraderRakebackAnchor,
    planned.rakebackUpgraderMinMultiplier,
  );
  return {
    gameWeight,
    upgraderEligibleShare,
    combined: gameWeight,
  };
}

/**
 * Strip the v2-only fields so the v1 engine receives a clean `SystemEdgeBaseline`.
 * Raffle cost flows through UNCHANGED now — it is the real reconstructed raffle
 * prize cost from `getRaffleForecastBaseline().totalPrizeCost` (no longer a shard
 * proxy), so the v1 raffle lever projects the real cost.
 */
function toV1Baseline(baseline: EdgePlanV2Baseline): SystemEdgeBaseline {
  return baseline;
}

function toV1Levers(planned: PlannedLeversV2, baseline: EdgePlanV2Baseline): PlannedLevers {
  return {
    ...planned,
    rakebackPackBattleWeight: blendedPackBattleRakebackWeight(baseline, planned),
  };
}

/** Planned blended house edge for v2 levers (wraps v1 helper). */
export function plannedBlendedHouseEdgeV2(
  baseline: EdgePlanV2Baseline,
  levers: PlannedLeversV2,
): number {
  return plannedBlendedHouseEdge(baseline, toV1Levers(levers, baseline));
}

/** Planned margin-bearing blend (packs + upgrader wager only). */
export function plannedMarginBearingHouseEdgeV2(
  baseline: EdgePlanV2Baseline,
  levers: PlannedLeversV2,
): number {
  return plannedMarginBearingHouseEdge(baseline, toV1Levers(levers, baseline));
}

/** Full breakdown for blended-edge UI (all-wager vs margin-bearing). */
export function computeBlendedEdgeBreakdownV2(
  baseline: EdgePlanV2Baseline,
  levers: PlannedLeversV2,
): BlendedEdgeBreakdown {
  return computeBlendedEdgeBreakdown(baseline, toV1Levers(levers, baseline).edges);
}

export function defaultLeversV2(baseline: EdgePlanV2Baseline): PlannedLeversV2 {
  const v1 = defaultLevers(baseline);

  return {
    ...v1,
    balanceWithdrawalShare: baseline.balanceWithdrawalShare,
    withdrawalWagerReqMult: 1,
    withdrawalPackBattleWeight: 1,
    withdrawalUpgraderWeight: 1,
    rakebackPacksWeight: 1,
    rakebackBattlesWeight: 1,
    rakebackUpgraderMinMultiplier: 1,
    rakebackUpgraderMaxWinPct: 1,
  };
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
    rafflePrizePoolMult: 1,
    raffleFrequencyMult: 1,
    raffleTicketCostMult: 1,
    dailyPackEvUsd: {},
    dailyPacksFrequencyMult: 1,
    signupGrantUsd: 0,
    rainCostMult: 1,
    otherRewardCostMult: 1,
    mothaCostMult: 1,
    balanceWithdrawalShare: 0,
    withdrawalWagerReqMult: 1,
    withdrawalPackBattleWeight: 1,
    withdrawalUpgraderWeight: 1,
    rakebackPacksWeight: 1,
    rakebackBattlesWeight: 1,
    rakebackUpgraderMinMultiplier: 1,
    rakebackUpgraderMaxWinPct: 1,
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
  base.rafflePrizePoolMult = clamp(num(src.rafflePrizePoolMult, 1), 0, 5);
  base.raffleFrequencyMult = clamp(num(src.raffleFrequencyMult, 1), 0, 5);
  base.raffleTicketCostMult = clamp(num(src.raffleTicketCostMult, 1), 0, 5);
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

  base.balanceWithdrawalShare = clamp(num(src.balanceWithdrawalShare, 0), 0, 1);
  base.withdrawalWagerReqMult = clamp(num(src.withdrawalWagerReqMult, 1), 0, 5);
  base.withdrawalPackBattleWeight = clamp(
    num(src.withdrawalPackBattleWeight, 1),
    0,
    1,
  );
  base.withdrawalUpgraderWeight = clamp(num(src.withdrawalUpgraderWeight, 1), 0, 1);

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

  // Real affiliate split (commission vs leaderboard) — sourced from
  // getAffiliateOverview via the baseline. The v1 `core` carries the BUNDLED
  // affiliate cost; here we replace its commission leg with the real
  // commission figure (scaled by the rate levers) and surface the leaderboard
  // prize leg as its own held-fixed line.
  const affiliateCommission = projectAffiliateCommissionV2(baseline, planned);
  const affiliateLeaderboardCurrent = Math.max(0, baseline.affiliateLeaderboardCost);

  const levers: LeverProjection[] = core.levers
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
    .concat(
      affiliateLeaderboardCurrent > 0
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
        : [],
    );

  // Reconcile `core`'s BUNDLED affiliate planned cost to the v2 split total
  // (commission planned + held-fixed leaderboard). The current side already
  // matches: the real commission + leaderboard sum back to the bundled
  // `affiliateCost` that `core.currentRewardCost` counted.
  const coreAffiliate = core.levers.find((l) => l.key === "affiliate");
  const affiliatePlannedTotal =
    affiliateCommission.planned + affiliateLeaderboardCurrent;
  const affiliateAdjustment =
    coreAffiliate != null ? affiliatePlannedTotal - coreAffiliate.plannedCost : 0;

  const plannedRewardCost =
    core.plannedRewardCost + rakebackDelta + affiliateAdjustment;
  const currentRewardCost = core.currentRewardCost;
  const rewardCostDelta = plannedRewardCost - currentRewardCost;

  const plannedNgr = core.plannedNgr - rakebackDelta - affiliateAdjustment;
  const profitDelta = plannedNgr - core.currentNgr;
  const monthlyProfitDelta =
    baseline.periodDays > 0 ? (profitDelta / baseline.periodDays) * 30 : profitDelta;
  const annualProfitDelta =
    baseline.periodDays > 0 ? (profitDelta / baseline.periodDays) * 365 : profitDelta;

  return {
    ...core,
    ...planningGgr,
    levers,
    plannedRewardCost,
    currentRewardCost,
    rewardCostDelta,
    plannedNgr,
    profitDelta,
    monthlyProfitDelta,
    annualProfitDelta,
  };
}

/** Per-reward lever drag as a fraction of total wager (for edge waterfall UI). */
export type EdgeAfterRewardsLeverDrag = {
  key: string;
  label: string;
  plannedCostUsd: number;
  /** Positive = erodes edge (reward drag on the planned config). */
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

export const WAGER_SCENARIO_PRESET_MULTS = [1, 1.5, 2, 3, 4, 5] as const;

export function resolveScenarioWagerUsd(
  baseWager: number,
  scenario: WagerScenarioState,
): number {
  const wager = Number.isFinite(baseWager) ? Math.max(0, baseWager) : 0;
  const mult =
    Number.isFinite(scenario.presetMult) && scenario.presetMult > 0
      ? scenario.presetMult
      : 1;
  return wager * mult;
}

/** Reward levers whose planned $ cost scales with wager at constant rates. */
const WAGER_PROPORTIONAL_LEVER_KEYS = new Set([
  "rakeback",
  "affiliate",
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
  const baseWager = Math.max(
    0,
    projection.plannedWager ?? projection.currentWager ?? 0,
  );
  const scenarioOverride = ctx?.scenarioWagerUsd;
  const scenarioWager =
    scenarioOverride != null &&
    Number.isFinite(scenarioOverride) &&
    scenarioOverride > 0
      ? scenarioOverride
      : baseWager;
  const wagerScenarioMult = baseWager > 0 ? scenarioWager / baseWager : 1;

  // Margin-bearing wager (packs + upgrader only — battles produce 0 GGR and
  // must not dilute the headline edge). The whole waterfall runs on this basis
  // so gross − drag = net stays consistent. Uses the explicit margin-bearing
  // helpers, which are margin-bearing on prod (HEAD) regardless of the v1
  // "exclude battles from headline" refactor.
  const marginWager = ctx?.baseline
    ? Math.max(0, marginBearingWager(ctx.baseline))
    : baseWager;
  const scenarioMarginWager = marginWager * wagerScenarioMult;

  const grossEdge =
    ctx?.baseline && ctx?.levers
      ? plannedMarginBearingHouseEdgeV2(ctx.baseline, ctx.levers)
      : projection.plannedEdge;
  // "was" reference = the margin-bearing edge at the DEFAULT lever config
  // (planned-vs-planned), NOT the observed/measured edge (which mixes bases and
  // runs higher than the planning default).
  const currentGrossEdge = ctx?.baseline
    ? plannedMarginBearingHouseEdgeV2(ctx.baseline, defaultLeversV2(ctx.baseline))
    : projection.currentEdge > 0.00001
      ? projection.currentEdge
      : baseWager > 0
        ? projection.currentGgr / baseWager
        : 0;

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

  const scenarioPlannedGgr = grossEdge * scenarioMarginWager;
  const plannedRewardDrag =
    scenarioMarginWager > 0
      ? Math.max(0, scenarioPlannedRewardCost / scenarioMarginWager)
      : 0;
  const netEdgeAfterRewards =
    scenarioMarginWager > 0
      ? (scenarioPlannedGgr - scenarioPlannedRewardCost) / scenarioMarginWager
      : 0;

  const currentGgr = currentGrossEdge * marginWager;
  const currentRewardCost = projection.currentRewardCost;
  const currentRewardDrag =
    marginWager > 0 ? Math.max(0, currentRewardCost / marginWager) : 0;
  const currentNetEdge =
    marginWager > 0 ? (currentGgr - currentRewardCost) / marginWager : 0;

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
        scenarioMarginWager > 0 ? scenarioCost / scenarioMarginWager : 0;
      if (l.key === "affiliate" && ctx?.baseline && ctx?.levers) {
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
