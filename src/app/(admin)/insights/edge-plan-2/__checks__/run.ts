/**
 * Edge Plan 2.0 — pure model invariant checks (v2.1 overhaul, 2026-06-12).
 *
 * Run with:
 *   npx tsx "src/app/(admin)/insights/edge-plan-2/__checks__/run.ts"
 *
 * NO DB, NO React, NO server imports — this file imports ONLY the pure model
 * modules (`_model-v2` / `_shards-v2` / `_credit-matrix-v2`, which in turn
 * import only the pure v1 engine `system-edge-plan/_model`) and pins every
 * invariant the overhaul plan lists against a SYNTHETIC baseline fixture:
 *
 *   1.  Default-zero: profitDelta is exactly $0 at `defaultLeversV2` (also on
 *       a sparse/degraded baseline).
 *   2.  Raw math edge = mean(packs, upgrader) = 10.495% → renders EXACTLY
 *       "10.495%" (3-decimal precision, owner spec #7).
 *   3.  Raffle keep-slider: linear, monotone, exact endpoints.
 *   4.  Deposit fee: revenue = pct × selected volume EXACTLY, USDT* excluded
 *       by default, profitDelta moves by exactly the revenue.
 *   5.  Shards: 0.3000%-of-wager identity at spec defaults, 10-row case table
 *       (value === shards × EV), weights scale the cost, $0 when disabled.
 *   6.  Crediting matrix: $0 at all-100 cells, exact single-cell savings,
 *       monotone in cells, linear in reWagerRate, bounded above, cost
 *       REDUCTION sign in the projection.
 *   7.  Time-based deposit bonus: split ≤ lump, monotone in interval and
 *       amount, projection wiring.
 *   8.  Min-deposit gate: ratio 1 at the observed seed, monotone
 *       non-increasing, never > 1.
 *   9.  Rain: ratio 1 at the null (run-rate) defaults; pool / cadence scale
 *       the canonical net rain cost proportionally.
 *   10. $-budget round-trips: feeding every resolved seed back explicitly
 *       keeps profitDelta at $0.
 *   11. Sanitizer: legacy v1 payload migrates (removed fields dropped,
 *       `removeAffiliateWagerReq` inverted), clamps, exact key set.
 *   12. Grand identity: plannedNgr − currentNgr === profitDelta ===
 *       ggrDelta − rewardCostDelta + revenueDelta, including revenue + matrix.
 *   17. Page-wide wager scenario (owner: "1,2,3,4,5× don't work"):
 *       m=1 is the EXACT identity (verbatim base projection); at any m the
 *       proportional rows (rakeback / affiliate / shards) scale × m on both
 *       sides, fixed-window $ budgets and deposit-fee revenue stay flat,
 *       GGR scales × m, the profit identity holds, and the default-lever
 *       state stays exactly $0 at EVERY preset multiplier.
 *
 * Exit code 0 = every check passed; 1 = at least one failure (printed).
 */

import {
  type EdgePlanV2Baseline,
  type PlannedLeversV2,
  type OwnerReconBlock,
  defaultLeversV2,
  sanitizeLeversV2,
  projectEdgePlanV2,
  resolveLeverSeedsV2,
  resolveLeverAnchorsV2,
  buildOwnerWindowRecon,
  computeOwnerDragSummary,
  wagerProxyV2,
  LEADERBOARD_REWARD_LINE_KEY,
  rawMathEdgeV2,
  depositFeeDefaultSelectedAssets,
  depositFeeRevenueUsd,
  depositFeeSelectedVolumeUsd,
  depositBonusEligibilityRatio,
  eligibleDepositShare,
  timeBonusSplitModel,
  withdrawalRequiredWagerUsd,
  shardTypeWagerFromBaseline,
  shardConfigFromLevers,
  shardWindowCostV2,
  matrixProgramRatesV2,
  matrixSavingsWindowUsd,
  PLANNED_PACKS_BATTLES_EDGE_DEFAULT,
  PLANNED_BATTLES_EDGE_DEFAULT,
  PLANNED_UPGRADER_EDGE_DEFAULT,
  applyWagerScenarioV2,
  formatWagerMultLabel,
  WAGER_SCENARIO_PRESET_MULTS,
  // Spec #7
  formatRawMathEdgePctV2,
  // Spec #9
  affiliateGlobalScaleFactorV2,
  effectiveAffiliateRateV2,
  topAffiliateTierEdgeShare,
  // Spec #11
  rainPlanV2,
  // Spec #14
  EDGE_INCLUSION_KEYS,
  defaultEdgeInclusionV2,
  isLeverIncludedInEdgeV2,
  computeEdgeAfterRewards,
  // Spec #8
  computeTimeBonusEngineV2,
  type DepositBonusForecastAnchor,
  // Spec #12
  detectAdjustmentReasonKeyV2,
  buildNotItemizedDrilldownV2,
  type NotItemizedRowV2,
} from "../_model-v2";

// Spec #8 — the forecast-page engine pieces, imported DIRECTLY so the
// bridge's numbers can be pinned IDENTICAL to a verbatim page-style call.
import {
  DEPOSIT_BONUS_FORECAST_CONFIG,
  BASELINE_SCENARIO_ID,
  SCENARIO_A_BASELINE,
  simulateSet as depositBonusSimulateSet,
  projectSplitCapVsBaseline,
  findSplitCapLibraryScenario,
} from "../../rewards/deposit-bonus/_forecast";
import { SCENARIO_C_SIXH_25 } from "../../rewards/deposit-bonus/_forecast/scenarios";

import {
  SHARD_CASES,
  SHARDS_DEFAULT_WAGER_PER_SHARD_USD,
  SHARDS_DEFAULT_EV_PER_SHARD_USD,
  SHARDS_TARGET_GIVEBACK,
  shardCaseValueUsd,
  shardCostInWindow,
  effectiveShardGiveback,
} from "../_shards-v2";

import {
  matrixCellKey,
  getMatrixCell,
  sanitizeMatrixCells,
  totalMatrixSavingsUsd,
  programSavingsUsd,
  CREDIT_MATRIX_PROGRAM_IDS,
} from "../_credit-matrix-v2";

// ─── Tiny check harness ──────────────────────────────────────────────────────

