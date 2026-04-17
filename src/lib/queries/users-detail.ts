import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

export async function getUserDetail(id: string) {
  let inventoryValueResult: { _sum: { value_at_obtained: unknown } };
  let wagerBreakdown: { type: string; _sum: { amount: unknown } }[];
  let vouchersResult: { _sum: { value: unknown } };
  try {
    [inventoryValueResult, wagerBreakdown, vouchersResult] = await Promise.all([
      db.user_inventory.aggregate({
        where: { user_id: id, sold_at: null, exchanged_at: null },
        _sum: { value_at_obtained: true },
      }),
      db.ledger_transactions.groupBy({
        by: ["type"],
        where: {
          user_id: id,
          type: { in: ["pack_opening", "battle_bet", "battle_sponsorship"] },
          status: "completed",
        },
        _sum: { amount: true },
      }),
      db.vouchers.aggregate({
        where: { user_id: id, claimed_at: null },
        _sum: { value: true },
      }),
    ]);
  } catch (e) {
    console.error("[getUserDetail] inventory/wager/vouchers query failed:", e);
    inventoryValueResult = { _sum: { value_at_obtained: null } };
    wagerBreakdown = [];
    vouchersResult = { _sum: { value: null } };
  }

  const [
    user,
    balances,
    statistics,
    featureLocks,
    inventoryCount,
    affiliateAccount,
    shippingAddress,
    vault,
    mutes,
    cardWithdrawals,
    activeSeed,
    depositAddresses,
    cardWithdrawalTotal,
    depositCount,
    depositTotalAgg,
    withdrawalCount,
  ] = await Promise.all([
    db.user.findUnique({
      where: { id },
      include: {
        account: {
          select: { providerId: true, accountId: true, created_at: true },
        },
      },
    }),
    db.balances.findUnique({ where: { user_id: id } }),
    db.user_statistics.findUnique({ where: { user_id: id } }),
    db.user_feature_locks.findUnique({ where: { user_id: id } }),
    db.user_inventory.count({ where: { user_id: id, sold_at: null, exchanged_at: null } }),
    db.affiliate_accounts.findUnique({
      where: { user_id: id },
      select: {
        total_referred: true,
        total_wager_volume_usd: true,
        total_earned_usd: true,
        available_usd: true,
        total_paid_out_usd: true,
        total_bonus_distributed_usd: true,
        last_payout_at: true,
      },
    }),
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
    db.card_withdrawal_requests.aggregate({
      where: {
        user_id: id,
        status: { in: ["completed", "shipped"] },
      },
      _sum: { total_value_usd: true },
    }),
    // Event counts surfaced at the top of the detail page header. Counts
    // are defined to mirror the existing "total withdrawn" aggregate in
    // balances so the header and the Balances card agree on what counts
    // as a completed deposit / withdrawal.
    db.ledger_transactions.count({
      where: {
        user_id: id,
        type: "deposit",
        status: "completed",
      },
    }),
    // Sum of completed deposits (excluding deposit_bonus) for avg calculation
    db.ledger_transactions.aggregate({
      where: {
        user_id: id,
        type: "deposit",
        status: "completed",
      },
      _sum: { amount: true },
    }),
    db.card_withdrawal_requests.count({
      where: {
        user_id: id,
        status: { in: ["completed", "shipped"] },
      },
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
      discord: (() => {
        const dc = user.account.find((a) => a.providerId === "discord");
        if (!dc) return null;
        return {
          id: dc.accountId,
          linkedAt: dc.created_at?.toISOString() ?? null,
        };
      })(),
    },
    balances: balances
      ? {
          availableBalance: toNumber(balances.available_balance),
          lockedBalance: toNumber(balances.locked_balance),
          totalDeposited: toNumber(balances.total_deposited),
          totalWithdrawn: toNumber(balances.total_withdrawn) + toNumber(cardWithdrawalTotal._sum.total_value_usd),
          totalWagered: toNumber(balances.total_wagered),
          totalWon: toNumber(balances.total_won),
          bonusPoints: balances.bonus_points,
          unlockAt: balances.unlock_at?.toISOString() ?? null,
          inventoryValue: inventoryValueResult._sum.value_at_obtained
            ? toNumber(inventoryValueResult._sum.value_at_obtained)
            : 0,
          vouchersValue: vouchersResult._sum.value
            ? toNumber(vouchersResult._sum.value)
            : 0,
          packsWagered: Math.abs(toNumber(
            wagerBreakdown.find((w) => w.type === "pack_opening")?._sum.amount ?? 0,
          )),
          battlesWagered: Math.abs(
            toNumber(wagerBreakdown.find((w) => w.type === "battle_bet")?._sum.amount ?? 0) +
              toNumber(wagerBreakdown.find((w) => w.type === "battle_sponsorship")?._sum.amount ?? 0),
          ),
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
    counts: {
      deposits: depositCount,
      withdrawals: withdrawalCount,
      avgDeposit:
        depositCount > 0
          ? toNumber(depositTotalAgg._sum.amount ?? 0) / depositCount
          : 0,
    },
  };
}
