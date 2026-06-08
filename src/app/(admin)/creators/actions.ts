"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { toNumber } from "@/lib/utils/decimal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { dispatchWebhook } from "@/lib/webhook-dispatcher";
import type { deal_type, deal_status } from "@/generated/admin-prisma/client";

// ── Schemas ─────────────────────────────────────────────────────────

// Affiliate codes live in URL paths and chat mentions — restrict to
// lowercase alphanumeric + `_` + `-` to keep them safe everywhere.
const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(32)
  .regex(/^[A-Z0-9_-]+$/, "Code must be alphanumeric, _ or -");

// Reusable USD-amount validator. Caps at 10M to catch typos.
const optionalDollarAmount = z
  .number()
  .finite()
  .nonnegative()
  .max(10_000_000)
  .nullable()
  .optional();

const requiredDollarAmount = z
  .number()
  .finite()
  .nonnegative()
  .multipleOf(0.01)
  .max(10_000_000);

// 0–100 percent, NOT 0–1. Admins type "20" not "0.2".
const optionalPercent = z
  .number()
  .finite()
  .nonnegative()
  .max(100)
  .nullable()
  .optional();

// Reset-window in days. 3650 = ~10 years, plenty of headroom.
const optionalResetDays = z
  .number()
  .int()
  .nonnegative()
  .max(3650)
  .nullable()
  .optional();

// Used for min-stream-minutes etc.
const optionalCount = z
  .number()
  .int()
  .nonnegative()
  .max(1_000_000)
  .nullable()
  .optional();

const dealTypeSchema = z.enum([
  "flat_fee",
  "rev_share",
  "hybrid",
  "custom",
] as const satisfies readonly deal_type[]);

const dealStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "cancelled",
] as const satisfies readonly deal_status[]);

const createDealSchema = z.object({
  dealName: z.string().trim().max(120).optional(),
  dealType: dealTypeSchema,
  amount: requiredDollarAmount,
  currency: z.string().trim().min(1).max(8).optional(),
  startDate: z.string().min(1, "Start date is required"),
  endDate: z.string().optional(),
  notes: z.string().max(2000).optional(),
  keepPercentage: optionalPercent,
  currencyLimitAmount: optionalDollarAmount,
  currencyLimitResetDays: optionalResetDays,
  percentageLimit: optionalPercent,
  tipLimit: optionalDollarAmount,
  tipLimitResetDays: optionalResetDays,
  leaderboardPrizePool: optionalDollarAmount,
  leaderboardOurShare: optionalPercent,
  leaderboardFrequency: z.string().trim().max(32).nullable().optional(),
  minStreamMinutes: optionalCount,
});

const updateDealSchema = z.object({
  dealName: z.string().trim().max(120).nullable().optional(),
  dealType: dealTypeSchema.optional(),
  amount: requiredDollarAmount.optional(),
  currency: z.string().trim().min(1).max(8).optional(),
  startDate: z.string().min(1).optional(),
  endDate: z.string().nullable().optional(),
  status: dealStatusSchema.optional(),
  notes: z.string().max(2000).nullable().optional(),
  keepPercentage: optionalPercent,
  currencyLimitAmount: optionalDollarAmount,
  currencyLimitResetDays: optionalResetDays,
  percentageLimit: optionalPercent,
  tipLimit: optionalDollarAmount,
  tipLimitResetDays: optionalResetDays,
  leaderboardPrizePool: optionalDollarAmount,
  leaderboardOurShare: optionalPercent,
  leaderboardFrequency: z.string().trim().max(32).nullable().optional(),
  minStreamMinutes: optionalCount,
});

