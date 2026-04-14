"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin, requirePageAccess } from "@/lib/dal";
import { user_role } from "@/generated/prisma/client";
import { getUserInventory, getUserTransactions, getCreatorReferralClicks, getCreatorCodeUsages, getCreatorWithdrawalLimits, getProvablyFairResults, getSeedRotationHistory, getUserBalanceHistory } from "@/lib/queries/users";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { require2FA } from "@/lib/require-2fa";
import { checkBalanceAdjustmentLimit } from "@/lib/balance-limits";

const adjustBalanceSchema = z.object({
  userId: z.string(),
  amount: z.number(),
  reason: z.string().min(1),
});

export async function adjustBalance(data: {
  userId: string;
  amount: number;
  reason: string;
  totpCode: string;
}) {
  const session = await requireAdmin();
  const parsed = adjustBalanceSchema.parse(data);

  await require2FA(session.userId, data.totpCode);
  await checkBalanceAdjustmentLimit(session.userId, parsed.amount);

  const balances = await db.balances.findUnique({
    where: { user_id: parsed.userId },
  });
  if (!balances) throw new Error("User balances not found");

  const currentBalance = Number(balances.available_balance);
  const newBalance = currentBalance + parsed.amount;
  if (newBalance < 0) throw new Error("Resulting balance would be negative");

  await db.$transaction([
    db.balances.update({
      where: { user_id: parsed.userId },
      data: { available_balance: newBalance },
    }),
    db.ledger_transactions.create({
      data: {
        id: crypto.randomUUID(),
        user_id: parsed.userId,
        type: "admin_balance_adjustment",
        amount: parsed.amount,
        balance_before: currentBalance,
        balance_after: newBalance,
        description: `Admin adjustment: ${parsed.reason}`,
        status: "completed",
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "balance_adjustment",
    targetUserId: parsed.userId,
    metadata: { amount: parsed.amount, reason: parsed.reason },
  });

  // Fire balance_fill webhooks (non-blocking)
  adminDb.creator_webhooks
    .findMany({
      where: { target_user_id: parsed.userId, type: "balance_fill", enabled: true },
    })
    .then((webhooks) => {
      for (const webhook of webhooks) {
        const isDiscord = webhook.url.includes("discord.com/api/webhooks/");
        const sign = parsed.amount >= 0 ? "+" : "";

        const body = isDiscord
          ? JSON.stringify({
              content: `💰 Balance adjusted on Pack.ygg — ${sign}$${parsed.amount.toFixed(2)} (new balance: $${newBalance.toFixed(2)}) — Reason: ${parsed.reason}`,
            })
          : JSON.stringify({
              event: "balance_fill",
              amount: parsed.amount,
              new_balance: newBalance,
              reason: parsed.reason,
              timestamp: new Date().toISOString(),
            });

        const signature = crypto
          .createHmac("sha256", webhook.secret)
          .update(body)
          .digest("hex");

        fetch(webhook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Signature": signature,
          },
          body,
          signal: AbortSignal.timeout(10000),
        }).catch(() => {}); // fire-and-forget
      }
    })
    .catch(() => {}); // don't block if webhook query fails

  revalidatePath(`/users/${parsed.userId}`);
}

export async function changeRole(userId: string, newRole: string, totpCode: string) {
  const session = await requireAdmin();

  await require2FA(session.userId, totpCode);

  if (!["user", "support", "admin", "creator"].includes(newRole)) {
    throw new Error("Invalid role");
  }

  await db.user.update({
    where: { id: userId },
    data: { role: newRole as user_role },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "role_changed",
    targetUserId: userId,
    metadata: { new_role: newRole },
  });

  revalidatePath(`/users/${userId}`);
}

export async function toggleFeatureLock(
  userId: string,
  feature: string,
  locked: boolean
) {
  const session = await requireAdmin();

  const validFeatures = [
    "locked_withdrawals_crypto",
    "locked_withdrawals_items",
    "locked_inventory_sales",
    "locked_exchanges",
    "locked_openings",
    "locked_vault",
  ];
  if (!validFeatures.includes(feature)) throw new Error("Invalid feature");

  // locked_withdrawals_crypto is a String[] (not Boolean) — use ["all"] / []
  const value = feature === "locked_withdrawals_crypto"
    ? (locked ? ["all"] : [])
    : locked;

  const updateData: Record<string, unknown> = {
    [feature]: value,
  };

  // Set timestamps only — admin identity is tracked via audit events
  const byField = feature.startsWith("locked_withdrawals")
    ? "locked_withdrawals"
    : feature;
  updateData[`${byField}_at`] = locked ? new Date() : null;

  await db.user_feature_locks.upsert({
    where: { user_id: userId },
    update: updateData,
    create: {
      id: crypto.randomUUID(),
      user_id: userId,
      ...updateData,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: locked ? `${feature}_enabled` : `${feature}_disabled`,
    targetUserId: userId,
    metadata: { feature, locked },
  });

  revalidatePath(`/users/${userId}`);
}

export async function fetchInventory(
  userId: string,
  page: number,
  perPage: number,
  filters?: {
    rarity?: string;
    status?: string;
    search?: string;
    sort?: string;
    priceMin?: number;
    priceMax?: number;
  }
) {
  await requirePageAccess("/users");
  return getUserInventory(userId, page, perPage, filters);
}

export async function getGameSessionDetails(gameSessionId: string) {
  await requirePageAccess("/users");

  const session = await db.game_sessions.findUnique({
    where: { id: gameSessionId },
    include: {
      provably_fair_results: {
        include: {
          user_inventory: true,
        },
      },
    },
  });

  if (!session) return null;

  // Fetch pack details if it's a pack opening
  let pack: { id: string; name: string; imageUrl: string | null } | null = null;
  if (session.game_type === "pack" && session.game_id) {
    const directPack = await db.packs.findUnique({
      where: { id: session.game_id },
      select: { id: true, name: true, image_url: true },
    });
    if (directPack) {
      pack = { id: directPack.id, name: directPack.name, imageUrl: directPack.image_url };
    } else {
      const userPack = await db.user_packs.findUnique({
        where: { id: session.game_id },
        include: {
          packs: { select: { id: true, name: true, image_url: true } },
        },
      });
      if (userPack?.packs) {
        pack = {
          id: userPack.packs.id,
          name: userPack.packs.name,
          imageUrl: userPack.packs.image_url,
        };
      }
    }
  }

  const inventoryItems = session.provably_fair_results
    .filter((r) => r.user_inventory)
    .map((r) => r.user_inventory!);

  const cardIds = [...new Set(inventoryItems.map((i) => i.card_id))];
  const cards = cardIds.length > 0
    ? await db.cards.findMany({
        where: { id: { in: cardIds } },
        select: { id: true, name: true, image_url: true, rarity: true, price: true },
      })
    : [];
  const cardMap = new Map(cards.map((c) => [c.id, c]));

  const items = inventoryItems.map((inv) => {
    const card = cardMap.get(inv.card_id);
    return {
      id: inv.id,
      cardName: card?.name ?? "Unknown",
      imageUrl: card?.image_url ?? null,
      rarity: card?.rarity ?? null,
      priceUsd: Number(card?.price ?? 0),
      valueAtObtained: Number(inv.value_at_obtained),
    };
  });

  const pfResults = session.provably_fair_results.map((r) => ({
    id: r.id,
    clientSeed: r.client_seed,
    serverSeedHash: r.server_seed_hash,
    serverSeed: r.server_seed,
    nonce: r.nonce,
    cursor: r.cursor,
    ticket: r.ticket,
    resultHash: r.result_hash,
  }));

  return {
    id: session.id,
    gameType: session.game_type,
    result: session.result,
    betAmount: Number(session.bet_amount),
    pack,
    items,
    pfResults,
    createdAt: session.created_at.toISOString(),
  };
}

const withdrawalLimitsSchema = z.object({
  userId: z.string(),
  currencyLimitAmount: z.number().nullable(),
  currencyLimitStartDate: z.string().nullable(),
  currencyLimitResetDays: z.number().int().nullable(),
  percentageLimit: z.number().nullable(),
});

export async function updateWithdrawalLimits(data: {
  userId: string;
  currencyLimitAmount: number | null;
  currencyLimitStartDate: string | null;
  currencyLimitResetDays: number | null;
  percentageLimit: number | null;
}) {
  const session = await requireAdmin();
  const parsed = withdrawalLimitsSchema.parse(data);

  await db.creator_withdrawal_limits.upsert({
    where: { user_id: parsed.userId },
    update: {
      currency_limit_amount: parsed.currencyLimitAmount,
      currency_limit_start_date: parsed.currencyLimitStartDate ? new Date(parsed.currencyLimitStartDate) : null,
      currency_limit_reset_days: parsed.currencyLimitResetDays,
      percentage_limit: parsed.percentageLimit,
      updated_at: new Date(),
    },
    create: {
      id: crypto.randomUUID(),
      user_id: parsed.userId,
      currency_limit_amount: parsed.currencyLimitAmount,
      currency_limit_start_date: parsed.currencyLimitStartDate ? new Date(parsed.currencyLimitStartDate) : null,
      currency_limit_reset_days: parsed.currencyLimitResetDays,
      percentage_limit: parsed.percentageLimit,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_withdrawal_limits_updated",
    targetUserId: parsed.userId,
    metadata: {
      currencyLimitAmount: parsed.currencyLimitAmount,
      currencyLimitStartDate: parsed.currencyLimitStartDate,
      currencyLimitResetDays: parsed.currencyLimitResetDays,
      percentageLimit: parsed.percentageLimit,
    },
  });

  revalidatePath(`/users/${parsed.userId}`);
}

export async function fetchCreatorClicks(
  affiliateCode: string,
  page: number,
  perPage: number
) {
  await requirePageAccess("/users");
  return getCreatorReferralClicks(affiliateCode, page, perPage);
}

export async function fetchCreatorCodeUsages(
  userId: string,
  page: number,
  perPage: number
) {
  await requirePageAccess("/users");
  return getCreatorCodeUsages(userId, page, perPage);
}

export async function assignAffiliateCode(userId: string, affiliateCode: string | null) {
  const session = await requireAdmin();

  if (!affiliateCode || affiliateCode.trim() === "") {
    // Find current referrer to decrement their total_referred
    const currentUser = await db.user.findUnique({
      where: { id: userId },
      select: { referred_by: true },
    });

    await db.user.update({
      where: { id: userId },
      data: { referred_by: null },
    });

    if (currentUser?.referred_by) {
      await db.affiliate_accounts.update({
        where: { user_id: currentUser.referred_by },
        data: { total_referred: { decrement: 1 } },
      });
    }

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "affiliate_code_cleared",
      targetUserId: userId,
      metadata: {},
    });

    revalidatePath(`/users/${userId}`);
    if (currentUser?.referred_by) revalidatePath(`/users/${currentUser.referred_by}`);
    return { success: true };
  }

  const codeRecord = await db.affiliate_codes.findUnique({
    where: { code: affiliateCode.trim() },
  });

  if (!codeRecord) {
    throw new Error("Affiliate code not found");
  }

  if (codeRecord.user_id === userId) {
    throw new Error("Cannot assign a user to their own affiliate code");
  }

  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: { referred_by: codeRecord.user_id },
    }),
    db.affiliate_accounts.update({
      where: { user_id: codeRecord.user_id },
      data: { total_referred: { increment: 1 } },
    }),
    db.affiliate_code_usages.create({
      data: {
        affiliate_user_id: codeRecord.user_id,
        code: affiliateCode.trim(),
        referred_user_id: userId,
        usage_type: "deposit",
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_assigned",
    targetUserId: userId,
    metadata: { affiliateCode: affiliateCode.trim(), affiliateOwnerId: codeRecord.user_id },
  });

  revalidatePath(`/users/${userId}`);
  revalidatePath(`/users/${codeRecord.user_id}`);
  return { success: true };
}

