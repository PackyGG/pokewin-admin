/**
 * Edge Plan 2.0 — projection model (v2 overhaul, 2026-06-12).
 *
 * Wraps the v1 pure projection engine (read-only import) for the per-type
 * GGR planning math + the rakeback/affiliate/daily-pack/signup levers, and
 * REPLACES every multiplier-style reward lever with direct $ inputs seeded
 * from real 30d run-rates, plus:
 *   • a `revenueLevers` channel (deposit fee) — profitDelta =
 *     ggrDelta − rewardCostDelta + revenueDelta,
 *   • shards (NEW — `_shards-v2.ts` pure math),
 *   • the reward-source crediting matrix (NEW — `_credit-matrix-v2.ts`,
 *     a cost REDUCTION lever row),
 *   • a measured-vs-planning split: `baseline.canonical` carries the REAL
 *     `getWindowMetrics` 30d block (the "Measured 30d" strip) while the
 *     planning numbers stay a separate, clearly-labeled what-if.
 *
 * INVARIANT (the __checks__ assert it): at `defaultLeversV2(baseline)` the
 * projection's profitDelta is EXACTLY $0 — every $ input seeds from its
 * real run-rate (or `null` = "resolve to the run-rate"), every toggle
 * defaults to current behavior, shards default OFF, matrix cells default
 * 100% credit, deposit fee defaults 0%.
 */

import {
  type SystemEdgeBaseline,
  type PlannedLevers,
  type EdgePlanProjection,
  type GameTypeProjection,
  type LeverProjection,
  type RakebackCadenceId,
  type RakebackCadenceLever,
  type GameTypeId,
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
  DEPOSIT_BONUS_CAP_COST_EXPONENT,
  marginBearingWager,
  computeBlendedEdgeBreakdown,
  computeNetEdgeScenarios as computeNetEdgeScenariosV1,
  defaultPlannedEdge,
  type BlendedEdgeBreakdown,
} from "../system-edge-plan/_model";

import {
  type ShardGameWeights,
  type ShardLeverConfig,
  type ShardTypeWager,
  SHARDS_DEFAULT_WAGER_PER_SHARD_USD,
  SHARDS_DEFAULT_EV_PER_SHARD_USD,
  shardCostInWindow,
} from "./_shards-v2";

import {
  type CreditMatrixCells,
  type CreditMatrixProgramRate,
  type RewardSourceVolume,
  deriveProgramRates,
  sanitizeMatrixCells,
  totalMatrixSavingsUsd,
} from "./_credit-matrix-v2";

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
  REMOVE_WAGER_REQ_COMMISSION_BASE_MULT,
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

// Shard + matrix primitives re-exported for the section builders.
export {
  SHARD_CASES,
  SHARDS_DEFAULT_WAGER_PER_SHARD_USD,
  SHARDS_DEFAULT_EV_PER_SHARD_USD,
  SHARDS_TARGET_GIVEBACK,
  shardCaseValueUsd,
  shardCostInWindow,
  shardMonthlyCost,
  effectiveShardGiveback,
  shardGivebackVsTarget,
  weightedShardWager,
  type ShardCase,
  type ShardGameWeights,
  type ShardLeverConfig,
  type ShardTypeWager,
} from "./_shards-v2";

export {
  CREDIT_MATRIX_PROGRAM_IDS,
  CREDIT_MATRIX_PROGRAM_LABELS,
  matrixCellKey,
  getMatrixCell,
  deriveProgramRates,
  programSavingsUsd,
  totalMatrixSavingsUsd,
  type CreditMatrixCells,
  type CreditMatrixProgramId,
  type CreditMatrixProgramRate,
  type RewardSourceVolume,
} from "./_credit-matrix-v2";

// ─── XP ↔ USD calibration (probe-pinned 2026-06-12) ─────────────────────────

/**
 * USD of wager-loss represented by ONE XP point.
 *
 * Probe evidence (scripts/probe-edge-plan-recon.ts, live prod): the level-1
 * threshold sits at exactly 1,000 XP and the owner pins level 1 at "$10
 * wager-loss" — so XP is wager-loss in CENTS (1 XP = $0.01), i.e. the
 * owner's "~1:1" holds in cents, and the constant to convert an XP
 * threshold to a $ wager-loss requirement is 0.01.
 */
export const XP_TO_USD = 0.01 as const;

// ─── Reward-source display enumeration (unchanged from v2.0) ────────────────

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

// ─── Baseline block types (assembled in _baseline-v2.ts) ────────────────────

/**
 * The REAL measured 30d block from `getWindowMetrics` — the same source as
 * /ggr + the dashboard. Rendered as the clearly-labeled "Measured 30d"
 * strip; planning numbers stay separate. Null only when the read failed.
 */
export type CanonicalMeasuredBlock = {
  wager: number;
  gamingPayout: number;
  ggr: number;
  ngr: number;
  rewardCost: number;
  houseEdge: number | null;
  bets: number;
  rainHouseCost: number;
};

/** One coin's real 30d deposit volume (deposit-fee lever input). */
export type DepositAssetVolume = {
  /** Asset id (ledger `crypto_asset` / `deposit_addresses.asset_id`). */
  asset: string;
  count: number;
  volumeUsd: number;
};

/** One prize line of a live raffle, valued at the live item price. */
export type LiveRafflePrizeLine = {
  type: "pack" | "card";
  id: string;
  quantity: number;
  unitPriceUsd: number;
};

/** A currently-live (status=active) raffle — context card. */
export type LiveRaffleInfo = {
  id: string;
  title: string | null;
  totalEntries: number;
  participantCount: number;
  /** ISO timestamp or null. */
  endsAt: string | null;
  /** Σ prize line value at live prices (shared prize-valuation helper). */
  prizeValueUsd: number;
  prizes: LiveRafflePrizeLine[];
};

/** Real 30d rain cadence/pool anchor from the `rains` table. */
export type RainAnchor = {
  /** Completed rains in the window. */
  count: number;
  /** Mean pool (USD) per completed rain. */
  avgPoolUsd: number;
  /** Mean configured duration (ends_at − starts_at) in hours. */
  avgDurationHours: number;
  /** Observed mean hours BETWEEN rains (windowHours ÷ count) — cadence. */
  avgIntervalHours: number;
  /** Σ pool USD across completed rains. */
  totalPoolUsd: number;
};

/** One adjustment-category row (canonical customer scope, 30d). */
export type AdjustmentCategoryRow = {
  /** Canonical category key, or null = the "Not itemized" NULL bucket. */
  category: string | null;
  label: string;
  count: number;
  creditsUsd: number;
  debitsUsd: number;
  /** True when this category is COUNTED in GGR/NGR/cost. */
  counted: boolean;
};

/** One deposit-size histogram bucket: deposits with amount < maxUsd. */
export type DepositSizeBucket = {
  /** Upper bound (exclusive) in USD; null = the open top bucket. */
  maxUsd: number | null;
  count: number;
};

/** One per-user-day deposit-bonus bucket (time-bonus anchor). */
export type TimeBonusBucket = {
  /** Upper bound (exclusive) of the per-user-day bonus $; null = open top. */
  maxUsd: number | null;
  userDays: number;
  totalUsd: number;
};

/** Real per-user-day deposit-bonus distribution over the window. */
export type TimeBonusAnchor = {
  userDays: number;
  users: number;
  totalUsd: number;
  avgPerUserDayUsd: number;
  maxPerUserDayUsd: number;
  /** Observed share of window days an active claimer claims (0..1). */
  claimRatePerUserDay: number;
  buckets: TimeBonusBucket[];
};

/** Level/XP gate behind one daily reward pack. */
export type DailyPackLevelInfo = {
  packId: string;
  rewardSlug: string;
  levelRequired: number;
  /**
   * Empirical XP threshold for `levelRequired` (from `user_statistics`
   * level boundaries, monotone-enforced). Null when no user has reached
   * that level yet (no empirical boundary).
   */
  xpThreshold: number | null;
  /** xpThreshold × XP_TO_USD — the $ wager-loss required to unlock. */
  wagerLossRequiredUsd: number | null;
  /**
   * Default 30d re-lock fraction (`rewards.daily_unlock_percentage`,
   * NULL = 1%) — share of the level's wager-loss a user must re-earn after
   * the 30-day period. A PLAYER requirement, not a house cost.
   */
  relockPctDefault: number;
};

/** Real 30d usage stats for one daily reward pack. */
export type DailyPackUsageInfo = {
  packId: string;
  opens: number;
  claimers: number;
  opensPerClaimer: number;
  /** Customers at/above the pack's required level (eligibility base). */
  eligibleUsers: number | null;
  /** claimers ÷ eligibleUsers (0..1), null when eligibility unknown. */
  claimRateVsEligible: number | null;
  /** Share of claimers who claimed on ≥90% of window days (0..1). */
  everyTimeClaimerPct: number | null;
};

export type UpgraderRakebackBucket = {
  label: string;
  minMultiplier: number;
  maxMultiplier: number | null;
  wager: number;
  winRate: number;
};

// ─── Owner-trusted reconciliation block (rework 2026-06-12) ──────────────────
//
// The numbers the OWNER trusts live on the /insights hub: hub wager
// (`getInsightsHubWager*` — borrow-net real customer stake + upgrader) and
// the canonical cost-breakdown block (`getCostBreakdown` — GGR / NGR /
// rewardPayouts / realized P&L). The Edge Plan page anchors its headline on
// EXACTLY those helpers, per window, windows always LOUD — this block is the
// serializable carrier. `buildOwnerWindowRecon` is PURE so the __checks__
// can pin its identities without a DB.

/** The stable cost-breakdown line key of the creator-attributed leaderboard prizes. */
export const LEADERBOARD_REWARD_LINE_KEY = "reward:affiliate_leaderboard";

/** One reward program's window spend + its edge reduction vs the hub wager. */
export type OwnerProgramSpend = {
  /** Stable cost-breakdown line key (e.g. "reward:rakeback"). */
  key: string;
  label: string;
  amountUsd: number;
  /** spend ÷ hub wager, in percentage points (the program's edge reduction). Null when wager unknown. */
  edgeReductionPp: number | null;
};

