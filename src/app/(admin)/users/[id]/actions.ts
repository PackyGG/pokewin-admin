"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin, requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { user_role } from "@/generated/prisma/client";
import { getUserInventory, getUserTransactions, getCreatorReferralClicks, getCreatorCodeUsages, getCreatorWithdrawalLimits, getProvablyFairResults, getSeedRotationHistory, getUserBalanceHistory } from "@/lib/queries/users";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { require2FA } from "@/lib/require-2fa";
import { checkBalanceAdjustmentLimit } from "@/lib/balance-limits";
import { creatorsApi, BackendApiError } from "@/lib/backend-api";
import {
  canUserAdjustBalance,
  hasCapability,
} from "@/app/(admin)/settings/roles/permissions-utils";

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
}): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/users");

  const parseResult = adjustBalanceSchema.safeParse(data);
  if (!parseResult.success) {
    return { success: false, error: parseResult.error.issues[0]?.message ?? "Invalid input" };
  }
  const parsed = parseResult.data;

  // Admins can always adjust; non-admins need the __can_adjust_balance capability
  if (session.role !== "admin") {
    const perms = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { allowed_pages: true },
    });
    if (!perms || !canUserAdjustBalance(perms.allowed_pages)) {
      return { success: false, error: "You do not have permission to adjust balances" };
    }
  }

  try {
    await require2FA(session.userId, data.totpCode);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "2FA verification failed" };
  }

  try {
    await checkBalanceAdjustmentLimit(session.userId, parsed.amount);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Balance limit exceeded" };
  }

  const balances = await db.balances.findUnique({
    where: { user_id: parsed.userId },
  });
  if (!balances) return { success: false, error: "User balances not found" };

  const currentBalance = Number(balances.available_balance);
  const newBalance = currentBalance + parsed.amount;
  if (newBalance < 0) {
    return { success: false, error: "Resulting balance would be negative" };
  }

  try {
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
  } catch (err) {
    console.error("[adjustBalance] Transaction failed:", err);
    return { success: false, error: "Balance adjustment failed — please try again" };
  }

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
        }).catch((err) => {
          console.error(
            `[balance_fill_webhook] dispatch failed for ${webhook.url}:`,
            err instanceof Error ? err.message : err
          );
        });
      }
    })
    .catch((err) => {
      console.error(
        "[balance_fill_webhook] webhook query failed:",
        err instanceof Error ? err.message : err
      );
    });

  revalidatePath(`/users/${parsed.userId}`);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Manual withdrawal — admin records an off-platform payout
// ---------------------------------------------------------------------------
//
// Use case: admin paid a user out via crypto / bank / card / etc. outside the
// normal `card_withdrawal_requests` flow. Without this action the on-site
// balance still says the user has the money, so the P&L formula
//
//   pnl = deposits − withdrawals − onSiteBalance − inventoryValue − vouchers
//
// would treat that money as still-owed to the user → P&L undercounts house
// gains and the dashboard "Liabilities" / per-user PnL tile is wrong.
//
// What this action does atomically:
//   1. Decrements `available_balance` by the payout amount (the user no
//      longer has it on-site — they got paid).
//   2. Increments `total_withdrawn` by the payout amount (so the P&L
//      `withdrawals` term picks it up via balances.total_withdrawn).
//   3. Writes a `ledger_transactions` row with a negative amount + a
//      "Manual withdrawal:" description prefix, so the user's transaction
//      history shows it. We use the existing `admin_balance_adjustment`
//      type so we don't need a schema migration; the description prefix
//      + audit event are how we identify these later.
//   4. Audit-logs `manual_withdrawal_recorded` with the amount + reason.
//
// Gates: requirePageAccess("/users") + (admin OR
// __can_record_manual_withdrawal capability) + 2FA + the same per-admin
// balance limit that gates adjustBalance (manual withdrawals count
// against the cap because they move user money around just like a
// balance adjustment does).
const manualWithdrawalSchema = z.object({
  userId: z.string(),
  amountUsd: z.number().positive("Amount must be positive"),
  reason: z.string().min(1, "Reason is required"),
});

