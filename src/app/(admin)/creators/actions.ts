"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { adminDrizzle } from "@/lib/drizzle";
import {
  admin_users,
  creator_deals,
  creator_webhooks,
} from "@/lib/db-schema/admin/schema";
import {
  affiliate_accounts,
  affiliate_codes,
  affiliate_level_configs,
  affiliate_payouts,
  balances,
  creator_withdrawal_limits,
  ledger_transactions,
  site_config,
  user as mainUsers,
} from "@/lib/db-schema/main/schema";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { toNumber } from "@/lib/utils/decimal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { dispatchWebhook } from "@/lib/webhook-dispatcher";
import { assertSafeWebhookUrl, isSafeWebhookUrl } from "@/lib/security/webhook-url";

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
] as const);

const dealStatusSchema = z.enum([
  "pending",
  "active",
  "completed",
  "cancelled",
] as const);

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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_make_creator", "promote a user to creator");

  const [mainUser] = await db
    .select({
      username: mainUsers.username,
      email: mainUsers.email,
      role: mainUsers.role,
    })
    .from(mainUsers)
    .where(eq(mainUsers.id, userId))
    .limit(1);
  if (!mainUser) throw new Error("User not found");
  if (!mainUser.email) throw new Error("User has no email");

  const raw = (mainUser.username ?? mainUser.email.split("@")[0]).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const code = raw.length >= 2 ? raw : raw + Math.random().toString(36).toUpperCase().slice(2, 2 + (2 - raw.length));

  // Check code uniqueness, append random suffix if needed
  let finalCode = code;
  const [existingCode] = await db
    .select({ id: affiliate_codes.id })
    .from(affiliate_codes)
    .where(eq(affiliate_codes.code, finalCode))
    .limit(1);
  if (existingCode) {
    finalCode = `${code}${Math.floor(Math.random() * 1000)}`;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(mainUsers)
      .set({
        role: "creator",
        affiliate_code: finalCode,
        affiliate_code_active: true,
        updated_at: new Date().toISOString(),
      })
      .where(eq(mainUsers.id, userId));
    await tx.insert(affiliate_accounts).values({ user_id: userId });
    await tx.insert(affiliate_codes).values({ user_id: userId, code: finalCode });
  });

  // Create admin_user with role=creator so they can access the admin dashboard
  // Skip if one already exists with the same email
  // Only used for existence check — tiny select avoids missing-column crashes
  // when a later-migration column is missing in prod.
  const existingAdminUser = (
    await adminDrizzle
      .select({ id: admin_users.id })
      .from(admin_users)
      .where(eq(admin_users.email, mainUser.email))
      .limit(1)
  )[0];
  if (!existingAdminUser) {
    const tempPassword = crypto.randomBytes(16).toString("hex");
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const username = mainUser.username ?? mainUser.email.split("@")[0];

    // Same RETURNING * defense — without an explicit select, a new column
    // missing on prod would crash "Make Creator" even though the insert
    // columns themselves are all present.
    await adminDrizzle.insert(admin_users).values({
        email: mainUser.email,
        username: `creator_${username}`,
        password_hash: passwordHash,
        role: "creator",
        allowed_pages: ["/my-profile"],
        updated_at: new Date().toISOString(),
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

// Removed 2026-07-29: updateAffiliateLevel. There is NO per-user level
// column anywhere in the MAIN schema (affiliate_accounts has none) — the
// action only bumped updated_at while the UIs toasted "Level updated" and
// a false audit event was written. Per-user level is display-only,
// derived from the global affiliate_level_configs thresholds; the only
// real level mutation is updateLevelConfig below.

export async function addAffiliateCode(userId: string, code: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_assign_affiliate", "create affiliate codes");

  const parsedCode = codeSchema.safeParse(code);
  if (!parsedCode.success) {
    throw new Error(parsedCode.error.issues[0]?.message ?? "Invalid affiliate code");
  }
  const trimmed = parsedCode.data;

  const [existing] = await db
    .select({ id: affiliate_codes.id })
    .from(affiliate_codes)
    .where(eq(affiliate_codes.code, trimmed))
    .limit(1);
  if (existing) throw new Error("Code already exists");

  // Code ownership lives in affiliate_codes only. user.affiliate_code
  // is the referral cookie this user CARRIES (the code they used at
  // signup), not an "owned-code" pointer — see the schema note in
  // src/lib/queries/creators-detail.ts:58. A previous version of this
  // action also wrote user.affiliate_code = trimmed; that confused the
  // two and caused /users/[id] to show the cookie labeled as the
  // user's own code. Reverted to ONLY insert the affiliate_codes row.
  try {
    await db.insert(affiliate_codes).values({ user_id: userId, code: trimmed });
  } catch (error) {
    if ((error as { code?: string })?.code === "23505") {
      throw new Error("Code already exists");
    }
    throw error;
  }

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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_assign_affiliate", "remove affiliate codes");

  const [code] = await db
    .select({ user_id: affiliate_codes.user_id, code: affiliate_codes.code })
    .from(affiliate_codes)
    .where(eq(affiliate_codes.id, codeId))
    .limit(1);
  if (!code) throw new Error("Code not found");

  await db.delete(affiliate_codes).where(eq(affiliate_codes.id, codeId));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_code_removed",
    targetUserId: code.user_id,
    metadata: { code: code.code },
  });

  revalidatePath(`/creators/${code.user_id}`);
}

// Removed 2026-07-29: toggleAffiliateCode. `affiliate_codes` has NO
// is_active column in prod — the action only bumped updated_at while the
// UI toasted "Code activated/deactivated" and wrote a false audit event.
// The only real activation switch is the account-wide
// `user.affiliate_code_active` flag — see toggleCodeActive below.

export async function updateCreatorLimits(
  userId: string,
  limits: {
    currencyLimitAmount?: number | null;
    percentageLimit?: number | null;
    tipLimit?: number | null;
    currencyLimitResetDays?: number | null;
  }
) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_update_creator_limits", "update creator limits");

  await db
    .insert(creator_withdrawal_limits)
    .values({
      user_id: userId,
      currency_limit_amount:
        limits.currencyLimitAmount == null
          ? null
          : String(limits.currencyLimitAmount),
      percentage_limit:
        limits.percentageLimit == null
          ? null
          : String(limits.percentageLimit),
      currency_limit_reset_days: limits.currencyLimitResetDays ?? null,
    })
    .onConflictDoUpdate({
      target: creator_withdrawal_limits.user_id,
      set: {
        currency_limit_amount:
          limits.currencyLimitAmount == null
            ? null
            : String(limits.currencyLimitAmount),
        percentage_limit:
          limits.percentageLimit == null
            ? null
            : String(limits.percentageLimit),
        currency_limit_reset_days: limits.currencyLimitResetDays ?? null,
        updated_at: new Date().toISOString(),
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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_approve_creator_payout", "approve creator payouts");

  // Run everything inside a single interactive transaction so we can:
  //   1. Lock the affiliate_accounts row (SELECT ... FOR UPDATE) to prevent
  //      a double-payout race when two parallel calls both see a positive
  //      `available_usd` before either has zeroed it.
  //   2. Write a paired ledger_transactions entry alongside the balance
  //      update — required by the CLAUDE.md rule that every balance change
  //      must go through the ledger for the immutable audit trail.
  const { available } = await db.transaction(async (tx) => {
    const [lockedAccount] = await tx
      .select({ available_usd: affiliate_accounts.available_usd })
      .from(affiliate_accounts)
      .where(eq(affiliate_accounts.user_id, affiliateUserId))
      .limit(1)
      .for("update");
    if (!lockedAccount) {
      throw new Error("Affiliate account not found");
    }
    const availableText = String(lockedAccount.available_usd);
    const available = toNumber(availableText);
    if (available <= 0) {
      throw new Error("No available balance to pay out");
    }

    // SECURITY (SECURITY_AUDIT.md HIGH-4): lock the MAIN balances row for the
    // duration of this tx BEFORE the read-modify-write below. The credit writes
    // an ABSOLUTE `available_balance = balanceBefore + available`, so without a
    // lock a concurrent balance write (a wager the backend debits, or another
    // admin adjust) that lands between our read and write is silently clobbered
    // (lost update). Mirrors the affiliate_accounts FOR UPDATE above; a
    // concurrent writer that also touches this row now serializes behind us.
    const [balance] = await tx
      .select({ available_balance: balances.available_balance })
      .from(balances)
      .where(eq(balances.user_id, affiliateUserId))
      .limit(1)
      .for("update");
    if (!balance) {
      throw new Error("User balance not found");
    }
    const balanceBefore = String(balance.available_balance);

    await tx.insert(affiliate_payouts).values({
        id: crypto.randomUUID(),
        affiliate_user_id: affiliateUserId,
        amount_usd: availableText,
        status: "paid",
    });

    await tx
      .update(affiliate_accounts)
      .set({
        available_usd: "0",
        total_paid_out_usd: sql`${affiliate_accounts.total_paid_out_usd} + ${availableText}`,
        last_payout_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(eq(affiliate_accounts.user_id, affiliateUserId));

    const [updatedBalance] = await tx
      .update(balances)
      .set({
        // Keep the authoritative money arithmetic in PostgreSQL numeric.
        // Converting Decimal(20,2) to JS Number before adding can lose cents
        // once the integer portion exceeds Number's exact range.
        available_balance: sql`${balances.available_balance} + ${availableText}`,
        updated_at: new Date().toISOString(),
      })
      .where(eq(balances.user_id, affiliateUserId))
      .returning({ available_balance: balances.available_balance });
    if (!updatedBalance) {
      throw new Error("User balance not found");
    }

    await tx.insert(ledger_transactions).values({
        user_id: affiliateUserId,
        type: "affiliate_claim",
        amount: availableText,
        balance_before: balanceBefore,
        balance_after: String(updatedBalance.available_balance),
        description: "Creator payout",
        status: "completed",
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
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(
    session,
    "__can_update_creator_level_config",
    "update creator level config",
  );

  await db
    .insert(affiliate_level_configs)
    .values({
      level,
      label: data.label ?? `Level ${level}`,
      commission_rate: String(data.commissionRate ?? 0),
      threshold: String(data.threshold ?? 0),
      updated_at: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: affiliate_level_configs.level,
      set: {
        ...(data.label !== undefined ? { label: data.label } : {}),
        ...(data.commissionRate !== undefined
          ? { commission_rate: String(data.commissionRate) }
          : {}),
        ...(data.threshold !== undefined
          ? { threshold: String(data.threshold) }
          : {}),
        updated_at: new Date().toISOString(),
      },
    },
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "affiliate_level_config_updated",
    metadata: { level, ...data },
  });

  revalidatePath("/creators/settings");
  // Affiliate config also surfaces on the /rewards Affiliate tab.
  revalidatePath("/rewards");
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
  const db = await getPrimaryDrizzleDb();
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
    await db
      .insert(site_config)
      .values({
        key: "affiliate_cut_expiration_days",
        value,
        description:
          "How many days after a user signs up via an affiliate code the affiliate keeps earning commission on that user. Empty / 0 = no expiration (lifetime).",
      })
      .onConflictDoUpdate({
        target: site_config.key,
        set: { value, updated_at: new Date().toISOString() },
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
  // Affiliate config also surfaces on the /rewards Affiliate tab.
  revalidatePath("/rewards");
  return { success: true };
}

export async function toggleCodeActive(userId: string, isActive: boolean) {
  const db = await getPrimaryDrizzleDb();
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_toggle_creator_code", "toggle creator codes");

  await db
    .update(mainUsers)
    .set({
      affiliate_code_active: isActive,
      updated_at: new Date().toISOString(),
    })
    .where(eq(mainUsers.id, userId));

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

  // SSRF egress guard (SECURITY_AUDIT.md MEDIUM-1) — replaces the parse-only
  // `new URL()` check: also rejects non-http(s) + private/loopback/internal.
  assertSafeWebhookUrl(data.url);

  const secret = crypto.randomBytes(32).toString("hex");

  // Explicit select — only the id is consumed downstream, and a default
  // RETURNING * crashes with 42703 when prod is missing a later-migration
  // column the generated client knows about.
  const [webhook] = await adminDrizzle
    .insert(creator_webhooks)
    .values({
      target_user_id: targetUserId,
      url: data.url,
      secret,
      type: "balance_fill",
    })
    .returning({ id: creator_webhooks.id });

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

  // SSRF egress guard (SECURITY_AUDIT.md MEDIUM-1).
  if (data.url) {
    assertSafeWebhookUrl(data.url);
  }

  const webhook = (
    await adminDrizzle
      .select()
      .from(creator_webhooks)
      .where(eq(creator_webhooks.id, webhookId))
      .limit(1)
  )[0];
  if (!webhook) throw new Error("Webhook not found");

  await adminDrizzle
    .update(creator_webhooks)
    .set({
      ...(data.url !== undefined && { url: data.url }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
      updated_at: new Date().toISOString(),
    })
    .where(eq(creator_webhooks.id, webhookId));

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

  const webhook = (
    await adminDrizzle
      .select()
      .from(creator_webhooks)
      .where(eq(creator_webhooks.id, webhookId))
      .limit(1)
  )[0];
  if (!webhook) throw new Error("Webhook not found");

  await adminDrizzle
    .delete(creator_webhooks)
    .where(eq(creator_webhooks.id, webhookId));

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

  const webhook = (
    await adminDrizzle
      .select()
      .from(creator_webhooks)
      .where(eq(creator_webhooks.id, webhookId))
      .limit(1)
  )[0];
  if (!webhook) throw new Error("Webhook not found");

  // Fetch-time SSRF guard (SECURITY_AUDIT.md MEDIUM-1) — defends against any
  // URL stored before the store-time validation above.
  if (!isSafeWebhookUrl(webhook.url)) {
    return { success: false, status: 0, error: "Webhook URL host is not allowed" };
  }

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

  const [deal] = await adminDrizzle
    .insert(creator_deals)
    .values({
      target_user_id: targetUserId,
      deal_name: parsed.data.dealName ?? null,
      deal_type: parsed.data.dealType,
      amount: String(parsed.data.amount),
      currency: parsed.data.currency ?? "USD",
      start_date: new Date(parsed.data.startDate).toISOString(),
      end_date: parsed.data.endDate
        ? new Date(parsed.data.endDate).toISOString()
        : null,
      notes: parsed.data.notes ?? null,
      keep_percentage:
        parsed.data.keepPercentage != null
          ? String(parsed.data.keepPercentage)
          : null,
      currency_limit_amount:
        parsed.data.currencyLimitAmount != null
          ? String(parsed.data.currencyLimitAmount)
          : null,
      currency_limit_reset_days: parsed.data.currencyLimitResetDays ?? null,
      percentage_limit:
        parsed.data.percentageLimit != null
          ? String(parsed.data.percentageLimit)
          : null,
      tip_limit:
        parsed.data.tipLimit != null ? String(parsed.data.tipLimit) : null,
      tip_limit_reset_days: parsed.data.tipLimitResetDays ?? null,
      leaderboard_prize_pool:
        parsed.data.leaderboardPrizePool != null
          ? String(parsed.data.leaderboardPrizePool)
          : null,
      leaderboard_our_share:
        parsed.data.leaderboardOurShare != null
          ? String(parsed.data.leaderboardOurShare)
          : null,
      leaderboard_frequency: parsed.data.leaderboardFrequency ?? null,
      min_stream_minutes: parsed.data.minStreamMinutes ?? null,
      max_financial_exposure: maxExposure == null ? null : String(maxExposure),
      status: "active",
    })
    .returning({ id: creator_deals.id });

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

  const deal = (
    await adminDrizzle
      .select()
      .from(creator_deals)
      .where(eq(creator_deals.id, dealId))
      .limit(1)
  )[0];
  if (!deal) throw new Error("Deal not found");

  // Merge existing deal data with updates for exposure calculation.
  // NULL-preserving on purpose: a NULL currency limit means "no limit
  // tracked" (exposure stays null), NOT a $0 limit — toNumber() would
  // silently coerce NULL to 0.
  const merged = {
    currencyLimitAmount: v.currencyLimitAmount !== undefined ? v.currencyLimitAmount : toNumberOrNull(deal.currency_limit_amount),
    currencyLimitResetDays: v.currencyLimitResetDays !== undefined ? v.currencyLimitResetDays : deal.currency_limit_reset_days,
    leaderboardPrizePool: v.leaderboardPrizePool !== undefined ? v.leaderboardPrizePool : toNumberOrNull(deal.leaderboard_prize_pool),
    leaderboardOurShare: v.leaderboardOurShare !== undefined ? v.leaderboardOurShare : toNumberOrNull(deal.leaderboard_our_share),
    leaderboardFrequency: v.leaderboardFrequency !== undefined ? v.leaderboardFrequency : deal.leaderboard_frequency,
  };
  const maxExposure = calculateMaxExposure(merged);

  await adminDrizzle
    .update(creator_deals)
    .set({
      ...(v.dealName !== undefined && { deal_name: v.dealName }),
      ...(v.dealType !== undefined && { deal_type: v.dealType }),
      ...(v.amount !== undefined && { amount: String(v.amount) }),
      ...(v.currency !== undefined && { currency: v.currency }),
      ...(v.startDate !== undefined && {
        start_date: new Date(v.startDate).toISOString(),
      }),
      ...(v.endDate !== undefined && {
        end_date: v.endDate ? new Date(v.endDate).toISOString() : null,
      }),
      ...(v.status !== undefined && { status: v.status }),
      ...(v.notes !== undefined && { notes: v.notes }),
      ...(v.keepPercentage !== undefined && {
        keep_percentage:
          v.keepPercentage != null ? String(v.keepPercentage) : null,
      }),
      ...(v.currencyLimitAmount !== undefined && {
        currency_limit_amount:
          v.currencyLimitAmount != null
            ? String(v.currencyLimitAmount)
            : null,
      }),
      ...(v.currencyLimitResetDays !== undefined && { currency_limit_reset_days: v.currencyLimitResetDays }),
      ...(v.percentageLimit !== undefined && {
        percentage_limit:
          v.percentageLimit != null ? String(v.percentageLimit) : null,
      }),
      ...(v.tipLimit !== undefined && {
        tip_limit: v.tipLimit != null ? String(v.tipLimit) : null,
      }),
      ...(v.tipLimitResetDays !== undefined && { tip_limit_reset_days: v.tipLimitResetDays }),
      ...(v.leaderboardPrizePool !== undefined && {
        leaderboard_prize_pool:
          v.leaderboardPrizePool != null
            ? String(v.leaderboardPrizePool)
            : null,
      }),
      ...(v.leaderboardOurShare !== undefined && {
        leaderboard_our_share:
          v.leaderboardOurShare != null
            ? String(v.leaderboardOurShare)
            : null,
      }),
      ...(v.leaderboardFrequency !== undefined && { leaderboard_frequency: v.leaderboardFrequency }),
      ...(v.minStreamMinutes !== undefined && { min_stream_minutes: v.minStreamMinutes }),
      max_financial_exposure: maxExposure == null ? null : String(maxExposure),
      updated_at: new Date().toISOString(),
    })
    .where(eq(creator_deals.id, dealId));

  // Sync withdrawal limits to main DB. Same NULL-preservation as the
  // exposure merge above: an unchanged NULL limit must stay NULL ("no
  // limit"), not be rewritten as a hard $0 / 0% limit.
  await syncWithdrawalLimits(deal.target_user_id, {
    currencyLimitAmount: v.currencyLimitAmount !== undefined ? v.currencyLimitAmount : toNumberOrNull(deal.currency_limit_amount),
    currencyLimitResetDays: v.currencyLimitResetDays !== undefined ? v.currencyLimitResetDays : deal.currency_limit_reset_days,
    percentageLimit: v.percentageLimit !== undefined ? v.percentageLimit : toNumberOrNull(deal.percentage_limit),
    tipLimit: v.tipLimit !== undefined ? v.tipLimit : toNumberOrNull(deal.tip_limit),
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
  const db = await getPrimaryDrizzleDb();
  await db
    .insert(creator_withdrawal_limits)
    .values({
      user_id: userId,
      currency_limit_amount:
        data.currencyLimitAmount == null
          ? null
          : String(data.currencyLimitAmount),
      currency_limit_reset_days: data.currencyLimitResetDays ?? null,
      percentage_limit:
        data.percentageLimit == null ? null : String(data.percentageLimit),
    })
    .onConflictDoUpdate({
      target: creator_withdrawal_limits.user_id,
      set: {
        currency_limit_amount:
          data.currencyLimitAmount == null
            ? null
            : String(data.currencyLimitAmount),
        currency_limit_reset_days: data.currencyLimitResetDays ?? null,
        percentage_limit:
          data.percentageLimit == null ? null : String(data.percentageLimit),
        updated_at: new Date().toISOString(),
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

// NULL-preserving decimal → number. Unlike toNumber() (which coerces
// NULL to 0), this keeps NULL as null so "no limit set" survives the
// merge instead of becoming a hard 0 limit.
function toNumberOrNull(value: unknown): number | null {
  return value == null ? null : toNumber(value);
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
  // 0–100 scale (optionalPercent — "admins type 20 not 0.2"), so divide
  // by 100 here or the leaderboard leg is inflated 100x.
  const ourShare = data.leaderboardOurShare ?? 0;
  const freqMultiplier = data.leaderboardFrequency === "weekly" ? 4
    : data.leaderboardFrequency === "biweekly" ? 2
    : data.leaderboardFrequency === "monthly" ? 1
    : 0;

  const leaderboardCostPerMonth = pool * (ourShare / 100) * freqMultiplier;
  return monthlyCashout + leaderboardCostPerMonth;
}

export async function deleteDeal(dealId: string) {
  const session = await requirePageAccess("/creators");
  await requireCapability(session, "__can_delete_creator_deal", "delete creator deals");

  const deal = (
    await adminDrizzle
      .select()
      .from(creator_deals)
      .where(eq(creator_deals.id, dealId))
      .limit(1)
  )[0];
  if (!deal) throw new Error("Deal not found");

  await adminDrizzle.delete(creator_deals).where(eq(creator_deals.id, dealId));

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_deal_deleted",
    targetUserId: deal.target_user_id,
    metadata: { dealId },
  });

  revalidatePath(`/creators/${deal.target_user_id}`);
}
