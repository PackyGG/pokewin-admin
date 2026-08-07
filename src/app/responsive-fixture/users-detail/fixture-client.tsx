"use client";

/**
 * Client wrapper that constructs a complete, type-correct UserDetail
 * fixture and renders the REAL <UserViewModern>. See ./page.tsx for why
 * this dev-only fixture exists.
 *
 * The fixture values are chosen to exercise the hero's worst layout case:
 *   - canChangeUserRoles: true  → renders the "Site role" control cluster
 *     AND the "Role on the game platform — not admin-panel access." helper
 *     <p> (the text that collapses to one-word-per-line on the owner's
 *     screenshot).
 *   - large 7-figure currency values → the widest KPI tiles, so any
 *     no-wrap / shrink-0 grid overflow surfaces.
 *   - role "creator" → also renders the "Creator page" link, maximising the
 *     action-toolbar width in the identity column.
 */

import { UserViewModern } from "@/app/(admin)/users/[id]/user-view-modern";
import type {
  UserDetail,
  PnlBreakdown,
  PaginatedTransactions,
  PaginatedInventory,
  Transaction,
} from "@/app/(admin)/users/[id]/user-tabs-types";
import type { UserRewards } from "@/lib/queries/users";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import type { UserRewardPackOpensResult } from "@/lib/queries/users-reward-pack-opens";

/** Wrap a fixture value in the resolved success shape the page's
 *  SafeQueryResult band promises carry (reliability remake). */
function ok<T>(data: T): Promise<SafeQueryResult<T>> {
  return Promise.resolve({ data, error: null });
}

const NOW_ISO = new Date().toISOString();

const EMPTY_TX: PaginatedTransactions = {
  data: [],
  total: 0,
  page: 1,
  perPage: 10,
  totalPages: 0,
};

function fiatDepositFixture(
  id: string,
  whopCheckoutEmail: string | null,
): Transaction {
  return {
    id,
    type: "deposit",
    amount: 100,
    balanceBefore: 50,
    balanceAfter: 150,
    worthBefore: 50,
    worthAfter: 150,
    description: "Fiat deposit via Whop",
    status: "completed",
    gameSessionId: null,
    packId: null,
    packName: null,
    cardsValue: null,
    gameResult: null,
    inventoryValue: 0,
    soldCard: null,
    cryptoAsset: null,
    cryptoAmount: null,
    exchangeRate: null,
    blockchainTxHash: null,
    sourceAddress: null,
    destinationAddress: null,
    depositAddressId: null,
    failureReason: null,
    metadata: null,
    fireblocksTxId: null,
    externalTxId: null,
    whopCheckoutEmail,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    borrowPercentage: null,
    borrowedAmountUsd: null,
    sponsorshipPercentage: null,
    battleId: null,
    battleMode: null,
    battlePending: null,
    hasPassword: null,
    battleWinnings: null,
    battleOutcomePending: null,
    battlePreviewWinnings: null,
    upgraderResult: null,
    upgraderWinnings: null,
    upgraderTargetMultiplier: null,
    upgraderTargetChance: null,
    upgraderTargetChanceDerived: null,
    upgraderHouseEdge: null,
    kenoResult: null,
    kenoWinnings: null,
    kenoPicks: null,
    kenoHits: null,
    kenoMultiplier: null,
    syntheticKind: null,
    doubleDownResult: null,
    doubleDownAmount: null,
    isInstantRakeback: null,
  };
}

const FINANCIAL_TX: PaginatedTransactions = {
  data: [
    fiatDepositFixture(
      "00000000-0000-4000-8000-000000000001",
      "checkout@example.com",
    ),
    fiatDepositFixture("00000000-0000-4000-8000-000000000002", null),
  ],
  total: 2,
  page: 1,
  perPage: 10,
  totalPages: 1,
};

const EMPTY_INVENTORY: PaginatedInventory = {
  data: [],
  total: 0,
  page: 1,
  perPage: 24,
  totalPages: 0,
};

const PNL: PnlBreakdown = {
  packRevenue: 0,
  battleRevenue: 0,
  upgraderRevenue: 0,
  cardSalesPayouts: 0,
  gamblingPnlRealized: 0,
  unrealizedLiability: 0,
  gamblingPnlTrue: 0,
  bonusesCost: 0,
  rakebackCost: 0,
  affiliateCost: 0,
  otherCosts: 0,
  otherCostsDetail: {
    rainWin: 0,
    racePrize: 0,
    balanceRewardClaim: 0,
    creatorTip: 0,
    voucherRedeemed: 0,
    voucherExchange: 0,
    exchangeExcessCredit: 0,
    exchangeExcessToVoucher: 0,
    battleExcessToVoucher: 0,
    affiliateLeaderboard: 0,
  },
  netPnlRealized: 0,
  netPnlTrue: 0,
  // Non-zero 24h (house gain → emerald) + 7d (house loss → rose) so the
  // new compact Platform-P&L footer chips exercise both color branches in
  // the render-verify sweep.
  pnl24h: 4_321.55,
  pnl3d: 0,
  pnl7d: -2_109.4,
  pnl14d: 0,
  deposits24h: 0,
  deposits3d: 0,
  deposits7d: 0,
  deposits14d: 0,
  wager24h: 0,
  wager3d: 0,
  wager7d: 0,
  wager14d: 0,
};