export async function makeCreator(userId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_make_creator", "promote a user to creator");

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { username: true, email: true, role: true },
  });
  if (!user) throw new Error("User not found");
  if (!user.email) throw new Error("User has no email");

  const raw = (user.username ?? user.email.split("@")[0]).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const code = raw.length >= 2 ? raw : raw + Math.random().toString(36).toUpperCase().slice(2, 2 + (2 - raw.length));

  // Check code uniqueness, append random suffix if needed
  let finalCode = code;
  const existingCode = await db.affiliate_codes.findUnique({ where: { code: finalCode } });
  if (existingCode) {
    finalCode = `${code}${Math.floor(Math.random() * 1000)}`;
  }

  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: { role: "creator", affiliate_code: finalCode, affiliate_code_active: true },
    }),
    db.affiliate_accounts.create({
      data: {
        user_id: userId,
      },
    }),
    db.affiliate_codes.create({
      data: {
        user_id: userId,
        code: finalCode,
      },
    }),
  ]);

  // Create admin_user with role=creator so they can access the admin dashboard
  // Skip if one already exists with the same email
  // Only used for existence check — tiny select avoids P2022 crashes
  // when a later-migration column is missing in prod.
  const existingAdminUser = await adminDb.admin_users.findFirst({
    where: { email: user.email },
    select: { id: true },
  });
  if (!existingAdminUser) {
    const tempPassword = crypto.randomBytes(16).toString("hex");
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const username = user.username ?? user.email.split("@")[0];

    // Same RETURNING * defense — without an explicit select, a new column
    // missing on prod would crash "Make Creator" even though the insert
    // columns themselves are all present.
    await adminDb.admin_users.create({
      data: {
        email: user.email,
        username: `creator_${username}`,
        password_hash: passwordHash,
        role: "creator",
        allowed_pages: ["/my-profile"],
      },
      select: { id: true },
    });
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_made_creator",
    targetUserId: userId,
    metadata: { code: finalCode },
  });

  revalidatePath("/creators");
}

export async function updateAffiliateLevel(userId: string, level: number) {
  const db = await getDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_update_creator_affiliate_level",
    "update creator affiliate level",
  );

  if (level < 1 || level > 8) throw new Error("Invalid level");

  await db.affiliate_accounts.update({
    where: { user_id: userId },
    data: { updated_at: new Date() }, // affiliate_level column doesn't exist in prod
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_level_updated",
    targetUserId: userId,
    metadata: { level },
  });

  revalidatePath(`/creators/${userId}`);
  revalidatePath("/creators");
}

export async function addAffiliateCode(userId: string, code: string) {
  const db = await getDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_assign_affiliate", "create affiliate codes");

  const parsedCode = codeSchema.safeParse(code);
  if (!parsedCode.success) {
    throw new Error(parsedCode.error.issues[0]?.message ?? "Invalid affiliate code");
  }
  const trimmed = parsedCode.data;

  const existing = await db.affiliate_codes.findUnique({ where: { code: trimmed } });
  if (existing) throw new Error("Code already exists");

  // Code ownership lives in affiliate_codes only. user.affiliate_code
  // is the referral cookie this user CARRIES (the code they used at
  // signup), not an "owned-code" pointer — see the schema note in
  // src/lib/queries/creators-detail.ts:58. A previous version of this
  // action also wrote user.affiliate_code = trimmed; that confused the
  // two and caused /users/[id] to show the cookie labeled as the
  // user's own code. Reverted to ONLY insert the affiliate_codes row.
  await db.affiliate_codes.create({
    data: { user_id: userId, code: trimmed },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_added",
    targetUserId: userId,
    metadata: { code: trimmed },
  });

  revalidatePath(`/creators/${userId}`);
  revalidatePath(`/users/${userId}`);
}

export async function removeAffiliateCode(codeId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_assign_affiliate", "remove affiliate codes");

  const code = await db.affiliate_codes.findUnique({ where: { id: codeId } });
  if (!code) throw new Error("Code not found");

  await db.affiliate_codes.delete({ where: { id: codeId } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_removed",
    targetUserId: code.user_id,
    metadata: { code: code.code },
  });

  revalidatePath(`/creators/${code.user_id}`);
}

