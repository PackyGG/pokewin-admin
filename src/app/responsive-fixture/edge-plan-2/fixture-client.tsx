"use client";

/**
 * Client wrapper that constructs a complete, type-correct EdgePlanV2Baseline
 * (v2.1 overhaul shape, 2026-06-12) and renders the REAL <EdgePlanV2Planner>.
 * See ./page.tsx for why this dev-only fixture exists.
 *
 * The fixture values are deterministic and chosen to exercise EVERY new
 * section of the overhaul at the DEFAULT lever config (the state the planner
 * mounts in — profitDelta exactly $0):
 *
 *   • NEGATIVE net edge after rewards — the reward legs below sum to ~$247k
 *     against a ~$162k planning GGR (0.1099 × packs wager + 0.10 × upgrader
 *     wager; battles carry 0% planning edge), so the rose (house-loss)
 *     net-edge path renders.
 *   • `canonical` (Measured 30d strip) — a NEGATIVE measured GGR/NGR block,
 *     deliberately DIFFERENT from the planning numbers, so the
 *     measured-vs-planning split is visibly two distinct sets of figures.
 *   • `depositsByAsset` — six coins incl. two USDT-family entries, so the
 *     deposit-fee chips render the "exempt by default" USDT state and the
 *     selected-volume math is checkable ($275,000 default non-USDT volume →
 *     a 2% fee reads exactly +$5,500.00).
 *   • `raffleCost` $22k + one LIVE raffle card — the ONE keep-slider raffle
 *     model (the three ×-multiplier sliders are gone).
 *   • `rainAnchor` (60 rains, $250 pool, 12h spacing) — the duration/$ rain
 *     inputs seed to ratio 1.
 *   • `adjustmentBreakdown` — four categories INCLUDING the NULL
 *     "Not itemized" bucket and an uncounted fake-balance row.
 *   • `depositSizeHistogram` + `timeBonusAnchor` — the min-deposit $ gate and
 *     the split-vs-lump time-bonus model both have real-shaped curves (the
 *     open histogram bucket averages $150/user-day so a $25-every-6h split
 *     visibly caps something).
 *   • `dailyPackLevels` + `dailyPackUsage` — level gates (XP → $ wager-loss
 *     at the 1¢/XP calibration), re-lock defaults, and usage stats for the
 *     packs table.
 *   • `rewardSourceVolumes` — all seven sources, so the crediting matrix
 *     renders a full rows × programs grid; shards are RE-INTRODUCED
 *     (planner-only `_shards-v2` model, default OFF → $0).
 *
 * It is NOT a reimplementation: it imports the production type and renders
 * the production planner.
 */

import { EdgePlanV2Planner } from "@/app/(admin)/insights/edge-plan-2/_planner/planner-shell";
import type {
  AffiliateTierLever,
  GameTypeBaseline,
  RakebackCadenceLever,
} from "@/app/(admin)/insights/system-edge-plan/_model";
import type { EdgePlanV2Baseline } from "@/app/(admin)/insights/edge-plan-2/_model-v2";

const PERIOD_DAYS = 30;

// ── Gaming anchors (30d) ────────────────────────────────────────────────────
// Packs carry the house edge (10.99%), upgrader its own (10%), battles 0% in
// planning. These mirror the REAL prod accounting artifact the owner hit: the
// pack-opens-inside-battles WAGER is booked to Packs while the battle ITEM
// payout is booked to Battles, so packs.edge reads inflated (+20%) and
// battles.edge reads deeply negative (−61%) — only their SUM reconciles. The
// planner MERGES packs + battles into one row driven by the PLANNING edge, so
// the fixture proves the merge renders sensibly despite this garbage input.
const GAME_TYPES: GameTypeBaseline[] = [
  {
    type: "packs",
    wager: 1_311_000,
    payout: 1_042_255,
    ggr: 268_745, // inflated artifact edge ≈ 20.5%
    edge: 0.205,
    bets: 84_000,
    dataAvailable: true,
  },
  {
    type: "battles",
    wager: 600_100,
    payout: 968_248,
    ggr: -368_148, // deflated artifact ≈ −61%
    edge: -0.613,
    bets: 21_000,
    dataAvailable: true,
  },
  {
    type: "upgrader",
    wager: 578_000,
    payout: 578_000,
    ggr: 0, // near break-even window; planning default 10% drives the row
    edge: 0,
    bets: 12_500,
    dataAvailable: true,
  },
];

const HEADLINE_WAGER = GAME_TYPES.reduce((s, g) => s + g.wager, 0); // 2,489,100
const HEADLINE_PAYOUT = GAME_TYPES.reduce((s, g) => s + g.payout, 0);
const HEADLINE_GGR = HEADLINE_WAGER - HEADLINE_PAYOUT;

