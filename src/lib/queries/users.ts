import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";

type UserListItem = {
  id: string;
  username: string | null;
  email: string | null;
  role: string;
  status: string;
  availableBalance: number;
  totalDeposited: number;
  createdAt: string;
};

export async function getUsers(params: {
  page?: number;
  perPage?: number;
  search?: string;
  role?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: string;
}): Promise<PaginatedResult<UserListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    role,
    status,
    sortBy = "created_at",
    sortOrder = "desc",
  } = params;

  const where: Prisma.UserWhereInput = {};

  if (search) {
    where.OR = [
      { username: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { id: search },
    ];
  }

  if (role && role !== "all") {
    where.role = role as Prisma.Enumuser_roleFieldUpdateOperationsInput["set"];
  }

  if (status === "banned") where.is_banned = true;
  else if (status === "locked") where.is_locked = true;
  else if (status === "active") {
    where.is_banned = false;
    where.is_locked = false;
  }

  const orderBy: Prisma.UserOrderByWithRelationInput = {};
  const validSortFields = ["created_at", "email", "username", "role"];
  const field = validSortFields.includes(sortBy) ? sortBy : "created_at";
  const order = sortOrder === "asc" ? "asc" : "desc";
  (orderBy as Record<string, string>)[field] = order;

  const [users, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        balances: {
          select: { available_balance: true, total_deposited: true },
        },
      },
    }),
    db.user.count({ where }),
  ]);

  return {
    data: users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      status: u.is_banned ? "banned" : u.is_locked ? "locked" : "active",
      availableBalance: toNumber(u.balances?.available_balance),
      totalDeposited: toNumber(u.balances?.total_deposited),
      createdAt: u.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getUserDetail(id: string) {
  let inventoryValueResult: { _sum: { value_at_obtained: unknown } };
  let wagerBreakdown: { type: string; _sum: { amount: unknown } }[];
  try {
    [inventoryValueResult, wagerBreakdown] = await Promise.all([
      db.user_inventory.aggregate({
        where: { user_id: id, sold_at: null, exchanged_at: null },
        _sum: { value_at_obtained: true },
      }),
      db.ledger_transactions.groupBy({
        by: ["type"],
        where: {
          user_id: id,
          type: { in: ["pack_opening", "battle_bet"] },
          status: "completed",
        },
        _sum: { amount: true },
      }),
    ]);
  } catch (e) {
    console.error("[getUserDetail] inventory/wager query failed:", e);
    inventoryValueResult = { _sum: { value_at_obtained: null } };
    wagerBreakdown = [];
  }

  const [user, balances, statistics, featureLocks, inventoryCount, affiliateAccount, shippingAddress, vault, mutes, cardWithdrawals, activeSeed, depositAddresses] =
    await Promise.all([
      db.user.findUnique({
        where: { id },
        include: { account: { select: { providerId: true } } },
      }),
      db.balances.findUnique({ where: { user_id: id } }),
      db.user_statistics.findUnique({ where: { user_id: id } }),
      db.user_feature_locks.findUnique({ where: { user_id: id } }),
      db.user_inventory.count({ where: { user_id: id, sold_at: null, exchanged_at: null } }),
      db.affiliate_accounts.findUnique({ where: { user_id: id } }),
      db.shipping_addresses.findUnique({ where: { user_id: id } }),
      db.vaults.findUnique({ where: { user_id: id } }),
      db.user_mutes.findMany({
        where: { user_id: id },
        orderBy: { created_at: "desc" },
        take: 10,
      }),
      db.card_withdrawal_requests.findMany({
        where: { user_id: id },
        orderBy: { requested_at: "desc" },
        take: 10,
      }),
      db.active_seeds.findUnique({ where: { user_id: id } }),
      db.deposit_addresses.findMany({
        where: { user_id: id },
        orderBy: { created_at: "desc" },
      }),
    ]);

  if (!user) return null;

  // Resolve referred_by username
  let referredByUsername: string | null = null;
  if (user.referred_by) {
    const referrer = await db.user.findUnique({
      where: { id: user.referred_by },
      select: { username: true, email: true },
    });
    referredByUsername = referrer?.username ?? referrer?.email ?? user.referred_by;
  }

  return {
    user: {
      id: user.id,
      username: user.username,
      displayUsername: user.display_username,
      name: user.name,
      email: user.email,
      emailVerified: user.email_verified,
      role: user.role,
      image: user.image,
      twoFactorEnabled: user.two_factor_enabled ?? false,
      isBanned: user.is_banned,
      bannedReason: user.banned_reason,
      bannedAt: user.banned_at?.toISOString() ?? null,
      bannedBy: user.banned_by,
      isLocked: user.is_locked,
      lockedReason: user.locked_reason,
      lockedAt: user.locked_at?.toISOString() ?? null,
      lockedBy: user.locked_by,
      lockedUntil: user.locked_until?.toISOString() ?? null,
      country: user.country,
      countryCode: user.country_code,
      city: user.city,
      state: user.state,
      continentCode: user.continent_code,
      signupIp: user.signup_ip,
      referredBy: user.referred_by,
      referredByUsername,
      affiliateCode: user.affiliate_code,
      affiliateCodeActive: user.affiliate_code_active ?? false,
      affiliateCodeExpiresAt: user.affiliate_code_expires_at?.toISOString() ?? null,
      affiliateBonusOptedIn: user.affiliate_bonus_opted_in ?? false,
      hasApiKey: !!user.api_key,
      createdAt: user.created_at.toISOString(),
      updatedAt: user.updated_at.toISOString(),
      providers: user.account.map((a) => a.providerId),
    },
    balances: balances
      ? {
          availableBalance: toNumber(balances.available_balance),
          lockedBalance: toNumber(balances.locked_balance),
          totalDeposited: toNumber(balances.total_deposited),
          totalWithdrawn: toNumber(balances.total_withdrawn),
          totalWagered: toNumber(balances.total_wagered),
          totalWon: toNumber(balances.total_won),
          bonusPoints: balances.bonus_points,
          unlockAt: balances.unlock_at?.toISOString() ?? null,
          inventoryValue: inventoryValueResult._sum.value_at_obtained
            ? toNumber(inventoryValueResult._sum.value_at_obtained)
            : 0,
          packsWagered: Math.abs(toNumber(
            wagerBreakdown.find((w) => w.type === "pack_opening")?._sum.amount ?? 0,
          )),
          battlesWagered: Math.abs(toNumber(
            wagerBreakdown.find((w) => w.type === "battle_bet")?._sum.amount ?? 0,
          )),
        }
      : null,
    statistics: statistics
      ? {
          openedPacks: statistics.opened_packs_count,
          battlesPlayed: statistics.battles_played,
          xp: statistics.xp,
          level: statistics.level,
          weeklyWagerCount: statistics.weekly_wager_count,
          lastWageredAt: statistics.last_wagered_at?.toISOString() ?? null,
          currentDayWageredUsd: toNumber(statistics.current_day_wagered_usd),
          currentWeekWageredUsd: toNumber(statistics.current_week_wagered_usd),
          currentMonthWageredUsd: toNumber(statistics.current_month_wagered_usd),
          isProfilePrivate: statistics.is_profile_private,
        }
      : null,
    featureLocks: featureLocks
      ? {
          lockedWithdrawalsCrypto: featureLocks.locked_withdrawals_crypto.length > 0,
          lockedWithdrawalsItems: featureLocks.locked_withdrawals_items,
          lockedInventorySales: featureLocks.locked_inventory_sales,
          lockedExchanges: featureLocks.locked_exchanges,
          lockedOpenings: featureLocks.locked_openings,
          lockedVault: featureLocks.locked_vault,
        }
      : null,
    inventoryCount,
    affiliate: affiliateAccount
      ? {
          code: user?.affiliate_code ?? "",
          totalReferred: affiliateAccount.total_referred,
          totalWagerVolumeUsd: toNumber(affiliateAccount.total_wager_volume_usd),
          totalEarnedUsd: toNumber(affiliateAccount.total_earned_usd),
          availableUsd: toNumber(affiliateAccount.available_usd),
          totalPaidOutUsd: toNumber(affiliateAccount.total_paid_out_usd),
          totalBonusDistributedUsd: toNumber(affiliateAccount.total_bonus_distributed_usd),
          lastPayoutAt: affiliateAccount.last_payout_at?.toISOString() ?? null,
        }
      : null,
    shippingAddress: shippingAddress
      ? {
          firstName: shippingAddress.first_name,
          lastName: shippingAddress.last_name,
          phoneCountryCode: shippingAddress.phone_country_code,
          phoneNumber: shippingAddress.phone_number,
          addressLine1: shippingAddress.address_line_1,
          addressLine2: shippingAddress.address_line_2,
          city: shippingAddress.city,
          zipCode: shippingAddress.zip_code,
          stateProvince: shippingAddress.state_province,
          country: shippingAddress.country,
        }
      : null,
    vault: vault
      ? {
          id: vault.id,
          name: vault.name,
          customerRefId: vault.customer_ref_id,
          fireblocksVaultId: vault.fireblocks_vault_id ?? null,
          createdAt: vault.created_at.toISOString(),
        }
      : null,
    mutes: mutes.map((m) => ({
      id: m.id,
      mutedBy: m.muted_by,
      reason: m.reason,
      expiresAt: m.expires_at?.toISOString() ?? null,
      unmutedAt: m.unmuted_at?.toISOString() ?? null,
      unmutedBy: m.unmuted_by,
      createdAt: m.created_at.toISOString(),
    })),
    cardWithdrawals: cardWithdrawals.map((cw) => ({
      id: cw.id,
      method: cw.method,
      totalValueUsd: toNumber(cw.total_value_usd),
      shippingFeeUsd: cw.shipping_fee_usd ? toNumber(cw.shipping_fee_usd) : null,
      trackingNumber: cw.tracking_number,
      carrier: cw.carrier,
      status: cw.status,
      failureReason: cw.failure_reason,
      requestedAt: cw.requested_at.toISOString(),
      completedAt: cw.completed_at?.toISOString() ?? null,
    })),
    activeSeed: activeSeed
      ? {
          clientSeed: activeSeed.client_seed,
          serverSeedHash: activeSeed.server_seed_hash,
          nonce: activeSeed.nonce,
        }
      : null,
    depositAddresses: depositAddresses.map((da) => ({
      id: da.id,
      assetId: da.asset_id,
      address: da.address,
      tag: da.tag,
      legacyAddress: da.legacy_address,
      createdAt: da.created_at.toISOString(),
    })),
  };
}

export async function getUserInventory(
  userId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: {
    rarity?: string;
    status?: string;
    search?: string;
    sort?: string;
    priceMin?: number;
    priceMax?: number;
  }
) {
  const where: Prisma.user_inventoryWhereInput = { user_id: userId };

  if (filters?.status === "owned") {
    where.sold_at = { equals: null };
    where.exchanged_at = { equals: null };
  } else if (filters?.status === "sold") {
    where.sold_at = { not: null };
  } else if (filters?.status === "exchanged") {
    where.exchanged_at = { not: null };
  }

  if (filters?.priceMin != null) {
    where.value_at_obtained = { ...(where.value_at_obtained as object ?? {}), gte: filters.priceMin };
  }
  if (filters?.priceMax != null) {
    where.value_at_obtained = { ...(where.value_at_obtained as object ?? {}), lte: filters.priceMax };
  }

  // For rarity / search filtering, we need to find matching card IDs first
  let cardIdFilter: string[] | null = null;
  if (filters?.rarity || filters?.search) {
    const cardWhere: Prisma.cardsWhereInput = {};
    if (filters.rarity) cardWhere.rarity = { equals: filters.rarity, mode: "insensitive" };
    if (filters.search) cardWhere.name = { contains: filters.search, mode: "insensitive" };
    const matchingCards = await db.cards.findMany({
      where: cardWhere,
      select: { id: true },
    });
    cardIdFilter = matchingCards.map((c) => c.id);
    where.card_id = { in: cardIdFilter };
  }

  // Sort
  let orderBy: Prisma.user_inventoryOrderByWithRelationInput = { created_at: "desc" };
  if (filters?.sort === "price_asc") orderBy = { value_at_obtained: "asc" };
  else if (filters?.sort === "price_desc") orderBy = { value_at_obtained: "desc" };
  else if (filters?.sort === "oldest") orderBy = { created_at: "asc" };

  const [items, total] = await Promise.all([
    db.user_inventory.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.user_inventory.count({ where }),
  ]);

  // Fetch card details for the items
  const cardIds = [...new Set(items.map((i) => i.card_id))];
  const cards = cardIds.length > 0
    ? await db.cards.findMany({
        where: { id: { in: cardIds } },
        select: { id: true, name: true, image_url: true, rarity: true },
      })
    : [];
  const cardMap = new Map(cards.map((c) => [c.id, c]));

  return {
    data: items.map((item) => {
      const card = cardMap.get(item.card_id);
      return {
        id: item.id,
        cardName: card?.name ?? "Unknown Card",
        imageUrl: card?.image_url ?? null,
        rarity: card?.rarity ?? null,
        value: toNumber(item.value_at_obtained),
        sourceType: item.source_type,
        obtainedAt: item.obtained_at.toISOString(),
        soldAt: item.sold_at?.toISOString() ?? null,
        exchangedAt: item.exchanged_at?.toISOString() ?? null,
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getUserTransactions(
  userId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: { type?: string; types?: string[]; status?: string; dateFrom?: string; dateTo?: string }
) {
  const where: Prisma.ledger_transactionsWhereInput = { user_id: userId };

  if (filters?.type && filters.type !== "all") {
    where.type = filters.type as Prisma.Enumledger_transaction_typeFilter["equals"];
  } else if (filters?.types && filters.types.length > 0) {
    where.type = { in: filters.types as Prisma.Enumledger_transaction_typeFilter["in"] };
  }
  if (filters?.status && filters.status !== "all") {
    where.status = filters.status as Prisma.Enumledger_transaction_statusFilter["equals"];
  }
  if (filters?.dateFrom || filters?.dateTo) {
    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (filters.dateFrom) {
      const d = new Date(filters.dateFrom);
      if (!isNaN(d.getTime())) dateFilter.gte = d;
    }
    if (filters?.dateTo) {
      const to = new Date(filters.dateTo);
      if (!isNaN(to.getTime())) {
        to.setDate(to.getDate() + 1);
        dateFilter.lte = to;
      }
    }
    if (dateFilter.gte || dateFilter.lte) {
      where.created_at = dateFilter;
    }
  }

  const [transactions, total] = await Promise.all([
    db.ledger_transactions.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        game_sessions_ledger_transactions_game_session_idTogame_sessions: {
          select: { game_id: true, game_type: true },
        },
      },
    }),
    db.ledger_transactions.count({ where }),
  ]);

  // Resolve pack names for pack_opening transactions
  // game_id may reference packs directly or user_packs
  const gameSessionsWithPacks = transactions
    .filter((t) => t.game_sessions_ledger_transactions_game_session_idTogame_sessions?.game_type === "pack")
    .map((t) => t.game_sessions_ledger_transactions_game_session_idTogame_sessions!);

  const packGameIds = [...new Set(gameSessionsWithPacks.map((gs) => gs.game_id).filter(Boolean))] as string[];
  const packByGameId = new Map<string, { id: string; name: string }>();

  if (packGameIds.length > 0) {
    // Try direct pack lookup first
    const directPacks = await db.packs.findMany({
      where: { id: { in: packGameIds } },
      select: { id: true, name: true },
    });
    for (const p of directPacks) {
      packByGameId.set(p.id, p);
    }

    // For any remaining IDs, try user_packs
    const remaining = packGameIds.filter((id) => !packByGameId.has(id));
    if (remaining.length > 0) {
      const userPacks = await db.user_packs.findMany({
        where: { id: { in: remaining } },
        include: { packs: { select: { id: true, name: true } } },
      });
      for (const up of userPacks) {
        if (up.packs) packByGameId.set(up.id, up.packs);
      }
    }
  }

  // Resolve card details for card_sale transactions
  const cardSaleItemIds = transactions
    .filter((t) => t.type === "card_sale" && t.metadata && typeof t.metadata === "object")
    .map((t) => (t.metadata as Record<string, unknown>)?.inventory_item_id)
    .filter((id): id is string => typeof id === "string");

  const inventoryItems = cardSaleItemIds.length > 0
    ? await db.user_inventory.findMany({
        where: { id: { in: cardSaleItemIds } },
        select: { id: true, card_id: true, source_type: true, source_id: true },
      })
    : [];

  const cardIds = [...new Set(inventoryItems.map((i) => i.card_id))];
  const cards = cardIds.length > 0
    ? await db.cards.findMany({
        where: { id: { in: cardIds } },
        select: { id: true, name: true, image_url: true, rarity: true },
      })
    : [];
  const cardMap = new Map(cards.map((c) => [c.id, c]));
  const inventoryMap = new Map(inventoryItems.map((i) => [i.id, { ...i, card: cardMap.get(i.card_id) ?? null }]));

  // Resolve cards value for gaming transactions via provably_fair_results
  const gamingSessionIds = transactions
    .filter((t) => (t.type === "pack_opening" || t.type === "battle_bet" || t.type === "battle_sponsorship") && t.game_session_id)
    .map((t) => t.game_session_id!);
  const cardsValueBySession = new Map<string, number>();
  if (gamingSessionIds.length > 0) {
    try {
      const pfResults = await db.provably_fair_results.findMany({
        where: { game_session_id: { in: gamingSessionIds }, inventory_item_id: { not: null } },
        select: {
          game_session_id: true,
          user_inventory: { select: { value_at_obtained: true } },
        },
      });
      for (const pf of pfResults) {
        if (pf.user_inventory?.value_at_obtained) {
          const current = cardsValueBySession.get(pf.game_session_id) ?? 0;
          cardsValueBySession.set(pf.game_session_id, current + toNumber(pf.user_inventory.value_at_obtained));
        }
      }
    } catch (e) {
      console.error("[getUserTransactions] provably_fair_results query failed:", e);
    }
  }

  return {
    data: transactions.map((t) => {
      const gs = t.game_sessions_ledger_transactions_game_session_idTogame_sessions;
      const pack = gs?.game_type === "pack" && gs.game_id ? packByGameId.get(gs.game_id) ?? null : null;
      const meta = t.metadata as Record<string, unknown> | null;
      const invItemId = meta?.inventory_item_id as string | undefined;
      const soldItem = invItemId ? inventoryMap.get(invItemId) ?? null : null;
      return {
        id: t.id,
        type: t.type,
        amount: toNumber(t.amount),
        balanceBefore: toNumber(t.balance_before),
        balanceAfter: toNumber(t.balance_after),
        description: t.description,
        status: t.status,
        gameSessionId: t.game_session_id,
        packId: pack?.id ?? null,
        packName: pack?.name ?? null,
        cardsValue: t.game_session_id ? cardsValueBySession.get(t.game_session_id) ?? null : null,
        soldCard: soldItem?.card ? {
          name: soldItem.card.name,
          imageUrl: soldItem.card.image_url,
          rarity: soldItem.card.rarity,
        } : null,
        cryptoAsset: t.crypto_asset,
        cryptoAmount: t.crypto_amount ? toNumber(t.crypto_amount) : null,
        exchangeRate: t.exchange_rate ? toNumber(t.exchange_rate) : null,
        blockchainTxHash: t.blockchain_tx_hash,
        sourceAddress: t.source_address,
        destinationAddress: t.destination_address,
        depositAddressId: t.deposit_address_id,
        failureReason: t.failure_reason,
        metadata: t.metadata ? JSON.parse(JSON.stringify(t.metadata)) : null,
        fireblocksTxId: t.fireblocks_tx_id,
        externalTxId: t.external_tx_id,
        createdAt: t.created_at.toISOString(),
        updatedAt: t.updated_at.toISOString(),
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getUserAuditLog(
  userId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: { eventType?: string }
) {
  const where: Record<string, unknown> = { user_id: userId };
  if (filters?.eventType && filters.eventType !== "all") {
    where.event_type = filters.eventType;
  }

  const [events, total] = await Promise.all([
    db.audit_events.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.audit_events.count({ where }),
  ]);

  return {
    data: events.map((e) => ({
      id: e.id,
      eventType: e.event_type,
      ip: e.ip,
      country: e.country,
      createdAt: e.created_at.toISOString(),
      metadata: e.metadata,
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export type PnlBreakdown = {
  // Gambling revenue (platform perspective, positive = platform earned)
  packRevenue: number;
  battleRevenue: number;
  cardSalesPayouts: number;
  gamblingPnlRealized: number;
  unrealizedLiability: number;
  gamblingPnlTrue: number;
  // Costs (positive = cost to platform)
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
  };
  // Net
  netPnlRealized: number;
  netPnlTrue: number;
};

export async function getUserPnlBreakdown(userId: string): Promise<PnlBreakdown> {
  const [rows, inventoryValue] = await Promise.all([
    db.$queryRaw<{ type: string; net: string }[]>`
      SELECT type,
             COALESCE(SUM(balance_after - balance_before), 0)::text AS net
      FROM ledger_transactions
      WHERE user_id = ${userId} AND status = 'completed'
        AND type IN (
          'pack_opening','battle_bet','battle_sponsorship','battle_refund',
          'card_sale','reward_card_sale','card_exchange',
          'deposit_bonus','promo_code_redeemed','gift_card_redeemed','waitlist_prize',
          'rakeback_claim','affiliate_claim',
          'rain_win','race_prize','balance_reward_claim','creator_tip',
          'voucher_redeemed','voucher_exchange','exchange_excess_credit',
          'exchange_excess_to_voucher','battle_excess_to_voucher')
      GROUP BY type
    `,
    db.user_inventory.aggregate({
      where: { user_id: userId, sold_at: null, exchanged_at: null },
      _sum: { value_at_obtained: true },
    }),
  ]);

  const byType = new Map(rows.map((r) => [r.type, parseFloat(r.net) || 0]));
  const sum = (...types: string[]) => types.reduce((acc, t) => acc + (byType.get(t) ?? 0), 0);

  // Gambling revenue: user loses money → net is negative → negate for platform perspective
  const packRevenue = -sum("pack_opening");
  const battleRevenue = -sum("battle_bet", "battle_sponsorship", "battle_refund");
  // Card sales: user gets money back → net is positive → negate = negative (cost to platform)
  const cardSalesPayouts = -sum("card_sale", "reward_card_sale", "card_exchange");
  const gamblingPnlRealized = packRevenue + battleRevenue + cardSalesPayouts;

  // Unrealized: cards the user still holds = future liability
  const unrealizedLiability = inventoryValue._sum.value_at_obtained
    ? toNumber(inventoryValue._sum.value_at_obtained)
    : 0;
  const gamblingPnlTrue = gamblingPnlRealized - unrealizedLiability;

  // Costs to platform (user gains money → positive net)
  const bonusesCost = sum("deposit_bonus", "promo_code_redeemed", "gift_card_redeemed", "waitlist_prize");
  const rakebackCost = sum("rakeback_claim");
  const affiliateCost = sum("affiliate_claim");
  const otherCostsDetail = {
    rainWin: sum("rain_win"),
    racePrize: sum("race_prize"),
    balanceRewardClaim: sum("balance_reward_claim"),
    creatorTip: sum("creator_tip"),
    voucherRedeemed: sum("voucher_redeemed"),
    voucherExchange: sum("voucher_exchange"),
    exchangeExcessCredit: sum("exchange_excess_credit"),
    exchangeExcessToVoucher: sum("exchange_excess_to_voucher"),
    battleExcessToVoucher: sum("battle_excess_to_voucher"),
  };
  const otherCosts = Object.values(otherCostsDetail).reduce((a, b) => a + b, 0);

  const totalCosts = bonusesCost + rakebackCost + affiliateCost + otherCosts;
  const netPnlRealized = gamblingPnlRealized - totalCosts;
  const netPnlTrue = gamblingPnlTrue - totalCosts;

  return {
    packRevenue, battleRevenue, cardSalesPayouts,
    gamblingPnlRealized, unrealizedLiability, gamblingPnlTrue,
    bonusesCost, rakebackCost, affiliateCost, otherCosts, otherCostsDetail,
    netPnlRealized, netPnlTrue,
  };
}

export async function getUserBalanceHistory(userId: string) {
  const transactions = await db.ledger_transactions.findMany({
    where: { user_id: userId, status: "completed" },
    orderBy: { created_at: "asc" },
    select: {
      balance_after: true,
      created_at: true,
    },
  });

  // Aggregate by date — keep last balance_after per day
  const byDate = new Map<string, number>();
  for (const t of transactions) {
    const date = t.created_at.toISOString().slice(0, 10);
    byDate.set(date, toNumber(t.balance_after));
  }

  return Array.from(byDate, ([date, balance]) => ({ date, balance }));
}

export async function getCreatorReferralClicks(
  affiliateCode: string,
  page: number = 1,
  perPage: number = 20
): Promise<PaginatedResult<{
  id: number;
  code: string;
  userAgent: string | null;
  ip: string;
  country: string;
  region: string;
  city: string;
  createdAt: string | null;
}>> {
  const where = { code: affiliateCode };
  const [clicks, total] = await Promise.all([
    db.affiliate_clicks.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.affiliate_clicks.count({ where }),
  ]);

  return {
    data: clicks.map((c) => ({
      id: c.id,
      code: c.code,
      userAgent: c.user_agent,
      ip: c.ip,
      country: c.country,
      region: c.region,
      city: c.city,
      createdAt: c.created_at?.toISOString() ?? null,
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getCreatorCodeUsages(
  userId: string,
  page: number = 1,
  perPage: number = 20
): Promise<PaginatedResult<{
  id: string;
  referredUserId: string;
  referredUsername: string | null;
  usageType: string;
  depositAmountUsd: number;
  wagerAmountUsd: number;
  referrerCutUsd: number;
  userBonusUsd: number;
  createdAt: string;
}>> {
  const where = { affiliate_user_id: userId };
  const [usages, total] = await Promise.all([
    db.affiliate_code_usages.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        user_affiliate_code_usages_referred_user_idTouser: {
          select: { username: true, email: true },
        },
      },
    }),
    db.affiliate_code_usages.count({ where }),
  ]);

  return {
    data: usages.map((u) => ({
      id: u.id,
      referredUserId: u.referred_user_id,
      referredUsername:
        u.user_affiliate_code_usages_referred_user_idTouser?.username ??
        u.user_affiliate_code_usages_referred_user_idTouser?.email ??
        null,
      usageType: u.usage_type,
      depositAmountUsd: toNumber(u.deposit_amount_usd),
      wagerAmountUsd: toNumber(u.wager_amount_usd),
      referrerCutUsd: toNumber(u.referrer_cut_usd),
      userBonusUsd: toNumber(u.user_bonus_usd),
      createdAt: u.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getCreatorWithdrawalLimits(userId: string) {
  const limits = await db.creator_withdrawal_limits.findUnique({
    where: { user_id: userId },
  });
  if (!limits) return null;
  return {
    currencyLimitAmount: limits.currency_limit_amount ? toNumber(limits.currency_limit_amount) : null,
    currencyLimitStartDate: limits.currency_limit_start_date?.toISOString() ?? null,
    currencyLimitResetDays: limits.currency_limit_reset_days,
    percentageLimit: limits.percentage_limit ? toNumber(limits.percentage_limit) : null,
  };
}

export type UserSession = {
  id: number;
  depositAmount: number;
  depositDate: string;
  depositCryptoAsset: string | null;
  withdrawAmount: number | null;
  withdrawDate: string | null;
  withdrawMethod: string | null;
  withdrawStatus: string | null;
  activityCount: number;
  wagered: number;
  won: number;
  netPnl: number;
  endBalance: number;
  isOpen: boolean;
};

export async function getUserSessions(userId: string): Promise<UserSession[]> {
  // Fetch all completed transactions ordered by time
  const transactions = await db.ledger_transactions.findMany({
    where: { user_id: userId, status: "completed" },
    orderBy: { created_at: "asc" },
    select: {
      type: true,
      amount: true,
      balance_after: true,
      created_at: true,
    },
  });

  // Fetch all crypto withdrawal requests
  const cryptoWithdrawals = await db.card_withdrawal_requests.findMany({
    where: { user_id: userId, method: "crypto" },
    orderBy: { requested_at: "asc" },
    select: {
      total_value_usd: true,
      status: true,
      requested_at: true,
    },
  });

  // Build a merged timeline of events
  type TimelineEvent =
    | { kind: "deposit"; amount: number; balance: number; date: Date }
    | { kind: "crypto_withdrawal"; amount: number; status: string; date: Date }
    | { kind: "activity"; type: string; amount: number; balance: number; date: Date };

  const timeline: TimelineEvent[] = [];

  const wagerTypes = new Set(["pack_opening", "battle_bet"]);
  const winTypes = new Set(["card_sale", "reward_card_sale", "race_prize", "rain_win", "balance_reward_claim"]);

  for (const t of transactions) {
    const amt = toNumber(t.amount);
    const bal = toNumber(t.balance_after);
    const date = t.created_at;

    if (t.type === "deposit") {
      timeline.push({ kind: "deposit", amount: amt, balance: bal, date });
    } else {
      timeline.push({ kind: "activity", type: t.type, amount: amt, balance: bal, date });
    }
  }

  for (const w of cryptoWithdrawals) {
    timeline.push({
      kind: "crypto_withdrawal",
      amount: toNumber(w.total_value_usd),
      status: w.status,
      date: w.requested_at,
    });
  }

  // Sort by date
  timeline.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Build sessions: each deposit starts a new session, each crypto withdrawal ends it
  type SessionState = {
    depositAmount: number;
    depositDate: Date;
    depositCryptoAsset: null;
    wagered: number;
    won: number;
    activityCount: number;
    endBalance: number;
  };
  const sessions: UserSession[] = [];
  let current: SessionState | null = null;
  let sessionId = 0;

  const startNewSession = (date: Date, balance: number, depositAmount: number = 0) => {
    sessionId++;
    current = {
      depositAmount,
      depositDate: date,
      depositCryptoAsset: null,
      wagered: 0,
      won: 0,
      activityCount: 0,
      endBalance: balance,
    };
  };

  const closeSession = (withdrawAmount: number | null = null, withdrawDate: Date | null = null, withdrawMethod: string | null = null, withdrawStatus: string | null = null) => {
    if (!current) return;
    sessions.push({
      id: sessionId,
      depositAmount: current.depositAmount,
      depositDate: current.depositDate.toISOString(),
      depositCryptoAsset: null,
      withdrawAmount,
      withdrawDate: withdrawDate?.toISOString() ?? null,
      withdrawMethod,
      withdrawStatus,
      activityCount: current.activityCount,
      wagered: current.wagered,
      won: current.won,
      netPnl: current.won - current.wagered,
      endBalance: current.endBalance,
      isOpen: withdrawAmount === null,
    });
  };

  for (const event of timeline) {
    if (event.kind === "deposit") {
      // Close any open session before starting a new one
      if (current) {
        closeSession();
      }
      startNewSession(event.date, event.balance, event.amount);
    } else if (event.kind === "crypto_withdrawal") {
      if (current) {
        closeSession(event.amount, event.date, "crypto", event.status);
        current = null;
      }
    } else if (event.kind === "activity") {
      // Start a session if none is open
      if (!current) {
        startNewSession(event.date, event.balance);
      }
      current!.activityCount++;
      current!.endBalance = event.balance;
      if (wagerTypes.has(event.type)) {
        current!.wagered += Math.abs(event.amount);
      }
      if (winTypes.has(event.type)) {
        current!.won += event.amount;
      }
    }
  }

  // Close last open session if any
  const last = current as SessionState | null;
  if (last) {
    sessions.push({
      id: sessionId,
      depositAmount: last.depositAmount,
      depositDate: last.depositDate.toISOString(),
      depositCryptoAsset: null,
      withdrawAmount: null,
      withdrawDate: null,
      withdrawMethod: null,
      withdrawStatus: null,
      activityCount: last.activityCount,
      wagered: last.wagered,
      won: last.won,
      netPnl: last.won - last.wagered,
      endBalance: last.endBalance,
      isOpen: true,
    });
  }

  // Return newest first
  return sessions.reverse();
}

// ---------------------------------------------------------------------------
// Provably Fair
// ---------------------------------------------------------------------------

export type ProvablyFairResultItem = {
  id: string;
  clientSeed: string;
  serverSeedHash: string;
  serverSeed: string | null;
  nonce: number;
  cursor: number;
  ticket: number;
  resultHash: string;
  resultMetadata: unknown;
  gameType: string;
  battleId: string | null;
  cardName: string | null;
  cardValue: number | null;
  createdAt: string;
};

export async function getProvablyFairResults(
  userId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: { search?: string; gameType?: string }
) {
  const where: Prisma.provably_fair_resultsWhereInput = {
    game_sessions: { user_id: userId },
  };

  if (filters?.gameType && filters.gameType !== "all") {
    where.game_sessions = {
      ...(where.game_sessions as object),
      game_type: filters.gameType as Prisma.Enumgame_typeFilter["equals"],
    };
  }

  if (filters?.search) {
    const s = filters.search;
    const asInt = parseInt(s, 10);
    where.OR = [
      { result_hash: { contains: s, mode: "insensitive" } },
      { server_seed_hash: { contains: s, mode: "insensitive" } },
      { client_seed: { contains: s, mode: "insensitive" } },
      ...(Number.isFinite(asInt) ? [{ ticket: asInt }] : []),
    ];
  }

  const [items, total] = await Promise.all([
    db.provably_fair_results.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        game_sessions: { select: { game_type: true } },
        user_inventory: {
          select: {
            value_at_obtained: true,
            cards: { select: { name: true } },
          },
        },
      },
    }),
    db.provably_fair_results.count({ where }),
  ]);

  return {
    data: items.map((r): ProvablyFairResultItem => ({
      id: r.id,
      clientSeed: r.client_seed,
      serverSeedHash: r.server_seed_hash,
      serverSeed: r.server_seed,
      nonce: r.nonce,
      cursor: r.cursor,
      ticket: r.ticket,
      resultHash: r.result_hash,
      resultMetadata: r.result_metadata,
      gameType: r.game_sessions.game_type,
      battleId: r.battle_id,
      cardName: r.user_inventory?.cards?.name ?? null,
      cardValue: r.user_inventory ? toNumber(r.user_inventory.value_at_obtained) : null,
      createdAt: r.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export type SeedRotationItem = {
  id: string;
  oldClientSeed: string;
  oldServerSeed: string;
  oldServerSeedHash: string;
  oldNonce: number;
  newClientSeed: string;
  newServerSeedHash: string;
  rotatedAt: string;
};

export async function getSeedRotationHistory(
  userId: string,
  page: number = 1,
  perPage: number = 10
) {
  const where: Prisma.seed_rotation_historyWhereInput = { user_id: userId };

  const [items, total] = await Promise.all([
    db.seed_rotation_history.findMany({
      where,
      orderBy: { rotated_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.seed_rotation_history.count({ where }),
  ]);

  return {
    data: items.map((r): SeedRotationItem => ({
      id: r.id,
      oldClientSeed: r.old_client_seed,
      oldServerSeed: r.old_server_seed,
      oldServerSeedHash: r.old_server_seed_hash,
      oldNonce: r.old_nonce,
      newClientSeed: r.new_client_seed,
      newServerSeedHash: r.new_server_seed_hash,
      rotatedAt: r.rotated_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

