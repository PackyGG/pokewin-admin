export type UserDetail = {
  user: {
    id: string;
    username: string | null;
    displayUsername: string | null;
    name: string | null;
    email: string | null;
    emailVerified: boolean;
    role: string;
    image: string | null;
    twoFactorEnabled: boolean;
    isBanned: boolean;
    bannedReason: string | null;
    bannedAt: string | null;
    bannedBy: string | null;
    isLocked: boolean;
    lockedReason: string | null;
    lockedAt: string | null;
    lockedBy: string | null;
    lockedUntil: string | null;
    country: string | null;
    countryCode: string | null;
    city: string | null;
    state: string | null;
    continentCode: string;
    signupIp: string | null;
    referredBy: string | null;
    referredByUsername: string | null;
    /**
     * The actual code string used at signup (from
     * affiliate_code_usages). Falls back to the referrer's CURRENT
     * affiliate_code if the historical signup row isn't recorded.
     * Distinct from `affiliateCode` which is the code THIS user owns.
     */
    referredByCode: string | null;
    affiliateCode: string | null;
    /**
     * Every row in affiliate_codes for this user — the full list of
     * codes they own. `isPrimary` flags whichever one matches
     * user.affiliate_code. Sorted by created_at ASC (oldest first).
     */
    ownedCodes: Array<{
      code: string;
      createdAt: string;
      isPrimary: boolean;
    }>;
    affiliateCodeActive: boolean;
    affiliateCodeExpiresAt: string | null;
    affiliateBonusOptedIn: boolean;
    hasApiKey: boolean;
    createdAt: string;
    updatedAt: string;
    providers: string[];
    /**
     * The provider this user signed up with — the FIRST linked
     * account (sorted by account.created_at ASC). Common values:
     * "discord", "google", "steam", "credential" (= email/password).
     * Null when the user has no linked account.
     */
    signupProvider: string | null;
    discord: {
      id: string;
      linkedAt: string | null;
    } | null;
  };
  balances: {
    availableBalance: number;
    lockedBalance: number;
    totalDeposited: number;
    totalWithdrawn: number;
    totalWagered: number;
    totalWon: number;
    bonusPoints: number;
    unlockAt: string | null;
    inventoryValue: number;
    vouchersValue: number;
    packsWagered: number;
    battlesWagered: number;
  } | null;
  statistics: {
    openedPacks: number;
    battlesPlayed: number;
    xp: number;
    level: number;
    weeklyWagerCount: number;
    lastWageredAt: string | null;
    currentDayWageredUsd: number;
    currentWeekWageredUsd: number;
    currentMonthWageredUsd: number;
    isProfilePrivate: boolean;
  } | null;
  featureLocks: {
    lockedWithdrawalsCrypto: boolean;
    lockedWithdrawalsItems: boolean;
    lockedInventorySales: boolean;
    lockedExchanges: boolean;
    lockedOpenings: boolean;
    lockedVault: boolean;
  } | null;
  /**
   * Per-user battle limit overrides. `null` row → user falls back to
   * site_config defaults (battle_max_value_usd / battle_base_bet_limit_usd).
   * Each field is independently nullable: a row may override one limit
   * while leaving the other on the platform default.
   */
  battleLimits: {
    maxValueUsd: number | null;
    baseBetLimitUsd: number | null;
  } | null;
  inventoryCount: number;
  affiliate: {
    code: string;
    totalReferred: number;
    totalWagerVolumeUsd: number;
    totalEarnedUsd: number;
    availableUsd: number;
    totalPaidOutUsd: number;
    totalBonusDistributedUsd: number;
    lastPayoutAt: string | null;
  } | null;
  shippingAddress: {
    firstName: string;
    lastName: string;
    phoneCountryCode: string;
    phoneNumber: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    zipCode: string;
    stateProvince: string | null;
    country: string;
  } | null;
  vault: {
    id: string;
    name: string;
    customerRefId: string | null;
    fireblocksVaultId: string | null;
    createdAt: string;
  } | null;
  mutes: {
    id: string;
    mutedBy: string;
    reason: string | null;
    expiresAt: string | null;
    unmutedAt: string | null;
    unmutedBy: string | null;
    createdAt: string;
  }[];
  cardWithdrawals: {
    id: string;
    method: string;
    totalValueUsd: number;
    shippingFeeUsd: number | null;
    trackingNumber: string | null;
    carrier: string | null;
    status: string;
    failureReason: string | null;
    requestedAt: string;
    completedAt: string | null;
  }[];
  activeSeed: {
    clientSeed: string;
    serverSeedHash: string | null;
    nonce: number;
  } | null;
  depositAddresses: {
    id: string;
    assetId: string;
    address: string;
    tag: string | null;
    legacyAddress: string | null;
    createdAt: string;
  }[];
  counts: {
    deposits: number;
    withdrawals: number;
    avgDeposit: number;
  };
  tips: {
    received: { count: number; totalUsd: number; recent: TipEntry[] };
    sent: { count: number; totalUsd: number; recent: TipEntry[] };
    rainPrizes: { count: number; totalUsd: number; recent: TipEntry[] };
    leaderboardWins: { count: number; totalUsd: number; recent: TipEntry[] };
  };
  sessionRole: string;
  // True when the user isn't a creator now but was one before (audit
  // role-change to creator, or owns creator-only affiliate codes).
  wasCreator: boolean;
  // When they were promoted to creator (ISO), if known from the audit
  // trail. Null when only inferred from owned codes.
  creatorSince: string | null;
  capabilities: {
    canAdjustBalance: boolean;
    canAdjustXp: boolean;
    canEditIdentity: boolean;
    canBanUsers: boolean;
    canLockUsers: boolean;
    canToggleFeatureLocks: boolean;
    canAssignAffiliate: boolean;
    canWipeAccounts: boolean;
    canChangeUserRoles: boolean;
    canRecordManualWithdrawal: boolean;
  };
};