export async function recordManualWithdrawal(data: {
  userId: string;
  amountUsd: number;
  reason: string;
  totpCode: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/users");

  const parseResult = manualWithdrawalSchema.safeParse(data);
  if (!parseResult.success) {
    return {
      success: false,
      error: parseResult.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const parsed = parseResult.data;

  // Admins always pass; non-admins need the dedicated capability.
  if (session.role !== "admin") {
    const perms = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { allowed_pages: true },
    });
    if (
      !perms ||
      !hasCapability(perms.allowed_pages, "__can_record_manual_withdrawal")
    ) {
      return {
        success: false,
        error: "You do not have permission to record manual withdrawals",
      };
    }
  }

  try {
    await require2FA(session.userId, data.totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "2FA verification failed",
    };
  }

  // Same throttle as adjustBalance — a manual withdrawal moves the same
  // dollars and shouldn't bypass the per-admin cap.
  try {
    await checkBalanceAdjustmentLimit(session.userId, parsed.amountUsd);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Balance limit exceeded",
    };
  }

  const balances = await db.balances.findUnique({
    where: { user_id: parsed.userId },
  });
  if (!balances) return { success: false, error: "User balances not found" };

  const currentBalance = Number(balances.available_balance);

  // Two flavors of manual withdrawal, and we support both:
  //
  //   1. Live payout — user has the money on-site. We deduct from
  //      `available_balance` AND bump `total_withdrawn`. The
  //      `ledger_transactions` row reflects the actual balance delta
  //      (so the invariant `amount = balance_after - balance_before`
  //      holds). Mirrors a normal withdrawal, just outside the
  //      card_withdrawal_requests flow.
  //
  //   2. Backfill / P&L correction — user already received the
  //      money off-platform AND their on-site balance is gone (zero
  //      or smaller than the payout). We deduct whatever is there
  //      (could be 0) and bump `total_withdrawn` by the FULL recorded
  //      amount so the canonical P&L formula
  //          pnl = deposits − withdrawals − onSiteBalance − inv − vouch
  //      counts the payout. The "phantom" portion (amount minus what
  //      was actually deducted) is recorded in the audit event and
  //      called out in the ledger description so the discrepancy is
  //      auditable.
  //
  // We never let `available_balance` go negative — that would
  // misrepresent the user's debt-vs-credit relationship with the
  // platform and break wager-balance checks elsewhere.
  const balanceDeducted = Math.min(currentBalance, parsed.amountUsd);
  const newBalance = currentBalance - balanceDeducted;
  const newTotalWithdrawn =
    Number(balances.total_withdrawn) + parsed.amountUsd;
  const phantomPortion = parsed.amountUsd - balanceDeducted;

  try {
    await db.$transaction([
      db.balances.update({
        where: { user_id: parsed.userId },
        data: {
          available_balance: newBalance,
          total_withdrawn: newTotalWithdrawn,
        },
      }),
      // Only write a ledger row when something was actually deducted
      // from on-site balance. A pure-record case (balance was 0,
      // payout fully phantom) gets recorded via the audit event and
      // total_withdrawn — writing a ledger row with amount=0 would
      // pollute transaction listings without conveying anything.
      ...(balanceDeducted > 0
        ? [
            db.ledger_transactions.create({
              data: {
                id: crypto.randomUUID(),
                user_id: parsed.userId,
                // Reuse the existing type — we don't have schema-write
                // access on the main DB; the "Manual withdrawal:"
                // prefix + audit event keep these distinguishable.
                type: "admin_balance_adjustment",
                amount: -balanceDeducted,
                balance_before: currentBalance,
                balance_after: newBalance,
                description:
                  phantomPortion > 0
                    ? `Manual withdrawal: ${parsed.reason} (total $${parsed.amountUsd.toFixed(2)}, $${balanceDeducted.toFixed(2)} from on-site)`
                    : `Manual withdrawal: ${parsed.reason}`,
                status: "completed",
              },
            }),
          ]
        : []),
    ]);
  } catch (err) {
    console.error("[recordManualWithdrawal] Transaction failed:", err);
    return {
      success: false,
      error: "Failed to record manual withdrawal — please try again",
    };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "manual_withdrawal_recorded",
    targetUserId: parsed.userId,
    metadata: {
      amountUsd: parsed.amountUsd,
      reason: parsed.reason,
      balanceDeducted,
      phantomPortion,
      onSiteBalanceBefore: currentBalance,
    },
  });

  revalidatePath(`/users/${parsed.userId}`);
  return { success: true };
}