export async function toggleAffiliateCode(codeId: string, isActive: boolean) {
  const db = await getDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_toggle_creator_code", "toggle creator codes");

  const code = await db.affiliate_codes.findUnique({ where: { id: codeId } });
  if (!code) throw new Error("Code not found");

  await db.affiliate_codes.update({
    where: { id: codeId },
    data: { updated_at: new Date() }, // is_active column doesn't exist in prod
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_toggled",
    targetUserId: code.user_id,
    metadata: { code: code.code, is_active: isActive },
  });

  revalidatePath(`/creators/${code.user_id}`);
}

export async function updateCreatorLimits(
  userId: string,
  limits: {
    currencyLimitAmount?: number | null;
    percentageLimit?: number | null;
    tipLimit?: number | null;
    currencyLimitResetDays?: number | null;
  }
) {
  const db = await getDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_update_creator_limits", "update creator limits");

  await db.creator_withdrawal_limits.upsert({
    where: { user_id: userId },
    create: {
      user_id: userId,
      currency_limit_amount: limits.currencyLimitAmount ?? null,
      percentage_limit: limits.percentageLimit ?? null,
      currency_limit_reset_days: limits.currencyLimitResetDays ?? null,
    },
    update: {
      currency_limit_amount: limits.currencyLimitAmount ?? null,
      percentage_limit: limits.percentageLimit ?? null,
      currency_limit_reset_days: limits.currencyLimitResetDays ?? null,
    },
  });

  // Dispatch webhook when tip limit changes — fire-and-forget so the
  // action can return without waiting on the creator's webhook endpoint.
  if (limits.tipLimit !== undefined) {
    const tipLimit = limits.tipLimit;
    after(() => {
      dispatchWebhook(userId, "deal_data", {
        action: "tip_limit_updated",
        userId,
        tipLimit,
      }).catch(() => {});
    });
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_limits_updated",
    targetUserId: userId,
    metadata: limits,
  });

  revalidatePath(`/creators/${userId}`);
}

export async function processCreatorPayout(affiliateUserId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_approve_creator_payout", "approve creator payouts");

  // Run everything inside a single interactive transaction so we can:
  //   1. Lock the affiliate_accounts row (SELECT ... FOR UPDATE) to prevent
  //      a double-payout race when two parallel calls both see a positive
  //      `available_usd` before either has zeroed it.
  //   2. Write a paired ledger_transactions entry alongside the balance
  //      update — required by the CLAUDE.md rule that every balance change
  //      must go through the ledger for the immutable audit trail.
  const { available } = await db.$transaction(async (tx) => {
    const lockedRows = await tx.$queryRaw<
      { available_usd: string }[]
    >`
      SELECT available_usd::text AS available_usd
      FROM affiliate_accounts
      WHERE user_id = ${affiliateUserId}
      FOR UPDATE
    `;
    if (lockedRows.length === 0) {
      throw new Error("Affiliate account not found");
    }
    const available = Number(lockedRows[0].available_usd);
    if (available <= 0) {
      throw new Error("No available balance to pay out");
    }

    const balance = await tx.balances.findUnique({
      where: { user_id: affiliateUserId },
      select: { available_balance: true },
    });
    if (!balance) {
      throw new Error("User balance not found");
    }
    const balanceBefore = toNumber(balance.available_balance);
    const balanceAfter = balanceBefore + available;

    await tx.affiliate_payouts.create({
      data: {
        id: crypto.randomUUID(),
        affiliate_user_id: affiliateUserId,
        amount_usd: available,
        status: "paid",
      },
    });

    await tx.affiliate_accounts.update({
      where: { user_id: affiliateUserId },
      data: {
        available_usd: 0,
        total_paid_out_usd: { increment: available },
        last_payout_at: new Date(),
      },
    });

    await tx.balances.update({
      where: { user_id: affiliateUserId },
      data: { available_balance: balanceAfter },
    });

    await tx.ledger_transactions.create({
      data: {
        user_id: affiliateUserId,
        type: "affiliate_claim",
        amount: available,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        description: "Creator payout",
        status: "completed",
      },
    });

    return { available };
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_payout_processed",
    targetUserId: affiliateUserId,
    metadata: { amount_usd: available },
  });

  revalidatePath("/creators");
  revalidatePath(`/creators/${affiliateUserId}`);
}