export type TipEntry = {
  id: string;
  amountUsd: number;
  counterpartyId: string | null;
  counterpartyName: string | null;
  createdAt: string;
};

export type Transaction = {
  id: string;
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  /**
   * Total worth (cash balance + held inventory worth) before/after this
   * transaction. inventoryValue is the held value AT the tx; worthBefore
   * removes the items this tx itself won. Mirrors the detail modal's
   * "Worth Before / Worth After" so the table and modal never disagree.
   */
  worthBefore: number;
  worthAfter: number;
  description: string;
  status: string;
  gameSessionId: string | null;
  packId: string | null;
  packName: string | null;
  cardsValue: number | null;
  gameResult: "win" | "lose" | "draw" | null;
  inventoryValue: number;
  soldCard: {
    name: string;
    imageUrl: string | null;
    rarity: string | null;
  } | null;
  cryptoAsset: string | null;
  cryptoAmount: number | null;
  exchangeRate: number | null;
  blockchainTxHash: string | null;
  sourceAddress: string | null;
  destinationAddress: string | null;
  depositAddressId: string | null;
  failureReason: string | null;
  metadata: unknown;
  fireblocksTxId: string | null;
  externalTxId: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * % of the bet that the house fronted (borrow). null = not a
   * borrow-capable event (e.g. deposit). 0 = pack/battle paid fully
   * in cash. >0 = borrow signal — drives the BorrowBadge in the
   * activity tab.
   */
  borrowPercentage: number | null;
  /** USD the house fronted on this row (bet × borrow%). */
  borrowedAmountUsd: number | null;
  /**
   * Sponsorship % of the linked battle (0 = none, 100 = fully
   * sponsored — the creator paid the whole entry so others join free).
   * null on non-battle rows — drives the "Sponsored" badge.
   */
  sponsorshipPercentage: number | null;
  /**
   * Battle id for battle rows (battle_bet / battle_sponsorship /
   * battle_refund) — powers the "watch live" link to
   * packy.gg/battle/<id>. Null on non-battle rows.
   */
  battleId: string | null;
  /**
   * Winnings for a WON battle_bet row — the battle's total card value
   * (a battle is winner-takes-all: the winner walks away with every card
   * pulled across all participants). Same definition the battles
   * list/detail pages use.
   *   - 0    → battle resolved as a LOSS (won nothing; house keeps the bet)
   *   - >0   → battle WON; total card value the winner took
   *   - null → not a resolved battle_bet, OR a win whose battle id could
   *            not be derived (the UI falls back to a truthful outcome
   *            label instead of showing a fabricated number)
   */
  battleWinnings: number | null;
};

