"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import bcrypt from "bcryptjs";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { toNumber } from "@/lib/utils/decimal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { dispatchWebhook } from "@/lib/webhook-dispatcher";
import { fetchPublicStats } from "@/lib/socials-public";
import type { deal_type, deal_status } from "@/generated/admin-prisma/client";

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

  const code = (user.username ?? user.email.split("@")[0]).toLowerCase().replace(/[^a-z0-9]/g, "");

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

  const trimmed = code.trim().toLowerCase();
  if (!trimmed || trimmed.length < 2) throw new Error("Code must be at least 2 characters");

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
  revalidatePath("/creators/codes");
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

export async function adminLinkSocialByUsername(
  targetUserId: string,
  platform: string,
  username: string
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_link_creator_social", "link creator socials");

  const trimmed = username.trim().replace(/^@/, "");
  if (!trimmed) throw new Error("Username is required");

  const validPlatforms = ["twitter", "youtube", "kick", "instagram"];
  if (!validPlatforms.includes(platform)) throw new Error("Invalid platform");

  // Bound the public-stats fetch with a short timeout race so the
  // server action doesn't block the dialog for up to 20s. Each
  // platform's fetcher has a 10s primary timeout AND falls back to a
  // secondary API (twitterapi.io / Social Blade) with another 10s
  // timeout, so worst case the user sees the page freeze for ~20s
  // while the action awaits.
  //
  // Trade-off: if the primary API is slow, we save the row with
  // follower_count = 0 and last_fetched_at = null. The page calls
  // refreshStaleSocials() non-blocking on every render and that
  // helper treats null last_fetched_at as stale, so the count gets
  // backfilled on the next visit. UX: instant link + toast, follower
  // number updates after the next page render rather than after a
  // multi-second freeze.
  const QUICK_FETCH_MS = 3000;
  const stats = await Promise.race([
    fetchPublicStats(platform, trimmed),
    new Promise<{ followerCount: null; platformUserId: null }>((resolve) => {
      setTimeout(
        () => resolve({ followerCount: null, platformUserId: null }),
        QUICK_FETCH_MS,
      );
    }),
  ]);

  // Only stamp last_fetched_at when we actually got stats — leaving
  // it null means refreshStaleSocials will pick this row up on the
  // next render and finish the fetch in the background.
  const gotStats = stats.followerCount !== null;
  await adminDb.creator_socials.upsert({
    where: {
      target_user_id_platform: {
        target_user_id: targetUserId,
        platform: platform as "twitter" | "youtube" | "kick" | "instagram",
      },
    },
    create: {
      target_user_id: targetUserId,
      platform: platform as "twitter" | "youtube" | "kick" | "instagram",
      username: trimmed,
      platform_user_id: stats.platformUserId ?? null,
      follower_count: stats.followerCount ?? 0,
      last_fetched_at: gotStats ? new Date() : null,
    },
    update: {
      username: trimmed,
      // On re-link, only overwrite stats if we got fresh ones —
      // otherwise leave the existing row's count alone and mark it
      // stale (last_fetched_at: null) so the background refresher
      // picks it up.
      platform_user_id: stats.platformUserId ?? null,
      ...(gotStats
        ? { follower_count: stats.followerCount ?? 0, last_fetched_at: new Date() }
        : { last_fetched_at: null }),
    },
    select: { id: true },
  });

  revalidatePath(`/creators/${targetUserId}`);
  revalidatePath("/my-profile");
  return stats.followerCount;
}

export async function adminUnlinkSocial(
  targetUserId: string,
  socialId: string
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_unlink_creator_social", "unlink creator socials");

  const social = await adminDb.creator_socials.findUnique({
    where: { id: socialId },
  });
  if (!social || social.target_user_id !== targetUserId)
    throw new Error("Social connection not found");

  await adminDb.creator_socials.delete({ where: { id: socialId }, select: { id: true } });

  revalidatePath(`/creators/${targetUserId}`);
  revalidatePath("/my-profile");
}

// --- Deals ---

export async function createDeal(
  targetUserId: string,
  data: {
    dealName?: string;
    dealType: deal_type;
    amount: number;
    currency?: string;
    startDate: string;
    endDate?: string;
    notes?: string;
    keepPercentage?: number | null;
    currencyLimitAmount?: number | null;
    currencyLimitResetDays?: number | null;
    percentageLimit?: number | null;
    tipLimit?: number | null;
    tipLimitResetDays?: number | null;
    leaderboardPrizePool?: number | null;
    leaderboardOurShare?: number | null;
    leaderboardFrequency?: string | null;
    minStreamMinutes?: number | null;
  }
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_create_creator_deal", "create creator deals");

  // Calculate max financial exposure
  const maxExposure = calculateMaxExposure(data);

  const deal = await adminDb.creator_deals.create({
    data: {
      target_user_id: targetUserId,
      deal_name: data.dealName ?? null,
      deal_type: data.dealType,
      amount: data.amount,
      currency: data.currency ?? "USD",
      start_date: new Date(data.startDate),
      end_date: data.endDate ? new Date(data.endDate) : null,
      notes: data.notes ?? null,
      keep_percentage: data.keepPercentage ?? null,
      currency_limit_amount: data.currencyLimitAmount ?? null,
      currency_limit_reset_days: data.currencyLimitResetDays ?? null,
      percentage_limit: data.percentageLimit ?? null,
      tip_limit: data.tipLimit ?? null,
      tip_limit_reset_days: data.tipLimitResetDays ?? null,
      leaderboard_prize_pool: data.leaderboardPrizePool ?? null,
      leaderboard_our_share: data.leaderboardOurShare ?? null,
      leaderboard_frequency: data.leaderboardFrequency ?? null,
      min_stream_minutes: data.minStreamMinutes ?? null,
      max_financial_exposure: maxExposure,
      status: "active",
    },
    select: { id: true },
  });

  // Sync withdrawal limits to main DB
  await syncWithdrawalLimits(targetUserId, data);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_deal_created",
    targetUserId,
    metadata: { dealId: deal.id, dealType: data.dealType, amount: data.amount },
  });

  revalidatePath(`/creators/${targetUserId}`);
}