export async function updateLevelConfig(
  level: number,
  data: { label?: string; commissionRate?: number; threshold?: number }
) {
  const db = await getDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_update_creator_level_config",
    "update creator level config",
  );

  const updateData: Record<string, unknown> = {};
  if (data.label !== undefined) updateData.label = data.label;
  if (data.commissionRate !== undefined) updateData.commission_rate = data.commissionRate;
  if (data.threshold !== undefined) updateData.threshold = data.threshold;

  await db.affiliate_level_configs.upsert({
    where: { level },
    create: {
      level,
      label: data.label ?? `Level ${level}`,
      commission_rate: data.commissionRate ?? 0,
      threshold: data.threshold ?? 0,
    },
    update: updateData,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_level_config_updated",
    metadata: { level, ...data },
  });

  revalidatePath("/creators/settings");
}

/**
 * Update the global affiliate-cut expiration — how many days after a user
 * is referred should their affiliate keep earning commission. Stored as
 * site_config.affiliate_cut_expiration_days (string, integer). Empty /
 * null / 0 means "never expire" — the backend applies commission for
 * the user's lifetime.
 *
 * Returns errors as values so the client toast shows real messages
 * instead of the RSC production mask.
 */
export async function updateAffiliateCutExpiration(
  days: number | null,
): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_update_creator_cut_expiration",
    "update creator cut expiration",
  );

  if (days !== null && (!Number.isFinite(days) || days < 0)) {
    return { success: false, error: "Days must be a non-negative number" };
  }
  if (days !== null && days > 3650) {
    return { success: false, error: "Days must be 3650 or fewer (~10 years)" };
  }

  const value = days === null || days === 0 ? "" : String(Math.floor(days));

  try {
    await db.site_config.upsert({
      where: { key: "affiliate_cut_expiration_days" },
      update: { value },
      create: {
        key: "affiliate_cut_expiration_days",
        value,
        description:
          "How many days after a user signs up via an affiliate code the affiliate keeps earning commission on that user. Empty / 0 = no expiration (lifetime).",
      },
    });
  } catch (err) {
    console.error("[updateAffiliateCutExpiration] DB write failed:", err);
    const message = err instanceof Error ? err.message : "Unknown DB error";
    return { success: false, error: `Failed to update: ${message}` };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_cut_expiration_updated",
    metadata: { days },
  });

  revalidatePath("/creators/settings");
  return { success: true };
}

export async function toggleCodeActive(userId: string, isActive: boolean) {
  const db = await getDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_toggle_creator_code", "toggle creator codes");

  await db.user.update({
    where: { id: userId },
    data: { affiliate_code_active: isActive },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_global_toggle",
    targetUserId: userId,
    metadata: { is_active: isActive },
  });

  revalidatePath(`/creators/${userId}`);
  revalidatePath("/creators");
}

// --- Webhooks ---