/** One reward line as fed into the recon builder (from getCostBreakdown.lines). */
export type OwnerRewardLineInput = {
  key: string;
  label: string;
  amountUsd: number;
};

export type OwnerWindowReconInput = {
  windowKey: "30d" | "lifetime365";
  /** LOUD window label, e.g. "Last 30 days" / "Lifetime (365d-capped)". */
  label: string;
  /** Hub-style customer wager (borrow-net real stake, creator-sessions excluded, + upgrader). */
  hubWagerUsd: number;
  /** Canonical GGR / NGR from getCostBreakdown (same helper as /insights). */
  ggr: number;
  ngr: number;
  /** Realized windowed P&L (calculateWindowedPnl via getCostBreakdown). */
  realizedPnl: number;
  /** Canonical house edge (GGR ÷ canonical wager — accounting view). */
  houseEdge: number | null;
  /** The reward cost lines (kind === "reward") from getCostBreakdown. */
  rewardLines: OwnerRewardLineInput[];
};

/** One window of owner-trusted numbers, fully reconciled with /insights. */
export type OwnerWindowRecon = {
  windowKey: "30d" | "lifetime365";
  label: string;
  /** In plain words: how much customers bet (real cash, borrow-net). */
  wager: number;
  /** In plain words: what the house actually banked this window. */
  realizedPnl: number;
  ggr: number;
  ngr: number;
  /** Canonical reward cost (GGR − NGR) — still INCLUDING creator-attributed leaderboard prizes. */
  rewardPayouts: number;
  /** Affiliate leaderboard prizes — CREATOR cost per the house model, NOT on-site reward drag. */
  creatorLeaderboardCost: number;
  /** rewardPayouts − creatorLeaderboardCost — the on-site reward spend the drag uses. */
  onSiteRewardCost: number;
  /** onSiteRewardCost ÷ wager (fraction, 0..). Null when wager unknown. */
  onSiteDragPct: number | null;
  /** rewardPayouts ÷ wager — the with-creator transparency figure. */
  dragWithCreatorPct: number | null;
  houseEdge: number | null;
  /** Per-program on-site spend (leaderboard EXCLUDED — it is the creator footnote). */
  programs: OwnerProgramSpend[];
};

export type OwnerReconBlock = {
  /** Last 30 days — the planner's working window. */
  d30: OwnerWindowRecon;
  /** Lifetime (365d-capped) — must equal the /insights hub by construction. */
  lifetime: OwnerWindowRecon;
  /** ISO timestamp of the baseline build. */
  asOfIso: string;
};

/**
 * PURE assembly of one owner-trusted recon window. Identities the
 * __checks__ pin:
 *   • rewardPayouts === ggr − ngr (canonical),
 *   • onSiteRewardCost === rewardPayouts − creatorLeaderboardCost (≥ 0),
 *   • onSiteDragPct === onSiteRewardCost ÷ wager,
 *   • programs exclude the leaderboard line and Σ programs ≈ on-site lines.
 */
export function buildOwnerWindowRecon(
  input: OwnerWindowReconInput,
): OwnerWindowRecon {
  const wager = Math.max(0, input.hubWagerUsd);
  const rewardPayouts = input.ggr - input.ngr;
  const leaderboardLine = input.rewardLines.find(
    (l) => l.key === LEADERBOARD_REWARD_LINE_KEY,
  );
  const creatorLeaderboardCost = Math.max(0, leaderboardLine?.amountUsd ?? 0);
  const onSiteRewardCost = Math.max(0, rewardPayouts - creatorLeaderboardCost);
  const frac = (v: number): number | null => (wager > 0 ? v / wager : null);

  const programs: OwnerProgramSpend[] = input.rewardLines
    .filter((l) => l.key !== LEADERBOARD_REWARD_LINE_KEY && l.amountUsd > 0)
    .map((l) => ({
      key: l.key,
      label: l.label,
      amountUsd: l.amountUsd,
      edgeReductionPp: wager > 0 ? (l.amountUsd / wager) * 100 : null,
    }))
    .sort((a, b) => b.amountUsd - a.amountUsd);

  return {
    windowKey: input.windowKey,
    label: input.label,
    wager,
    realizedPnl: input.realizedPnl,
    ggr: input.ggr,
    ngr: input.ngr,
    rewardPayouts,
    creatorLeaderboardCost,
    onSiteRewardCost,
    onSiteDragPct: frac(onSiteRewardCost),
    dragWithCreatorPct: frac(rewardPayouts),
    houseEdge: input.houseEdge,
    programs,
  };
}

export type EdgePlanV2Baseline = SystemEdgeBaseline & {
  /** Canonical headline wager (30d) — getWindowMetrics, incl. upgrader. */
  totalWager: number;
  /** Ledger organic stake (no creator code; on-stream excluded; borrow incl.). */
  ledgerOrganicWager: number;
  /** Upgrader stake from non-creator-coded users. */
  upgraderOrganicWager: number;
  /** Real affiliate COMMISSION cost (Σ|affiliate_claim|). */
  affiliateCommissionCost: number;
  /** Real affiliate LEADERBOARD prize cost (Σ|affiliate_leaderboard_prize|). */
  affiliateLeaderboardCost: number;
  /**
   * Where the affiliate commission/leaderboard split was sourced.
   * "ledger" = canonical customer-scope `sumLedgerTypes` legs (same scope
   * as every other reward leg — creators excluded); "fallback" = the reads
   * failed and the bundled v1 total is shown as commission.
   */
  affiliateSplitSource: "ledger" | "fallback";
  /** Share of withdrawal volume exiting as balance (0..1). Real ledger split. */
  balanceWithdrawalShare: number;
  /** Estimated total withdrawal USD in window. */
  estimatedWithdrawalVolumeUsd: number;
  withdrawalVolumeSource: "ledger" | "estimate";
  balanceWithdrawalShareSource: "ledger" | "estimate";
  /** True when headline metrics were recovered or planning defaults used. */
  baselineSparse?: boolean;
  /** Per-channel motha founder giveaway split (30d window). */
  mothaBreakdown: {
    tips: number;
    rain: number;
    sponsorship: number;
    eventCount: number;
    activeDays: number;
  } | null;
  /** Real borrow-play stake (packs / battles) over the window — display. */
  packWagerBorrowed: number;
  battleWagerBorrowed: number;

  // ── v2.1 overhaul blocks ──
  /** REAL measured 30d block (getWindowMetrics) — the "Measured 30d" strip. */
  canonical: CanonicalMeasuredBlock | null;
  /** MAX(ledger created_at), bounded read — the "Data through X" stamp. */
  ledgerMaxCreatedAt: string | null;
  /** Real 30d deposit volume per coin (deposit-fee lever chips). */
  depositsByAsset: DepositAssetVolume[];
  /** Currently-live raffles, valued via the shared prize-valuation helper. */
  liveRaffles: LiveRaffleInfo[];
  /** Real rain cadence/pool anchor (null when the scan failed). */
  rainAnchor: RainAnchor | null;
  /** Real Σ |gift_card_redeemed| over the window. */
  giftCardCost: number;
  /** Real Σ |promo_code_redeemed| over the window. */
  promoCodeCost: number;
  /** Real per-category adjustment breakdown (canonical scope, NULL bucket). */
  adjustmentBreakdown: AdjustmentCategoryRow[];
  /** Σ counted-category CREDITS (the reward-cost slice of adjustments). */
  adjustmentCountedCost: number;
  /** Real deposit-size histogram (count per bucket). */
  depositSizeHistogram: DepositSizeBucket[];
  /** Smallest observed deposit (USD) — the min-deposit input's seed. */
  depositBonusMinDepositObservedUsd: number | null;
  /** Real per-user-day deposit-bonus distribution (time-bonus anchor). */
  timeBonusAnchor: TimeBonusAnchor | null;
  /** Level/XP gate per daily reward pack. */
  dailyPackLevels: DailyPackLevelInfo[];
  /** Real 30d usage stats per daily reward pack. */
  dailyPackUsage: DailyPackUsageInfo[];
  /** Measured 30d $ per reward source (credit-matrix rows; no new scans). */
  rewardSourceVolumes: RewardSourceVolume[];

  // ── Rework 2026-06-12: owner-trusted anchoring ──
  /**
   * The owner-trusted recon block — hub wager + canonical cost-breakdown
   * per window (30d + lifetime-365). CRITICAL: the baseline build THROWS
   * (and the failure is never cached) when this could not be assembled,
   * so a served baseline always carries it.
   */
  recon: OwnerReconBlock;
  /**
   * Names of NON-critical legs that degraded this build (safeQuery
   * fallbacks). Empty = fully healthy. The page renders these as visible
   * error bands — never as silent zeros.
   */
  degradedBlocks: string[];
};

// ─── The v2 lever state ──────────────────────────────────────────────────────

/**
 * The planner's mutable state. $-budget fields are `number | null` where
 * `null` means "resolve to the real run-rate seed" (see
 * {@link resolveLeverSeedsV2}) — this keeps the default-mount profitDelta at
 * exactly $0 for ANY baseline and lets presets round-trip without baking a
 * stale baseline value in.
 *
 * REMOVED vs the previous v2 shape (legacy preset keys are dropped by the
 * sanitizer): raffle pool/frequency/ticket mults, deposit-bonus
 * match/min-deposit/wager-req mults, race pool/frequency/entry mults,
 * rainCostMult, mothaCostMult, otherRewardCostMult, withdrawalWagerReqMult,
 * hourly users/utilization, removeAffiliateWagerReq (inverted into
 * `affiliateWagerReqEnabled`), rakebackUpgraderMinMultiplier /
 * rakebackUpgraderMaxWinPct.
 */