let passes = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL  ${name}`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function approx(actual: number, expected: number, eps: number, what: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
    throw new Error(`${what}: expected ≈${expected} (±${eps}), got ${actual}`);
  }
}

// ─── Synthetic baseline fixture (deterministic, every block populated) ──────

const PERIOD_DAYS = 30;

/**
 * Owner-recon fixture — the live-prod probe values from the 2026-06-12 recon
 * (rounded to the cent) so the recon identities are pinned against the REAL
 * shape: hub wager $2,780,670.55 / realized P&L +$46,714.78 (30d) and hub
 * wager $3,211,825.42 / +$120,729.44 (lifetime 365d-capped), with the
 * $61,346 affiliate-leaderboard line attributed to CREATOR costs.
 */
function makeRecon(): OwnerReconBlock {
  const rewardLines30 = [
    { key: "reward:affiliate_leaderboard", label: "Affiliate leaderboard prizes", amountUsd: 61_346 },
    { key: "reward:race", label: "Race prizes", amountUsd: 26_592.5 },
    { key: "reward:deposit_bonus", label: "Deposit bonuses", amountUsd: 17_329.76 },
    { key: "reward:rakeback", label: "Rakeback claims", amountUsd: 8_741.97 },
    { key: "reward:rain", label: "Rain prizes (net house cost)", amountUsd: 1_558.4 },
    { key: "reward:promo_gift", label: "Promo / gift card redemptions", amountUsd: 1_437.85 },
    { key: "reward:leaderboard_waitlist", label: "Leaderboard / waitlist / balance rewards", amountUsd: 1_327 },
    { key: "reward:affiliate", label: "Affiliate commissions", amountUsd: 1_093.51 },
    { key: "reward:adjustment_bonus", label: "Bonus credits", amountUsd: 6_838.37 },
  ];
  return {
    d30: buildOwnerWindowRecon({
      windowKey: "30d",
      label: "Last 30 days",
      hubWagerUsd: 2_780_670.55,
      ggr: -119_856.44,
      ngr: -246_121.8,
      realizedPnl: 46_714.78,
      houseEdge: -0.1063,
      rewardLines: rewardLines30,
    }),
    lifetime: buildOwnerWindowRecon({
      windowKey: "lifetime365",
      label: "Lifetime (365d-capped)",
      hubWagerUsd: 3_211_825.42,
      ggr: -72_798.29,
      ngr: -204_483.03,
      realizedPnl: 120_729.44,
      houseEdge: null,
      rewardLines: rewardLines30.map((l) =>
        l.key === "reward:race" ? { ...l, amountUsd: 27_582.5 } : l,
      ),
    }),
    asOfIso: "2026-06-12T00:00:00.000Z",
  };
}

function makeBaseline(): EdgePlanV2Baseline {
  const gameTypes = [
    { type: "packs" as const, wager: 1_311_000, payout: 1_042_255, ggr: 268_745, edge: 0.205, bets: 84_000, dataAvailable: true },
    { type: "battles" as const, wager: 600_100, payout: 968_248, ggr: -368_148, edge: -0.613, bets: 21_000, dataAvailable: true },
    { type: "upgrader" as const, wager: 578_000, payout: 578_000, ggr: 0, edge: 0, bets: 12_500, dataAvailable: true },
  ];
  const wager = gameTypes.reduce((s, g) => s + g.wager, 0); // 2,489,100
  const gamingPayout = gameTypes.reduce((s, g) => s + g.payout, 0);
  const ggr = wager - gamingPayout;

  const affiliateCommissionCost = 30_000;
  const affiliateLeaderboardCost = 8_000;

  return {
    periodLabel: "Last 30 days",
    periodDays: PERIOD_DAYS,
    gameTypes,
    wager,
    gamingPayout,
    ggr,
    houseEdge: wager > 0 ? ggr / wager : null,
    bets: gameTypes.reduce((s, g) => s + g.bets, 0),

    rakebackCost: 45_000,
    affiliateCost: affiliateCommissionCost + affiliateLeaderboardCost,
    depositBonusCost: 52_000,
    raceCost: 18_000,
    raffleCost: 22_000,
    dailyPacksCost: 31_000,
    signupPacksCost: 14_000,
    rainCost: 9_000,
    mothaCost: 6_000,
    otherRewardCost: 12_000,

    rakebackCadences: [
      { cadence: "daily", label: "Daily", currentRate: 0.0025, enabled: true },
      { cadence: "weekly", label: "Weekly", currentRate: 0.005, enabled: true },
      { cadence: "monthly", label: "Monthly", currentRate: 0.01, enabled: false },
    ],
    affiliateTiers: [
      { level: 1, label: "Level 1", currentRate: 0.05, threshold: 0 },
      { level: 2, label: "Level 2", currentRate: 0.07, threshold: 25_000 },
      { level: 3, label: "Level 3", currentRate: 0.1, threshold: 100_000 },
    ],
    affiliateBlendedRate: 0.0085,

    dailyPackRows: [
      {
        packId: "chk-daily-1",
        name: "Daily Tier 1",
        slug: "daily-tier-1",
        opens: 18_500,
        claimers: 7_200,
        giveawayPayout: 19_000,
        measuredEvUsd: 19_000 / 18_500,
        imageUrl: null,
        cardPreviews: [],
      },
      {
        packId: "chk-daily-2",
        name: "Daily Tier 3",
        slug: "daily-tier-3",
        opens: 6_400,
        claimers: 2_100,
        giveawayPayout: 12_000,
        measuredEvUsd: 12_000 / 6_400,
        imageUrl: null,
        cardPreviews: [],
      },
    ],
    rewardPackCatalog: [],
    signupAvgGrant: 5,
    signupClaimants: 2_800,
    signupSignups: 9_400,
    signupAvgPerSignup: 1.49,
    signupConversionPct: 2_800 / 9_400,
    welcomePacks: [],
    depositBonusCapUsd: 100,
    depositBonusWindowHours: 24,
    rainWinTotal: 14_000,
    rainTipTotal: 5_000,

    totalWager: wager,
    ledgerOrganicWager: 0,
    upgraderOrganicWager: 0,
    affiliateCommissionCost,
    affiliateLeaderboardCost,
    affiliateSplitSource: "ledger",
    balanceWithdrawalShare: 0.42,
    estimatedWithdrawalVolumeUsd: 410_000,
    withdrawalVolumeSource: "ledger",
    balanceWithdrawalShareSource: "ledger",
    baselineSparse: false,
    mothaBreakdown: {
      tips: 3_200,
      rain: 1_800,
      sponsorship: 1_000,
      eventCount: 34,
      activeDays: 21,
    },
    packWagerBorrowed: 140_000,
    battleWagerBorrowed: 95_000,

    // ── v2.1 blocks ──
    canonical: {
      wager: 2_310_000,
      gamingPayout: 2_419_800,
      ggr: -109_800,
      ngr: -236_030,
      rewardCost: 126_230,
      houseEdge: -109_800 / 2_310_000,
      bets: 91_800,
      rainHouseCost: 1_551.32,
    },
    ledgerMaxCreatedAt: "2026-06-11T16:20:00.000Z",
    depositsByAsset: [
      { asset: "BTC", count: 340, volumeUsd: 120_000 },
      { asset: "USDT", count: 260, volumeUsd: 95_000 },
      { asset: "ETH", count: 210, volumeUsd: 80_000 },
      { asset: "SOL", count: 150, volumeUsd: 45_000 },
      { asset: "LTC", count: 95, volumeUsd: 30_000 },
      { asset: "USDT_TRON", count: 55, volumeUsd: 20_000 },
    ],
    liveRaffles: [
      {
        id: "chk-raffle-1",
        title: "Weekly Mega Raffle",
        totalEntries: 48_000,
        participantCount: 1_240,
        endsAt: "2026-06-15T20:00:00.000Z",
        prizeValueUsd: 4_800,
        prizes: [
          { type: "pack", id: "pack-a", quantity: 10, unitPriceUsd: 400 },
          { type: "card", id: "card-z", quantity: 2, unitPriceUsd: 400 },
        ],
      },
    ],
    rainAnchor: {
      count: 60,
      avgPoolUsd: 250,
      avgDurationHours: 0.5,
      avgIntervalHours: (PERIOD_DAYS * 24) / 60, // 12h
      totalPoolUsd: 15_000,
    },
    giftCardCost: 4_000,
    promoCodeCost: 3_000,
    adjustmentBreakdown: [
      { category: "giveaway", label: "Giveaway / promo credit", count: 24, creditsUsd: 1_800, debitsUsd: 0, counted: true },
      { category: "service_recovery", label: "Service recovery", count: 9, creditsUsd: 700, debitsUsd: 50, counted: true },
      { category: "official_stream", label: "Official stream (fake balance)", count: 12, creditsUsd: 5_000, debitsUsd: 4_200, counted: false },
      { category: null, label: "Not itemized", count: 17, creditsUsd: 950, debitsUsd: 300, counted: false },
    ],
    adjustmentCountedCost: 2_500,
    depositSizeHistogram: [
      { maxUsd: 5, count: 0 },
      { maxUsd: 10, count: 120 },
      { maxUsd: 15, count: 95 },
      { maxUsd: 20, count: 160 },
      { maxUsd: 25, count: 210 },
      { maxUsd: 30, count: 90 },
      { maxUsd: 40, count: 110 },
      { maxUsd: 50, count: 140 },
      { maxUsd: 75, count: 95 },
      { maxUsd: 100, count: 120 },
      { maxUsd: 150, count: 70 },
      { maxUsd: 200, count: 45 },
      { maxUsd: 300, count: 30 },
      { maxUsd: 500, count: 18 },
      { maxUsd: 1000, count: 6 },
      { maxUsd: null, count: 2 },
    ],
    depositBonusMinDepositObservedUsd: 5,
    // Bucket totals are CONSISTENT with their [lo, hi) ranges (total/userDays
    // sits inside the bucket), and the open top bucket averages $150/user-day
    // so the $25-every-6h split (a $100/day cap) actually binds.
    timeBonusAnchor: {
      userDays: 4_100,
      users: 640,
      totalUsd: 68_300,
      avgPerUserDayUsd: 68_300 / 4_100,
      maxPerUserDayUsd: 480,
      claimRatePerUserDay: Math.min(1, 4_100 / (640 * PERIOD_DAYS)),
      buckets: [
        { maxUsd: 1, userDays: 400, totalUsd: 250 },
        { maxUsd: 2.5, userDays: 520, totalUsd: 900 },
        { maxUsd: 5, userDays: 600, totalUsd: 2_200 },
        { maxUsd: 10, userDays: 700, totalUsd: 5_100 },
        { maxUsd: 15, userDays: 500, totalUsd: 6_200 },
        { maxUsd: 20, userDays: 380, totalUsd: 6_600 },
        { maxUsd: 25, userDays: 300, totalUsd: 6_700 },
        { maxUsd: 50, userDays: 360, totalUsd: 12_550 },
        { maxUsd: 75, userDays: 200, totalUsd: 12_000 },
        { maxUsd: 100, userDays: 80, totalUsd: 6_800 },
        { maxUsd: null, userDays: 60, totalUsd: 9_000 },
      ],
    },
    dailyPackLevels: [
      {
        packId: "chk-daily-1",
        rewardSlug: "daily-1",
        levelRequired: 5,
        xpThreshold: 25_000,
        wagerLossRequiredUsd: 250,
        relockPctDefault: 0.01,
      },
      {
        packId: "chk-daily-2",
        rewardSlug: "daily-3",
        levelRequired: 30,
        xpThreshold: 1_500_000,
        wagerLossRequiredUsd: 15_000,
        relockPctDefault: 0.02,
      },
    ],
    dailyPackUsage: [
      {
        packId: "chk-daily-1",
        opens: 18_500,
        claimers: 7_200,
        opensPerClaimer: 18_500 / 7_200,
        eligibleUsers: 9_000,
        claimRateVsEligible: 7_200 / 9_000,
        everyTimeClaimerPct: 0.34,
      },
      {
        packId: "chk-daily-2",
        opens: 6_400,
        claimers: 2_100,
        opensPerClaimer: 6_400 / 2_100,
        eligibleUsers: 2_600,
        claimRateVsEligible: 2_100 / 2_600,
        everyTimeClaimerPct: 0.55,
      },
    ],
    rewardSourceVolumes: [
      { sourceId: "rain_win", label: "Rain wins", amountUsd: 14_000 },
      { sourceId: "race_prize", label: "Race prizes", amountUsd: 18_000 },
      { sourceId: "rakeback_claim", label: "Rakeback claims", amountUsd: 45_000 },
      { sourceId: "affiliate_claim", label: "Affiliate commission", amountUsd: 30_000 },
      { sourceId: "affiliate_leaderboard_prize", label: "Leaderboard prizes", amountUsd: 8_000 },
      { sourceId: "deposit_bonus", label: "Deposit bonus", amountUsd: 52_000 },
      { sourceId: "motha", label: "Giveaways / tips (motha)", amountUsd: 6_000 },
    ],

    recon: makeRecon(),
    // The owner's trusted dashboard tile (+$44,925.74) — components chosen
    // so the balance-sheet formula reconciles exactly (pinned below).
    ownerTotalPnl: {
      pnl: 44_925.74,
      totalDeposited: 1_950_000,
      totalWithdrawn: 1_520_000,
      userBalance: 210_000,
      inventory: 140_000,
      vouchers: 18_000,
      unclaimedRakeback: 17_074.26,
    },
    degradedBlocks: [],
  };
}

/** Degraded variant: every optional anchor null/empty (failed scans). */
function makeSparseBaseline(): EdgePlanV2Baseline {
  return {
    ...makeBaseline(),
    canonical: null,
    ledgerMaxCreatedAt: null,
    depositsByAsset: [],
    liveRaffles: [],
    rainAnchor: null,
    adjustmentBreakdown: [],
    depositSizeHistogram: [],
    depositBonusMinDepositObservedUsd: null,
    timeBonusAnchor: null,
    dailyPackLevels: [],
    dailyPackUsage: [],
    rewardSourceVolumes: [],
    ownerTotalPnl: null,
    degradedBlocks: [
      "deposits-by-asset",
      "rain-anchor",
      "deposit-histogram",
      "time-bonus-anchor",
    ],
  };
}

/**
 * The OWNER's failure mode: the measured per-program cost legs read $0
 * (the old cached-zeros baseline) while the secondary anchors (cadence
 * configs, time-bonus scan, rain pools, live raffles, blended rates) are
 * present. Pre-rework, every multiplicative lever was DEAD here
 * (`0 × anything = 0`); the reactivity contract asserts each one still
 * moves the profit delta.
 */
function makeDegradedAnchorsBaseline(): EdgePlanV2Baseline {
  return {
    ...makeBaseline(),
    rakebackCost: 0,
    affiliateCost: 0,
    affiliateCommissionCost: 0,
    affiliateLeaderboardCost: 0,
    depositBonusCost: 0,
    raffleCost: 0,
    rainCost: 0,
    degradedBlocks: ["affiliate-commission", "affiliate-leaderboard"],
  };
}

const baseline = makeBaseline();
const CENT = 0.005;

function project(overrides: Partial<PlannedLeversV2>) {
  return projectEdgePlanV2(baseline, { ...defaultLeversV2(baseline), ...overrides });
}

function profitIdentity(p: ReturnType<typeof projectEdgePlanV2>, what: string): void {
  const scale = Math.max(1, Math.abs(p.plannedNgr), Math.abs(p.currentNgr));
  approx(
    p.plannedNgr - p.currentNgr,
    p.profitDelta,
    1e-6 * scale,
    `${what}: plannedNgr − currentNgr === profitDelta`,
  );
  approx(
    p.profitDelta,
    p.ggrDelta - p.rewardCostDelta + p.revenueDelta,
    1e-6 * scale,
    `${what}: profitDelta === ggrDelta − rewardCostDelta + revenueDelta`,
  );
}

// ─── 1. Default-zero invariant ───────────────────────────────────────────────

check("default-zero: profitDelta is $0 at defaultLeversV2 (full baseline)", () => {
  const p = project({});
  approx(p.ggrDelta, 0, 1e-6, "ggrDelta at defaults");
  approx(p.rewardCostDelta, 0, CENT, "rewardCostDelta at defaults");
  assert(p.revenueDelta === 0, `revenueDelta at defaults must be exactly 0, got ${p.revenueDelta}`);
  approx(p.profitDelta, 0, CENT, "profitDelta at defaults");
  for (const l of p.levers) {
    approx(l.deltaCost, 0, CENT, `lever "${l.key}" deltaCost at defaults`);
  }
  profitIdentity(p, "defaults");
});

check("default-zero: holds on a sparse/degraded baseline too", () => {
  const sparse = makeSparseBaseline();
  const p = projectEdgePlanV2(sparse, defaultLeversV2(sparse));
  approx(p.profitDelta, 0, CENT, "profitDelta at defaults (sparse)");
  assert(p.revenueDelta === 0, "revenueDelta (sparse) must be 0");
  profitIdentity(p, "defaults (sparse)");
});

// ─── 2. Raw math edge ────────────────────────────────────────────────────────

check("raw math edge (spec #7): mean(10.99%, 10%) = 10.495% → renders EXACTLY \"10.495%\"", () => {
  const raw = rawMathEdgeV2(defaultLeversV2(baseline));
  approx(
    raw,
    (PLANNED_PACKS_BATTLES_EDGE_DEFAULT + PLANNED_UPGRADER_EDGE_DEFAULT) / 2,
    1e-12,
    "rawMathEdgeV2 at defaults",
  );
  approx(raw, 0.10495, 1e-9, "rawMathEdgeV2 numeric value");
  // THE spec-#7 pin: the dedicated raw-edge formatter shows the exact
  // 3-decimal value at the defaults — never the rounded "10.50%".
  const rendered = formatRawMathEdgePctV2(raw);
  assert(rendered === "10.495%", `raw-edge render must be "10.495%", got "${rendered}"`);
  // 2dp-clean values drop the redundant third decimal (stay visually 2dp).
  assert(formatRawMathEdgePctV2(0.105) === "10.50%", "10.500 trims to 10.50%");
  assert(formatRawMathEdgePctV2(0.11) === "11.00%", "11.000 trims to 11.00%");
  assert(formatRawMathEdgePctV2(Number.NaN) === "—", "non-finite renders an em dash");
  // Battles contribute nothing to the raw mean and stay pinned at 0.
  assert(PLANNED_BATTLES_EDGE_DEFAULT === 0, "battles planning edge must be 0");
});

// ─── 3. Raffle keep slider ───────────────────────────────────────────────────

check("raffles: keep-slider is exact, linear and monotone", () => {
  const row = (k: number) => {
    const r = project({ raffleKeepPct: k }).levers.find((l) => l.key === "raffles");
    assert(r != null, "raffles lever row missing");
    return r;
  };
  approx(row(1).plannedCost, baseline.raffleCost, 1e-9, "keep=100% reproduces the real cost");
  approx(row(1).deltaCost, 0, 1e-9, "keep=100% is delta $0");
  approx(row(0).plannedCost, 0, 1e-9, "keep=0% turns raffles off");
  approx(row(0.5).plannedCost, baseline.raffleCost * 0.5, 1e-9, "keep=50% is exactly half");
  // Linearity: f(a)+f(b) === f(0)+f(a+b) for a+b ≤ 1.
  approx(
    row(0.25).plannedCost + row(0.75).plannedCost,
    row(0).plannedCost + row(1).plannedCost,
    1e-9,
    "keep-slider linearity",
  );
  let prev = -1;
  for (const k of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const cost = row(k).plannedCost;
    assert(cost >= prev - 1e-9, `keep-slider must be monotone (broke at ${k})`);
    prev = cost;
  }
});

// ─── 4. Deposit fee (revenue) ────────────────────────────────────────────────

check("deposit fee: USDT family excluded from the default selection", () => {
  const def = depositFeeDefaultSelectedAssets(baseline);
  assert(def.length === 4, `expected 4 default coins, got ${def.length}`);
  for (const a of def) {
    assert(!a.toUpperCase().startsWith("USDT"), `USDT-family asset "${a}" must be exempt by default`);
  }
  for (const a of ["BTC", "ETH", "SOL", "LTC"]) {
    assert(def.includes(a), `default selection must include ${a}`);
  }
});

check("deposit fee: revenue = pct × selected volume EXACTLY; profitDelta moves by exactly the revenue", () => {
  const pct = 0.025;
  const defaultVolume = 120_000 + 80_000 + 45_000 + 30_000; // non-USDT
  approx(
    depositFeeSelectedVolumeUsd(baseline, { depositFeeSelectedAssets: null }),
    defaultVolume,
    1e-9,
    "default selected volume",
  );
  approx(
    depositFeeRevenueUsd(baseline, { depositFeePct: pct, depositFeeSelectedAssets: null }),
    pct * defaultVolume,
    1e-9,
    "fee revenue exactness",
  );
  const p = project({ depositFeePct: pct });
  approx(p.revenueDelta, pct * defaultVolume, 1e-9, "projection revenueDelta");
  approx(p.profitDelta, pct * defaultVolume, CENT, "profitDelta moves by exactly the revenue");
  approx(p.rewardCostDelta, 0, CENT, "fee must not touch reward cost");
  profitIdentity(p, "deposit fee");
  // Explicit USDT-only selection prices the fee on USDT volume alone.
  approx(
    depositFeeRevenueUsd(baseline, { depositFeePct: pct, depositFeeSelectedAssets: ["USDT"] }),
    pct * 95_000,
    1e-9,
    "explicit USDT selection",
  );
  assert(
    depositFeeRevenueUsd(baseline, { depositFeePct: 0, depositFeeSelectedAssets: null }) === 0,
    "0% fee must be $0 revenue",
  );
});

// ─── 5. Shards ───────────────────────────────────────────────────────────────

check("shards: 0.3000%-of-wager identity at spec defaults (weights 1/1/1, $20, $0.06)", () => {
  const typeWager = shardTypeWagerFromBaseline(baseline);
  const config = {
    enabled: true,
    wagerPerShardUsd: SHARDS_DEFAULT_WAGER_PER_SHARD_USD,
    evPerShardUsd: SHARDS_DEFAULT_EV_PER_SHARD_USD,
    weights: { packs: 1, battles: 1, upgrader: 1 },
  };
  const giveback = effectiveShardGiveback(typeWager, config);
  approx(giveback, SHARDS_TARGET_GIVEBACK, 1e-12, "effective giveback === 0.003 exactly");
  approx(
    shardCostInWindow(typeWager, config),
    baseline.wager * 0.003,
    1e-6,
    "window shard cost = wager × 0.003",
  );
});

check("shards: case table is EXACTLY the owner's 10 rows (names, shards, derived $)", () => {
  // Owner spec 2026-06-12 — names + shard counts pinned verbatim; the $
  // column is DERIVED (shards × $0.06), never stored.
  const OWNER_ROWS: { name: string; shards: number; usd: number }[] = [
    { name: "Starter Kit", shards: 2, usd: 0.12 },
    { name: "Training Ground", shards: 5, usd: 0.3 },
    { name: "Sharp Choice", shards: 10, usd: 0.6 },
    { name: "Elite Loadout", shards: 25, usd: 1.5 },
    { name: "Cash Flow", shards: 50, usd: 3 },
    { name: "Treasure Trove", shards: 100, usd: 6 },
    { name: "Imperial Vault", shards: 250, usd: 15 },
    { name: "Endless Gold", shards: 1_000, usd: 60 },
    { name: "Full House", shards: 5_000, usd: 300 },
    { name: "Eternal Fortune", shards: 10_000, usd: 600 },
  ];
  assert(SHARD_CASES.length === OWNER_ROWS.length, `expected ${OWNER_ROWS.length} shard cases, got ${SHARD_CASES.length}`);
  let prevShards = 0;
  for (let i = 0; i < OWNER_ROWS.length; i++) {
    const want = OWNER_ROWS[i];
    const got = SHARD_CASES[i];
    assert(
      got.name === want.name && got.shards === want.shards,
      `row ${i + 1} must be "${want.name}" @ ${want.shards} shards, got "${got.name}" @ ${got.shards}`,
    );
    approx(
      shardCaseValueUsd(got, SHARDS_DEFAULT_EV_PER_SHARD_USD),
      want.usd,
      1e-9,
      `derived $ (${want.name})`,
    );
    assert(got.shards > prevShards, `case ladder must be ascending (broke at ${got.name})`);
    prevShards = got.shards;
  }
});

check("shards: disabled → $0; weights scale; projection profitDelta = −shard cost", () => {
  const typeWager = shardTypeWagerFromBaseline(baseline);
  const off = shardConfigFromLevers(defaultLeversV2(baseline));
  assert(off.enabled === false, "shards must default OFF");
  assert(shardCostInWindow(typeWager, off) === 0, "disabled shards must cost $0");

  const halfUpgrader = {
    enabled: true,
    wagerPerShardUsd: 20,
    evPerShardUsd: 0.06,
    weights: { packs: 1, battles: 1, upgrader: 0.5 },
  };
  approx(
    shardCostInWindow(typeWager, halfUpgrader),
    ((typeWager.packs + typeWager.battles + 0.5 * typeWager.upgrader) / 20) * 0.06,
    1e-9,
    "weighted shard cost",
  );

  const p = project({ shardsEnabled: true });
  const expectedCost = baseline.wager * 0.003;
  // The model bridge (levers → shard config → window cost) agrees too.
  approx(
    shardWindowCostV2(baseline, { ...defaultLeversV2(baseline), shardsEnabled: true }),
    expectedCost,
    1e-6,
    "shardWindowCostV2 bridge",
  );
  const shardRow = p.levers.find((l) => l.key === "shards");
  assert(shardRow != null, "shards lever row missing");
  approx(shardRow.plannedCost, expectedCost, 1e-6, "shards row planned cost");
  approx(p.profitDelta, -expectedCost, CENT, "shards ON moves profitDelta by −cost");
  profitIdentity(p, "shards on");
});

// ─── 6. Crediting matrix ─────────────────────────────────────────────────────

check("matrix: $0 savings at all-100 cells; exact single-cell savings; sign is a cost REDUCTION", () => {
  const defaults = defaultLeversV2(baseline);
  approx(matrixSavingsWindowUsd(baseline, defaults), 0, 1e-12, "all-100 cells → $0 savings");

  const cells = { [matrixCellKey("rain_win", "rakeback")]: 0 };
  const rakebackRate = baseline.rakebackCost / baseline.wager;
  const expected = rakebackRate * 1 * 14_000 * 1; // rate × reWager × volume × (1−0)
  approx(
    matrixSavingsWindowUsd(baseline, { ...defaults, matrixCells: cells }),
    expected,
    1e-9,
    "single-cell savings exactness",
  );

  const p = project({ matrixCells: cells });
  const row = p.levers.find((l) => l.key === "credit-matrix");
  assert(row != null, "credit-matrix lever row missing");
  approx(row.deltaCost, -expected, 1e-6, "matrix row is a NEGATIVE cost delta (reduction)");
  approx(p.profitDelta, expected, CENT, "matrix savings raise profit");
  profitIdentity(p, "matrix");
});

check("matrix: monotone in cells, linear in reWagerRate, bounded above", () => {
  const defaults = defaultLeversV2(baseline);
  const key = matrixCellKey("rakeback_claim", "races");
  const at = (cell: number, rw = 1) =>
    matrixSavingsWindowUsd(baseline, {
      ...defaults,
      matrixReWagerRate: rw,
      matrixCells: { [key]: cell },
    });
  assert(at(0.25) > at(0.5) && at(0.5) > at(0.75) && at(0.75) > 0, "lowering a cell must increase savings");
  approx(at(0, 0.5), at(0, 1) * 0.5, 1e-9, "savings linear in reWagerRate");
  assert(at(0, 0) === 0, "reWagerRate 0 → $0 savings");

  // Global bound: every cell at 0 ⇒ savings === Σ_program rate × Σ volumes.
  const allZero: Record<string, number> = {};
  for (const s of baseline.rewardSourceVolumes) {
    for (const prog of CREDIT_MATRIX_PROGRAM_IDS) {
      allZero[matrixCellKey(s.sourceId, prog)] = 0;
    }
  }
  const rates = matrixProgramRatesV2(baseline, defaults);
  const totalVolume = baseline.rewardSourceVolumes.reduce((s, v) => s + v.amountUsd, 0);
  const bound = rates.reduce((s, r) => s + r.ratePerWagerDollar * totalVolume, 0);
  const maxSavings = totalMatrixSavingsUsd(rates, 1, baseline.rewardSourceVolumes, allZero);
  approx(maxSavings, bound, 1e-6, "all-zero cells hit the upper bound exactly");
  assert(at(0.4) <= maxSavings + 1e-9, "partial cells stay under the bound");
  // Per-program savings are individually bounded too.
  for (const r of rates) {
    const s = programSavingsUsd(r, 1, baseline.rewardSourceVolumes, allZero);
    assert(s <= r.ratePerWagerDollar * totalVolume + 1e-9, `program ${r.programId} exceeds its bound`);
  }
});

check("matrix: cell sanitizer keeps valid sparse cells, drops junk, clamps", () => {
  const cells = sanitizeMatrixCells({
    [matrixCellKey("rain_win", "shards")]: 0.5,
    "rain_win:bogus_program": 0.2,
    junk: 0.1,
    [matrixCellKey("race_prize", "races")]: 2, // clamps to 1 → dropped (sparse default)
    [matrixCellKey("deposit_bonus", "xp")]: -1, // clamps to 0 → kept
    [matrixCellKey("motha", "rakeback")]: Number.NaN,
  });
  assert(cells[matrixCellKey("rain_win", "shards")] === 0.5, "valid cell kept");
  assert(!("rain_win:bogus_program" in cells), "unknown program dropped");
  assert(!("junk" in cells), "non-cell key dropped");
  assert(!(matrixCellKey("race_prize", "races") in cells), "≥1 cells are sparse-default (dropped)");
  assert(cells[matrixCellKey("deposit_bonus", "xp")] === 0, "negative clamps to 0");
  assert(!(matrixCellKey("motha", "rakeback") in cells), "NaN dropped");
  assert(getMatrixCell(cells, "never_set", "races") === 1, "missing cell reads as 100% credit");
});

// ─── 7. Time-based deposit bonus ─────────────────────────────────────────────

check("time bonus: split ≤ lump always; monotone in interval and amount", () => {
  const anchor = baseline.timeBonusAnchor;
  assert(anchor != null, "fixture anchor missing");
  const model = (amountUsd: number, intervalHours: number) =>
    timeBonusSplitModel(
      anchor,
      { depositBonusHourlyAmountUsd: amountUsd, depositBonusHourlyIntervalHours: intervalHours },
      PERIOD_DAYS,
    );

  for (const amount of [1, 5, 25, 100]) {
    for (const interval of [1, 3, 6, 12, 24, 72]) {
      const m = model(amount, interval);
      assert(
        m.splitWindowUsd <= m.lumpWindowUsd + 1e-9,
        `split (${m.splitWindowUsd}) must be ≤ lump (${m.lumpWindowUsd}) @ $${amount}/${interval}h`,
      );
      assert(m.savedMonthlyUsd >= -1e-9, "monthly savings can never be negative");
      assert(m.capHitUserDaysPct >= 0 && m.capHitUserDaysPct <= 1, "cap-hit share must be 0..1");
      approx(
        m.savedMonthlyUsd,
        ((m.lumpWindowUsd - m.splitWindowUsd) / PERIOD_DAYS) * 30,
        1e-9,
        "saved/mo identity",
      );
    }
  }
  // Longer interval (smaller daily cap) → split window can only shrink.
  let prevSplit = Number.POSITIVE_INFINITY;
  for (const interval of [1, 2, 4, 6, 12, 24, 48]) {
    const m = model(25, interval);
    assert(m.splitWindowUsd <= prevSplit + 1e-9, `interval monotonicity broke at ${interval}h`);
    prevSplit = m.splitWindowUsd;
  }
  // Bigger per-grant amount → split window can only grow.
  let prevAmt = -1;
  for (const amount of [1, 2, 5, 10, 25, 100, 1_000]) {
    const m = model(amount, 6);
    assert(m.splitWindowUsd >= prevAmt - 1e-9, `amount monotonicity broke at $${amount}`);
    prevAmt = m.splitWindowUsd;
  }
  // A huge cap reproduces the lump exactly.
  approx(model(10_000, 1).splitWindowUsd, anchor.totalUsd, 1e-9, "uncapped split === lump");
});

check("time bonus: projection wires cappedShare into the deposit-bonus row", () => {
  const levers = {
    depositBonusHourlyEnabled: true,
    depositBonusHourlyAmountUsd: 25,
    depositBonusHourlyIntervalHours: 6,
  };
  const m = timeBonusSplitModel(
    baseline.timeBonusAnchor,
    { depositBonusHourlyAmountUsd: 25, depositBonusHourlyIntervalHours: 6 },
    PERIOD_DAYS,
  );
  assert(m.cappedShare < 1, "fixture must actually cap something at $25/6h");
  const p = project(levers);
  const row = p.levers.find((l) => l.key === "deposit-bonus");
  assert(row != null, "deposit-bonus row missing");
  approx(
    row.plannedCost,
    baseline.depositBonusCost * m.cappedShare,
    1e-6,
    "deposit-bonus planned = cost × cappedShare",
  );
  profitIdentity(p, "time bonus");
});

// ─── 8. Min-deposit gate ─────────────────────────────────────────────────────

check("min-deposit: ratio 1 at the observed seed, monotone non-increasing, never > 1", () => {
  const observed = baseline.depositBonusMinDepositObservedUsd ?? 0;
  approx(depositBonusEligibilityRatio(baseline, observed), 1, 1e-12, "ratio at the observed seed");
  approx(depositBonusEligibilityRatio(baseline, 0), 1, 1e-12, "gate below observed cannot exceed 1");
  let prev = 1 + 1e-12;
  for (const min of [5, 10, 20, 25, 50, 100, 250, 1_000, 10_000]) {
    const r = depositBonusEligibilityRatio(baseline, min);
    assert(r <= 1 + 1e-12, `ratio must never exceed 1 (got ${r} @ $${min})`);
    assert(r <= prev + 1e-12, `ratio must be non-increasing (broke at $${min})`);
    assert(r >= 0, "ratio must be ≥ 0");
    prev = r;
  }
  assert(eligibleDepositShare(baseline.depositSizeHistogram, 0) === 1, "share at $0 is 1");
  assert(eligibleDepositShare([], 50) === 1, "empty histogram claims no filtering");
  // Projection: raising the gate can only lower the deposit-bonus cost.
  const cost = (min: number | null) => {
    const row = project({ depositBonusMinDepositUsd: min }).levers.find(
      (l) => l.key === "deposit-bonus",
    );
    assert(row != null, "deposit-bonus row missing");
    return row.plannedCost;
  };
  approx(cost(null), baseline.depositBonusCost, 1e-6, "null gate = observed = full cost");
  assert(cost(50) <= cost(20) + 1e-9 && cost(20) <= cost(null) + 1e-9, "projection gate monotonicity");
});

// ─── 9. Rain ─────────────────────────────────────────────────────────────────

check("rain: ratio 1 at the null defaults; pool and cadence scale proportionally", () => {
  const anchor = baseline.rainAnchor;
  assert(anchor != null, "fixture rain anchor missing");
  const rainRow = (o: Partial<PlannedLeversV2>) => {
    const row = project(o).levers.find((l) => l.key === "rain");
    assert(row != null, "rain row missing");
    return row;
  };
  approx(rainRow({}).deltaCost, 0, 1e-9, "null inputs → observed cadence/pool → delta $0");
  // Double the per-event pool at the observed cadence → exactly 2× the cost.
  approx(
    rainRow({ rainPerEventUsd: anchor.avgPoolUsd * 2 }).plannedCost,
    baseline.rainCost * 2,
    1e-6,
    "2× pool → 2× rain cost",
  );
  // Double the spacing between rains → half the events → half the cost.
  approx(
    rainRow({ rainDurationHours: anchor.avgIntervalHours * 2 }).plannedCost,
    baseline.rainCost * 0.5,
    1e-6,
    "2× interval → 0.5× rain cost",
  );
  // Degraded anchor: defaults still hold the $0 invariant.
  const sparse = makeSparseBaseline();
  const p = projectEdgePlanV2(sparse, defaultLeversV2(sparse));
  const row = p.levers.find((l) => l.key === "rain");
  assert(row != null, "rain row missing (sparse)");
  approx(row.deltaCost, 0, 1e-9, "null anchor keeps rain delta $0");
});

// ─── 10. $-budget round-trips ────────────────────────────────────────────────

check("budgets: feeding every resolved seed back EXPLICITLY keeps profitDelta $0", () => {
  const defaults = defaultLeversV2(baseline);
  const seeds = resolveLeverSeedsV2(baseline, defaults);
  const p = project({
    depositBonusMinDepositUsd: seeds.depositBonusMinDepositUsd,
    raceMonthlyBudgetUsd: seeds.raceMonthlyBudgetUsd,
    rainDurationHours: seeds.rainDurationHours,
    rainPerEventUsd: seeds.rainPerEventUsd,
    mothaMonthlyBudgetUsd: seeds.mothaMonthlyBudgetUsd,
    giftCardsMonthlyUsd: seeds.giftCardsMonthlyUsd,
    promoCodesMonthlyUsd: seeds.promoCodesMonthlyUsd,
    adjustmentsMonthlyRecurringUsd: seeds.adjustmentsMonthlyRecurringUsd,
  });
  approx(p.profitDelta, 0, CENT, "explicit seeds round-trip to $0");
  profitIdentity(p, "budget round-trip");
});

check("budgets: 2× the race seed doubles the races cost; residual-other reconciles", () => {
  const seeds = resolveLeverSeedsV2(baseline, defaultLeversV2(baseline));
  const p = project({ raceMonthlyBudgetUsd: seeds.raceMonthlyBudgetUsd * 2 });
  const races = p.levers.find((l) => l.key === "races");
  assert(races != null, "races row missing");
  approx(races.plannedCost, baseline.raceCost * 2, 1e-6, "2× race budget");
  // Residual other = otherRewardCost − gift − promo − counted adjustments.
  const other = p.levers.find((l) => l.key === "other");
  assert(other != null, "residual-other row missing");
  approx(
    other.currentCost,
    baseline.otherRewardCost -
      baseline.giftCardCost -
      baseline.promoCodeCost -
      baseline.adjustmentCountedCost,
    1e-9,
    "residual other identity",
  );
});

// ─── 11. Sanitizer / legacy-v1 preset migration ─────────────────────────────

const LEGACY_V1_KEYS = [
  "rafflePrizePoolMult",
  "raffleFrequencyMult",
  "raffleTicketCostMult",
  "depositBonusMatchMult",
  "depositBonusMinDepositMult",
  "depositBonusWagerReqMult",
  "racePrizePoolMult",
  "raceFrequencyMult",
  "raceEntryCostMult",
  "rainCostMult",
  "mothaCostMult",
  "otherRewardCostMult",
  "withdrawalWagerReqMult",
  "hourlyUsers",
  "hourlyUtilization",
  "removeAffiliateWagerReq",
  "rakebackUpgraderMinMultiplier",
  "rakebackUpgraderMaxWinPct",
];

check("sanitizer: legacy v1 payload migrates (fields dropped, affiliate toggle inverted)", () => {
  const legacy: Record<string, unknown> = {
    edges: { packs: 0.12, battles: 0.05, upgrader: 0.09 },
    rakebackRates: { daily: 0.003, weekly: 0.004, monthly: 0.005 },
    affiliateRates: { 1: 0.06, 2: 0.08 },
    signupGrantUsd: 7,
    dailyPacksFrequencyMult: 1.5,
    removeAffiliateWagerReq: true,
    rafflePrizePoolMult: 2,
    raffleFrequencyMult: 0.5,
    raffleTicketCostMult: 1.2,
    depositBonusMatchMult: 2,
    depositBonusMinDepositMult: 1.5,
    depositBonusWagerReqMult: 0.5,
    racePrizePoolMult: 2,
    raceFrequencyMult: 2,
    raceEntryCostMult: 0.5,
    rainCostMult: 3,
    mothaCostMult: 0,
    otherRewardCostMult: 2,
    withdrawalWagerReqMult: 1.4,
    hourlyUsers: 120,
    hourlyUtilization: 0.5,
    rakebackUpgraderMinMultiplier: 2,
    rakebackUpgraderMaxWinPct: 0.4,
  };
  const out = sanitizeLeversV2(legacy);
  for (const k of LEGACY_V1_KEYS) {
    assert(!(k in out), `removed v1 field "${k}" must not survive migration`);
  }
  assert(out.affiliateWagerReqEnabled === false, "removeAffiliateWagerReq:true must invert to enabled:false");
  assert(out.edges.packs === 0.12 && out.edges.upgrader === 0.09, "kept edges must carry over");
  assert(out.edges.battles === PLANNED_BATTLES_EDGE_DEFAULT, "battles edge stays pinned to the planning 0");
  assert(out.rakebackRates.daily === 0.003, "rakeback rates carry over");
  assert(out.affiliateRates[2] === 0.08, "affiliate rates carry over");
  assert(out.signupGrantUsd === 7, "signup grant carries over");
  assert(out.raffleKeepPct === 1, "new raffleKeepPct defaults to keep-all");
  assert(out.depositFeePct === 0 && out.depositFeeSelectedAssets === null, "deposit fee defaults off");
  assert(out.shardsEnabled === false, "shards default off");
  assert(out.raceMonthlyBudgetUsd === null, "new $ budgets default to the run-rate (null)");
  // The exact key set matches the canonical lever shape (no extras, none missing).
  const expectedKeys = new Set(Object.keys(defaultLeversV2(baseline)));
  const gotKeys = new Set(Object.keys(out));
  assert(
    expectedKeys.size === gotKeys.size && [...expectedKeys].every((k) => gotKeys.has(k)),
    `sanitized key set must equal PlannedLeversV2 (got ${[...gotKeys].sort().join(",")})`,
  );
});

check("sanitizer: explicit new key beats the legacy inversion; clamps + nullables hold", () => {
  const out = sanitizeLeversV2({
    affiliateWagerReqEnabled: true,
    removeAffiliateWagerReq: true,
    depositFeePct: 5, // clamps to 1
    raffleKeepPct: -2, // clamps to 0
    raceMonthlyBudgetUsd: -5, // invalid → null (run-rate)
    rainDurationHours: 1e9, // clamps to 720
    matrixReWagerRate: Number.POSITIVE_INFINITY, // non-finite → default 1
    shardsWagerPerShardUsd: 0, // clamps to 0.01
    depositFeeSelectedAssets: [" BTC ", "BTC", 5, "ETH", ""],
    dailyPackRelockPct: { p1: 2, p2: -1, p3: "x" },
  });
  assert(out.affiliateWagerReqEnabled === true, "explicit new key must win over the legacy inversion");
  assert(out.depositFeePct === 1, "depositFeePct clamps to 1");
  assert(out.raffleKeepPct === 0, "raffleKeepPct clamps to 0");
  assert(out.raceMonthlyBudgetUsd === null, "negative budget falls back to null");
  assert(out.rainDurationHours === 720, "rainDurationHours clamps to 720");
  assert(out.matrixReWagerRate === 1, "non-finite reWagerRate falls back to 1");
  assert(out.shardsWagerPerShardUsd === 0.01, "wagerPerShard clamps above 0");
  assert(
    Array.isArray(out.depositFeeSelectedAssets) &&
      out.depositFeeSelectedAssets.length === 2 &&
      out.depositFeeSelectedAssets[0] === "BTC" &&
      out.depositFeeSelectedAssets[1] === "ETH",
    "asset list trims, dedupes and drops non-strings",
  );
  assert(out.dailyPackRelockPct.p1 === 1 && out.dailyPackRelockPct.p2 === 0, "relock clamps to 0..1");
  assert(!("p3" in out.dailyPackRelockPct), "non-finite relock dropped");
  // Garbage in → complete neutral state out.
  const neutral = sanitizeLeversV2(undefined);
  assert(neutral.raffleKeepPct === 1 && neutral.shardsEnabled === false, "undefined → neutral");
});

// ─── 12. Grand identity (revenue + matrix + shards + budgets together) ──────

check("grand identity: plannedNgr − currentNgr === profitDelta with EVERY channel active", () => {
  const seeds = resolveLeverSeedsV2(baseline, defaultLeversV2(baseline));
  const p = project({
    edges: { packs: 0.125, battles: 0, upgrader: 0.08 },
    depositFeePct: 0.02,
    raffleKeepPct: 0.4,
    raceMonthlyBudgetUsd: seeds.raceMonthlyBudgetUsd * 1.5,
    rainPerEventUsd: seeds.rainPerEventUsd * 0.5,
    mothaMonthlyBudgetUsd: 0,
    giftCardsMonthlyUsd: seeds.giftCardsMonthlyUsd * 2,
    adjustmentsMonthlyRecurringUsd: 0,
    depositBonusMinDepositUsd: 25,
    depositBonusHourlyEnabled: true,
    shardsEnabled: true,
    shardsUpgraderWeight: 0.5,
    matrixReWagerRate: 0.6,
    matrixCells: {
      [matrixCellKey("rain_win", "rakeback")]: 0,
      [matrixCellKey("race_prize", "races")]: 0.5,
      [matrixCellKey("deposit_bonus", "shards")]: 0.25,
    },
    affiliateWagerReqEnabled: false,
  });
  profitIdentity(p, "grand identity");
  assert(p.revenueDelta > 0, "fee revenue must be active in the combined scenario");
  const matrixRow = p.levers.find((l) => l.key === "credit-matrix");
  assert(matrixRow != null && matrixRow.deltaCost < 0, "matrix savings must be active");
  const shardsRow = p.levers.find((l) => l.key === "shards");
  assert(shardsRow != null && shardsRow.deltaCost > 0, "shards cost must be active");
});

// ─── 13. Withdrawal worked example (display helper) ─────────────────────────

check("withdrawals: deposit $100 → $100 @ 100%, $200 @ 50%, never @ 0%", () => {
  approx(withdrawalRequiredWagerUsd(100, 1) ?? Number.NaN, 100, 1e-12, "100% weight");
  approx(withdrawalRequiredWagerUsd(100, 0.5) ?? Number.NaN, 200, 1e-12, "50% weight");
  assert(withdrawalRequiredWagerUsd(100, 0) === null, "0% weight never unlocks");
  approx(withdrawalRequiredWagerUsd(250, 0.25) ?? Number.NaN, 1_000, 1e-12, "25% weight");
});

// ─── 14. Owner-trusted recon identities (rework 2026-06-12; headline swap ────
//        2026-06-12: HEADLINE = lifetime, 30d = recon row + planner window) ──

check("recon: 30d ROW identities + live-prod pins (wager $2.78M, P&L +$46.7K, on-site $64.9K = 2.33%) — the planner window", () => {
  const r = makeRecon().d30;
  // Identities (buildOwnerWindowRecon is pure — these hold for ANY input).
  approx(r.rewardPayouts, r.ggr - r.ngr, 1e-9, "rewardPayouts === ggr − ngr");
  approx(
    r.onSiteRewardCost,
    Math.max(0, r.rewardPayouts - r.creatorLeaderboardCost),
    1e-9,
    "onSite === rewardPayouts − creator leaderboard",
  );
  assert(r.onSiteDragPct != null && r.dragWithCreatorPct != null, "drag pcts must resolve");
  approx(r.onSiteDragPct, r.onSiteRewardCost / r.wager, 1e-12, "onSiteDragPct identity");
  approx(r.dragWithCreatorPct, r.rewardPayouts / r.wager, 1e-12, "withCreator identity");
  // Live-prod pins (recon probe 2026-06-12) — the numbers the page shows.
  approx(r.wager, 2_780_670.55, 0.005, "hub wager 30d");
  approx(r.realizedPnl, 46_714.78, 0.005, "realized P&L 30d");
  approx(r.rewardPayouts, 126_265.36, 0.005, "canonical reward cost 30d");
  approx(r.creatorLeaderboardCost, 61_346, 0.005, "creator leaderboard 30d");
  approx(r.onSiteRewardCost, 64_919.36, 0.005, "on-site reward cost 30d");
  approx(r.onSiteDragPct * 100, 2.33, 0.005, "on-site drag ≈ 2.33% of hub wager");
  approx(r.dragWithCreatorPct * 100, 4.54, 0.005, "with-creator drag ≈ 4.54% (transparency)");
  // Programs exclude the creator-attributed leaderboard line, sorted desc.
  assert(
    r.programs.every((p) => p.key !== LEADERBOARD_REWARD_LINE_KEY),
    "programs must EXCLUDE the leaderboard line",
  );
  for (let i = 1; i < r.programs.length; i++) {
    assert(r.programs[i - 1].amountUsd >= r.programs[i].amountUsd, "programs sorted by spend desc");
  }
  for (const p of r.programs) {
    assert(p.edgeReductionPp != null, `program ${p.key} must carry an edge reduction`);
    approx(p.edgeReductionPp, (p.amountUsd / r.wager) * 100, 1e-9, `edge reduction pp (${p.key})`);
  }
});

check("recon: lifetime HEADLINE pins the /insights hub numbers (wager $3,211,825.42 · P&L +$120,729.44)", () => {
  const r = makeRecon().lifetime;
  approx(r.wager, 3_211_825.42, 0.005, "hub wager lifetime (365d-capped)");
  approx(r.realizedPnl, 120_729.44, 0.005, "realized P&L lifetime");
  approx(r.rewardPayouts, 131_684.74, 0.005, "canonical reward cost 365d");
  approx(r.onSiteRewardCost, 70_338.74, 0.005, "on-site reward cost 365d");
  assert(r.onSiteDragPct != null, "lifetime drag must resolve");
  approx(r.onSiteDragPct * 100, 2.19, 0.005, "lifetime on-site drag ≈ 2.19% (the HEADLINE drag — of lifetime wager)");
  assert(r.label.includes("365"), "lifetime label must be LOUD about the 365d cap");
  // Headline creator-costs footnote is the LIFETIME split (headline swap).
  approx(r.creatorLeaderboardCost, 61_346, 0.005, "creator leaderboard lifetime (headline footnote $)");
  assert(r.dragWithCreatorPct != null, "lifetime with-creator drag must resolve");
  approx(r.dragWithCreatorPct * 100, 4.1, 0.005, "lifetime drag incl. creator ≈ 4.10% (headline footnote %)");
});

check("drag recompose: NO leaderboard lever row; reward totals + drag exclude creator prizes", () => {
  const p = project({});
  assert(
    p.levers.every((l) => l.key !== "leaderboard"),
    "the leaderboard lever row must be GONE (creator cost, not reward drag)",
  );
  approx(
    p.creatorLeaderboardCostUsd,
    baseline.affiliateLeaderboardCost,
    1e-9,
    "creator leaderboard passthrough (footnote line)",
  );
  // The reward-cost total is exactly the Σ of the remaining rows — the
  // creator prizes are in NONE of them.
  const sumCurrent = p.levers.reduce((s, l) => s + l.currentCost, 0);
  approx(p.currentRewardCost, sumCurrent, 1e-6, "currentRewardCost === Σ lever rows");

  const drag = computeOwnerDragSummary(baseline, p);
  // The headline strip swap (lifetime headline) is DISPLAY-ONLY: the
  // planner-drag summary must STAY anchored to the 30d planner window.
  assert(
    drag.windowLabel === baseline.recon.d30.label,
    "planner drag summary must stay on the 30d planner window (headline swap is display-only)",
  );
  approx(drag.hubWagerUsd, baseline.recon.d30.wager, 1e-9, "drag denominator = hub wager");
  approx(drag.measuredOnSiteCostUsd, baseline.recon.d30.onSiteRewardCost, 1e-9, "measured on-site cost");
  approx(drag.creatorLeaderboardCostUsd, baseline.recon.d30.creatorLeaderboardCost, 1e-9, "creator footnote $");
  assert(drag.plannedDragPct != null && drag.currentDragPct != null, "drags resolve");
  approx(drag.plannedDragPct, drag.currentDragPct, 1e-12, "defaults: planned drag === current drag");
  approx(
    drag.plannedDragPct,
    p.plannedRewardCost / baseline.recon.d30.wager,
    1e-12,
    "planned drag = planner reward rows ÷ hub wager",
  );
});

// ─── 15. Lever anchors (degraded-baseline liveness) ─────────────────────────

check("anchors: measured legs win; degraded legs fall back to secondary sources (flagged)", () => {
  const healthy = resolveLeverAnchorsV2(baseline);
  assert(
    !healthy.rakeback.estimated &&
      !healthy.affiliateCommission.estimated &&
      !healthy.depositBonus.estimated &&
      !healthy.raffles.estimated &&
      !healthy.rain.estimated,
    "healthy baseline → every anchor measured",
  );
  approx(healthy.rakeback.anchorUsd, baseline.rakebackCost, 1e-9, "measured rakeback anchor");
  approx(healthy.raffles.anchorUsd, baseline.raffleCost, 1e-9, "measured raffle anchor");

  const degraded = makeDegradedAnchorsBaseline();
  const a = resolveLeverAnchorsV2(degraded);
  const proxy = wagerProxyV2(degraded);
  approx(proxy, degraded.wager, 1e-9, "wager proxy = v1 canonical wager when present");
  assert(
    a.rakeback.estimated && a.affiliateCommission.estimated && a.depositBonus.estimated && a.raffles.estimated && a.rain.estimated,
    "degraded baseline → every anchor flagged estimated",
  );
  // Fallback chain values: blended cadence rate × proxy / blended affiliate
  // rate × proxy / time-bonus Σ / live-raffle prize value / rain pool Σ.
  approx(a.rakeback.anchorUsd, ((0.0025 + 0.005) / 2) * proxy, 1e-6, "rakeback fallback anchor");
  approx(a.affiliateCommission.anchorUsd, 0.0085 * proxy, 1e-6, "affiliate fallback anchor");
  approx(a.depositBonus.anchorUsd, 68_300, 1e-9, "deposit-bonus fallback anchor (time-bonus Σ)");
  approx(a.raffles.anchorUsd, 4_800, 1e-9, "raffle fallback anchor (live prize value)");
  approx(a.rain.anchorUsd, 15_000, 1e-9, "rain fallback anchor (pool Σ)");

  // wagerProxy falls back to the hub 30d wager when even v1 wager is 0.
  const noV1 = { ...degraded, wager: 0 };
  approx(wagerProxyV2(noV1), degraded.recon.d30.wager, 1e-9, "proxy falls back to hub wager");
});

check("anchors: default levers still project $0 delta on the degraded-anchors baseline", () => {
  const degraded = makeDegradedAnchorsBaseline();
  const p = projectEdgePlanV2(degraded, defaultLeversV2(degraded));
  approx(p.profitDelta, 0, CENT, "profitDelta $0 at defaults (degraded anchors)");
  for (const l of p.levers) {
    approx(l.deltaCost, 0, CENT, `lever "${l.key}" deltaCost at defaults (degraded anchors)`);
  }
  profitIdentity(p, "defaults (degraded anchors)");
});

// ─── 16. Per-lever reactivity contract (healthy AND degraded fixture) ───────
//
// THE owner bug: levers that do nothing. For EVERY lever, a non-default
// value must change its own row's plannedCost AND move the profit delta —
// on the healthy fixture and on the degraded-anchors fixture (the exact
// state the owner was driving when "the P&L does not move").

type Perturbation = {
  name: string;
  /** The lever row that must move (null = revenue / gaming-edge channels). */
  leverKey: string | null;
  overrides: (b: EdgePlanV2Baseline) => Partial<PlannedLeversV2>;
};

const PERTURBATIONS: Perturbation[] = [
  {
    name: "rakeback cadence rate",
    leverKey: "rakeback",
    overrides: (b) => ({
      rakebackRates: { ...defaultLeversV2(b).rakebackRates, daily: 0.01 },
    }),
  },
  {
    name: "rakeback game weighting",
    leverKey: "rakeback",
    overrides: () => ({ rakebackUpgraderWeight: 0.25 }),
  },
  {
    name: "rakeback instant claim",
    leverKey: "rakeback",
    overrides: () => ({ rakebackInstantAdoption: 0.5, rakebackInstantPayoutPct: 0.5 }),
  },
  {
    name: "affiliate tier rate",
    leverKey: "affiliate",
    overrides: (b) => ({
      affiliateRates: { ...defaultLeversV2(b).affiliateRates, 1: 0.2 },
    }),
  },
  {
    name: "affiliate wager-req toggle",
    leverKey: "affiliate",
    overrides: () => ({ affiliateWagerReqEnabled: false }),
  },
  {
    name: "affiliate GLOBAL scale (spec #9)",
    leverKey: "affiliate",
    overrides: () => ({ affiliateGlobalScalePct: 50 }),
  },
  {
    name: "deposit-bonus cap",
    leverKey: "deposit-bonus",
    overrides: () => ({ depositBonusCapMult: 0.5 }),
  },
  {
    name: "deposit-bonus min-deposit $ gate",
    leverKey: "deposit-bonus",
    overrides: () => ({ depositBonusMinDepositUsd: 50 }),
  },
  {
    name: "deposit-bonus time split",
    leverKey: "deposit-bonus",
    overrides: () => ({
      depositBonusHourlyEnabled: true,
      depositBonusHourlyAmountUsd: 25,
      depositBonusHourlyIntervalHours: 6,
    }),
  },
  {
    name: "race monthly $",
    leverKey: "races",
    overrides: () => ({ raceMonthlyBudgetUsd: 1_234 }),
  },
  {
    name: "raffle keep %",
    leverKey: "raffles",
    overrides: () => ({ raffleKeepPct: 0.5 }),
  },
  {
    name: "rain per-event $",
    leverKey: "rain",
    overrides: (b) => ({ rainPerEventUsd: (b.rainAnchor?.avgPoolUsd ?? 100) * 2 }),
  },
  {
    name: "rain cadence",
    leverKey: "rain",
    overrides: (b) => ({ rainDurationHours: (b.rainAnchor?.avgIntervalHours ?? 6) * 2 }),
  },
  {
    name: "motha monthly $",
    leverKey: "motha",
    overrides: () => ({ mothaMonthlyBudgetUsd: 0 }),
  },
  {
    name: "gift cards monthly $",
    leverKey: "gift-cards",
    overrides: () => ({ giftCardsMonthlyUsd: 9_999 }),
  },
  {
    name: "promo codes monthly $",
    leverKey: "promo-codes",
    overrides: () => ({ promoCodesMonthlyUsd: 0 }),
  },
  {
    name: "counted adjustments monthly $",
    leverKey: "adjustments",
    overrides: () => ({ adjustmentsMonthlyRecurringUsd: 0 }),
  },
  {
    name: "daily pack EV",
    leverKey: "daily-packs",
    overrides: (b) => ({
      dailyPackEvUsd: { ...defaultLeversV2(b).dailyPackEvUsd, "chk-daily-1": 2.5 },
    }),
  },
  {
    name: "daily pack frequency",
    leverKey: "daily-packs",
    overrides: () => ({ dailyPacksFrequencyMult: 2 }),
  },
  {
    name: "signup grant $",
    leverKey: "signup-packs",
    overrides: (b) => ({ signupGrantUsd: (b.signupAvgGrant ?? 0) + 2 }),
  },
  {
    name: "shards toggle",
    leverKey: "shards",
    overrides: () => ({ shardsEnabled: true }),
  },
  {
    name: "credit matrix cell",
    leverKey: "credit-matrix",
    overrides: () => ({ matrixCells: { [matrixCellKey("race_prize", "races")]: 0 } }),
  },
  {
    name: "deposit fee (revenue channel)",
    leverKey: null,
    overrides: () => ({ depositFeePct: 0.02 }),
  },
  {
    name: "packs edge slider (ggrDelta)",
    leverKey: null,
    overrides: (b) => ({
      edges: { ...defaultLeversV2(b).edges, packs: defaultLeversV2(b).edges.packs + 0.02 },
    }),
  },
  {
    name: "upgrader edge slider (ggrDelta)",
    leverKey: null,
    overrides: (b) => ({
      edges: { ...defaultLeversV2(b).edges, upgrader: Math.max(0, defaultLeversV2(b).edges.upgrader - 0.03) },
    }),
  },
];

function assertReactive(b: EdgePlanV2Baseline, fixtureName: string): void {
  const base = projectEdgePlanV2(b, defaultLeversV2(b));
  for (const pert of PERTURBATIONS) {
    const p = projectEdgePlanV2(b, { ...defaultLeversV2(b), ...pert.overrides(b) });
    assert(
      Math.abs(p.profitDelta - base.profitDelta) > CENT,
      `[${fixtureName}] "${pert.name}" must move the profit delta (got ${p.profitDelta} vs ${base.profitDelta})`,
    );
    if (pert.leverKey != null) {
      const before = base.levers.find((l) => l.key === pert.leverKey);
      const after = p.levers.find((l) => l.key === pert.leverKey);
      assert(before != null && after != null, `[${fixtureName}] lever row "${pert.leverKey}" missing`);
      assert(
        Math.abs(after.plannedCost - before.plannedCost) > CENT,
        `[${fixtureName}] "${pert.name}" must move its own row's plannedCost`,
      );
    } else if (pert.name.startsWith("deposit fee")) {
      assert(p.revenueDelta > 0, `[${fixtureName}] deposit fee must move revenueDelta`);
    } else {
      assert(Math.abs(p.ggrDelta) > CENT, `[${fixtureName}] edge slider must move ggrDelta`);
    }
    profitIdentity(p, `${fixtureName}: ${pert.name}`);
  }
}