const REWARDS: UserRewards = {
  openOneTimeCount: 0,
  rakebackClaimableUsd: 0,
  rakebackClaimedUsd: 0,
  rakebackClaimedCount: 0,
  byFrequency: {
    daily: { claimedUsd: 0, claimableUsd: 0, claimedCount: 0 },
    weekly: { claimedUsd: 0, claimableUsd: 0, claimedCount: 0 },
    monthly: { claimedUsd: 0, claimableUsd: 0, claimedCount: 0 },
  },
  instantClaimedUsd: null,
  instantClaimedCount: null,
};

// Reward / sign-up pack opens — modelled on the real verified shape (a welcome
// pack granting several penny cards + a level pack granting one) so the
// fixture render exercises the new Rewards-tab provenance section.
const REWARD_PACK_OPENS: UserRewardPackOpensResult = {
  totalOpens: 2,
  totalCards: 4,
  totalValue: 0.04,
  opens: [
    {
      sessionId: "fixture-session-welcome",
      packName: "Welcome Pack",
      packImageUrl: null,
      rewardName: "Welcome Reward",
      rewardSlug: "onboarding",
      rewardType: "one_time",
      openedAt: "2026-06-13T20:32:36.609Z",
      cardCount: 3,
      ownedCount: 0,
      totalValue: 0.03,
      cards: [
        { inventoryId: "fx-1", cardName: "Chraziard", rarity: "Common", value: 0.01, owned: false },
        { inventoryId: "fx-2", cardName: "Chraziard", rarity: "Common", value: 0.01, owned: false },
        { inventoryId: "fx-3", cardName: "Chraziard", rarity: "Common", value: 0.01, owned: false },
      ],
    },
    {
      sessionId: "fixture-session-level1",
      packName: "Level 1",
      packImageUrl: null,
      rewardName: "Level 1",
      rewardSlug: "level-1",
      rewardType: "daily",
      openedAt: "2026-06-13T20:32:36.837Z",
      cardCount: 1,
      ownedCount: 1,
      totalValue: 0.01,
      cards: [
        {
          inventoryId: "fx-4",
          cardName: "Ancient Booster Energy Capsule",
          rarity: "Uncommon",
          value: 0.01,
          owned: true,
        },
      ],
    },
  ],
};

