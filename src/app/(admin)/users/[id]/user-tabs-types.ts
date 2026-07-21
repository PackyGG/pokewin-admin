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
    // Self-exclusion (responsible-gambling), USER-initiated on the game
    // platform — DISPLAY-ONLY in the admin (no impose/lift action). Raw
    // mirror of the four game-DB columns. `isSelfExcluded` true with
    // `selfExcludedUntil` in the PAST = EXPIRED; the view derives
    // active-vs-expired from the timestamp.
    isSelfExcluded: boolean;
    selfExcludedReason: string | null;
    selfExcludedAt: string | null;
    selfExcludedUntil: string | null;
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
      /**
       * DISTINCT referred_user_id count from affiliate_code_usages for
       * this code (UPPER(code) match, no usage_type restriction — same
       * semantics as getCodeReferrals/getCodeAnalytics and the
       * /users?affiliateCode= list filter). 0 when the code has never
       * referred anyone.
       */
      referralCount: number;
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
    /**
     * The RAW `balances.available_balance` column — the actual spendable
     * cash a removal adjustment debits. Differs from `availableBalance`
     * (which nets official-stream fake balance for display/P&L parity), so
     * the Adjust-Balance preview validates against THIS to match the server.
     */
    availableBalanceRaw: number;
    /**
     * Vault-cooldown balance — `balances.locked_balance`. Funds the user
     * moved into vault that are still in the cooldown window (paired with
     * `unlockAt`). This is the user's own money, just not spendable yet;
     * NOT the same as `wagerLocked` (which is bonus money gated by a
     * wager-requirement debt). The "Vault" line in the balance breakdown
     * shows this.
     */
    lockedBalance: number;
    /**
     * Wager-locked bonus debt — `balances.wager_requirement_remaining`
     * (frozen-rate debt counter, see users-wager-progress.ts). This is
     * spendable on wagers but reserves that many balance dollars from
     * withdrawal until burned down by weighted wagers. The "Locked" line
     * in the balance breakdown shows this. `null` when the connected DB
     * lacks the column (schema drift) — the row hides on null.
     */
    wagerLocked: number | null;
    /**
     * Wagered cleared toward the requirement —
     * `balances.wager_requirement_progress`. Paired with `wagerLocked` to
     * show progress in the "Locked" row subtitle. `null` when the column
     * isn't on the connected DB.
     */
    wagerProgress: number | null;
    totalDeposited: number;
    /** Fiat (non-crypto / card) portion of totalDeposited — lifetime. */
    fiatDeposits: number;
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
    // Leaderboard wins carry the source leaderboard (id + title +
    // 1-based rank), so the UI can label which leaderboard each win
    // came from and deep-link to /creators/leaderboards/[id].
    leaderboardWins: {
      count: number;
      totalUsd: number;
      recent: LeaderboardWinEntry[];
    };
    /** On-site race prize claims (`race_prize` ledger credits). */
    raceClaims: {
      count: number;
      totalUsd: number;
      recent: RaceClaimEntry[];
    };
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
    canChangeUserRoles: boolean;
    canRecordManualWithdrawal: boolean;
    /** Motha-only — edit balance-adjustment tag + description on ledger rows. */
    canEditBalanceAdjustments: boolean;
  };
};

export type TipEntry = {
  id: string;
  amountUsd: number;
  counterpartyId: string | null;
  counterpartyName: string | null;
  createdAt: string;
};

/**
 * Recent affiliate-leaderboard win — extends the TipEntry shape with
 * the source leaderboard reference so the row can link out and
 * surface "from <title>" below the amount. Any of leaderboardId /
 * leaderboardTitle / position may be null if the prize ledger row's
 * metadata didn't carry that piece (older rows / hard-deleted
 * leaderboards) — the UI falls back to the generic "Leaderboard win"
 * label in that case.
 */
export type LeaderboardWinEntry = TipEntry & {
  leaderboardId: string | null;
  leaderboardTitle: string | null;
  position: number | null;
};