export async function changeRole(userId: string, newRole: string, totpCode: string) {
  const db = await getDb();
  // Role changes remain admin-only (+ 2FA). The capability check is kept as
  // defence-in-depth so `__can_change_user_roles` is catalogued; admins pass
  // automatically.
  const session = await requireAdmin();
  await requireCapability(session, "__can_change_user_roles", "change user roles");

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

/**
 * Force-demote a creator back to "user" via BOTH the backend's demote
 * endpoint AND a direct DB write. Solves the bug where the /users/[id]
 * "Reset to User Role" escape hatch only flipped `user.role` locally —
 * leaving every backend-managed side effect of the original promote
 * (creator-deal balance fills, cached aggregations, creator session
 * state, etc.) intact. The result was: user shows up as "user" again,
 * but their previous creator-period numbers never came back to the
 * dashboard P&L because the promote-time mutations were never undone.
 *
 * Order:
 *   1) Best-effort `creatorsApi.demote()` — backend cleans up its
 *      state. Errors are caught + logged but do not abort the flow,
 *      because the whole reason this escape hatch exists is for the
 *      case where the backend silently no-ops.
 *   2) Always run the direct `user.role = 'user'` write so the role
 *      is GUARANTEED flipped even if the backend was unreachable.
 *   3) Audit-log both attempts so the trail is honest about what
 *      ran vs failed.
 */
export async function forceResetCreatorToUser(
  userId: string,
  totpCode: string,
): Promise<
  | { success: true; backendDemoted: boolean; backendError: string | null }
  | { success: false; error: string }
> {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_change_user_roles", "change user roles");
  await require2FA(session.userId, totpCode);

  // Step 1: best-effort backend demote. Capture the error but don't
  // surface it as a hard failure — the local role flip below is the
  // user-visible "did the role change" signal, and it always runs.
  let backendDemoted = false;
  let backendError: string | null = null;
  try {
    await creatorsApi.demote(userId);
    backendDemoted = true;
  } catch (err) {
    if (err instanceof BackendApiError) {
      backendError = err.code ? `${err.message} (${err.code})` : err.message;
    } else if (err instanceof Error) {
      backendError = err.message;
    } else {
      backendError = "Unknown backend error";
    }
  }

  // Step 2: local role flip. Always runs.
  await db.user.update({
    where: { id: userId },
    data: { role: "user" as user_role },
  });

  // Step 3: single audit row capturing both attempts.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_force_reset_to_user",
    targetUserId: userId,
    metadata: {
      backend_demoted: backendDemoted,
      backend_error: backendError,
      via: "users_detail_escape_hatch",
    },
  });

  revalidatePath(`/users/${userId}`);
  revalidatePath("/creators");
  return { success: true, backendDemoted, backendError };
}

export async function updateUserIdentity(
  userId: string,
  data: {
    email?: string;
    username?: string;
    displayUsername?: string;
  },
): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_edit_identity", "edit user identity");

  const updateData: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = {};

  if (data.email !== undefined) {
    const email = data.email.trim().toLowerCase();
    if (!email) return { success: false, error: "Email cannot be empty" };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, error: "Invalid email format" };
    }
    // Check uniqueness
    const existing = await db.user.findFirst({
      where: { email, id: { not: userId } },
      select: { id: true },
    });
    if (existing) return { success: false, error: "Email is already in use" };
    updateData.email = email;
    updateData.email_verified = true;
    metadata.email = email;
  }

  if (data.username !== undefined) {
    const username = data.username.trim();
    if (!username) return { success: false, error: "Username cannot be empty" };
    if (username.length < 3 || username.length > 20) {
      return { success: false, error: "Username must be 3–20 characters" };
    }
    // Check uniqueness
    const existing = await db.user.findFirst({
      where: { username, id: { not: userId } },
      select: { id: true },
    });
    if (existing) return { success: false, error: "Username is already taken" };
    updateData.username = username;
    metadata.username = username;
  }

  if (data.displayUsername !== undefined) {
    const displayUsername = data.displayUsername.trim() || null;
    updateData.display_username = displayUsername;
    metadata.display_username = displayUsername;
  }

  if (Object.keys(updateData).length === 0) {
    return { success: false, error: "Nothing to update" };
  }

  updateData.updated_at = new Date();

  try {
    await db.user.update({
      where: { id: userId },
      data: updateData,
    });
  } catch (err) {
    console.error("[updateUserIdentity] DB update failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: `Update failed: ${message}` };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_identity_updated",
    targetUserId: userId,
    metadata,
  });

  revalidatePath(`/users/${userId}`);
  revalidatePath("/users");
  return { success: true };
}