const DATA: UserDetail = {
  user: {
    id: "fixture00000000000000000000000000",
    username: "fixture_creator",
    displayUsername: "Fixture Creator",
    name: "Fixture Creator",
    email: "fixture.creator@example.com",
    emailVerified: true,
    role: "creator",
    image: null,
    twoFactorEnabled: true,
    isBanned: false,
    bannedReason: null,
    bannedAt: null,
    bannedBy: null,
    isLocked: false,
    lockedReason: null,
    lockedAt: null,
    lockedBy: null,
    lockedUntil: null,
    // Self-exclusion (responsible-gambling) — DISPLAY-ONLY mirror. Fixture
    // carries an ACTIVE exclusion (until in the future) so the render harness
    // exercises the Self-Excluded badge + flag chip + Account-tab card.
    isSelfExcluded: true,
    selfExcludedReason: "Taking a break (self-requested)",
    selfExcludedAt: "2026-06-10T12:00:00.000Z",
    selfExcludedUntil: "2026-07-10T12:00:00.000Z",
    suspectedAlt: false,
    linkedDeviceAccountCount: 0,
    deviceCaptureCount: 1,
    deviceCapturedAt: "2026-07-22T19:55:01.813Z",
    deviceConfidence: 0.99,
    deviceVisitorId: "Ibk1527CUFmcnjLwIs4A",
    deviceVisitorIdCount: 1,
    deviceSignupCaptureCount: 1,
    deviceLoginCaptureCount: 2,
    deviceLastLoginAt: "2026-08-04T19:30:00.000Z",
    deviceLastLoginIp: "203.0.113.42",
    deviceLastLoginVisitorId: "Ibk1527CUFmcnjLwIs4A",
    signupIpSharedCount: 2,
    country: "Germany",
    countryCode: "DE",
    city: "Berlin",
    state: null,
    continentCode: "EU",
    signupIp: null,
    referredBy: null,
    referredByUsername: null,
    referredByCode: null,
    affiliateCode: "FIXTURE10",
    ownedCodes: [
      { code: "FIXTURE10", createdAt: NOW_ISO, isPrimary: true, referralCount: 3 },
    ],
    affiliateCodeActive: true,
    affiliateCodeExpiresAt: null,
    affiliateBonusOptedIn: true,
    hasApiKey: false,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    providers: ["discord"],
    signupProvider: "discord",
    discord: { id: "123456789012345678", linkedAt: NOW_ISO },
  },
  // Large 7-figure values → the widest possible KPI tiles, so the hero's
  // KPI grid is under maximum horizontal pressure at narrow widths.
  balances: {
    availableBalance: 1_234_567.89,
    availableBalanceRaw: 1_234_567.89,
    lockedBalance: 0,
    wagerLocked: 0,
    wagerProgress: 0,
    totalDeposited: 2_345_678.9,
    fiatDeposits: 1_234_567.5,
    totalWithdrawn: 1_111_111.11,
    totalWagered: 9_876_543.21,
    totalWon: 8_765_432.1,
    unlockAt: null,
    inventoryValue: 456_789.12,
    vouchersValue: 0,
    packsWagered: 5_000_000,
    battlesWagered: 4_876_543.21,
  },
  statistics: {
    openedPacks: 12_345,
    battlesPlayed: 6_789,
    xp: 999_999,
    level: 87,
    weeklyWagerCount: 321,
    lastWageredAt: NOW_ISO,
    currentDayWageredUsd: 12_345,
    currentWeekWageredUsd: 123_456,
    currentMonthWageredUsd: 1_234_567,
    isProfilePrivate: false,
  },
  featureLocks: {
    lockedWithdrawalsCrypto: false,
    lockedWithdrawalsItems: false,
    lockedInventorySales: false,
    lockedExchanges: false,
    lockedOpenings: false,
    lockedVault: false,
  },
  battleLimits: null,
  inventoryCount: 42,
  affiliate: {
    code: "FIXTURE10",
    totalReferred: 123,
    totalWagerVolumeUsd: 5_000_000,
    totalEarnedUsd: 50_000,
    availableUsd: 1_234,
    totalPaidOutUsd: 48_766,
    totalBonusDistributedUsd: 0,
    lastPayoutAt: NOW_ISO,
  },
  shippingAddress: null,
  vault: null,
  mutes: [],
  cardWithdrawals: [],
  activeSeed: null,
  depositAddresses: [],
  counts: { deposits: 256, withdrawals: 64, avgDeposit: 9_162.03 },
  tips: {
    received: { count: 0, totalUsd: 0, recent: [] },
    sent: { count: 0, totalUsd: 0, recent: [] },
    rainPrizes: { count: 0, totalUsd: 0, recent: [] },
    leaderboardWins: { count: 0, totalUsd: 0, recent: [] },
    raceClaims: { count: 0, totalUsd: 0, recent: [] },
  },
  sessionRole: "admin",
  wasCreator: false,
  creatorSince: NOW_ISO,
  // canChangeUserRoles: true is the key flag — it renders the Site-role
  // control cluster AND the "Role on the game platform…" helper <p>.
  capabilities: {
    canAdjustBalance: true,
    canAdjustXp: true,
    canEditIdentity: true,
    canBanUsers: true,
    canLockUsers: true,
    canToggleFeatureLocks: true,
    canAssignAffiliate: true,
    canChangeUserRoles: true,
    canRecordManualWithdrawal: true,
    canEditBalanceAdjustments: true,
  },
};

export function UserDetailFixtureClient() {
  // Every band input is passed as an already-resolved SafeQueryResult
  // promise (the page's streamed-band contract) — the hero + Overview tab
  // (what the audit measures) render synchronously from them. Tab-gated
  // bands the fixture doesn't exercise still get resolved values so any
  // tab click renders without a server round-trip.
  return (
    <UserViewModern
      data={DATA}
      backSlot={null}
      tagsSlot={null}
      testingBattleOutcomeSlot={null}
      pnlResultPromise={ok(PNL)}
      gamingTxPromise={ok<PaginatedTransactions>(EMPTY_TX)}
      financialTxPromise={ok<PaginatedTransactions>(FINANCIAL_TX)}
      adjustmentsTxPromise={ok<PaginatedTransactions>(EMPTY_TX)}
      rewardsPromise={ok<UserRewards>(REWARDS)}
      rewardPackOpensPromise={ok<UserRewardPackOpensResult>(REWARD_PACK_OPENS)}
      inventoryPromise={ok<PaginatedInventory>(EMPTY_INVENTORY)}
      disposedInventoryPromise={ok<PaginatedInventory>(EMPTY_INVENTORY)}
      wagerRequirementPromise={Promise.resolve(null)}
      featureLocksPromise={Promise.resolve(null)}
      fiatDepositAccessPromise={Promise.resolve({
        user_id: DATA.user.id,
        enabled: true,
      })}
      kycPromise={Promise.resolve(null)}
      auditPromise={Promise.resolve({
        data: { events: [], total: 0, truncated: false },
        error: null,
      })}
      wagerProgressPromise={Promise.resolve(null)}
      balanceWeightingPromise={Promise.resolve(null)}
      viewerIsAdjustmentOwner
      initialTab="overview"
    />
  );
}