export async function createWebhook(
  targetUserId: string,
  data: { url: string }
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_create_creator_webhook", "create creator webhooks");

  try {
    new URL(data.url);
  } catch {
    throw new Error("Invalid webhook URL");
  }

  const secret = crypto.randomBytes(32).toString("hex");

  // Explicit select — only the id is consumed downstream, and a default
  // RETURNING * crashes with P2022 when prod is missing a later-migration
  // column the generated client knows about.
  const webhook = await adminDb.creator_webhooks.create({
    data: {
      target_user_id: targetUserId,
      url: data.url,
      secret,
      type: "balance_fill",
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_webhook_created",
    targetUserId,
    metadata: { webhookId: webhook.id },
  });

  revalidatePath(`/creators/${targetUserId}`);
  return { id: webhook.id, secret };
}

export async function updateWebhook(
  webhookId: string,
  data: { url?: string; enabled?: boolean }
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_update_creator_webhook", "update creator webhooks");

  if (data.url) {
    try {
      new URL(data.url);
    } catch {
      throw new Error("Invalid webhook URL");
    }
  }

  const webhook = await adminDb.creator_webhooks.findUnique({ where: { id: webhookId } });
  if (!webhook) throw new Error("Webhook not found");

  await adminDb.creator_webhooks.update({
    where: { id: webhookId },
    data: {
      ...(data.url !== undefined && { url: data.url }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
      updated_at: new Date(),
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_webhook_updated",
    targetUserId: webhook.target_user_id,
    metadata: { webhookId, ...data },
  });

  revalidatePath(`/creators/${webhook.target_user_id}`);
}

export async function deleteWebhook(webhookId: string) {
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_delete_creator_webhook", "delete creator webhooks");

  const webhook = await adminDb.creator_webhooks.findUnique({ where: { id: webhookId } });
  if (!webhook) throw new Error("Webhook not found");

  await adminDb.creator_webhooks.delete({ where: { id: webhookId }, select: { id: true } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_webhook_deleted",
    targetUserId: webhook.target_user_id,
    metadata: { webhookId },
  });

  revalidatePath(`/creators/${webhook.target_user_id}`);
}

export async function testWebhook(webhookId: string) {
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_test_creator_webhook", "test creator webhooks");

  const webhook = await adminDb.creator_webhooks.findUnique({ where: { id: webhookId } });
  if (!webhook) throw new Error("Webhook not found");

  const isDiscord = webhook.url.includes("discord.com/api/webhooks/");

  const payload = isDiscord
    ? JSON.stringify({
        content: `✅ Test webhook from Pack.ygg Admin — type: ${webhook.type}`,
      })
    : JSON.stringify({
        event: "test",
        type: webhook.type,
        timestamp: new Date().toISOString(),
        message: "This is a test webhook from Pack.ygg Admin",
      });

  const signature = crypto
    .createHmac("sha256", webhook.secret)
    .update(payload)
    .digest("hex");

  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
      },
      body: payload,
      signal: AbortSignal.timeout(10000),
    });

    return { success: response.ok, status: response.status };
  } catch (error) {
    return { success: false, status: 0, error: error instanceof Error ? error.message : "Unknown error" };
  }
}

// --- Socials (admin management) ---
//
// Removed 2026-05-07: admin link/unlink for creator socials.
// Creators connect their own accounts via the public site flow now;
// the admin panel only displays the resulting rows in the page header.
// The supporting helpers (fetchPublicStats, refreshStaleSocials) stay
// untouched — they're still used by the background refresher that
// keeps follower counts fresh on the displayed chips.

// --- Deals ---