check("reactivity: EVERY lever moves its row + profit delta on the HEALTHY fixture", () => {
  assertReactive(makeBaseline(), "healthy");
});

check("reactivity: EVERY lever stays LIVE on the DEGRADED-ANCHORS fixture (the owner's bug)", () => {
  assertReactive(makeDegradedAnchorsBaseline(), "degraded-anchors");
});

// ─── 17. Page-wide wager scenario (owner: "wager amounts 1,2,3,4,5x dont work") ──

/**
 * A deliberately NON-default lever state so the scenario has real $ moving
 * on every channel: a raised weekly rakeback rate (proportional), shards ON
 * (proportional), a deposit fee (flat revenue) and a raised race budget
 * (fixed-window $).
 */
function scenarioCustomLevers(b: EdgePlanV2Baseline): PlannedLeversV2 {
  const d = defaultLeversV2(b);
  return {
    ...d,
    rakebackRates: { ...d.rakebackRates, weekly: d.rakebackRates.weekly + 0.01 },
    shardsEnabled: true,
    depositFeePct: 0.02,
    raceMonthlyBudgetUsd: 30_000,
  };
}

check("scenario: m=1 is the EXACT identity (verbatim base projection)", () => {
  const p = projectEdgePlanV2(baseline, scenarioCustomLevers(baseline));
  const v = applyWagerScenarioV2(baseline, p, { presetMult: 1 });
  assert(v.active === false, "m=1 must not flag the scenario active");
  assert(v.mult === 1, "m=1 resolved mult");
  assert(v.profitDelta === p.profitDelta, "profitDelta identity");
  assert(v.plannedGgr === p.plannedGgr, "plannedGgr identity");
  assert(v.currentGgr === p.currentGgr, "currentGgr identity");
  assert(v.ggrDelta === p.ggrDelta, "ggrDelta identity");
  assert(v.plannedRewardCost === p.plannedRewardCost, "plannedRewardCost identity");
  assert(v.currentRewardCost === p.currentRewardCost, "currentRewardCost identity");
  assert(v.rewardCostDelta === p.rewardCostDelta, "rewardCostDelta identity");
  assert(v.plannedNgr === p.plannedNgr, "plannedNgr identity");
  assert(v.currentNgr === p.currentNgr, "currentNgr identity");
  assert(v.revenueDelta === p.revenueDelta, "revenueDelta identity");
  assert(v.monthlyProfitDelta === p.monthlyProfitDelta, "monthly identity");
  assert(v.annualProfitDelta === p.annualProfitDelta, "annual identity");
  assert(v.wager === p.plannedWager, "wager identity");
  assert(v.hubWager === baseline.recon.d30.wager, "hub wager identity");
  assert(v.levers.length === p.levers.length, "lever row count identity");
  for (const row of v.levers) {
    const base = p.levers.find((l) => l.key === row.key);
    assert(base != null, `base row "${row.key}" present`);
    assert(row.plannedCost === base.plannedCost, `row "${row.key}" plannedCost identity`);
    assert(row.currentCost === base.currentCost, `row "${row.key}" currentCost identity`);
    assert(row.deltaCost === base.deltaCost, `row "${row.key}" deltaCost identity`);
  }
});