/** Recent on-site race prize claim — `race_prize` ledger row. */
export type RaceClaimEntry = TipEntry & {
  raceType: string | null;
  position: number | null;
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
   * packy.gg/games/battles/<id>. Null on non-battle rows.
   */
  battleId: string | null;
  /**
   * Raw battle-mode enum string for the linked battle — one of
   * "normal" | "jackpot" | "group" | "hp_rush" | "lowest". Surfaced as a
   * structured "Battle Mode" row in the transaction-detail modal (which
   * maps it to a readable label and appends any borrow/sponsorship
   * modifier). Null on non-battle rows or when the battle row could not
   * be fetched.
   */
  battleMode: string | null;
  /**
   * BOOLEAN — is the linked battle still running (not yet settled)?
   *   • true  → battle status is `animating` or `in_progress` (the
   *             outcome is not locked in yet) — drives the "Pending"
   *             chip next to the Battle Mode row in the detail modal.
   *   • false → battle is settled (`completed` / `cancelled`) or queued
   *             (`waiting`); no chip is rendered.
   *   • null  → not a battle row (or the battle row could not be fetched).
   *
   * "Pending" deliberately covers ONLY `animating` + `in_progress` — the
   * states where the bet is live and the outcome can still change — to
   * match how the battle surfaces treat an in-flight battle.
   */
  battlePending: boolean | null;
  /**
   * BOOLEAN — does the linked battle have a password set?
   *   • true  → the row's Watch button offers a "copy URL with
   *             password" path and the transaction-detail modal
   *             renders a password-reveal row (both admin-only).
   *   • false → battle exists but is public; no password affordance.
   *   • null  → not a battle row.
   *
   * The plaintext value is NEVER carried in this payload — it's
   * fetched on demand via the revealBattlePassword server action
   * (admin-only + audit-logged on every reveal).
   */
  hasPassword: boolean | null;
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
  /**
   * Win/loss DIRECTION for a PENDING battle_bet row (battle status
   * animating / in_progress), derived from battles.winner_team vs the
   * user's battle_participants.team_number. The exact dollar AMOUNT is
   * intentionally NOT derivable while pending and stays hidden — only the
   * direction is shown.
   *   - "win"  → user's team == winner_team (house loss → rose)
   *   - "loss" → user's team != winner_team (house gain → emerald)
   *   - null   → not a pending battle_bet, OR winner_team not yet
   *              materialized (in_progress can be null) → "resolving"
   */
  battleOutcomePending: "win" | "loss" | null;
  /**
   * Upgrader-only outcome derived from the presence of a matching
   * upgrader_payout row sharing this row's game_session_id.
   *   - "win"  → a payout row exists (upgraderWinnings = its value)
   *   - "lose" → no payout row (upgraderWinnings = 0)
   *   - null   → not an upgrader_bet
   */
  upgraderResult: "win" | "lose" | null;
  /**
   * Realized take on a winning upgrader play. 0 on a loss; >0 on a
   * win; null on non-upgrader rows. Backend-side fallback picks the
   * larger of ABS(amount) and (balance_after − balance_before) on the
   * matching upgrader_payout row so we catch both shipping shapes.
   */
  upgraderWinnings: number | null;
  /**
   * Upgrader play CONFIGURATION — the target multiplier the user
   * picked before the spin (e.g. 5 → "5×"). Sourced defensively from
   * the first PF row's `result_metadata` blob (see
   * `lib/utils/upgrader-metadata.ts`). Null on non-upgrader rows or
   * when the backend didn't store it on the blob.
   */
  upgraderTargetMultiplier: number | null;
  /**
   * Target win-chance % the user was running at (0-100). Either
   * stored directly on `result_metadata` or DERIVED from
   * `upgraderTargetMultiplier` when only the multiplier is present.
   * Null on non-upgrader rows or when neither path resolves.
   */
  upgraderTargetChance: number | null;
  /**
   * True when `upgraderTargetChance` was estimated from the target
   * multiplier (10% default house edge) rather than stored on spin
   * metadata. False when chance was read directly from metadata.
   * Null on non-upgrader rows.
   */
  upgraderTargetChanceDerived: boolean | null;
  /**
   * House edge fraction from spin metadata (0.1 = 10%). Null when
   * not stored or not an upgrader row.
   */
  upgraderHouseEdge: number | null;
  /**
   * Discriminator for CLIENT-SYNTHESIZED rows that do NOT correspond to a
   * real ledger_transactions row.
   *   - "double_down" → the row is a synthetic post-battle double-down event
   *                     (see the DOUBLE-DOWN block in users-transactions.ts).
   *                     Its `id` is `dd-<gameSessionId>` (never collides with a
   *                     ledger id) and its `type` is left as the real linked
   *                     `battle_bet` enum value (so it stays a valid
   *                     ledger_transaction_type); the UI branches on THIS field,
   *                     not on `type`, to render the dedicated double-down row.
   *   - null → a normal, ledger-backed row (every existing row).
   */
  syntheticKind: "double_down" | null;
  /**
   * Post-battle DOUBLE-DOWN outcome — the user gambled their battle winnings
   * (double-or-nothing) after a WIN. Sourced from `battle_double_down_offers`
   * (resolved rounds only), joined to the winning battle_bet by
   * game_session_id. Set ONLY on the synthetic `syntheticKind === "double_down"`
   * row (which is injected chronologically just above its battle_bet); null on
   * every real ledger row.
   *   - "win"  → the double-down WON → user kept MORE money → house LOSS (rose)
   *   - "lose" → the double-down LOST → winnings forfeited → house WIN (emerald)
   *   - null   → not a double-down row.
   *
   * A LOST double-down produces NO ledger row, which is why the row is
   * synthesized (the gaming tab is otherwise ledger-driven).
   */
  doubleDownResult: "win" | "lose" | null;
  /**
   * USD tied to the double-down (set only on the synthetic double-down row):
   *   - on a WIN  → the REAL credited payout (the payout voucher's value).
   *   - on a LOSE → the forfeited stake (the battle winnings the user lost;
   *                 the house kept it).
   *   - null on non-double-down rows.
   */
  doubleDownAmount: number | null;
  /**
   * Instant-rakeback flag for `rakeback_claim` rows.
   *   - true  → this claim used the instant/early-claim flow
   *             (`rakeback_claims.last_preclaim_at` is non-null), so the row
   *             renders as "Instant rakeback".
   *   - false → a normal (cadence-period) rakeback claim → "Rakeback".
   *   - null  → not a rakeback_claim row, OR the early-claim column is absent
   *             on this DB env (drift-safe: prod hasn't shipped it yet), so
   *             the row degrades to the plain "Rakeback" label.
   */
  isInstantRakeback: boolean | null;
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

/**
 * Human-readable label for a `user_inventory.source_type` enum value
 * (pack | reward | battle | exchange | raffle | upgrader). Drives the
 * provenance badge on inventory rows so an admin can see at a glance WHERE a
 * card came from — in particular `reward` = a card granted by a reward /
 * sign-up / daily pack (an inventory giveaway with no ledger grant row; the
 * full per-pack trail lives on the Rewards tab). Unknown/future members fall
 * back to a capitalised raw value rather than hiding data.
 */
export function inventorySourceLabel(sourceType: string): string {
  switch (sourceType) {
    case "reward":
      return "Reward pack";
    case "pack":
      return "Pack open";
    case "battle":
      return "Battle win";
    case "exchange":
      return "Exchange";
    case "raffle":
      return "Raffle";
    case "upgrader":
      return "Upgrader";
    default:
      return sourceType.charAt(0).toUpperCase() + sourceType.slice(1);
  }
}

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
  // Rolling windowed house P&L (past 24h / 3d / 7d / 14d) — see
  // getUserPnlBreakdown. Four rungs so the row reads from acute to
  // baseline; same rolling-window convention as the dashboard's
  // global period selector. The 14d rung gives admins a slightly
  // longer baseline than 7d for spotting medium-term trends on
  // active users without paging the deeper monthly breakdown.
  // (The 12h rung was dropped per owner request.)
  pnl24h: number;
  pnl3d: number;
  pnl7d: number;
  pnl14d: number;
  deposits24h: number;
  deposits3d: number;
  deposits7d: number;
  deposits14d: number;
  // Rolling windowed wager (bet stakes) over the same windows.
  wager24h: number;
  wager3d: number;
  wager7d: number;
  wager14d: number;
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
  /**
   * Per-roll pack → picked-card mapping for this game session, derived from
   * each provably_fair row's `result_metadata` (pack_id / pack_name / card_id /
   * round_id) joined to packs + cards. One entry per round for a battle (the
   * leg the user kept wins; otherwise the card they pulled), or one entry per
   * pull for a plain pack opening. `kept` is true when the picked card landed
   * in the user's inventory (vs. redistributed to an opponent in borrow modes).
   * Empty when no PF row references a pack (older sessions / non-pack games).
   */
  packsOpened: {
    key: string;
    roundIndex: number | null;
    nonce: number;
    kept: boolean;
    pack: { id: string; name: string; imageUrl: string | null };
    card: {
      name: string;
      imageUrl: string | null;
      rarity: string | null;
      valueUsd: number;
    } | null;
  }[];
  createdAt: string;
};