export async function createDeal(
  targetUserId: string,
  data: z.infer<typeof createDealSchema>
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_create_creator_deal", "create creator deals");

  const parsed = createDealSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid deal input");
  }

  // Calculate max financial exposure
  const maxExposure = calculateMaxExposure(parsed.data);

  const deal = await adminDb.creator_deals.create({
    data: {
      target_user_id: targetUserId,
      deal_name: parsed.data.dealName ?? null,
      deal_type: parsed.data.dealType,
      amount: parsed.data.amount,
      currency: parsed.data.currency ?? "USD",
      start_date: new Date(parsed.data.startDate),
      end_date: parsed.data.endDate ? new Date(parsed.data.endDate) : null,
      notes: parsed.data.notes ?? null,
      keep_percentage: parsed.data.keepPercentage ?? null,
      currency_limit_amount: parsed.data.currencyLimitAmount ?? null,
      currency_limit_reset_days: parsed.data.currencyLimitResetDays ?? null,
      percentage_limit: parsed.data.percentageLimit ?? null,
      tip_limit: parsed.data.tipLimit ?? null,
      tip_limit_reset_days: parsed.data.tipLimitResetDays ?? null,
      leaderboard_prize_pool: parsed.data.leaderboardPrizePool ?? null,
      leaderboard_our_share: parsed.data.leaderboardOurShare ?? null,
      leaderboard_frequency: parsed.data.leaderboardFrequency ?? null,
      min_stream_minutes: parsed.data.minStreamMinutes ?? null,
      max_financial_exposure: maxExposure,
      status: "active",
    },
    select: { id: true },
  });

  // Sync withdrawal limits to main DB
  await syncWithdrawalLimits(targetUserId, parsed.data);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_deal_created",
    targetUserId,
    metadata: { dealId: deal.id, dealType: parsed.data.dealType, amount: parsed.data.amount },
  });

  revalidatePath(`/creators/${targetUserId}`);
}

export async function updateDeal(
  dealId: string,
  data: z.infer<typeof updateDealSchema>
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_update_creator_deal", "update creator deals");

  const parsed = updateDealSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid deal input");
  }
  const v = parsed.data;

  const deal = await adminDb.creator_deals.findUnique({ where: { id: dealId } });
  if (!deal) throw new Error("Deal not found");

  // Merge existing deal data with updates for exposure calculation
  const merged = {
    currencyLimitAmount: v.currencyLimitAmount !== undefined ? v.currencyLimitAmount : toNumber(deal.currency_limit_amount),
    currencyLimitResetDays: v.currencyLimitResetDays !== undefined ? v.currencyLimitResetDays : deal.currency_limit_reset_days,
    leaderboardPrizePool: v.leaderboardPrizePool !== undefined ? v.leaderboardPrizePool : toNumber(deal.leaderboard_prize_pool),
    leaderboardOurShare: v.leaderboardOurShare !== undefined ? v.leaderboardOurShare : toNumber(deal.leaderboard_our_share),
    leaderboardFrequency: v.leaderboardFrequency !== undefined ? v.leaderboardFrequency : deal.leaderboard_frequency,
  };
  const maxExposure = calculateMaxExposure(merged);

  await adminDb.creator_deals.update({
    where: { id: dealId },
    data: {
      ...(v.dealName !== undefined && { deal_name: v.dealName }),
      ...(v.dealType !== undefined && { deal_type: v.dealType }),
      ...(v.amount !== undefined && { amount: v.amount }),
      ...(v.currency !== undefined && { currency: v.currency }),
      ...(v.startDate !== undefined && { start_date: new Date(v.startDate) }),
      ...(v.endDate !== undefined && { end_date: v.endDate ? new Date(v.endDate) : null }),
      ...(v.status !== undefined && { status: v.status }),
      ...(v.notes !== undefined && { notes: v.notes }),
      ...(v.keepPercentage !== undefined && { keep_percentage: v.keepPercentage }),
      ...(v.currencyLimitAmount !== undefined && { currency_limit_amount: v.currencyLimitAmount }),
      ...(v.currencyLimitResetDays !== undefined && { currency_limit_reset_days: v.currencyLimitResetDays }),
      ...(v.percentageLimit !== undefined && { percentage_limit: v.percentageLimit }),
      ...(v.tipLimit !== undefined && { tip_limit: v.tipLimit }),
      ...(v.tipLimitResetDays !== undefined && { tip_limit_reset_days: v.tipLimitResetDays }),
      ...(v.leaderboardPrizePool !== undefined && { leaderboard_prize_pool: v.leaderboardPrizePool }),
      ...(v.leaderboardOurShare !== undefined && { leaderboard_our_share: v.leaderboardOurShare }),
      ...(v.leaderboardFrequency !== undefined && { leaderboard_frequency: v.leaderboardFrequency }),
      ...(v.minStreamMinutes !== undefined && { min_stream_minutes: v.minStreamMinutes }),
      max_financial_exposure: maxExposure,
      updated_at: new Date(),
    },
    select: { id: true },
  });

  // Sync withdrawal limits to main DB
  await syncWithdrawalLimits(deal.target_user_id, {
    currencyLimitAmount: v.currencyLimitAmount !== undefined ? v.currencyLimitAmount : toNumber(deal.currency_limit_amount),
    currencyLimitResetDays: v.currencyLimitResetDays !== undefined ? v.currencyLimitResetDays : deal.currency_limit_reset_days,
    percentageLimit: v.percentageLimit !== undefined ? v.percentageLimit : toNumber(deal.percentage_limit),
    tipLimit: v.tipLimit !== undefined ? v.tipLimit : toNumber(deal.tip_limit),
    tipLimitResetDays: v.tipLimitResetDays !== undefined ? v.tipLimitResetDays : deal.tip_limit_reset_days,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_deal_updated",
    targetUserId: deal.target_user_id,
    metadata: { dealId, ...v },
  });

  revalidatePath(`/creators/${deal.target_user_id}`);
}