check("scenario: proportional rows × m, fixed budgets flat, revenue flat, GGR × m, identity — at EVERY preset", () => {
  const p = projectEdgePlanV2(baseline, scenarioCustomLevers(baseline));
  const basePlannedRevenue = p.revenueLevers.reduce((s, r) => s + r.plannedUsd, 0);
  for (const m of WAGER_SCENARIO_PRESET_MULTS) {
    const v = applyWagerScenarioV2(baseline, p, { presetMult: m });
    assert(v.mult === m, `${m}×: resolved mult`);
    assert(v.active === (m !== 1), `${m}×: active flag`);

    // The proportional set is EXACTLY the waterfall's footnote set.
    const propKeys = v.levers
      .filter((r) => r.scalesWithWager)
      .map((r) => r.key)
      .sort();
    assert(
      JSON.stringify(propKeys) === JSON.stringify(["affiliate", "rakeback", "shards"]),
      `${m}×: proportional set must be rakeback/affiliate/shards, got ${propKeys.join(",")}`,
    );

    for (const row of v.levers) {
      const base = p.levers.find((l) => l.key === row.key);
      assert(base != null, `${m}×: base row "${row.key}" present`);
      if (row.scalesWithWager) {
        assert(
          row.plannedCost === base.plannedCost * m,
          `${m}×: proportional row "${row.key}" plannedCost must scale × m exactly`,
        );
        assert(
          row.currentCost === base.currentCost * m,
          `${m}×: proportional row "${row.key}" currentCost must scale × m exactly`,
        );
      } else {
        assert(
          row.plannedCost === base.plannedCost,
          `${m}×: fixed row "${row.key}" plannedCost must hold flat`,
        );
        assert(
          row.currentCost === base.currentCost,
          `${m}×: fixed row "${row.key}" currentCost must hold flat`,
        );
      }
      assert(row.baseCurrentCost === base.currentCost, `${m}×: row "${row.key}" baseCurrentCost`);
      assert(row.basePlannedCost === base.plannedCost, `${m}×: row "${row.key}" basePlannedCost`);
    }

    // Deposit-fee revenue is flat (deposits ≠ wager).
    assert(v.plannedRevenue === basePlannedRevenue, `${m}×: revenue must stay flat`);
    assert(v.revenueDelta === p.revenueDelta, `${m}×: revenueDelta must stay flat`);
    assert(v.plannedRevenue > 0, `${m}×: the 2% fee must be live in this state`);

    // GGR linear in wager; wagers scale × m exactly.
    assert(v.plannedGgr === p.plannedGgr * m, `${m}×: plannedGgr must scale × m`);
    assert(v.currentGgr === p.currentGgr * m, `${m}×: currentGgr must scale × m`);
    assert(v.wager === Math.max(0, p.plannedWager) * m, `${m}×: planning wager × m`);
    assert(v.hubWager === baseline.recon.d30.wager * m, `${m}×: hub wager × m`);

    // Σ rows = the headline reward cost (the mirror's by-construction total).
    const sumPlanned = v.levers.reduce((s, l) => s + l.plannedCost, 0);
    approx(v.plannedRewardCost, sumPlanned, CENT, `${m}×: Σ rows ≈ plannedRewardCost`);

    // Grand identity at the scenario.
    const scale = Math.max(1, Math.abs(v.plannedNgr), Math.abs(v.currentNgr));
    approx(
      v.plannedNgr - v.currentNgr,
      v.profitDelta,
      1e-6 * scale,
      `${m}×: plannedNgr − currentNgr === profitDelta`,
    );
    approx(
      v.profitDelta,
      v.ggrDelta - v.rewardCostDelta + v.revenueDelta,
      1e-6 * scale,
      `${m}×: profitDelta === ggrDelta − rewardCostDelta + revenueDelta`,
    );
  }
});