export type PlannedLeversV2 = {
  /** Planned house edge per game type (0..1). */
  edges: Record<GameTypeId, number>;

  // ── Rakeback ──
  rakebackRates: Record<RakebackCadenceId, number>;
  rakebackPacksWeight: number;
  rakebackBattlesWeight: number;
  rakebackUpgraderWeight: number;
  rakebackInstantPayoutPct: number;
  rakebackInstantAdoption: number;

  // ── Affiliate ──
  affiliateRates: Record<number, number>;
  /**
   * Keep the 1× wager requirement on affiliate commission (default true =
   * current behavior). OFF = instant withdrawal of commission → commission
   * cost × REMOVE_WAGER_REQ_COMMISSION_BASE_MULT (≈1.54, the v1 breakage
   * model — NOT a flat "+15%").
   */
  affiliateWagerReqEnabled: boolean;

  // ── Deposit bonus ──
  depositBonusCapMult: number;
  /** Minimum deposit ($) to qualify; null = the observed minimum (seed). */
  depositBonusMinDepositUsd: number | null;
  /** Time-based split: pay the bonus as $X grants every N hours. */
  depositBonusHourlyEnabled: boolean;
  depositBonusHourlyAmountUsd: number;
  depositBonusHourlyIntervalHours: number;

  // ── Deposit fee (REVENUE — not a cost row) ──
  /** Fee fraction (0..1) charged on selected-coin deposit volume. */
  depositFeePct: number;
  /** Selected coin chips; null = default selection (all except USDT*). */
  depositFeeSelectedAssets: string[] | null;

  // ── Raffles ──
  /** Keep fraction (0..1) of the real 30d raffle prize cost. 1 = keep all. */
  raffleKeepPct: number;

  // ── $ budgets (null = run-rate seed) ──
  raceMonthlyBudgetUsd: number | null;
  /** Hours BETWEEN rains (cadence input); null = observed spacing. */
  rainDurationHours: number | null;
  /** Pool $ per rain event; null = observed average pool. */
  rainPerEventUsd: number | null;
  mothaMonthlyBudgetUsd: number | null;
  giftCardsMonthlyUsd: number | null;
  promoCodesMonthlyUsd: number | null;
  adjustmentsMonthlyRecurringUsd: number | null;

  // ── Daily packs ──
  dailyPackEvUsd: Record<string, number>;
  dailyPacksFrequencyMult: number;
  /**
   * Per-pack 30d re-lock fraction overrides (0..1), keyed by pack id.
   * Missing key = the pack's real default (`relockPctDefault`, usually 1%).
   * A PLAYER requirement — affects NO $ in the projection.
   */
  dailyPackRelockPct: Record<string, number>;

  // ── Signup ──
  signupGrantUsd: number;

  // ── Withdrawals (display-only knobs — no $ projection) ──
  balanceWithdrawalShare: number;
  withdrawalPackBattleWeight: number;
  withdrawalUpgraderWeight: number;

  // ── Shards ──
  shardsEnabled: boolean;
  shardsWagerPerShardUsd: number;
  shardsEvPerShardUsd: number;
  shardsPacksWeight: number;
  shardsBattlesWeight: number;
  shardsUpgraderWeight: number;

  // ── Crediting matrix ──
  /** Share of each reward $ assumed re-wagered (the honest assumption knob). */
  matrixReWagerRate: number;
  matrixCells: CreditMatrixCells;
};

/** A revenue lever's current-vs-planned contribution (house income). */
export type RevenueLeverProjection = {
  key: string;
  label: string;
  currentUsd: number;
  plannedUsd: number;
  /** plannedUsd − currentUsd (positive = MORE house revenue = emerald). */
  deltaUsd: number;
};

export type EdgePlanV2Projection = EdgePlanProjection & {
  /** Revenue channel (deposit fee). NOT part of reward cost. */
  revenueLevers: RevenueLeverProjection[];
  /** Σ revenue deltas. profitDelta = ggrDelta − rewardCostDelta + revenueDelta. */
  revenueDelta: number;
  /**
   * Creator-attributed affiliate leaderboard prizes (window $). Per the
   * house model these are CREATOR costs, NOT on-site reward drag — the
   * lever rows / reward cost totals above EXCLUDE them; this passthrough
   * feeds the small labeled creator-costs footnote line.
   */
  creatorLeaderboardCostUsd: number;
};

// ─── Affiliate split fallback (unchanged) ────────────────────────────────────

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

export function affiliateWorstCaseEdgeDrag(
  baseline: EdgePlanV2Baseline,
  levers: PlannedLeversV2,
): number {
  const houseEdge = plannedMarginBearingHouseEdgeV2(baseline, levers);
  const edgeShare = topAffiliateTierEdgeShare(baseline, levers);
  return affiliateEdgeShareToWagerDrag(edgeShare, houseEdge);
}

// ─── Raw mathematical edge (owner spec #2) ───────────────────────────────────

/**
 * The RAW MATHEMATICAL edge = simple mean of the packs and upgrader planned
 * edges (no wager weighting). At the planning defaults (10.99% & 10%) this
 * is exactly 10.495%. Displayed NEXT TO the wager-weighted real-data edge,
 * both clearly labeled — never a replacement for it.
 */
export function rawMathEdgeV2(
  levers: Pick<PlannedLeversV2, "edges">,
): number {
  const packs = clamp(levers.edges.packs ?? PLANNED_PACKS_BATTLES_EDGE_DEFAULT, 0, 1);
  const upgrader = clamp(levers.edges.upgrader ?? PLANNED_UPGRADER_EDGE_DEFAULT, 0, 1);
  return (packs + upgrader) / 2;
}

// ─── Lever seed resolution (null = run-rate) ─────────────────────────────────

/** Concrete (resolved) values for every null-able $ seed on the levers. */
export type ResolvedLeverSeedsV2 = {
  depositBonusMinDepositUsd: number;
  raceMonthlyBudgetUsd: number;
  rainDurationHours: number;
  rainPerEventUsd: number;
  mothaMonthlyBudgetUsd: number;
  giftCardsMonthlyUsd: number;
  promoCodesMonthlyUsd: number;
  adjustmentsMonthlyRecurringUsd: number;
};

function monthlyRunRate(windowUsd: number, periodDays: number): number {
  const days = periodDays > 0 ? periodDays : 30;
  return (Math.max(0, windowUsd) / days) * 30;
}

function windowFromMonthly(monthlyUsd: number, periodDays: number): number {
  const days = periodDays > 0 ? periodDays : 30;
  return (Math.max(0, monthlyUsd) / 30) * days;
}

/**
 * Resolve every null-able lever to its REAL run-rate seed. The default
 * lever state (all nulls) resolves to values that reproduce the baseline
 * exactly → profitDelta $0 at mount, for any baseline.
 */
export function resolveLeverSeedsV2(
  baseline: EdgePlanV2Baseline,
  levers: PlannedLeversV2,
): ResolvedLeverSeedsV2 {
  const days = Math.max(1, baseline.periodDays);
  const anchor = baseline.rainAnchor;
  const observedIntervalHours =
    anchor && anchor.count > 0 ? (days * 24) / anchor.count : 1;
  const observedPerEventUsd = anchor && anchor.count > 0 ? anchor.avgPoolUsd : 0;

  const nn = (v: number | null, seed: number): number =>
    v != null && Number.isFinite(v) && v >= 0 ? v : seed;

  return {
    depositBonusMinDepositUsd: nn(
      levers.depositBonusMinDepositUsd,
      baseline.depositBonusMinDepositObservedUsd ?? 0,
    ),
    raceMonthlyBudgetUsd: nn(
      levers.raceMonthlyBudgetUsd,
      monthlyRunRate(baseline.raceCost, days),
    ),
    rainDurationHours: Math.max(
      0.05,
      nn(levers.rainDurationHours, observedIntervalHours),
    ),
    rainPerEventUsd: nn(levers.rainPerEventUsd, observedPerEventUsd),
    mothaMonthlyBudgetUsd: nn(
      levers.mothaMonthlyBudgetUsd,
      monthlyRunRate(baseline.mothaCost, days),
    ),
    giftCardsMonthlyUsd: nn(
      levers.giftCardsMonthlyUsd,
      monthlyRunRate(baseline.giftCardCost, days),
    ),
    promoCodesMonthlyUsd: nn(
      levers.promoCodesMonthlyUsd,
      monthlyRunRate(baseline.promoCodeCost, days),
    ),
    adjustmentsMonthlyRecurringUsd: nn(
      levers.adjustmentsMonthlyRecurringUsd,
      monthlyRunRate(baseline.adjustmentCountedCost, days),
    ),
  };
}

// ─── Deposit fee (revenue) ───────────────────────────────────────────────────

/** Default coin selection: every asset EXCEPT the USDT family. */
export function depositFeeDefaultSelectedAssets(
  baseline: Pick<EdgePlanV2Baseline, "depositsByAsset">,
): string[] {
  return baseline.depositsByAsset
    .filter((a) => !a.asset.toUpperCase().startsWith("USDT"))
    .map((a) => a.asset);
}

/** Resolve the active coin selection (null = the USDT-excluding default). */
export function resolvedDepositFeeAssets(
  baseline: Pick<EdgePlanV2Baseline, "depositsByAsset">,
  levers: Pick<PlannedLeversV2, "depositFeeSelectedAssets">,
): string[] {
  if (levers.depositFeeSelectedAssets == null) {
    return depositFeeDefaultSelectedAssets(baseline);
  }
  return levers.depositFeeSelectedAssets;
}

/** Σ selected-coin deposit volume over the window (USD). */
export function depositFeeSelectedVolumeUsd(
  baseline: Pick<EdgePlanV2Baseline, "depositsByAsset">,
  levers: Pick<PlannedLeversV2, "depositFeeSelectedAssets">,
): number {
  const selected = new Set(resolvedDepositFeeAssets(baseline, levers));
  let sum = 0;
  for (const a of baseline.depositsByAsset) {
    if (selected.has(a.asset)) sum += Math.max(0, a.volumeUsd);
  }
  return sum;
}

/**
 * Deposit-fee revenue over the WINDOW = pct × selected coin volume.
 * Deposits ≠ wager: this deliberately does NOT scale with the wager
 * scenario multiplier (the UI footnote says so).
 */