// Gaming = the full pack / battle / upgrader play cycle: the bet/play legs. The
// item cash-OUTS — card_sale / reward_card_sale (selling a won/reward card back
// to balance) and voucher_redeemed (cashing a won voucher back to balance) —
// were MOVED to the Inventory tab (CARD_SALE_TX_TYPES below) per owner: they're
// item realizations, shown next to the items they came from. The
// battle_excess_to_voucher win leg was ALSO moved to the Inventory tab
// (BATTLE_VOUCHER_TX_TYPES below) per owner — the paired battle_bet row already
// shows the full win P&L on Gaming, so the voucher-leg row was redundant here;
// as a voucher GRANT (held item, voucher == card) it now sits with inventory.
// Pure exchanges (card_exchange / voucher_exchange / exchange_excess_*) stay
// OUT — exchanging an item is value-neutral, not a realization. Keep this list
// in sync with GAMING_TYPES in page.tsx (this = load-more; that = initial fetch).
export const GAMING_TX_TYPES = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "upgrader_bet",
  "upgrader_payout",
] as const;
// Financial = deposits, withdrawals (card_withdrawal + withdrawal_shipping_fee)
// and direct cash payouts (rakeback / affiliate / rain / race / gift / promo).
// The win-realization rows (card_sale / reward_card_sale) and the
// battle_excess_to_voucher win-grant do NOT live here — they're on the
// Inventory tab (CARD_SALE_TX_TYPES / BATTLE_VOUCHER_TX_TYPES), next to the
// items they realize/created. Pure card / voucher exchanges
// (card_exchange / voucher_exchange / exchange_excess_*) are in neither list —
// exchanging an item is value-neutral, not a cash event.
export const FINANCIAL_TX_TYPES = [
  "deposit",
  "deposit_bonus",
  "admin_balance_adjustment",
  "card_withdrawal",
  // Cash leg of a crypto-BALANCE withdrawal (new sweepstakes model) — the user
  // cashing out, same as card_withdrawal. Surface it in the Finances feed.
  // Drift-safe: getUserTransactions intersects with the LIVE enum.
  "balance_withdrawal",
  "withdrawal_shipping_fee",
  "rakeback_claim",
  "balance_reward_claim",
  "affiliate_claim",
  "promo_code_redeemed",
  "gift_card_redeemed",
  "rain_win",
  "race_prize",
  // Creator/affiliate-leaderboard win paid to the user. Also surfaced in its
  // own "Leaderboard" box on Overview (tips.leaderboardWins) — shown HERE too
  // so it appears in the Deposits & Withdrawals feed like race_prize does.
  // Drift-safe: getUserTransactions intersects with the LIVE enum.
  "affiliate_leaderboard_prize",
  // Keep in sync with FINANCIAL_TYPES in page.tsx (this = load-more list;
  // that = initial fetch). Challenge prize is a direct cash payout.
  "challenge_prize",
  // XP purchase — the user spent withdrawable balance to buy XP (a debit /
  // house gain). Surface it in the Finances feed alongside the other balance
  // movements. Drift-safe: getUserTransactions intersects the requested list
  // with the LIVE enum, so a DB without this member just drops it.
  "xp_purchase",
  // Vault movements — user-internal transfer between available balance and
  // the Fireblocks-locked vault product. Neutral for house P&L (the value
  // never leaves the user's control), but the available-balance side moves
  // on lock/unlock — which is exactly why operators NEED to see them next
  // to deposits/withdrawals: a `vault_unlock` + `balance_withdrawal` pair
  // is the trail for "where did this withdrawal come from?" otherwise the
  // withdrawal appears to materialize out of nowhere. Drift-safe via the
  // LIVE-enum intersection in getUserTransactions. Keep in sync with
  // FINANCIAL_TYPES in page.tsx.
  "vault_lock",
  "vault_unlock",
] as const;
// Deposit-side ledger types: the user funding their account. `deposit` is the
// crypto/cash-in; `deposit_bonus` is the house top-up that rides on a deposit.
// Subset of FINANCIAL_TX_TYPES — used by the Deposits & Withdrawals table's
// "Deposits" segmented filter to narrow the server query + Type dropdown.
export const DEPOSIT_TX_TYPES = ["deposit", "deposit_bonus"] as const;
// Withdrawal-side ledger types: the user cashing out. `card_withdrawal` is the
// payout; `withdrawal_shipping_fee` is the fee leg charged on a physical-card
// withdrawal. Subset of FINANCIAL_TX_TYPES — used by the "Withdrawals"
// segmented filter on the Deposits & Withdrawals table.
export const WITHDRAWAL_TX_TYPES = [
  "card_withdrawal",
  "balance_withdrawal",
  "withdrawal_shipping_fee",
] as const;
// Admin balance adjustments only. Used for the dedicated, UNCAPPED Overview
// fetch + block so every manual admin credit/clawback is guaranteed to
// surface, instead of competing for slots in the shared 10-row financial
// page (where a single newer batch of deposits/withdrawals could hide an
// older adjustment). Shares the same query path, so the official_stream
// fake-balance exclusion still applies automatically.
export const ADJUSTMENT_TX_TYPES = ["admin_balance_adjustment"] as const;
// Item cash-OUTS surfaced on the Inventory tab's "Card & Voucher Sales"
// section: selling a won (card_sale) or reward (reward_card_sale) card back to
// balance, OR cashing a won voucher back to balance (voucher_redeemed). All
// realize a held item into cash (voucher == card per house rules), so they sit
// next to the items they came from. Keep in sync with CARD_SALE_TYPES in page.tsx.
export const CARD_SALE_TX_TYPES = [
  "card_sale",
  "reward_card_sale",
  "voucher_redeemed",
] as const;
// Battle-win voucher GRANT surfaced on the Inventory tab's "Battle Win
// Vouchers" section: battle_excess_to_voucher is the leftover voucher leg of a
// battle win (voucher == card per house rules). It is NOT a sale/cash-out like
// CARD_SALE_TX_TYPES — it's the win-grant of a held item — so it gets its own
// section rather than diluting the sales-only "Card & Voucher Sales" meaning.
// Moved off Gaming per owner (the paired battle_bet row already carries the
// full win P&L). Keep in sync with BATTLE_VOUCHER_TYPES in page.tsx.
export const BATTLE_VOUCHER_TX_TYPES = ["battle_excess_to_voucher"] as const;
export const EXCHANGE_TX_TYPES = [
  "card_exchange",
  "exchange_excess_to_voucher",
  "exchange_excess_credit",
  "battle_excess_to_voucher",
  "voucher_exchange",
] as const;

export type TabKey =
  | "overview"
  | "rewards"
  | "gaming"
  | "inventory"
  | "account"
  | "kyc";

export const TAB_KEYS = new Set<TabKey>([
  "overview",
  "rewards",
  "gaming",
  "inventory",
  "account",
  "kyc",
]);

export function coerceTab(raw: string | undefined): TabKey {
  if (raw && TAB_KEYS.has(raw as TabKey)) return raw as TabKey;
  return "overview";
}