export async function toggleFeatureLock(
  userId: string,
  feature: string,
  locked: boolean
) {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_toggle_feature_locks", "toggle feature locks");

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
  const db = await getDb();
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
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_update_user_withdrawal_limits", "update user withdrawal limits");
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
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_assign_affiliate", "assign affiliate codes");

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
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_assign_affiliate", "create affiliate codes");
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
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_adjust_xp", "adjust user XP");
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

// ---------------------------------------------------------------------------
// Wipe Account Data — Alt Account Cleanup
// ---------------------------------------------------------------------------
// Permanently deletes ALL user activity data while keeping the User row and
// account (OAuth) rows intact. Designed for alt account cleanup where the
// admin wants to nuke everything so the alt cannot benefit from existing
// data. Ledger transactions are included in the wipe.
//
// Deletion order is dictated by FK constraints — see the plan file for the
// full dependency graph. Everything runs inside a single interactive
// $transaction so it's all-or-nothing.
// ---------------------------------------------------------------------------

export async function wipeUserAccount(
  userId: string,
  totpCode: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_wipe_accounts", "wipe user account data");

  // 2FA gate — verify the calling admin's TOTP code BEFORE doing anything
  // destructive. Mirrors the pattern used by deleteUser / changeRole.
  try {
    await require2FA(session.userId, totpCode);
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Invalid 2FA code",
    };
  }

  // Verify the user exists
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, email: true },
  });
  if (!user) return { success: false, error: "User not found" };

  // Audit BEFORE the wipe — if the transaction fails, the attempt is still logged
  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "user_account_wiped",
      targetUserId: userId,
      metadata: { username: user.username, email: user.email },
    });
  } catch (err) {
    console.error("[wipeUserAccount] Failed to create audit event:", err);
    return { success: false, error: "Failed to create audit event" };
  }

  try {
    await db.$transaction(async (tx) => {
      // ── Phase 1: Null out references in shared/other-user tables ──────
      await tx.raffles.updateMany({
        where: { winner_user_id: userId },
        data: { winner_user_id: null },
      });
      await tx.rains.updateMany({
        where: { winner_user_id: userId },
        data: { winner_user_id: null },
      });
      await tx.gift_cards.updateMany({
        where: { redeemed_by_user_id: userId },
        data: { redeemed_by_user_id: null, ledger_tx_id: null },
      });
      await tx.audit_events.updateMany({
        where: { user_id: userId },
        data: { user_id: null },
      });
      await tx.fingerprints.updateMany({
        where: { user_id: userId },
        data: { user_id: null },
      });
      await tx.chat_messages.updateMany({
        where: { deleted_by: userId },
        data: { deleted_by: null },
      });
      // card_withdrawal_requests — null out admin actor refs
      await tx.card_withdrawal_requests.updateMany({
        where: { confirmed_by: userId },
        data: { confirmed_by: null },
      });
      await tx.card_withdrawal_requests.updateMany({
        where: { processed_by: userId },
        data: { processed_by: null },
      });
      await tx.card_withdrawal_requests.updateMany({
        where: { shipped_by: userId },
        data: { shipped_by: null },
      });
      // user_feature_locks — null out admin actor refs on OTHER users' locks
      await tx.user_feature_locks.updateMany({
        where: { locked_deposits_by: userId },
        data: { locked_deposits_by: null },
      });
      await tx.user_feature_locks.updateMany({
        where: { locked_exchanges_by: userId },
        data: { locked_exchanges_by: null },
      });
      await tx.user_feature_locks.updateMany({
        where: { locked_inventory_sales_by: userId },
        data: { locked_inventory_sales_by: null },
      });
      await tx.user_feature_locks.updateMany({
        where: { locked_openings_by: userId },
        data: { locked_openings_by: null },
      });
      await tx.user_feature_locks.updateMany({
        where: { locked_vault_by: userId },
        data: { locked_vault_by: null },
      });
      await tx.user_feature_locks.updateMany({
        where: { locked_withdrawals_by: userId },
        data: { locked_withdrawals_by: null },
      });
      await tx.user_mutes.updateMany({
        where: { unmuted_by: userId },
        data: { unmuted_by: null },
      });

      // ── Phase 2: Delete leaf tables (reference other user tables) ─────
      await tx.provably_fair_results.deleteMany({
        where: {
          OR: [
            { game_sessions: { user_id: userId } },
            { battles: { user_id: userId } },
            { user_inventory: { user_id: userId } },
          ],
        },
      });
      await tx.battle_participants.deleteMany({
        where: {
          OR: [
            { user_id: userId },
            { battles: { user_id: userId } },
          ],
        },
      });
      await tx.affiliate_code_usages.deleteMany({
        where: {
          OR: [
            { affiliate_user_id: userId },
            { referred_user_id: userId },
          ],
        },
      });
      await tx.race_claims.deleteMany({ where: { user_id: userId } });
      await tx.rakeback_claims.deleteMany({ where: { user_id: userId } });
      await tx.promo_code_redemptions.deleteMany({ where: { user_id: userId } });
      await tx.pinned_chat_messages.deleteMany({ where: { pinned_by: userId } });

      // ── Phase 3: Zero balances + clear ledger FK, then delete game_sessions
      // Balances row is KEPT (zeroed) — deleting it would break the backend
      // ("Balance not found" errors). We null out last_transaction_id first
      // so the ledger_transactions delete in Phase 4 doesn't hit FK constraints.
      await tx.balances.updateMany({
        where: { user_id: userId },
        data: {
          available_balance: 0,
          locked_balance: 0,
          total_deposited: 0,
          total_withdrawn: 0,
          total_wagered: 0,
          total_won: 0,
          bonus_points: 0,
          last_transaction_id: null,
          unlock_at: null,
          version: 1,
          updated_at: new Date(),
        },
      });
      await tx.game_sessions.deleteMany({ where: { user_id: userId } });

      // ── Phase 4: Delete ledger_transactions ───────────────────────────
      await tx.ledger_transactions.deleteMany({ where: { user_id: userId } });

      // ── Phase 5: Delete remaining parent tables ───────────────────────
      // Vaults + deposit_addresses are KEPT (crypto infra must survive).
      await tx.battles.deleteMany({ where: { user_id: userId } });
      await tx.user_inventory.deleteMany({ where: { user_id: userId } });
      await tx.chat_messages.deleteMany({ where: { user_id: userId } });

      // ── Phase 6: Delete all standalone tables ─────────────────────────
      await tx.raffle_entries.deleteMany({ where: { user_id: userId } });
      await tx.rain_entries.deleteMany({ where: { user_id: userId } });
      await tx.rain_tips.deleteMany({ where: { user_id: userId } });
      await tx.user_rewards.deleteMany({ where: { user_id: userId } });
      await tx.wager_period_snapshots.deleteMany({ where: { user_id: userId } });
      await tx.race_leaderboard_snapshots.deleteMany({ where: { user_id: userId } });
      // user_statistics — KEPT (zeroed) to avoid "stats not found" errors
      await tx.user_statistics.updateMany({
        where: { user_id: userId },
        data: {
          opened_packs_count: 0,
          battles_played: 0,
          xp: 0,
          level: 0,
          current_day_wagered_usd: 0,
          current_week_wagered_usd: 0,
          current_month_wagered_usd: 0,
          last_wagered_at: null,
          weekly_wager_count: 0,
          updated_at: new Date(),
        },
      });
      await tx.pack_favorites.deleteMany({ where: { user_id: userId } });
      await tx.seed_rotation_history.deleteMany({ where: { user_id: userId } });
      await tx.user_packs.deleteMany({ where: { user_id: userId } });
      await tx.user_mutes.deleteMany({
        where: { OR: [{ user_id: userId }, { muted_by: userId }] },
      });
      // user_feature_locks (user's own) — KEPT per admin request
      await tx.card_withdrawal_requests.deleteMany({ where: { user_id: userId } });
      await tx.shipping_addresses.deleteMany({ where: { user_id: userId } });
      // deposit_addresses — KEPT (crypto infra)
      await tx.vouchers.deleteMany({ where: { user_id: userId } });
      await tx.affiliate_accounts.deleteMany({ where: { user_id: userId } });
      await tx.affiliate_codes.deleteMany({ where: { user_id: userId } });
      await tx.affiliate_code_queue.deleteMany({ where: { user_id: userId } });
      await tx.affiliate_payouts.deleteMany({ where: { affiliate_user_id: userId } });
      await tx.session.deleteMany({ where: { userId } });
      // two_factor + active_seeds — KEPT (auth/provably-fair infra)
      await tx.creator_withdrawal_limits.deleteMany({ where: { user_id: userId } });

      // ── Phase 7: Reset User row ──────────────────────────────────────
      await tx.user.update({
        where: { id: userId },
        data: {
          affiliate_code: null,
          affiliate_code_expires_at: null,
          affiliate_code_active: false,
          affiliate_bonus_opted_in: false,
          referred_by: null,
          is_locked: false,
          locked_reason: null,
          locked_at: null,
          locked_until: null,
          locked_by: null,
          is_banned: false,
          banned_reason: null,
          banned_at: null,
          banned_by: null,
          is_suspected_alt: false,
          suspected_alt_at: null,
          updated_at: new Date(),
        },
      });
    }, { timeout: 60_000 });
  } catch (err) {
    console.error("[wipeUserAccount] Transaction failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: `Wipe failed: ${message}` };
  }

  revalidatePath(`/users/${userId}`);
  revalidatePath("/users");
  return { success: true };
}
