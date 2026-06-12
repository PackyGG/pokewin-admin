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
 *   2.  Raw math edge = mean(packs, upgrader) = 10.495% → renders "10.50%".
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
} from "../_model-v2";

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

check("raw math edge: mean(10.99%, 10%) = 10.495% → renders as 10.50%", () => {
  const raw = rawMathEdgeV2(defaultLeversV2(baseline));
  approx(
    raw,
    (PLANNED_PACKS_BATTLES_EDGE_DEFAULT + PLANNED_UPGRADER_EDGE_DEFAULT) / 2,
    1e-12,
    "rawMathEdgeV2 at defaults",
  );
  approx(raw, 0.10495, 1e-9, "rawMathEdgeV2 numeric value");
  const rendered = `${(raw * 100).toFixed(2)}%`;
  assert(rendered === "10.50%", `2dp render must be "10.50%", got "${rendered}"`);
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

check("shards: case table has 10 rows, value === shards × EV, owner-pinned endpoints", () => {
  assert(SHARD_CASES.length === 10, `expected 10 shard cases, got ${SHARD_CASES.length}`);
  const first = SHARD_CASES[0];
  const last = SHARD_CASES[SHARD_CASES.length - 1];
  assert(first.name === "Starter Kit" && first.shards === 2, "first case must be Starter Kit @ 2 shards");
  assert(last.name === "Eternal Fortune" && last.shards === 10_000, "last case must be Eternal Fortune @ 10,000 shards");
  approx(shardCaseValueUsd(first, SHARDS_DEFAULT_EV_PER_SHARD_USD), 0.12, 1e-9, "Starter Kit value");
  approx(shardCaseValueUsd(last, SHARDS_DEFAULT_EV_PER_SHARD_USD), 600, 1e-9, "Eternal Fortune value");
  let prevShards = 0;
  for (const c of SHARD_CASES) {
    assert(c.shards > prevShards, `case ladder must be ascending (broke at ${c.name})`);
    prevShards = c.shards;
    approx(
      shardCaseValueUsd(c, SHARDS_DEFAULT_EV_PER_SHARD_USD),
      c.shards * 0.06,
      1e-9,
      `case value identity (${c.name})`,
    );
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

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("");
if (failures.length > 0) {
  console.error(`✗ ${failures.length} check(s) FAILED (${passes} passed):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ All ${passes} Edge Plan 2.0 model checks passed.`);