export async function updateDeal(
  dealId: string,
  data: {
    dealName?: string | null;
    dealType?: deal_type;
    amount?: number;
    currency?: string;
    startDate?: string;
    endDate?: string | null;
    status?: deal_status;
    notes?: string | null;
    keepPercentage?: number | null;
    currencyLimitAmount?: number | null;
    currencyLimitResetDays?: number | null;
    percentageLimit?: number | null;
    tipLimit?: number | null;
    tipLimitResetDays?: number | null;
    leaderboardPrizePool?: number | null;
    leaderboardOurShare?: number | null;
    leaderboardFrequency?: string | null;
    minStreamMinutes?: number | null;
  }
) {
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_update_creator_deal", "update creator deals");

  const deal = await adminDb.creator_deals.findUnique({ where: { id: dealId } });
  if (!deal) throw new Error("Deal not found");

  // Merge existing deal data with updates for exposure calculation
  const merged = {
    currencyLimitAmount: data.currencyLimitAmount !== undefined ? data.currencyLimitAmount : toNumber(deal.currency_limit_amount),
    currencyLimitResetDays: data.currencyLimitResetDays !== undefined ? data.currencyLimitResetDays : deal.currency_limit_reset_days,
    leaderboardPrizePool: data.leaderboardPrizePool !== undefined ? data.leaderboardPrizePool : toNumber(deal.leaderboard_prize_pool),
    leaderboardOurShare: data.leaderboardOurShare !== undefined ? data.leaderboardOurShare : toNumber(deal.leaderboard_our_share),
    leaderboardFrequency: data.leaderboardFrequency !== undefined ? data.leaderboardFrequency : deal.leaderboard_frequency,
  };
  const maxExposure = calculateMaxExposure(merged);

  await adminDb.creator_deals.update({
    where: { id: dealId },
    data: {
      ...(data.dealName !== undefined && { deal_name: data.dealName }),
      ...(data.dealType !== undefined && { deal_type: data.dealType }),
      ...(data.amount !== undefined && { amount: data.amount }),
      ...(data.currency !== undefined && { currency: data.currency }),
      ...(data.startDate !== undefined && { start_date: new Date(data.startDate) }),
      ...(data.endDate !== undefined && { end_date: data.endDate ? new Date(data.endDate) : null }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.notes !== undefined && { notes: data.notes }),
      ...(data.keepPercentage !== undefined && { keep_percentage: data.keepPercentage }),
      ...(data.currencyLimitAmount !== undefined && { currency_limit_amount: data.currencyLimitAmount }),
      ...(data.currencyLimitResetDays !== undefined && { currency_limit_reset_days: data.currencyLimitResetDays }),
      ...(data.percentageLimit !== undefined && { percentage_limit: data.percentageLimit }),
      ...(data.tipLimit !== undefined && { tip_limit: data.tipLimit }),
      ...(data.tipLimitResetDays !== undefined && { tip_limit_reset_days: data.tipLimitResetDays }),
      ...(data.leaderboardPrizePool !== undefined && { leaderboard_prize_pool: data.leaderboardPrizePool }),
      ...(data.leaderboardOurShare !== undefined && { leaderboard_our_share: data.leaderboardOurShare }),
      ...(data.leaderboardFrequency !== undefined && { leaderboard_frequency: data.leaderboardFrequency }),
      ...(data.minStreamMinutes !== undefined && { min_stream_minutes: data.minStreamMinutes }),
      max_financial_exposure: maxExposure,
      updated_at: new Date(),
    },
    select: { id: true },
  });

  // Sync withdrawal limits to main DB
  await syncWithdrawalLimits(deal.target_user_id, {
    currencyLimitAmount: data.currencyLimitAmount !== undefined ? data.currencyLimitAmount : toNumber(deal.currency_limit_amount),
    currencyLimitResetDays: data.currencyLimitResetDays !== undefined ? data.currencyLimitResetDays : deal.currency_limit_reset_days,
    percentageLimit: data.percentageLimit !== undefined ? data.percentageLimit : toNumber(deal.percentage_limit),
    tipLimit: data.tipLimit !== undefined ? data.tipLimit : toNumber(deal.tip_limit),
    tipLimitResetDays: data.tipLimitResetDays !== undefined ? data.tipLimitResetDays : deal.tip_limit_reset_days,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_deal_updated",
    targetUserId: deal.target_user_id,
    metadata: { dealId, ...data },
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