export function depositFeeRevenueUsd(
  baseline: Pick<EdgePlanV2Baseline, "depositsByAsset">,
  levers: Pick<PlannedLeversV2, "depositFeePct" | "depositFeeSelectedAssets">,
): number {
  const pct = clamp(levers.depositFeePct, 0, 1);
  if (pct <= 0) return 0;
  return pct * depositFeeSelectedVolumeUsd(baseline, levers);
}

// ─── Deposit-size eligibility (min-deposit $ gate) ───────────────────────────

/**
 * Share (0..1) of window deposits with amount ≥ `minUsd`, linearly
 * interpolated inside the histogram bucket that contains the threshold.
 * 1 when the histogram is empty (no data → no filtering claim).
 */
export function eligibleDepositShare(
  histogram: readonly DepositSizeBucket[],
  minUsd: number,
): number {
  const total = histogram.reduce((s, b) => s + Math.max(0, b.count), 0);
  if (total <= 0) return 1;
  const min = Math.max(0, Number.isFinite(minUsd) ? minUsd : 0);

  let eligible = 0;
  let lo = 0;
  for (const b of histogram) {
    const count = Math.max(0, b.count);
    const hi = b.maxUsd;
    if (hi == null) {
      // Open top bucket — everything in it clears any finite threshold ≥ lo;
      // below lo the whole bucket is eligible anyway.
      eligible += count;
    } else if (min <= lo) {
      eligible += count;
    } else if (min >= hi) {
      // none of this bucket
    } else {
      const span = hi - lo;
      eligible += span > 0 ? count * ((hi - min) / span) : 0;
    }
    lo = hi ?? lo;
  }
  return clamp(eligible / total, 0, 1);
}

/**
 * Cost ratio of moving the min-deposit gate from the OBSERVED minimum to
 * the planned $ value: eligibleShare(planned) ÷ eligibleShare(observed).
 * 1 at the seed; monotone non-increasing as the gate rises; never > 1
 * (lowering the gate below the observed minimum cannot create deposits
 * that never happened).
 */
export function depositBonusEligibilityRatio(
  baseline: Pick<
    EdgePlanV2Baseline,
    "depositSizeHistogram" | "depositBonusMinDepositObservedUsd"
  >,
  minDepositUsd: number,
): number {
  const observed = baseline.depositBonusMinDepositObservedUsd ?? 0;
  const baseShare = eligibleDepositShare(baseline.depositSizeHistogram, observed);
  const plannedShare = eligibleDepositShare(
    baseline.depositSizeHistogram,
    Math.max(observed, minDepositUsd),
  );
  if (baseShare <= 0) return 1;
  return clamp(plannedShare / baseShare, 0, 1);
}

// ─── Time-based deposit bonus (split-vs-lump, grounded) ──────────────────────

export type TimeBonusSplitModel = {
  /** Per-day cap a user can collect under the split = amount × (24 ÷ interval). */
  dailyCapUsd: number;
  /** Share (0..1) of observed per-user-day volume that fits under the cap. */
  cappedShare: number;
  /** Observed window bonus $ (the lump reference). */
  lumpWindowUsd: number;
  /** Window bonus $ under the split cap (≤ lump, monotone in the cap). */
  splitWindowUsd: number;
  /** (lump − split) scaled to a 30d month — "$X/mo saved by splitting". */
  savedMonthlyUsd: number;
  /** Share (0..1) of user-days at/above the cap — "N% of user-days hit cap". */
  capHitUserDaysPct: number;
};

/**
 * Grounded split-vs-lump model on the REAL per-user-day histogram: capping
 * each user-day at `amount × (24 ÷ interval)` keeps Σ min(dayTotal, cap).
 * Bucket-level bound: contribution = min(bucketTotal, bucketUserDays × cap)
 * — exact for buckets fully under the cap, a tight upper bound otherwise.
 * Split ≤ lump always; monotone in amount and 1/interval.
 */
export function timeBonusSplitModel(
  anchor: TimeBonusAnchor | null,
  levers: Pick<
    PlannedLeversV2,
    "depositBonusHourlyAmountUsd" | "depositBonusHourlyIntervalHours"
  >,
  periodDays: number,
): TimeBonusSplitModel {
  const interval = Math.max(1, levers.depositBonusHourlyIntervalHours);
  const dailyCapUsd =
    Math.max(0, levers.depositBonusHourlyAmountUsd) * (24 / interval);

  if (!anchor || anchor.totalUsd <= 0 || anchor.userDays <= 0) {
    return {
      dailyCapUsd,
      cappedShare: 1,
      lumpWindowUsd: anchor?.totalUsd ?? 0,
      splitWindowUsd: anchor?.totalUsd ?? 0,
      savedMonthlyUsd: 0,
      capHitUserDaysPct: 0,
    };
  }

  let capped = 0;
  let capHitDays = 0;
  let lo = 0;
  for (const b of anchor.buckets) {
    const days = Math.max(0, b.userDays);
    const total = Math.max(0, b.totalUsd);
    capped += Math.min(total, days * dailyCapUsd);
    const hi = b.maxUsd;
    if (hi == null) {
      if (dailyCapUsd <= lo) capHitDays += days;
      else if (days > 0 && total / days >= dailyCapUsd) capHitDays += days;
    } else if (dailyCapUsd <= lo) {
      capHitDays += days;
    } else if (dailyCapUsd < hi) {
      const span = hi - lo;
      capHitDays += span > 0 ? days * ((hi - dailyCapUsd) / span) : 0;
    }
    lo = hi ?? lo;
  }

  const cappedShare = clamp(capped / anchor.totalUsd, 0, 1);
  const lumpWindowUsd = anchor.totalUsd;
  const splitWindowUsd = lumpWindowUsd * cappedShare;
  const days = Math.max(1, periodDays);
  return {
    dailyCapUsd,
    cappedShare,
    lumpWindowUsd,
    splitWindowUsd,
    savedMonthlyUsd: ((lumpWindowUsd - splitWindowUsd) / days) * 30,
    capHitUserDaysPct: clamp(capHitDays / anchor.userDays, 0, 1),
  };
}

// ─── Withdrawal wager-rule worked example (display-only) ─────────────────────

/**
 * Required wager ($) in a game mode to clear a deposit's withdrawal
 * requirement at the mode's weight: deposit ÷ weight. Weight 1 → 1× the
 * deposit; weight 0.5 → 2×; weight 0 → null (mode never clears it).
 */
export function withdrawalRequiredWagerUsd(
  depositUsd: number,
  weight: number,
): number | null {
  const w = clamp(weight, 0, 1);
  if (w <= 0) return null;
  return Math.max(0, depositUsd) / w;
}

// ─── Shards + matrix bridges ─────────────────────────────────────────────────

/** Per-type window wager from the baseline gameTypes (shard input). */
export function shardTypeWagerFromBaseline(
  baseline: Pick<SystemEdgeBaseline, "gameTypes">,
): ShardTypeWager {
  const get = (t: GameTypeId): number =>
    baseline.gameTypes.find((g) => g.type === t)?.wager ?? 0;
  return { packs: get("packs"), battles: get("battles"), upgrader: get("upgrader") };
}

/** The shard config implied by the levers. */
export function shardConfigFromLevers(
  levers: Pick<
    PlannedLeversV2,
    | "shardsEnabled"
    | "shardsWagerPerShardUsd"
    | "shardsEvPerShardUsd"
    | "shardsPacksWeight"
    | "shardsBattlesWeight"
    | "shardsUpgraderWeight"
  >,
): ShardLeverConfig {
  const weights: ShardGameWeights = {
    packs: clamp(levers.shardsPacksWeight, 0, 1),
    battles: clamp(levers.shardsBattlesWeight, 0, 1),
    upgrader: clamp(levers.shardsUpgraderWeight, 0, 1),
  };
  return {
    enabled: levers.shardsEnabled === true,
    wagerPerShardUsd: Math.max(0, levers.shardsWagerPerShardUsd),
    evPerShardUsd: Math.max(0, levers.shardsEvPerShardUsd),
    weights,
  };
}

/** Planned shard cost over the window (USD; 0 when disabled). */
export function shardWindowCostV2(
  baseline: EdgePlanV2Baseline,
  levers: PlannedLeversV2,
): number {
  return shardCostInWindow(
    shardTypeWagerFromBaseline(baseline),
    shardConfigFromLevers(levers),
  );
}

/** Program cost-rates for the crediting matrix (incl. the planned shard rate). */
export function matrixProgramRatesV2(
  baseline: EdgePlanV2Baseline,
  levers: PlannedLeversV2,
): CreditMatrixProgramRate[] {
  const wager = baseline.wager;
  const shardRate = wager > 0 ? shardWindowCostV2(baseline, levers) / wager : 0;
  return deriveProgramRates({
    wager,
    rakebackCost: baseline.rakebackCost,
    raceCost: baseline.raceCost,
    affiliateLeaderboardCost: baseline.affiliateLeaderboardCost,
    dailyPacksCost: baseline.dailyPacksCost,
    shardRatePerWagerDollar: shardRate,
  });
}

/** Window $ saved by the crediting matrix at the planned cells. */
export function matrixSavingsWindowUsd(
  baseline: EdgePlanV2Baseline,
  levers: PlannedLeversV2,
): number {
  return totalMatrixSavingsUsd(
    matrixProgramRatesV2(baseline, levers),
    clamp(levers.matrixReWagerRate, 0, 1),
    baseline.rewardSourceVolumes,
    levers.matrixCells,
  );
}

// ─── Lever anchors (reactivity fix, 2026-06-12) ──────────────────────────────
//
// THE reactivity defect the owner hit: every multiplicative lever anchored
// on `baseline.<cost> × multiplier`, so a degraded (cached-zeros) baseline
// made the whole planner dead — `0 × anything = 0` no matter what he moved.
// The rebuild removes the `current <= 0 → {0,0}` guards entirely: each
// multiplicative lever resolves a $ ANCHOR with a fallback chain
// (measured leg → secondary measured scan → modeled rate × wager proxy),
// flagged `estimated` when the primary leg was missing so the UI can label
// it — the lever stays LIVE either way.