check("scenario: default levers stay EXACTLY $0 at every preset m", () => {
  const p = projectEdgePlanV2(baseline, defaultLeversV2(baseline));
  for (const m of WAGER_SCENARIO_PRESET_MULTS) {
    const v = applyWagerScenarioV2(baseline, p, { presetMult: m });
    approx(v.profitDelta, 0, CENT, `profitDelta at default levers, ${m}×`);
    approx(v.rewardCostDelta, 0, CENT * Math.max(1, m), `rewardCostDelta at default levers, ${m}×`);
  }
});

check("scenario: invalid multiplier state resolves to the 1× identity", () => {
  const p = projectEdgePlanV2(baseline, scenarioCustomLevers(baseline));
  for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = applyWagerScenarioV2(baseline, p, { presetMult: bad });
    assert(v.mult === 1 && v.active === false, `presetMult ${bad} must resolve to 1×`);
    assert(v.profitDelta === p.profitDelta, `presetMult ${bad}: identity profitDelta`);
  }
});

check("scenario: formatWagerMultLabel renders the chip labels", () => {
  assert(formatWagerMultLabel(1) === "1×", "1");
  assert(formatWagerMultLabel(1.5) === "1.5×", "1.5");
  assert(formatWagerMultLabel(2) === "2×", "2");
  assert(formatWagerMultLabel(5) === "5×", "5");
  assert(formatWagerMultLabel(0) === "1×", "0 falls back");
  assert(formatWagerMultLabel(Number.NaN) === "1×", "NaN falls back");
});

