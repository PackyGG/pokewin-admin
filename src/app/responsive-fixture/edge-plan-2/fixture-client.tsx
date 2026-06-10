"use client";

/**
 * Client wrapper that constructs a complete, type-correct EdgePlanV2Baseline
 * and renders the REAL <EdgePlanV2Planner>. See ./page.tsx for why this
 * dev-only fixture exists.
 *
 * The fixture values are chosen to exercise the rework's worst color + layout
 * cases at the DEFAULT lever config (the state the planner mounts in):
 *
 *   • NEGATIVE net edge after rewards — the reward legs below sum to ~$247k
 *     against a ~$162k gross GGR (0.1099 × packs wager + 0.10 × upgrader
 *     wager; battles carry 0% planning edge), so
 *     currentNgr = GGR − rewardCost < 0 and the net-edge-after-rewards read
 *     is negative. This forces the planner's ROSE (user-favourable / house
 *     loss) net-edge path to render — the exact color-token slot the rework
 *     fixes. House-POV: house in the red → rose.
 *   • NON-ZERO raffleCost ($22k) — the rework RESTORES raffles (the v2 build
 *     had disabled them). A real reconstructed raffle prize cost makes the
 *     restored Raffle lever section + its `raffles` projection row render.
 *   • REAL affiliate split — affiliateCost ($38k) splits into a real
 *     commission leg ($30k, `affiliate_claim`) + a separate leaderboard-prize
 *     leg ($8k, `affiliate_leaderboard_prize`); the two sum back to the
 *     bundled affiliateCost exactly, mirroring the real
 *     getAffiliateOverview()-sourced split (affiliateSplitSource "overview").
 *
 * Shards are GONE from the model (no shard baseline fields exist) and raffle
 * fields are back — this fixture matches that post-rework EdgePlanV2Baseline
 * shape exactly. It is NOT a reimplementation: it imports the production type
 * and renders the production planner.
 */

import { EdgePlanV2Planner } from "@/app/(admin)/insights/edge-plan-2/_planner/planner-shell";
import type {
  AffiliateTierLever,
  GameTypeBaseline,
  RakebackCadenceLever,
} from "@/app/(admin)/insights/system-edge-plan/_model";
import type {
  EdgePlanV2Baseline,
  UpgraderRakebackBucket,
} from "@/app/(admin)/insights/edge-plan-2/_model-v2";

const PERIOD_DAYS = 30;

// ── Gaming anchors (30d) ────────────────────────────────────────────────────
// Packs carry the house edge (10.99%), upgrader its own (10%), battles 0% in
// planning. Sized so the planning-default GGR (packs + upgrader only) is
// ~$161,880 — deliberately BELOW the ~$247k reward total so the net edge after
// rewards is negative (rose path). Three game types, all real-shaped.
// These mirror the REAL prod accounting artifact the owner hit: the
// pack-opens-inside-battles WAGER is booked to Packs while the battle ITEM
// payout is booked to Battles, so packs.edge reads inflated (+20%) and
// battles.edge reads deeply negative (−61%) — only their SUM reconciles. The
// rework MERGES packs + battles into one row driven by the PLANNING edge
// (10.99%), not these per-type artifact edges, so the fixture proves the merge
// renders a sensible positive combined row despite this garbage input.
const GAME_TYPES: GameTypeBaseline[] = [
  {
    type: "packs",
    wager: 1_311_000,
    payout: 1_042_255,
    ggr: 268_745, // inflated artifact edge ≈ 20.5% (wager incl. battle opens, payout excl. battle items)
    edge: 0.205,
    bets: 84_000,
    dataAvailable: true,
  },
  {
    type: "battles",
    wager: 600_100,
    payout: 968_248,
    ggr: -368_148, // deflated artifact ≈ −61% (battle item payout booked here, wager booked to Packs)
    edge: -0.613,
    bets: 21_000,
    dataAvailable: true,
  },
  {
    type: "upgrader",
    wager: 578_000,
    payout: 578_000,
    ggr: 0, // near break-even window → measured edge ~0%; planning default 10% drives the row
    edge: 0,
    bets: 12_500,
    dataAvailable: true,
  },
];

const HEADLINE_WAGER = GAME_TYPES.reduce((s, g) => s + g.wager, 0); // 2,300,000
const HEADLINE_PAYOUT = GAME_TYPES.reduce((s, g) => s + g.payout, 0);
const HEADLINE_GGR = HEADLINE_WAGER - HEADLINE_PAYOUT;

// ── Real reward legs (house outflow → rose). Sum ≈ $247k > gross GGR so the
//    net edge after rewards is negative at the default config. ──
const RAKEBACK_COST = 45_000;
const AFFILIATE_COMMISSION_COST = 30_000; // affiliate_claim
const AFFILIATE_LEADERBOARD_COST = 8_000; // affiliate_leaderboard_prize
const AFFILIATE_COST = AFFILIATE_COMMISSION_COST + AFFILIATE_LEADERBOARD_COST; // 38,000 (bundled)
const DEPOSIT_BONUS_COST = 52_000;
const RACE_COST = 18_000;
const RAFFLE_COST = 22_000; // non-zero → restored Raffle section renders
const DAILY_PACKS_COST = 31_000;
const SIGNUP_PACKS_COST = 14_000;
const RAIN_COST = 9_000;
const MOTHA_COST = 6_000;
const OTHER_REWARD_COST = 12_000;

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

// Upgrader target-multiplier buckets for the rakeback min-bet eligibility
// modeling (real shape from getUpgraderProfitability → mapUpgraderBuckets).
const UPGRADER_BUCKETS: UpgraderRakebackBucket[] = [
  { label: "<2×", minMultiplier: 0, maxMultiplier: 2, wager: 120_000, winRate: 0.46 },
  { label: "2–5×", minMultiplier: 2, maxMultiplier: 5, wager: 95_000, winRate: 0.22 },
  { label: "5–20×", minMultiplier: 5, maxMultiplier: 20, wager: 60_000, winRate: 0.08 },
  { label: "20×+", minMultiplier: 20, maxMultiplier: null, wager: 25_000, winRate: 0.02 },
];

const UPGRADER_BUCKET_WAGER = UPGRADER_BUCKETS.reduce((s, b) => s + b.wager, 0);

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

  // ── EdgePlanV2Baseline additions ──
  totalWager: HEADLINE_WAGER,
  ledgerOrganicWager: 1_980_000,
  upgraderOrganicWager: 285_000,
  affiliateCommissionCost: AFFILIATE_COMMISSION_COST,
  affiliateLeaderboardCost: AFFILIATE_LEADERBOARD_COST,
  affiliateSplitSource: "overview",
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
  upgraderRakebackAnchor: {
    buckets: UPGRADER_BUCKETS,
    totalWager: UPGRADER_BUCKET_WAGER,
    winRate: 0.31,
  },
  packWagerBorrowed: 140_000,
  battleWagerBorrowed: 95_000,
};

export function EdgePlanV2FixtureClient() {
  return <EdgePlanV2Planner baseline={FIXTURE} />;
}