/** Wager proxy for modeled anchors: v1 canonical wager, else the hub 30d wager. */
export function wagerProxyV2(
  baseline: Pick<EdgePlanV2Baseline, "wager" | "recon">,
): number {
  if (baseline.wager > 0) return baseline.wager;
  return Math.max(0, baseline.recon?.d30.wager ?? 0);
}

/** One resolved lever anchor. */
export type LeverAnchorV2 = {
  /** The $ base the lever's model scales. */
  anchorUsd: number;
  /** True when the measured leg was missing and a secondary/modeled source was used. */
  estimated: boolean;
};

export type ResolvedLeverAnchorsV2 = {
  rakeback: LeverAnchorV2;
  affiliateCommission: LeverAnchorV2;
  depositBonus: LeverAnchorV2;
  raffles: LeverAnchorV2;
  rain: LeverAnchorV2;
};

/**
 * Resolve the $ anchor for every multiplicative lever. Fallback chains:
 *   • rakeback      — measured claims → blended cadence rate × wager proxy
 *   • affiliate     — measured commission → blended realized rate × wager proxy
 *   • deposit bonus — measured cost → time-bonus anchor Σ (same ledger type)
 *   • raffles       — reconstructed prize cost → live-raffle prize value
 *   • rain          — canonical net rain → completed-rain pool Σ
 */
export function resolveLeverAnchorsV2(
  baseline: EdgePlanV2Baseline,
): ResolvedLeverAnchorsV2 {
  const proxy = wagerProxyV2(baseline);

  const measured = (usd: number): LeverAnchorV2 | null =>
    usd > 0 ? { anchorUsd: usd, estimated: false } : null;

  const rakebackBlend = blendedCadenceRate(
    baseline.rakebackCadences,
    (c) => c.currentRate,
  );
  return {
    rakeback:
      measured(Math.max(0, baseline.rakebackCost)) ?? {
        anchorUsd: rakebackBlend * proxy,
        estimated: true,
      },
    affiliateCommission:
      measured(Math.max(0, baseline.affiliateCommissionCost)) ?? {
        anchorUsd: Math.max(0, baseline.affiliateBlendedRate ?? 0) * proxy,
        estimated: true,
      },
    depositBonus:
      measured(Math.max(0, baseline.depositBonusCost)) ?? {
        anchorUsd: Math.max(0, baseline.timeBonusAnchor?.totalUsd ?? 0),
        estimated: true,
      },
    raffles:
      measured(Math.max(0, baseline.raffleCost)) ?? {
        anchorUsd: baseline.liveRaffles.reduce(
          (s, r) => s + Math.max(0, r.prizeValueUsd),
          0,
        ),
        estimated: true,
      },
    rain:
      measured(Math.max(0, baseline.rainCost)) ?? {
        anchorUsd: Math.max(0, baseline.rainAnchor?.totalPoolUsd ?? 0),
        estimated: true,
      },
  };
}

// ─── Rakeback / affiliate projections (v2) ───────────────────────────────────

function cadenceWeight(
  cadence: RakebackCadenceLever,
  all: RakebackCadenceLever[],
): number {
  const enabled = all.filter((c) => c.enabled);
  if (enabled.length === 0) return cadence.enabled ? 1 : 0;
  return cadence.enabled ? 1 / enabled.length : 0;
}

/** Blended cadence rate (enabled cadences equally weighted). */
function blendedCadenceRate(
  cadences: RakebackCadenceLever[],
  rateFor: (c: RakebackCadenceLever) => number,
): number {
  return cadences.reduce(
    (s, c) => s + Math.max(0, rateFor(c)) * cadenceWeight(c, cadences),
    0,
  );
}

function blendedPackBattleRakebackWeight(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): number {
  const packs = baseline.gameTypes.find((g) => g.type === "packs")?.wager ?? 0;
  const battles = baseline.gameTypes.find((g) => g.type === "battles")?.wager ?? 0;
  const pb = packs + battles;
  if (pb <= 0) {
    return (clamp(planned.rakebackPacksWeight, 0, 1) + clamp(planned.rakebackBattlesWeight, 0, 1)) / 2;
  }
  return (
    (packs * clamp(planned.rakebackPacksWeight, 0, 1) +
      battles * clamp(planned.rakebackBattlesWeight, 0, 1)) /
    pb
  );
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
  return (
    (packs * clamp(planned.rakebackPacksWeight, 0, 1) +
      battles * clamp(planned.rakebackBattlesWeight, 0, 1) +
      upg * clamp(planned.rakebackUpgraderWeight, 0, 1)) /
    total
  );
}

function projectRakebackV2(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
  anchor: LeverAnchorV2,
): { current: number; planned: number } {
  // REACTIVITY FIX: no `current <= 0 → {0,0}` dead guard. The anchor chain
  // (measured claims → blended rate × wager proxy) keeps the lever live;
  // at the default levers planned === current, so the $0-delta mount
  // invariant holds in every mode.
  const cadences = baseline.rakebackCadences;
  const currentBlend = blendedCadenceRate(cadences, (c) => c.currentRate);
  const plannedBlend = blendedCadenceRate(
    cadences,
    (c) => planned.rakebackRates[c.cadence] ?? c.currentRate,
  );
  const gameWeight = gameTypeRakebackWeightFactor(baseline, planned);

  const adoption = clamp(planned.rakebackInstantAdoption, 0, 1);
  const payoutPct = clamp(planned.rakebackInstantPayoutPct, 0, 1);
  const instantFactor = 1 - adoption + adoption * payoutPct;

  const current = anchor.anchorUsd;
  if (anchor.estimated) {
    // Modeled base: anchorUsd = currentBlend × proxy, so re-deriving the
    // planned $ from the planned blend keeps levers live even from a $0
    // anchor (raising any cadence rate immediately produces a cost).
    const proxy = wagerProxyV2(baseline);
    return {
      current,
      planned: Math.max(0, plannedBlend * proxy * gameWeight * instantFactor),
    };
  }

  const rateRatio = currentBlend > 0 ? plannedBlend / currentBlend : 1;
  return {
    current,
    planned: Math.max(0, current * rateRatio * gameWeight * instantFactor),
  };
}

/** Effective rakeback wager multiplier for UI readouts (1.0 = full accrual). */
export function rakebackEffectiveWagerMult(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): { gameWeight: number; combined: number } {
  const gameWeight = gameTypeRakebackWeightFactor(baseline, planned);
  return { gameWeight, combined: gameWeight };
}

/** Commission-only affiliate projection (excludes leaderboard prizes). */
function projectAffiliateCommissionV2(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
  anchor: LeverAnchorV2,
): { current: number; planned: number } {
  // REACTIVITY FIX: no dead guard. When the measured commission leg is
  // missing the anchor is the blended realized rate × wager proxy — the
  // same multiplicative model runs on the virtual anchor, so tier sliders
  // and the wager-req toggle keep moving $.
  const current = anchor.anchorUsd;

  const tiers = baseline.affiliateTiers;
  const mean = (xs: number[]) =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  const currentBlend = mean(tiers.map((t) => t.currentRate));
  const plannedBlend = mean(
    tiers.map((t) => Math.max(0, planned.affiliateRates[t.level] ?? t.currentRate)),
  );
  const rateRatio = tiers.length > 0 && currentBlend > 0 ? plannedBlend / currentBlend : 1;
  const reqMult = planned.affiliateWagerReqEnabled
    ? 1
    : REMOVE_WAGER_REQ_COMMISSION_BASE_MULT;

  return { current, planned: Math.max(0, current * rateRatio * reqMult) };
}

// ─── v1 bridge ───────────────────────────────────────────────────────────────

function toV1Baseline(baseline: EdgePlanV2Baseline): SystemEdgeBaseline {
  return baseline;
}

/**
 * Synthesize a FULL v1 `PlannedLevers` from the v2 state. Every v1 lever
 * the v2 planner replaced with its own $ model is pinned NEUTRAL (1.0 / off)
 * — its row is overridden in `projectEdgePlanV2`, so the v1 engine's output
 * for it is discarded. Only the levers v2 still delegates (edges, rakeback
 * rates, affiliate rates, daily packs, signup) carry real state.
 */