// ─── 18. Owner Total P&L fixture (dashboard tile reconciliation) ─────────────

check("owner total P&L: balance-sheet formula reconciles to the dashboard +$44,925.74", () => {
  const t = baseline.ownerTotalPnl;
  assert(t != null, "fixture carries the snapshot");
  approx(
    t.totalDeposited -
      t.totalWithdrawn -
      t.userBalance -
      t.inventory -
      t.vouchers -
      t.unclaimedRakeback,
    t.pnl,
    CENT,
    "pnl = deposits − withdrawals − onSiteBalance − inventory − vouchers − unclaimedRakeback",
  );
  approx(t.pnl, 44_925.74, CENT, "the owner's trusted dashboard figure");
});

// ─── 19. Global affiliate scale (owner spec #9) ──────────────────────────────

check("affiliate global scale (spec #9): 100-identity, 50 halves the cost EXACTLY, monotone, composes", () => {
  const d = defaultLeversV2(baseline);
  const baseRow = project({}).levers.find((l) => l.key === "affiliate");
  assert(baseRow != null, "affiliate row missing");

  const at = (pct: number) => {
    const p = project({ affiliateGlobalScalePct: pct });
    const row = p.levers.find((l) => l.key === "affiliate");
    assert(row != null, `affiliate row missing @ ${pct}`);
    return { p, row };
  };

  // 100 = exact identity ($0 delta — the default).
  const id = at(100);
  assert(id.row.plannedCost === baseRow.plannedCost, "scale 100 must be the EXACT identity");
  approx(id.row.deltaCost, 0, 1e-9, "scale 100 delta $0");

  // 50 halves the commission cost exactly; 0 turns the program off.
  const half = at(50);
  approx(half.row.plannedCost, baseline.affiliateCommissionCost * 0.5, 1e-9, "scale 50 → exactly half the cost");
  approx(at(0).row.plannedCost, 0, 1e-9, "scale 0 → program off");
  profitIdentity(half.p, "affiliate scale 50");

  // Monotone in the scale.
  let prev = -1;
  for (const pct of [0, 25, 50, 75, 100, 150, 200]) {
    const c = at(pct).row.plannedCost;
    assert(c >= prev - 1e-9, `scale must be monotone (broke at ${pct})`);
    prev = c;
  }

  // Factor + effective-rate display helper ("3.00% → 1.50%").
  assert(affiliateGlobalScaleFactorV2({ affiliateGlobalScalePct: 50 }) === 0.5, "factor 50 → 0.5");
  assert(affiliateGlobalScaleFactorV2({ affiliateGlobalScalePct: Number.NaN }) === 1, "non-finite → neutral 1");
  approx(
    effectiveAffiliateRateV2({ affiliateRates: { 1: 0.03 }, affiliateGlobalScalePct: 50 }, 1, 0.03),
    0.015,
    1e-12,
    "L1 3.00% → 1.50% at scale 50",
  );

  // MULTIPLICATIVE composition: doubling every per-level rate at scale 50
  // reproduces the default cost exactly.
  const doubled: Record<number, number> = {};
  for (const t of baseline.affiliateTiers) doubled[t.level] = t.currentRate * 2;
  const composed = project({ affiliateGlobalScalePct: 50, affiliateRates: doubled });
  const composedRow = composed.levers.find((l) => l.key === "affiliate");
  assert(composedRow != null, "composed affiliate row missing");
  approx(composedRow.plannedCost, baseline.affiliateCommissionCost, 1e-9, "×2 rates at 50% scale = default cost (composes)");

  // The edge-chip input (top-tier share) scales too.
  approx(
    topAffiliateTierEdgeShare(baseline, { ...d, affiliateGlobalScalePct: 50 }),
    topAffiliateTierEdgeShare(baseline, d) * 0.5,
    1e-12,
    "top-tier edge share halves at scale 50",
  );
});