export async function createAffiliateCode(userId: string, code: string) {
  const session = await requireAdmin();
  const trimmed = code.trim();
  if (!trimmed) return { success: false, error: "Code cannot be empty" };

  // Check code uniqueness
  const existingCode = await db.affiliate_codes.findUnique({ where: { code: trimmed } });
  if (existingCode) return { success: false, error: "This code is already taken" };

  await db.$transaction([
    db.affiliate_accounts.upsert({
      where: { user_id: userId },
      create: { user_id: userId },
      update: {},
    }),
    db.affiliate_codes.create({
      data: {
        user_id: userId,
        code: trimmed,
      },
    }),
    db.user.update({
      where: { id: userId },
      data: {
        affiliate_code: trimmed,
        affiliate_code_active: true,
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_created",
    targetUserId: userId,
    metadata: { code: trimmed },
  });

  revalidatePath(`/users/${userId}`);
  return { success: true };
}

const adjustXpSchema = z.object({
  userId: z.string(),
  amount: z.number(),
  reason: z.string().min(1),
});

export async function adjustXp(data: {
  userId: string;
  amount: number;
  reason: string;
}) {
  const session = await requireAdmin();
  const parsed = adjustXpSchema.parse(data);

  const stats = await db.user_statistics.findUnique({
    where: { user_id: parsed.userId },
  });
  if (!stats) throw new Error("User statistics not found");

  const currentXp = Number(stats.xp);
  const newXp = Math.max(0, currentXp + parsed.amount);

  await db.user_statistics.update({
    where: { user_id: parsed.userId },
    data: { xp: newXp },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "xp_adjustment",
    targetUserId: parsed.userId,
    metadata: { amount: parsed.amount, previousXp: currentXp, newXp, reason: parsed.reason },
  });

  revalidatePath(`/users/${parsed.userId}`);
}

export async function fetchUserTransactions(
  userId: string,
  page: number,
  perPage: number,
  filters?: { type?: string; types?: string[]; status?: string; dateFrom?: string; dateTo?: string }
) {
  await requirePageAccess("/users");
  return getUserTransactions(userId, page, perPage, filters);
}

export async function fetchProvablyFairResults(
  userId: string,
  page: number,
  perPage: number,
  filters?: { search?: string; gameType?: string }
) {
  await requirePageAccess("/users");
  return getProvablyFairResults(userId, page, perPage, filters);
}

export async function fetchSeedRotationHistory(
  userId: string,
  page: number,
  perPage: number
) {
  await requirePageAccess("/users");
  return getSeedRotationHistory(userId, page, perPage);
}

export async function fetchBalanceHistory(userId: string) {
  await requirePageAccess("/users");
  return getUserBalanceHistory(userId);
}

export async function fetchCreatorWithdrawalLimits(userId: string) {
  await requirePageAccess("/users");
  return getCreatorWithdrawalLimits(userId);
}