function toV1Levers(
  planned: PlannedLeversV2,
  baseline: EdgePlanV2Baseline,
): PlannedLevers {
  const v1 = defaultLevers(baseline);
  return {
    ...v1,
    edges: { ...planned.edges },
    rakebackRates: { ...planned.rakebackRates },
    rakebackPackBattleWeight: blendedPackBattleRakebackWeight(baseline, planned),
    rakebackUpgraderWeight: clamp(planned.rakebackUpgraderWeight, 0, 1),
    rakebackInstantPayoutPct: clamp(planned.rakebackInstantPayoutPct, 0, 1),
    rakebackInstantAdoption: clamp(planned.rakebackInstantAdoption, 0, 1),
    affiliateRates: { ...planned.affiliateRates },
    removeAffiliateWagerReq: planned.affiliateWagerReqEnabled === false,
    depositBonusMatchMult: 1,
    depositBonusCapMult: clamp(planned.depositBonusCapMult, 0, 5),
    depositBonusMinDepositMult: 1,
    depositBonusWagerReqMult: 1,
    racePrizePoolMult: 1,
    raceFrequencyMult: 1,
    raceEntryCostMult: 1,
    rafflePrizePoolMult: 1,
    raffleFrequencyMult: 1,
    raffleTicketCostMult: 1,
    dailyPackEvUsd: { ...planned.dailyPackEvUsd },
    dailyPacksFrequencyMult: clamp(planned.dailyPacksFrequencyMult, 0, 5),
    signupGrantUsd: Math.max(0, planned.signupGrantUsd),
    rainCostMult: 1,
    otherRewardCostMult: 1,
    mothaCostMult: 1,
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

/**
 * Net-edge scenario profiles for the Analysis zone, on the v2 lever state.
 * Wraps the v1 helper through the same `toV1Levers` bridge the projection
 * uses (v2-replaced levers pinned neutral — the scenarios profile gross edge
 * vs reward-erosion archetypes, not the v2 $ budget rows).
 */
export function computeNetEdgeScenariosV2(
  baseline: EdgePlanV2Baseline,
  levers: PlannedLeversV2,
): ReturnType<typeof computeNetEdgeScenariosV1> {
  return computeNetEdgeScenariosV1(baseline, toV1Levers(levers, baseline));
}

// ─── Defaults + sanitizer ────────────────────────────────────────────────────

export function defaultLeversV2(baseline: EdgePlanV2Baseline): PlannedLeversV2 {
  // Edge sliders seed from the PLANNING targets (packs+battles 10.99%,
  // upgrader 10%), NOT the per-type measured edge (an accounting artifact —
  // pack-opens-in-battles book wager to Packs and payout to Battles; only
  // the sum is meaningful).
  const edges: Record<GameTypeId, number> = {
    packs: PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
    battles: PLANNED_BATTLES_EDGE_DEFAULT,
    upgrader: PLANNED_UPGRADER_EDGE_DEFAULT,
  };

  const rakebackRates: Record<RakebackCadenceId, number> = {
    daily: 0,
    weekly: 0,
    monthly: 0,
  };
  for (const c of baseline.rakebackCadences) {
    rakebackRates[c.cadence] = c.currentRate;
  }

  const affiliateRates: Record<number, number> = {};
  for (const t of baseline.affiliateTiers) {
    affiliateRates[t.level] = t.currentRate;
  }

  const dailyPackEvUsd: Record<string, number> = {};
  for (const p of baseline.dailyPackRows) {
    dailyPackEvUsd[p.packId] = Math.max(0, p.measuredEvUsd);
  }
  for (const p of baseline.rewardPackCatalog) {
    if (dailyPackEvUsd[p.packId] == null) {
      dailyPackEvUsd[p.packId] = Math.max(0, p.theoreticalEvUsd);
    }
  }

  return {
    edges,

    rakebackRates,
    rakebackPacksWeight: 1,
    rakebackBattlesWeight: 1,
    rakebackUpgraderWeight: 1,
    rakebackInstantPayoutPct: 1,
    rakebackInstantAdoption: 0,

    affiliateRates,
    affiliateWagerReqEnabled: true,

    depositBonusCapMult: 1,
    depositBonusMinDepositUsd: null, // = observed minimum (ratio 1)
    depositBonusHourlyEnabled: false,
    depositBonusHourlyAmountUsd: 25,
    depositBonusHourlyIntervalHours: 6,

    depositFeePct: 0,
    depositFeeSelectedAssets: null, // = all except USDT*

    raffleKeepPct: 1,

    raceMonthlyBudgetUsd: null,
    rainDurationHours: null,
    rainPerEventUsd: null,
    mothaMonthlyBudgetUsd: null,
    giftCardsMonthlyUsd: null,
    promoCodesMonthlyUsd: null,
    adjustmentsMonthlyRecurringUsd: null,

    dailyPackEvUsd,
    dailyPacksFrequencyMult: 1,
    dailyPackRelockPct: {},

    signupGrantUsd: baseline.signupAvgGrant ?? 0,

    balanceWithdrawalShare: baseline.balanceWithdrawalShare,
    withdrawalPackBattleWeight: 1,
    withdrawalUpgraderWeight: 1,

    shardsEnabled: false,
    shardsWagerPerShardUsd: SHARDS_DEFAULT_WAGER_PER_SHARD_USD,
    shardsEvPerShardUsd: SHARDS_DEFAULT_EV_PER_SHARD_USD,
    shardsPacksWeight: 1,
    shardsBattlesWeight: 1,
    shardsUpgraderWeight: 1,

    matrixReWagerRate: 1,
    matrixCells: {},
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
    rakebackPacksWeight: 1,
    rakebackBattlesWeight: 1,
    rakebackUpgraderWeight: 1,
    rakebackInstantPayoutPct: 1,
    rakebackInstantAdoption: 0,
    affiliateRates: {},
    affiliateWagerReqEnabled: true,
    depositBonusCapMult: 1,
    depositBonusMinDepositUsd: null,
    depositBonusHourlyEnabled: false,
    depositBonusHourlyAmountUsd: 25,
    depositBonusHourlyIntervalHours: 6,
    depositFeePct: 0,
    depositFeeSelectedAssets: null,
    raffleKeepPct: 1,
    raceMonthlyBudgetUsd: null,
    rainDurationHours: null,
    rainPerEventUsd: null,
    mothaMonthlyBudgetUsd: null,
    giftCardsMonthlyUsd: null,
    promoCodesMonthlyUsd: null,
    adjustmentsMonthlyRecurringUsd: null,
    dailyPackEvUsd: {},
    dailyPacksFrequencyMult: 1,
    dailyPackRelockPct: {},
    signupGrantUsd: 0,
    balanceWithdrawalShare: 0,
    withdrawalPackBattleWeight: 1,
    withdrawalUpgraderWeight: 1,
    shardsEnabled: false,
    shardsWagerPerShardUsd: SHARDS_DEFAULT_WAGER_PER_SHARD_USD,
    shardsEvPerShardUsd: SHARDS_DEFAULT_EV_PER_SHARD_USD,
    shardsPacksWeight: 1,
    shardsBattlesWeight: 1,
    shardsUpgraderWeight: 1,
    matrixReWagerRate: 1,
    matrixCells: {},
  };
}

/**
 * Coerce arbitrary (persisted / legacy-v1 / hand-edited) input into a
 * COMPLETE, finite `PlannedLeversV2`. The single trust boundary for the
 * localStorage preset store — including the LAZY v1→v2 preset migration:
 *   • removed v1 fields (raffle/race mults, rainCostMult, …) are DROPPED,
 *   • `removeAffiliateWagerReq: true` is INVERTED into
 *     `affiliateWagerReqEnabled: false` (when the new key is absent),
 *   • unknown keys are ignored; non-finite numbers fall back.
 */
export function sanitizeLeversV2(input: unknown): PlannedLeversV2 {
  const base = neutralLeversV2();
  if (input == null || typeof input !== "object") return base;
  const src = input as Record<string, unknown>;

  const num = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const nullableUsd = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
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
  base.rakebackPacksWeight = clamp(num(src.rakebackPacksWeight, 1), 0, 1);
  base.rakebackBattlesWeight = clamp(num(src.rakebackBattlesWeight, 1), 0, 1);
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

  // affiliateWagerReqEnabled — with the legacy-v1 inversion fallback.
  if (typeof src.affiliateWagerReqEnabled === "boolean") {
    base.affiliateWagerReqEnabled = src.affiliateWagerReqEnabled;
  } else if (src.removeAffiliateWagerReq === true) {
    base.affiliateWagerReqEnabled = false;
  }

  base.depositBonusCapMult = clamp(num(src.depositBonusCapMult, 1), 0, 5);
  base.depositBonusMinDepositUsd = nullableUsd(src.depositBonusMinDepositUsd);
  base.depositBonusHourlyEnabled = src.depositBonusHourlyEnabled === true;
  base.depositBonusHourlyAmountUsd = Math.max(
    0,
    num(src.depositBonusHourlyAmountUsd, 25),
  );
  base.depositBonusHourlyIntervalHours = clamp(
    num(src.depositBonusHourlyIntervalHours, 6),
    1,
    720,
  );

  base.depositFeePct = clamp(num(src.depositFeePct, 0), 0, 1);
  if (Array.isArray(src.depositFeeSelectedAssets)) {
    const assets: string[] = [];
    const seen = new Set<string>();
    for (const a of src.depositFeeSelectedAssets) {
      if (typeof a !== "string") continue;
      const trimmed = a.trim().slice(0, 40);
      if (trimmed.length === 0 || seen.has(trimmed)) continue;
      seen.add(trimmed);
      assets.push(trimmed);
      if (assets.length >= 40) break;
    }
    base.depositFeeSelectedAssets = assets;
  }

  base.raffleKeepPct = clamp(num(src.raffleKeepPct, 1), 0, 1);

  base.raceMonthlyBudgetUsd = nullableUsd(src.raceMonthlyBudgetUsd);
  base.rainDurationHours =
    src.rainDurationHours == null
      ? null
      : clamp(num(src.rainDurationHours, 1), 0.05, 720);
  base.rainPerEventUsd = nullableUsd(src.rainPerEventUsd);
  base.mothaMonthlyBudgetUsd = nullableUsd(src.mothaMonthlyBudgetUsd);
  base.giftCardsMonthlyUsd = nullableUsd(src.giftCardsMonthlyUsd);
  base.promoCodesMonthlyUsd = nullableUsd(src.promoCodesMonthlyUsd);
  base.adjustmentsMonthlyRecurringUsd = nullableUsd(
    src.adjustmentsMonthlyRecurringUsd,
  );

  if (src.dailyPackEvUsd != null && typeof src.dailyPackEvUsd === "object") {
    const d = src.dailyPackEvUsd as Record<string, unknown>;
    for (const [packId, v] of Object.entries(d)) {
      if (typeof packId !== "string" || packId.length === 0) continue;
      base.dailyPackEvUsd[packId] = Math.max(0, num(v, 0));
    }
  }
  base.dailyPacksFrequencyMult = clamp(num(src.dailyPacksFrequencyMult, 1), 0, 5);
  if (src.dailyPackRelockPct != null && typeof src.dailyPackRelockPct === "object") {
    const d = src.dailyPackRelockPct as Record<string, unknown>;
    for (const [packId, v] of Object.entries(d)) {
      if (typeof packId !== "string" || packId.length === 0) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      base.dailyPackRelockPct[packId] = clamp(n, 0, 1);
    }
  }

  base.signupGrantUsd = Math.max(0, num(src.signupGrantUsd, 0));

  base.balanceWithdrawalShare = clamp(num(src.balanceWithdrawalShare, 0), 0, 1);
  base.withdrawalPackBattleWeight = clamp(num(src.withdrawalPackBattleWeight, 1), 0, 1);
  base.withdrawalUpgraderWeight = clamp(num(src.withdrawalUpgraderWeight, 1), 0, 1);

  base.shardsEnabled = src.shardsEnabled === true;
  base.shardsWagerPerShardUsd = clamp(
    num(src.shardsWagerPerShardUsd, SHARDS_DEFAULT_WAGER_PER_SHARD_USD),
    0.01,
    10_000,
  );
  base.shardsEvPerShardUsd = clamp(
    num(src.shardsEvPerShardUsd, SHARDS_DEFAULT_EV_PER_SHARD_USD),
    0,
    1_000,
  );
  base.shardsPacksWeight = clamp(num(src.shardsPacksWeight, 1), 0, 1);
  base.shardsBattlesWeight = clamp(num(src.shardsBattlesWeight, 1), 0, 1);
  base.shardsUpgraderWeight = clamp(num(src.shardsUpgraderWeight, 1), 0, 1);

  base.matrixReWagerRate = clamp(num(src.matrixReWagerRate, 1), 0, 1);
  base.matrixCells = sanitizeMatrixCells(src.matrixCells);

  return base;
}

// ─── Planning GGR (planned-vs-default, unchanged math) ───────────────────────

function applyPlanningGameProjections(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
  core: EdgePlanProjection,
): Pick<EdgePlanProjection, "gameTypes" | "ggrDelta"> {
  const defaults = defaultLeversV2(baseline);

  const projectType = (g: GameTypeProjection): GameTypeProjection => {
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
  };

  const packsCore = core.gameTypes.find((g) => g.type === "packs");
  const battlesCore = core.gameTypes.find((g) => g.type === "battles");

  // Packs + Battles merge into ONE row (the edge is on pack opens; battles
  // carry no separate edge — only the sum reconciles).
  const gameTypes: GameTypeProjection[] = [];
  if (packsCore) {
    const packsProj = projectType(packsCore);
    const battlesWager = battlesCore?.wager ?? 0;
    const combinedWager = packsProj.wager + battlesWager;
    const blendedEdge =
      combinedWager > 0 ? packsProj.plannedGgr / combinedWager : packsProj.plannedEdge;
    gameTypes.push({
      ...packsProj,
      label: battlesWager > 0 ? "Packs & battles" : packsProj.label,
      wager: combinedWager,
      currentEdge: blendedEdge,
      plannedEdge: blendedEdge,
      dataAvailable: packsProj.dataAvailable || (battlesCore?.dataAvailable ?? false),
    });
  }
  for (const g of core.gameTypes) {
    if (g.type === "packs" || g.type === "battles") continue;
    gameTypes.push(projectType(g));
  }

  return {
    gameTypes,
    ggrDelta: gameTypes.reduce((s, g) => s + g.ggrDelta, 0),
  };
}

// ─── The v2 projection ───────────────────────────────────────────────────────

/**
 * Sub-cent magnitude below which a $ delta is floating-point dust, not a
 * real planning move. The default-mount profitDelta is a sum of ~19 lever
 * deltas that are each analytically $0 but carry float residue; when that
 * residue lands negative, `Intl` renders "-$0.00" and the house-POV accent
 * flips rose — breaking the plan's "$0 at default mount" rendering
 * contract (verified on the deterministic fixture, 2026-06-12). Anything
 * under half a cent can never round to a visible cent, so clamping it to
 * exactly 0 changes no real number.
 */
const PROFIT_DELTA_DUST_USD = 0.005;

/** Clamp sub-cent floating-point dust to exactly 0 (see above). */
function clampDustToZero(usd: number): number {
  return Math.abs(usd) < PROFIT_DELTA_DUST_USD ? 0 : usd;
}

/**
 * Run the full current-vs-planned v2 projection. PURE.
 *
 *   profitDelta = ggrDelta − rewardCostDelta + revenueDelta
 *
 * Every lever row is either delegated to the v1 engine (rakeback /
 * affiliate / daily packs / signup — with v2 overrides) or computed here
 * from the v2 $ inputs against its real run-rate anchor. At
 * `defaultLeversV2` every row's deltaCost is $0 and revenueDelta is $0
 * (profitDelta is dust-clamped so the mount renders exactly $0 emerald,
 * never a "-$0.00" rose artifact).
 */
export function projectEdgePlanV2(
  baseline: EdgePlanV2Baseline,
  planned: PlannedLeversV2,
): EdgePlanV2Projection {
  const days = Math.max(1, baseline.periodDays);
  const seeds = resolveLeverSeedsV2(baseline, planned);
  const anchors = resolveLeverAnchorsV2(baseline);
  const core = projectEdgePlan(toV1Baseline(baseline), toV1Levers(planned, baseline));
  const planningGgr = applyPlanningGameProjections(baseline, planned, core);

  const rakeback = projectRakebackV2(baseline, planned, anchors.rakeback);
  const affiliateCommission = projectAffiliateCommissionV2(
    baseline,
    planned,
    anchors.affiliateCommission,
  );
  // Creator cost per the house model — surfaced as a footnote passthrough,
  // NEVER a reward-cost lever row (see the levers array below).
  const affiliateLeaderboardCurrent = Math.max(0, baseline.affiliateLeaderboardCost);

  // ── Deposit bonus: cap mult × $-gate eligibility × optional time-split ──
  // Anchored on the resolved anchor (measured cost → time-bonus Σ) so the
  // cap / min-$ / split levers stay live on a degraded baseline.
  const eligibilityRatio = depositBonusEligibilityRatio(
    baseline,
    seeds.depositBonusMinDepositUsd,
  );
  const split = timeBonusSplitModel(baseline.timeBonusAnchor, planned, days);
  const splitFactor =
    planned.depositBonusHourlyEnabled && split.lumpWindowUsd > 0
      ? split.cappedShare
      : 1;
  const depositBonusCurrent = anchors.depositBonus.anchorUsd;
  const depositBonusPlanned =
    depositBonusCurrent *
    Math.pow(Math.max(0, planned.depositBonusCapMult), DEPOSIT_BONUS_CAP_COST_EXPONENT) *
    eligibilityRatio *
    splitFactor;

  // ── Races: ONE monthly $ budget against the run-rate ──
  const racePlanned = windowFromMonthly(seeds.raceMonthlyBudgetUsd, days);

  // ── Raffles: keep-fraction of the anchored prize cost (measured →
  //    live-raffle prize value when the measured leg degraded) ──
  const raffleCurrent = anchors.raffles.anchorUsd;
  const rafflePlanned = raffleCurrent * clamp(planned.raffleKeepPct, 0, 1);

  // ── Rain: scale the anchored rain cost by planned/observed pool $ ──
  const anchor = baseline.rainAnchor;
  const observedRainUsd = anchor ? anchor.count * anchor.avgPoolUsd : 0;
  const plannedRainEvents = (days * 24) / Math.max(0.05, seeds.rainDurationHours);
  const plannedRainUsd = plannedRainEvents * Math.max(0, seeds.rainPerEventUsd);
  const rainCurrent = anchors.rain.anchorUsd;
  // With an observed cadence the planned $ scales the anchor by
  // planned/observed pool volume (ratio 1 at the null seeds). With NO
  // observed cadence at all, explicit cadence/pool inputs REPLACE the plan
  // (events × pool $ IS the planned window cost) so the lever still moves;
  // at the null defaults the anchor is reproduced → delta $0.
  const rainExplicit =
    planned.rainDurationHours != null || planned.rainPerEventUsd != null;
  const rainPlanned =
    observedRainUsd > 0
      ? rainCurrent * Math.max(0, plannedRainUsd / observedRainUsd)
      : rainExplicit
        ? plannedRainUsd
        : rainCurrent;

  // ── Motha / gift cards / promo codes / adjustments: monthly $ inputs ──
  const mothaPlanned = windowFromMonthly(seeds.mothaMonthlyBudgetUsd, days);
  const giftCardsPlanned = windowFromMonthly(seeds.giftCardsMonthlyUsd, days);
  const promoCodesPlanned = windowFromMonthly(seeds.promoCodesMonthlyUsd, days);
  const adjustmentsPlanned = windowFromMonthly(
    seeds.adjustmentsMonthlyRecurringUsd,
    days,
  );

  // ── Residual other (read-only): what's left after itemizing the above ──
  const residualOther = Math.max(
    0,
    baseline.otherRewardCost -
      baseline.giftCardCost -
      baseline.promoCodeCost -
      baseline.adjustmentCountedCost,
  );

  // ── Shards (NEW cost; $0 when disabled) ──
  const shardsPlanned = shardWindowCostV2(baseline, planned);

  // ── Crediting matrix (cost REDUCTION; $0 at all-100 cells) ──
  const matrixSavings = matrixSavingsWindowUsd(baseline, planned);

  // Delegated row from the v1 core: daily packs (its default planned sum
  // reproduces the per-pack anchored current exactly).
  const dailyPacksRow = core.levers.find((l) => l.key === "daily-packs");

  // Signup: DELTA-anchored — claimants × (grant − defaultGrant) on top of the
  // real cost — so the default mount is exactly $0 even when the stored avg
  // grant carries rounding vs totalCost ÷ claimants.
  const signupDefaultGrant = Math.max(0, baseline.signupAvgGrant ?? 0);
  const signupDelta =
    baseline.signupClaimants *
    (Math.max(0, planned.signupGrantUsd) - signupDefaultGrant);
  const signupPlanned = Math.max(0, baseline.signupPacksCost + signupDelta);

  const levers: LeverProjection[] = [
    // NOTE (owner model, 2026-06-12): affiliate LEADERBOARD prizes are
    // CREATOR costs — they are NOT a lever row and NOT in the reward-cost
    // totals/drag anymore. They surface only as the
    // `creatorLeaderboardCostUsd` footnote passthrough.
    {
      key: "rakeback",
      label: "Rakeback",
      currentCost: rakeback.current,
      plannedCost: rakeback.planned,
      deltaCost: rakeback.planned - rakeback.current,
      dataAvailable:
        rakeback.current > 0 || baseline.rakebackCadences.length > 0,
    },
    {
      key: "affiliate",
      label: "Affiliate commission",
      currentCost: affiliateCommission.current,
      plannedCost: affiliateCommission.planned,
      deltaCost: affiliateCommission.planned - affiliateCommission.current,
      dataAvailable:
        affiliateCommission.current > 0 || baseline.affiliateTiers.length > 0,
    },
    {
      key: "deposit-bonus",
      label: "Deposit bonus",
      currentCost: depositBonusCurrent,
      plannedCost: depositBonusPlanned,
      deltaCost: depositBonusPlanned - depositBonusCurrent,
      dataAvailable: depositBonusCurrent > 0,
    },
    {
      key: "races",
      label: "Races",
      currentCost: baseline.raceCost,
      plannedCost: racePlanned,
      deltaCost: racePlanned - baseline.raceCost,
      dataAvailable: baseline.raceCost > 0,
    },
    {
      key: "raffles",
      label: "Raffles",
      currentCost: raffleCurrent,
      plannedCost: rafflePlanned,
      deltaCost: rafflePlanned - raffleCurrent,
      dataAvailable: raffleCurrent > 0,
    },
    {
      key: "daily-packs",
      label: "Daily / free packs",
      currentCost: dailyPacksRow?.currentCost ?? baseline.dailyPacksCost,
      plannedCost: dailyPacksRow?.plannedCost ?? baseline.dailyPacksCost,
      deltaCost: dailyPacksRow?.deltaCost ?? 0,
      dataAvailable: dailyPacksRow?.dataAvailable ?? baseline.dailyPacksCost > 0,
    },
    {
      key: "signup-packs",
      label: "Signup balance reward",
      currentCost: baseline.signupPacksCost,
      plannedCost: signupPlanned,
      deltaCost: signupPlanned - baseline.signupPacksCost,
      dataAvailable: baseline.signupClaimants > 0,
    },
    {
      key: "rain",
      label: "Rain",
      currentCost: rainCurrent,
      plannedCost: rainPlanned,
      deltaCost: rainPlanned - rainCurrent,
      dataAvailable: rainCurrent > 0 || rainExplicit,
    },
    {
      key: "motha",
      label: "Motha giveaways",
      currentCost: baseline.mothaCost,
      plannedCost: mothaPlanned,
      deltaCost: mothaPlanned - baseline.mothaCost,
      dataAvailable: baseline.mothaCost > 0,
    },
    {
      key: "gift-cards",
      label: "Gift cards",
      currentCost: baseline.giftCardCost,
      plannedCost: giftCardsPlanned,
      deltaCost: giftCardsPlanned - baseline.giftCardCost,
      dataAvailable: baseline.giftCardCost > 0,
    },
    {
      key: "promo-codes",
      label: "Promo codes",
      currentCost: baseline.promoCodeCost,
      plannedCost: promoCodesPlanned,
      deltaCost: promoCodesPlanned - baseline.promoCodeCost,
      dataAvailable: baseline.promoCodeCost > 0,
    },
    {
      key: "adjustments",
      label: "Balance adjustments (counted)",
      currentCost: baseline.adjustmentCountedCost,
      plannedCost: adjustmentsPlanned,
      deltaCost: adjustmentsPlanned - baseline.adjustmentCountedCost,
      dataAvailable: baseline.adjustmentCountedCost > 0,
    },
    {
      key: "other",
      label: "Residual other rewards",
      currentCost: residualOther,
      plannedCost: residualOther,
      deltaCost: 0,
      dataAvailable: residualOther > 0,
    },
    {
      key: "shards",
      label: "Shards",
      currentCost: 0,
      plannedCost: shardsPlanned,
      deltaCost: shardsPlanned,
      dataAvailable: true,
    },
    {
      key: "credit-matrix",
      label: "Crediting matrix savings",
      currentCost: 0,
      plannedCost: -matrixSavings,
      deltaCost: -matrixSavings,
      dataAvailable: true,
    },
  ];

  // ── Revenue channel (deposit fee) ──
  const depositFeePlanned = depositFeeRevenueUsd(baseline, planned);
  const revenueLevers: RevenueLeverProjection[] = [
    {
      key: "deposit-fee",
      label: "Deposit fee revenue",
      currentUsd: 0,
      plannedUsd: depositFeePlanned,
      deltaUsd: depositFeePlanned,
    },
  ];
  const revenueDelta = revenueLevers.reduce((s, r) => s + r.deltaUsd, 0);

  // ── Reconciliation (planned-vs-default, $0 at the default mount) ──
  const ggrDelta = planningGgr.ggrDelta;
  const rewardCostDelta = levers.reduce((s, l) => s + l.deltaCost, 0);

  const plannedGgr = core.plannedGgr;
  const currentGgr = plannedGgr - ggrDelta;
  const currentRewardCost = levers.reduce((s, l) => s + l.currentCost, 0);
  const plannedRewardCost = currentRewardCost + rewardCostDelta;
  const currentRevenue = revenueLevers.reduce((s, r) => s + r.currentUsd, 0);
  const plannedRevenue = revenueLevers.reduce((s, r) => s + r.plannedUsd, 0);
  const plannedNgr = plannedGgr - plannedRewardCost + plannedRevenue;
  const currentNgr = currentGgr - currentRewardCost + currentRevenue;
  // Dust-clamped at the source so EVERY consumer (hero AnimatedNumber,
  // houseAccent, signed sublabels, tile accents) sees exactly 0 — not a
  // negative sub-cent residue that formats as "-$0.00" with a rose accent.
  const profitDelta = clampDustToZero(ggrDelta - rewardCostDelta + revenueDelta);
  const monthlyProfitDelta = (profitDelta / days) * 30;
  const annualProfitDelta = (profitDelta / days) * 365;

  return {
    ...core,
    ...planningGgr,
    levers,
    revenueLevers,
    revenueDelta,
    creatorLeaderboardCostUsd: affiliateLeaderboardCurrent,
    plannedGgr,
    currentGgr,
    plannedRewardCost,
    currentRewardCost,
    rewardCostDelta,
    plannedNgr,
    currentNgr,
    profitDelta,
    monthlyProfitDelta,
    annualProfitDelta,
  };
}

// ─── Owner-model reward drag (headline figure) ───────────────────────────────

/**
 * The headline reward drag the OWNER's model defines:
 *
 *   drag = on-site reward spend ÷ hub wager (real customer stake)
 *
 * — NOT reward-cost-incl-leaderboard ÷ margin-bearing wager (the old page's
 * "−15.97%" had both the numerator and the denominator wrong). The measured
 * figures come straight from the recon block (getCostBreakdown −
 * leaderboard leg, ÷ getInsightsHubWager30d); the planned figures divide
 * the planner's reward-cost rows (which already exclude the
 * creator-attributed leaderboard prizes) by the SAME hub wager.
 */
export type OwnerDragSummary = {
  windowLabel: string;
  /** Hub-style 30d customer wager — the drag denominator. */
  hubWagerUsd: number;
  /** Σ planner reward rows at the planned levers (on-site only). */
  plannedOnSiteCostUsd: number;
  /** Σ planner reward rows at the current anchors (on-site only). */
  currentOnSiteCostUsd: number;
  /** Measured on-site reward spend (recon: rewardPayouts − leaderboard). */
  measuredOnSiteCostUsd: number;
  /** Creator-attributed leaderboard prizes (the footnote line). */
  creatorLeaderboardCostUsd: number;
  /** plannedOnSiteCostUsd ÷ hubWagerUsd (fraction). Null when no wager. */
  plannedDragPct: number | null;
  currentDragPct: number | null;
  /** Measured drag (recon onSiteDragPct). */
  measuredDragPct: number | null;
  /** Transparency: measured drag WITH the creator leaderboard included. */
  dragWithCreatorPct: number | null;
};

export function computeOwnerDragSummary(
  baseline: EdgePlanV2Baseline,
  projection: EdgePlanV2Projection,
): OwnerDragSummary {
  const recon = baseline.recon.d30;
  const wager = Math.max(0, recon.wager);
  const planned = Math.max(0, projection.plannedRewardCost);
  const current = Math.max(0, projection.currentRewardCost);
  const frac = (v: number): number | null => (wager > 0 ? v / wager : null);
  return {
    windowLabel: recon.label,
    hubWagerUsd: wager,
    plannedOnSiteCostUsd: planned,
    currentOnSiteCostUsd: current,
    measuredOnSiteCostUsd: recon.onSiteRewardCost,
    creatorLeaderboardCostUsd: recon.creatorLeaderboardCost,
    plannedDragPct: frac(planned),
    currentDragPct: frac(current),
    measuredDragPct: recon.onSiteDragPct,
    dragWithCreatorPct: recon.dragWithCreatorPct,
  };
}

// ─── Edge-after-rewards waterfall (kept; revenue shown separately) ───────────

export type EdgeAfterRewardsLeverDrag = {
  key: string;
  label: string;
  plannedCostUsd: number;
  /** Positive = erodes edge (reward drag on the planned config). */
  dragPct: number;
  dragNote?: string;
};

export type EdgeAfterRewardsContext = {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  scenarioWagerUsd?: number | null;
};

export type EdgeAfterRewardsSummary = {
  wager: number;
  baseWager: number;
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

export type WagerScenarioState = {
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
const WAGER_PROPORTIONAL_LEVER_KEYS = new Set(["rakeback", "affiliate", "shards"]);

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

  const marginWager = ctx?.baseline
    ? Math.max(0, marginBearingWager(ctx.baseline))
    : baseWager;
  const scenarioMarginWager = marginWager * wagerScenarioMult;

  const grossEdge =
    ctx?.baseline && ctx?.levers
      ? plannedMarginBearingHouseEdgeV2(ctx.baseline, ctx.levers)
      : projection.plannedEdge;
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