// ─── 20. Rain DURATION (owner spec #11) ──────────────────────────────────────

check("rain duration (spec #11): 2h + $10 → 12 rains/day → $3,600/mo; seeds ratio-1; monotone", () => {
  const d = defaultLeversV2(baseline);

  // Owner example: set 2h → 12 rains a day; monthly = 24/2 × $10 × 30.
  const plan = rainPlanV2(baseline, { ...d, rainDurationHours: 2, rainPerEventUsd: 10 });
  approx(plan.rainsPerDay, 12, 1e-12, "24 ÷ 2h = 12 rains a day");
  approx(plan.monthlyBudgetUsd, (24 / 2) * 10 * 30, 1e-9, "monthly = 12 × $10 × 30 = $3,600");

  // Null seeds = the OBSERVED back-to-back duration → ratio exactly 1 → $0 delta.
  const anchor = baseline.rainAnchor;
  assert(anchor != null, "fixture rain anchor missing");
  const seeded = rainPlanV2(baseline, d);
  approx(seeded.durationHours, anchor.avgIntervalHours, 1e-9, "seed duration = window hours ÷ rain count");
  assert(seeded.planVsObservedRatio != null, "ratio resolves with an anchor");
  approx(seeded.planVsObservedRatio, 1, 1e-9, "ratio 1 at the null seeds");
  approx(seeded.monthlyBudgetUsd, (24 / anchor.avgIntervalHours) * 30 * anchor.avgPoolUsd, 1e-6, "seeded monthly plan");

  // Window cost: still scales the canonical net rain cost by planned/observed.
  const cost = (h: number) => {
    const row = project({ rainDurationHours: h }).levers.find((l) => l.key === "rain");
    assert(row != null, "rain row missing");
    return row.plannedCost;
  };
  approx(cost(anchor.avgIntervalHours / 2), baseline.rainCost * 2, 1e-6, "half the duration → 2× the window cost");
  assert(cost(1) > cost(2) && cost(2) > cost(6) && cost(6) > cost(24), "shorter duration → strictly more cost (monotone)");
});

// ─── 21. Edge-inclusion toggles (owner spec #14) ─────────────────────────────

check("edge inclusion (spec #14): all-on is BYTE-EQUAL; races-off removes exactly its contribution; re-on restores", () => {
  const d = defaultLeversV2(baseline);

  // All-on identity: explicit all-true map === the default, byte-for-byte.
  const implicit = projectEdgePlanV2(baseline, d);
  const explicit = projectEdgePlanV2(baseline, { ...d, edgeInclusion: defaultEdgeInclusionV2() });
  assert(JSON.stringify(implicit) === JSON.stringify(explicit), "all-on must be byte-equal to the default");
  assert(implicit.excludedPrograms.length === 0 && implicit.excludedLeverKeys.length === 0, "no exclusions at default");
  assert(EDGE_INCLUSION_KEYS.length === 13, "13 toggleable program rows");
  assert(isLeverIncludedInEdgeV2(d, "other") && isLeverIncludedInEdgeV2(d, "credit-matrix"), "non-program rows always included");

  // Non-default $ state so the exclusion moves a real delta.
  const seeds = resolveLeverSeedsV2(baseline, d);
  const hot: Partial<PlannedLeversV2> = { raceMonthlyBudgetUsd: seeds.raceMonthlyBudgetUsd * 2 };
  const on = project(hot);
  const off = project({ ...hot, edgeInclusion: { ...defaultEdgeInclusionV2(), races: false } });
  const racesOn = on.levers.find((l) => l.key === "races");
  const racesOff = off.levers.find((l) => l.key === "races");
  assert(racesOn != null && racesOff != null, "races rows missing");

  // The $ stays displayed on the row — attribution control, not a $0 budget.
  assert(racesOff.plannedCost === racesOn.plannedCost, "row $ must keep displaying");
  assert(racesOff.currentCost === racesOn.currentCost, "row current $ must keep displaying");

  // Totals drop by EXACTLY the row's contribution.
  approx(on.plannedRewardCost - off.plannedRewardCost, racesOn.plannedCost, 1e-9, "planned total drops by exactly races");
  approx(on.currentRewardCost - off.currentRewardCost, racesOn.currentCost, 1e-9, "current total drops by exactly races");
  approx(on.rewardCostDelta - off.rewardCostDelta, racesOn.deltaCost, 1e-9, "reward delta drops by exactly races delta");
  approx(off.profitDelta, on.profitDelta + racesOn.deltaCost, CENT, "profit excludes the races delta");
  profitIdentity(off, "races excluded");

  // Footnote payload (the transparency line).
  assert(off.excludedLeverKeys.length === 1 && off.excludedLeverKeys[0] === "races", "excluded keys");
  assert(
    off.excludedPrograms.length === 1 &&
      off.excludedPrograms[0].key === "races" &&
      off.excludedPrograms[0].plannedCostUsd === racesOn.plannedCost,
    "footnote carries the excluded program + $",
  );

  // Drag excludes it by exactly its contribution (planned drag × hub wager).
  const dragOn = computeOwnerDragSummary(baseline, on);
  const dragOff = computeOwnerDragSummary(baseline, off);
  assert(dragOn.plannedDragPct != null && dragOff.plannedDragPct != null, "drags resolve");
  approx(
    (dragOn.plannedDragPct - dragOff.plannedDragPct) * baseline.recon.d30.wager,
    racesOn.plannedCost,
    1e-6,
    "drag reduces by exactly the races contribution",
  );

  // The after-rewards waterfall drops the row too.
  const wf = computeEdgeAfterRewards(off, { baseline, levers: { ...d, ...hot, edgeInclusion: { ...defaultEdgeInclusionV2(), races: false } } });
  assert(wf.leverDrags.every((l) => l.key !== "races"), "waterfall must not carry an excluded row");

  // Re-on restores byte-equal.
  const restored = project({ ...hot, edgeInclusion: defaultEdgeInclusionV2() });
  assert(JSON.stringify(restored) === JSON.stringify(on), "re-enabling restores byte-equal");
});