// ── Real reward legs (house outflow → rose). Sum > planning GGR so the net
//    edge after rewards is negative at the default config. ──
const RAKEBACK_COST = 45_000;
const AFFILIATE_COMMISSION_COST = 30_000; // affiliate_claim
const AFFILIATE_LEADERBOARD_COST = 8_000; // affiliate_leaderboard_prize
const AFFILIATE_COST = AFFILIATE_COMMISSION_COST + AFFILIATE_LEADERBOARD_COST;
const DEPOSIT_BONUS_COST = 52_000;
const RACE_COST = 18_000;
const RAFFLE_COST = 22_000; // keep-slider raffle model
const DAILY_PACKS_COST = 31_000;
const SIGNUP_PACKS_COST = 14_000;
const RAIN_COST = 9_000; // = max(0, rainWin 14k − rainTip 5k)
const MOTHA_COST = 6_000;
const OTHER_REWARD_COST = 12_000;
// Itemized slices of OTHER (residual other = 12k − 4k − 3k − 2.5k = $2,500).
const GIFT_CARD_COST = 4_000;
const PROMO_CODE_COST = 3_000;
const ADJUSTMENT_COUNTED_COST = 2_500;

const RAKEBACK_CADENCES: RakebackCadenceLever[] = [
  { cadence: "daily", label: "Daily", currentRate: 0.0025, enabled: true },
  { cadence: "weekly", label: "Weekly", currentRate: 0.005, enabled: true },
  { cadence: "monthly", label: "Monthly", currentRate: 0.01, enabled: false },
];

const AFFILIATE_TIERS: AffiliateTierLever[] = [
  { level: 1, label: "Level 1", currentRate: 0.05, threshold: 0 },
  { level: 2, label: "Level 2", currentRate: 0.07, threshold: 25_000 },
  { level: 3, label: "Level 3", currentRate: 0.1, threshold: 100_000 },
  { level: 4, label: "Level 4", currentRate: 0.12, threshold: 500_000 },
];