async function syncWithdrawalLimits(
  userId: string,
  data: {
    currencyLimitAmount?: number | null;
    currencyLimitResetDays?: number | null;
    percentageLimit?: number | null;
    tipLimit?: number | null;
    tipLimitResetDays?: number | null;
  }
) {
  const db = await getDb();
  await db.creator_withdrawal_limits.upsert({
    where: { user_id: userId },
    create: {
      user_id: userId,
      currency_limit_amount: data.currencyLimitAmount ?? null,
      currency_limit_reset_days: data.currencyLimitResetDays ?? null,
      percentage_limit: data.percentageLimit ?? null,
    },
    update: {
      currency_limit_amount: data.currencyLimitAmount ?? null,
      currency_limit_reset_days: data.currencyLimitResetDays ?? null,
      percentage_limit: data.percentageLimit ?? null,
    },
  });

  // Dispatch webhook when tip limit changes — fire-and-forget.
  if (data.tipLimit !== undefined) {
    const tipLimit = data.tipLimit;
    after(() => {
      dispatchWebhook(userId, "deal_data", {
        action: "tip_limit_updated",
        userId,
        tipLimit,
      }).catch(() => {});
    });
  }
}

function calculateMaxExposure(data: {
  currencyLimitAmount?: number | null;
  currencyLimitResetDays?: number | null;
  leaderboardPrizePool?: number | null;
  leaderboardOurShare?: number | null;
  leaderboardFrequency?: string | null;
}): number | null {
  // Estimate monthly cashout from currency limit + reset days
  const limitAmount = data.currencyLimitAmount ?? null;
  const resetDays = data.currencyLimitResetDays ?? null;
  if (limitAmount === null) return null;
  const monthlyCashout = resetDays ? (limitAmount / resetDays) * 30 : limitAmount;

  const pool = data.leaderboardPrizePool ?? 0;
  const ourShare = data.leaderboardOurShare ?? 0;
  const freqMultiplier = data.leaderboardFrequency === "weekly" ? 4
    : data.leaderboardFrequency === "biweekly" ? 2
    : data.leaderboardFrequency === "monthly" ? 1
    : 0;

  const leaderboardCostPerMonth = pool * ourShare * freqMultiplier;
  return monthlyCashout + leaderboardCostPerMonth;
}

export async function deleteDeal(dealId: string) {
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_delete_creator_deal", "delete creator deals");

  const deal = await adminDb.creator_deals.findUnique({ where: { id: dealId } });
  if (!deal) throw new Error("Deal not found");

  await adminDb.creator_deals.delete({ where: { id: dealId }, select: { id: true } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_deal_deleted",
    targetUserId: deal.target_user_id,
    metadata: { dealId },
  });

  revalidatePath(`/creators/${deal.target_user_id}`);
}