check("edge inclusion (spec #14): composes with the wager-scenario multipliers", () => {
  const leverState: PlannedLeversV2 = {
    ...scenarioCustomLevers(baseline),
    edgeInclusion: { ...defaultEdgeInclusionV2(), shards: false },
  };
  const p = projectEdgePlanV2(baseline, leverState);
  const shardBase = p.levers.find((l) => l.key === "shards");
  assert(shardBase != null && shardBase.plannedCost > 0, "shards $ must be live in this state");
  assert(p.excludedLeverKeys.includes("shards"), "shards excluded");

  for (const m of [1, 2, 5]) {
    const v = applyWagerScenarioV2(baseline, p, { presetMult: m });
    const row = v.levers.find((l) => l.key === "shards");
    assert(row != null, `shards row missing @ ${m}×`);
    assert(row.includedInEdge === false, `${m}×: excluded flag carried`);
    // Excluded proportional row still scales for DISPLAY…
    assert(row.plannedCost === shardBase.plannedCost * (m === 1 ? 1 : m), `${m}×: excluded row $ still scales for display`);
    // …but the totals exclude it at every multiplier.
    const includedSum = v.levers.filter((r) => r.includedInEdge).reduce((s, l) => s + l.plannedCost, 0);
    approx(v.plannedRewardCost, includedSum, CENT, `${m}×: totals = Σ included rows only`);
    const allSum = v.levers.reduce((s, l) => s + l.plannedCost, 0);
    assert(allSum - v.plannedRewardCost > 0.01, `${m}×: total really excludes the shard $`);
    assert(v.excludedLeverKeys.length === 1 && v.excludedLeverKeys[0] === "shards", `${m}×: view carries the exclusion`);
  }
});

// ─── 22. Time-bonus = forecast engine (owner spec #8) ────────────────────────

function makeForecastAnchor(): DepositBonusForecastAnchor {
  return {
    totalCost: 52_000,
    uniqueClaimants: 640,
    periodDays: 30,
    claimProbability: 0.41,
    avgBonusUsd: 12.6,
    empiricalCapUsd: 100,
    capHitRate: 0.08,
    blendedRoi: 0.6,
    avgGgrPerClaimant: 31,
  };
}

check("time bonus engine (spec #8): $25/6h maps to C-6h-25 and EQUALS a verbatim forecast-page engine run", () => {
  const anchor = makeForecastAnchor();

  // The library mapping the owner spec names.
  const matched = findSplitCapLibraryScenario(25, 6);
  assert(matched != null && matched.id === SCENARIO_C_SIXH_25.id, "$25/6h must map to C-6h-25");

  const proj = projectSplitCapVsBaseline(anchor, 25, 6);
  assert(proj.matchedLibraryScenario === true, "library match flagged");
  assert(proj.scenarioId === "C-6h-25", "scenario id pins the library entry");
  assert(proj.horizonDays === 30, "default horizon = 30d");

  // IDENTITY: the bridge's numbers equal a direct page-style engine call —
  // same assumptions builder, same anchor, same scenario set.
  const assumptions = DEPOSIT_BONUS_FORECAST_CONFIG.defaults(anchor);
  const direct = depositBonusSimulateSet(
    [SCENARIO_A_BASELINE, SCENARIO_C_SIXH_25],
    assumptions,
    { days: assumptions.windowDays },
    BASELINE_SCENARIO_ID,
    anchor.totalCost,
  );
  const directRes = direct.find((r) => r.scenarioId === "C-6h-25");
  const directBase = direct.find((r) => r.scenarioId === BASELINE_SCENARIO_ID);
  assert(directRes != null && directBase != null, "direct engine run resolves");
  assert(proj.scenarioCostUsd === directRes.bonusCost, "scenario cost identical to the page engine");
  assert(proj.grossSavingsUsd === directRes.savingsVsBaseline, "gross savings identical");
  assert(proj.netSavingsUsd === directRes.netSavingsVsBaseline, "net savings identical");
  assert(proj.baselineCostUsd === directBase.bonusCost, "baseline cost identical");

  // The anchored baseline reproduces the REAL measured cost (30d ÷ 30d).
  approx(proj.baselineCostUsd, anchor.totalCost, 1e-6, "anchored baseline = real total cost");
  // Tightening to $25/6h can only save (engine directional contract).
  assert(proj.grossSavingsUsd >= 0, "split tightening must not cost more");
  // 30d horizon → monthly savings = horizon savings.
  approx(proj.monthlyNetSavingsUsd, proj.netSavingsUsd, 1e-9, "30d horizon → monthly = horizon");
  approx(proj.monthlyGrossSavingsUsd, proj.grossSavingsUsd, 1e-9, "30d horizon → monthly gross = horizon");

  // The v2 model wrapper threads the block's levers into the SAME call.
  const viaModel = computeTimeBonusEngineV2(
    { depositBonusForecastBaseline: anchor },
    { depositBonusHourlyAmountUsd: 25, depositBonusHourlyIntervalHours: 6 },
  );
  assert(viaModel != null, "wrapper resolves with a healthy anchor");
  assert(
    viaModel.scenarioCostUsd === proj.scenarioCostUsd &&
      viaModel.netSavingsUsd === proj.netSavingsUsd &&
      viaModel.scenarioId === proj.scenarioId,
    "wrapper output identical to the bridge",
  );

  // Degraded anchor → null (the UI falls back to the labeled floor line).
  assert(
    computeTimeBonusEngineV2(
      { depositBonusForecastBaseline: null },
      { depositBonusHourlyAmountUsd: 25, depositBonusHourlyIntervalHours: 6 },
    ) === null,
    "null anchor → null (floor-only rendering)",
  );

  // Non-library inputs synthesize the same split-window shape.
  const custom = projectSplitCapVsBaseline(anchor, 33, 7);
  assert(custom.matchedLibraryScenario === false, "33/7h is not a library entry");
  assert(custom.scenarioId === "edge-plan-split-33-7h", "synthesized id");
});

// ─── 23. Not-itemized drill-down (owner spec #12, pure half) ─────────────────

check("not-itemized (spec #12): reason keys pin to the probed live row shapes", () => {
  assert(detectAdjustmentReasonKeyV2("Admin adjustment: Giveaway", null) === "giveaway", "Giveaway");
  assert(detectAdjustmentReasonKeyV2("Admin adjustment: Bonus", null) === "bonus", "Bonus");
  assert(detectAdjustmentReasonKeyV2("Admin adjustment: Streamer Pro deal", null) === "streamer pro", "two-word key");
  assert(detectAdjustmentReasonKeyV2("Admin adjustment: 50% LB SPLIT", null) === "lb split", "leading percent dropped");
  assert(detectAdjustmentReasonKeyV2("Admin adjustment: LB SPLIT. 50%", null) === "lb split", "trailing punctuation stripped");
  assert(detectAdjustmentReasonKeyV2("Inventory removed: Mareep ($12.00) — XTR", null) === "inventory removal", "inventory description");
  assert(detectAdjustmentReasonKeyV2("whatever", "inventory_removal") === "inventory removal", "metadata kind wins");
  assert(detectAdjustmentReasonKeyV2(null, null) === "no description", "null description");
  assert(detectAdjustmentReasonKeyV2("Admin adjustment:   ", null) === "no reason", "empty reason");
});

check("not-itemized (spec #12): every grouping reconciles EXACTLY with the bucket totals", () => {
  const mk = (
    id: string,
    userId: string,
    iso: string,
    amountUsd: number,
    description: string,
  ): NotItemizedRowV2 => ({
    ledgerTxId: id,
    userId,
    username: userId === "u1" ? "alice" : null,
    createdAtIso: iso,
    amountUsd,
    description,
    reasonKey: detectAdjustmentReasonKeyV2(description, null),
    adminUsername: null,
    adminCategory: null,
    adminReason: null,
  });
  const rows: NotItemizedRowV2[] = [
    mk("t1", "u1", "2026-06-01T10:00:00.000Z", 100, "Admin adjustment: Giveaway"),
    mk("t2", "u1", "2026-06-05T10:00:00.000Z", -40, "Admin adjustment: accidentally credited"),
    mk("t3", "u2", "2026-05-20T10:00:00.000Z", 250, "Admin adjustment: Giveaway"),
    mk("t4", "u3", "2026-05-02T10:00:00.000Z", -10, "Inventory removed: Mareep ($12.00)"),
    mk("t5", "u2", "2026-06-11T10:00:00.000Z", 60, "Admin adjustment: Bonus"),
  ];
  const d = buildNotItemizedDrilldownV2(rows, { windowLabel: "Last 30 days", truncated: false });

  // Bucket-row totals (the panel's "Not itemized" line).
  assert(d.totals.count === 5, "count");
  approx(d.totals.creditsUsd, 410, 1e-9, "credits");
  approx(d.totals.debitsUsd, 50, 1e-9, "debits");
  approx(d.totals.netUsd, 360, 1e-9, "net = credits − debits");
  assert(d.truncated === false && d.windowLabel === "Last 30 days", "metadata");

  // EVERY grouping's Σ reconciles exactly with the totals.
  const sums = (xs: readonly { count: number; creditsUsd: number; debitsUsd: number }[]) =>
    xs.reduce(
      (s, g) => ({ count: s.count + g.count, credits: s.credits + g.creditsUsd, debits: s.debits + g.debitsUsd }),
      { count: 0, credits: 0, debits: 0 },
    );
  for (const [label, group] of [
    ["byMonth", sums(d.byMonth)],
    ["byReasonKey", sums(d.byReasonKey)],
    ["topUsersByNet", sums(d.topUsersByNet)],
  ] as const) {
    assert(group.count === 5, `${label} Σ count`);
    approx(group.credits, 410, 1e-9, `${label} Σ credits`);
    approx(group.debits, 50, 1e-9, `${label} Σ debits`);
  }

  // Months newest-first; users sorted by |net|; largest capped + sorted.
  assert(d.byMonth.length === 2 && d.byMonth[0].month === "2026-06" && d.byMonth[1].month === "2026-05", "months newest first");
  assert(d.topUsersByNet[0].userId === "u2", "u2 leads by |net| ($310)");
  approx(d.topUsersByNet[0].netUsd, 310, 1e-9, "u2 net");
  assert(d.largest.length === 5 && d.largest[0].amountUsd === 250 && d.largest[1].amountUsd === 100, "largest sorted by |amount|");
  const giveaway = d.byReasonKey.find((g) => g.reasonKey === "giveaway");
  assert(giveaway != null && giveaway.count === 2, "giveaway reason groups 2 rows");
  approx(giveaway.creditsUsd, 350, 1e-9, "giveaway credits");
});

// ─── 24. Sanitizer coverage for the new levers (specs #9/#14) ────────────────

check("sanitizer: affiliateGlobalScalePct clamps 0..200 (default 100); edgeInclusion fills every key", () => {
  assert(sanitizeLeversV2({}).affiliateGlobalScalePct === 100, "missing → 100");
  assert(sanitizeLeversV2({ affiliateGlobalScalePct: 500 }).affiliateGlobalScalePct === 200, "clamps to 200");
  assert(sanitizeLeversV2({ affiliateGlobalScalePct: -3 }).affiliateGlobalScalePct === 0, "clamps to 0");
  assert(sanitizeLeversV2({ affiliateGlobalScalePct: "junk" }).affiliateGlobalScalePct === 100, "non-finite → 100");
  assert(sanitizeLeversV2({ affiliateGlobalScalePct: 50 }).affiliateGlobalScalePct === 50, "valid value kept");

  const out = sanitizeLeversV2({ edgeInclusion: { races: false, bogus: false, rakeback: "x", shards: true } });
  assert(out.edgeInclusion.races === false, "explicit false kept");
  assert(out.edgeInclusion.rakeback === true, "non-boolean → true");
  assert(out.edgeInclusion.shards === true, "explicit true kept");
  assert(!("bogus" in out.edgeInclusion), "unknown program key dropped");
  for (const k of EDGE_INCLUSION_KEYS) {
    assert(k in out.edgeInclusion, `inclusion key "${k}" must be filled`);
  }
  assert(Object.keys(out.edgeInclusion).length === EDGE_INCLUSION_KEYS.length, "exact inclusion key set");
  // Defaults: every key true.
  const def = sanitizeLeversV2(undefined).edgeInclusion;
  assert(EDGE_INCLUSION_KEYS.every((k) => def[k] === true), "default inclusion all-true");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("");
if (failures.length > 0) {
  console.error(`✗ ${failures.length} check(s) FAILED (${passes} passed):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ All ${passes} Edge Plan 2.0 model checks passed.`);