const FIXTURE: EdgePlanV2Baseline = {
  // ── SystemEdgeBaseline ──
  periodLabel: "Last 30 days",
  periodDays: PERIOD_DAYS,

  gameTypes: GAME_TYPES,
  wager: HEADLINE_WAGER,
  gamingPayout: HEADLINE_PAYOUT,
  ggr: HEADLINE_GGR,
  houseEdge: HEADLINE_WAGER > 0 ? HEADLINE_GGR / HEADLINE_WAGER : null,
  bets: GAME_TYPES.reduce((s, g) => s + g.bets, 0),

  rakebackCost: RAKEBACK_COST,
  affiliateCost: AFFILIATE_COST,
  depositBonusCost: DEPOSIT_BONUS_COST,
  raceCost: RACE_COST,
  raffleCost: RAFFLE_COST,
  dailyPacksCost: DAILY_PACKS_COST,
  signupPacksCost: SIGNUP_PACKS_COST,
  rainCost: RAIN_COST,
  mothaCost: MOTHA_COST,
  otherRewardCost: OTHER_REWARD_COST,

  rakebackCadences: RAKEBACK_CADENCES,
  affiliateTiers: AFFILIATE_TIERS,
  affiliateBlendedRate: 0.0085,

  dailyPackRows: [
    {
      packId: "fixture-daily-1",
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
      packId: "fixture-daily-2",
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
  rewardPackCatalog: [
    {
      packId: "fixture-daily-1",
      name: "Daily Tier 1",
      slug: "daily-tier-1",
      active: true,
      cardsPerOpen: 3,
      theoreticalEvUsd: 1.05,
      imageUrl: null,
      cardPreviews: [],
    },
    {
      packId: "fixture-daily-2",
      name: "Daily Tier 3",
      slug: "daily-tier-3",
      active: true,
      cardsPerOpen: 3,
      theoreticalEvUsd: 1.92,
      imageUrl: null,
      cardPreviews: [],
    },
  ],

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

  // ── EdgePlanV2Baseline additions (pre-overhaul fields) ──
  totalWager: HEADLINE_WAGER,
  // Organic splits are retired from the headline path (the rescale bug fix
  // deleted applyOrganicWagerScale) — the real baseline pins them to 0.
  ledgerOrganicWager: 0,
  upgraderOrganicWager: 0,
  affiliateCommissionCost: AFFILIATE_COMMISSION_COST,
  affiliateLeaderboardCost: AFFILIATE_LEADERBOARD_COST,
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

  // ── v2.1 overhaul blocks ──
  // Measured 30d strip — deliberately NEGATIVE (the real new-DB shape) and
  // distinct from the planning numbers above. rewardCost = ggr − ngr.
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
  // Deposit-fee chips: default (non-USDT) volume = 120k+80k+45k+30k =
  // $275,000 → a 2.00% fee reads exactly +$5,500.00; untick BTC → +$3,100.00.
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
      id: "fixture-raffle-1",
      title: "Weekly Mega Raffle",
      totalEntries: 48_000,
      participantCount: 1_240,
      endsAt: "2026-06-15T20:00:00.000Z",
      prizeValueUsd: 4_800,
      prizes: [
        { type: "pack", id: "fixture-prize-pack", quantity: 10, unitPriceUsd: 400 },
        { type: "card", id: "fixture-prize-card", quantity: 2, unitPriceUsd: 400 },
      ],
    },
    {
      id: "fixture-raffle-2",
      title: "Charizard Chase",
      totalEntries: 9_500,
      participantCount: 310,
      endsAt: "2026-06-13T18:00:00.000Z",
      prizeValueUsd: 1_500,
      prizes: [
        { type: "card", id: "fixture-prize-zard", quantity: 1, unitPriceUsd: 1_500 },
      ],
    },
  ],
  rainAnchor: {
    count: 60,
    avgPoolUsd: 250,
    avgDurationHours: 0.5,
    avgIntervalHours: (PERIOD_DAYS * 24) / 60, // every 12h
    totalPoolUsd: 15_000,
  },
  giftCardCost: GIFT_CARD_COST,
  promoCodeCost: PROMO_CODE_COST,
  // Includes the NULL "Not itemized" bucket + an UNCOUNTED fake-balance row.
  adjustmentBreakdown: [
    {
      category: "giveaway",
      label: "Giveaway / promo credit",
      count: 24,
      creditsUsd: 1_800,
      debitsUsd: 0,
      counted: true,
    },
    {
      category: "service_recovery",
      label: "Service recovery",
      count: 9,
      creditsUsd: 700,
      debitsUsd: 50,
      counted: true,
    },
    {
      category: "official_stream",
      label: "Official stream (fake balance)",
      count: 12,
      creditsUsd: 5_000,
      debitsUsd: 4_200,
      counted: false,
    },
    {
      category: null,
      label: "Not itemized",
      count: 17,
      creditsUsd: 950,
      debitsUsd: 300,
      counted: false,
    },
  ],
  adjustmentCountedCost: ADJUSTMENT_COUNTED_COST, // = 1,800 + 700
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
  // Bucket totals sit INSIDE their [lo, hi) ranges; the open bucket averages
  // $150/user-day so a $25-every-6h split ($100/day cap) visibly caps it.
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
  // XP thresholds at the probe-pinned 1¢/XP calibration (level 5 = 25,000 XP
  // = $250 wager-loss; level 30 = 1,500,000 XP = $15,000).
  dailyPackLevels: [
    {
      packId: "fixture-daily-1",
      rewardSlug: "daily-1",
      levelRequired: 5,
      xpThreshold: 25_000,
      wagerLossRequiredUsd: 250,
      relockPctDefault: 0.01,
    },
    {
      packId: "fixture-daily-2",
      rewardSlug: "daily-3",
      levelRequired: 30,
      xpThreshold: 1_500_000,
      wagerLossRequiredUsd: 15_000,
      relockPctDefault: 0.02,
    },
  ],
  dailyPackUsage: [
    {
      packId: "fixture-daily-1",
      opens: 18_500,
      claimers: 7_200,
      opensPerClaimer: 18_500 / 7_200,
      eligibleUsers: 9_000,
      claimRateVsEligible: 7_200 / 9_000,
      everyTimeClaimerPct: 0.34,
    },
    {
      packId: "fixture-daily-2",
      opens: 6_400,
      claimers: 2_100,
      opensPerClaimer: 6_400 / 2_100,
      eligibleUsers: 2_600,
      claimRateVsEligible: 2_100 / 2_600,
      everyTimeClaimerPct: 0.55,
    },
  ],
  // Crediting-matrix rows — all seven sources, assembled from the legs above
  // (zero new scans in prod; here just the same numbers restated).
  rewardSourceVolumes: [
    { sourceId: "rain_win", label: "Rain wins", amountUsd: 14_000 },
    { sourceId: "race_prize", label: "Race prizes", amountUsd: RACE_COST },
    { sourceId: "rakeback_claim", label: "Rakeback claims", amountUsd: RAKEBACK_COST },
    {
      sourceId: "affiliate_claim",
      label: "Affiliate commission",
      amountUsd: AFFILIATE_COMMISSION_COST,
    },
    {
      sourceId: "affiliate_leaderboard_prize",
      label: "Leaderboard prizes",
      amountUsd: AFFILIATE_LEADERBOARD_COST,
    },
    { sourceId: "deposit_bonus", label: "Deposit bonus", amountUsd: DEPOSIT_BONUS_COST },
    { sourceId: "motha", label: "Giveaways / tips (motha)", amountUsd: MOTHA_COST },
  ],
};

export function EdgePlanV2FixtureClient() {
  return <EdgePlanV2Planner baseline={FIXTURE} />;
}