export type PaginatedTransactions = {
  data: Transaction[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
};

export type AuditEvent = {
  id: string;
  eventType: string;
  ip: string | null;
  country: string | null;
  createdAt: string;
  metadata: unknown;
};

export type PaginatedAuditLog = {
  data: AuditEvent[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
};

export type InventoryItem = {
  id: string;
  cardName: string;
  imageUrl: string | null;
  rarity: string | null;
  value: number;
  sourceType: string;
  obtainedAt: string;
  soldAt: string | null;
  exchangedAt: string | null;
};

export type PaginatedInventory = {
  data: InventoryItem[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
};

export type BalanceHistoryPoint = { date: string; balance: number };

export type PnlBreakdown = {
  packRevenue: number;
  battleRevenue: number;
  upgraderRevenue: number;
  cardSalesPayouts: number;
  gamblingPnlRealized: number;
  unrealizedLiability: number;
  gamblingPnlTrue: number;
  bonusesCost: number;
  rakebackCost: number;
  affiliateCost: number;
  otherCosts: number;
  otherCostsDetail: {
    rainWin: number;
    racePrize: number;
    balanceRewardClaim: number;
    creatorTip: number;
    voucherRedeemed: number;
    voucherExchange: number;
    exchangeExcessCredit: number;
    exchangeExcessToVoucher: number;
    battleExcessToVoucher: number;
    affiliateLeaderboard: number;
  };
  netPnlRealized: number;
  netPnlTrue: number;
  // Rolling windowed house P&L (past 24h / 7d) — see getUserPnlBreakdown.
  pnl24h: number;
  pnl7d: number;
};

export type AdminNote = {
  id: string;
  adminUserId: string;
  adminUsername: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type CreatorClick = {
  id: number;
  code: string;
  userAgent: string | null;
  ip: string;
  country: string;
  region: string;
  city: string;
  createdAt: string | null;
};

export type CreatorCodeUsage = {
  id: string;
  referredUserId: string;
  referredUsername: string | null;
  usageType: string;
  depositAmountUsd: number;
  wagerAmountUsd: number;
  referrerCutUsd: number;
  userBonusUsd: number;
  createdAt: string;
};

export type WithdrawalLimits = {
  currencyLimitAmount: number | null;
  currencyLimitStartDate: string | null;
  currencyLimitResetDays: number | null;
  percentageLimit: number | null;
} | null;

export type CreatorData = {
  clicks: {
    data: CreatorClick[];
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
  };
  usages: {
    data: CreatorCodeUsage[];
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
  };
  withdrawalLimits: WithdrawalLimits;
};

export type GameSessionDetails = {
  id: string;
  gameType: string;
  result: string | null;
  betAmount: number;
  pack: { id: string; name: string; imageUrl: string | null } | null;
  items: {
    id: string;
    cardName: string;
    imageUrl: string | null;
    rarity: string | null;
    priceUsd: number;
    valueAtObtained: number;
  }[];
  pfResults: {
    id: string;
    clientSeed: string;
    serverSeedHash: string;
    serverSeed: string | null;
    nonce: number;
    cursor: number;
    ticket: number;
    resultHash: string;
  }[];
  createdAt: string;
};

// Gaming = pack / battle / upgrader play. Card sales + exchanges live
// in FINANCIAL_TX_TYPES so the user-detail tabs stay coherent: Gaming
// for gameplay, Deposits & Withdrawals for cash movement.
export const GAMING_TX_TYPES = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "upgrader_bet",
  "upgrader_payout",
  "voucher_redeemed",
] as const;
export const FINANCIAL_TX_TYPES = [
  "deposit",
  "deposit_bonus",
  "admin_balance_adjustment",
  "card_withdrawal",
  "withdrawal_shipping_fee",
  "rakeback_claim",
  "balance_reward_claim",
  "affiliate_claim",
  "promo_code_redeemed",
  "gift_card_redeemed",
  "rain_win",
  "race_prize",
] as const;
export const CARD_SALE_TX_TYPES = ["card_sale", "reward_card_sale"] as const;
export const EXCHANGE_TX_TYPES = [
  "card_exchange",
  "exchange_excess_to_voucher",
  "exchange_excess_credit",
  "battle_excess_to_voucher",
  "voucher_exchange",
] as const;
