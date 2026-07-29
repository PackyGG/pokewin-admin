"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users, creator_socials, creator_webhooks } from "@/lib/db-schema/admin/schema";
import { user } from "@/lib/db-schema/main/schema";
import { verifySession, sessionHasRole } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { fetchPublicStats } from "@/lib/socials-public";
import { assertSafeWebhookUrl, isSafeWebhookUrl } from "@/lib/security/webhook-url";

/**
 * Get the main site user_id linked to the current admin creator.
 *
 * The link is resolved by email: the admin_users row and the creator's
 * main-site account share the same email address, so we look up the MAIN
 * `user` row (role = creator) matching the admin user's email. That id is
 * what creator_socials / creator_webhooks store in `target_user_id` — the
 * rest of the system (creators pages, webhook dispatch, deals) treats that
 * column strictly as a MAIN user id.
 *
 * If no main-site account matches, the creator is NOT linked yet and every
 * mutation here refuses. Falling back to the admin-DB uuid would write rows
 * keyed on an id no other surface can resolve — they would silently orphan
 * the moment the account is properly linked.
 */
import { getReadDrizzleDb } from "@/lib/db";

async function getCreatorTargetUserId(): Promise<string> {
  const session = await verifySession();
  // Holds the creator role (primary OR secondary in a multi-role set).
  if (!sessionHasRole(session, "creator")) throw new Error("Not a creator");
  const db = await getReadDrizzleDb();

  // Look up the admin_user to get email, then find main user by email
  const [adminUser] = await adminDrizzle.select({ email: admin_users.email })
    .from(admin_users).where(eq(admin_users.id, session.userId)).limit(1);
  if (!adminUser) throw new Error("Admin user not found");

  const [mainUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.email, adminUser.email), eq(user.role, "creator")))
    .limit(1);

  if (!mainUser) {
    throw new Error(
      "Your creator account isn't linked to a main-site user yet — ask an admin to link it before managing webhooks or socials.",
    );
  }
  return mainUser.id;
}

// --- Webhooks (creator self-service) ---

export async function createCreatorWebhook(data: { url: string }) {
  const userId = await getCreatorTargetUserId();

  // SSRF egress guard (SECURITY_AUDIT.md MEDIUM-1) — replaces the parse-only
  // `new URL()` check: also rejects non-http(s) + private/loopback/internal.
  assertSafeWebhookUrl(data.url);

  const secret = crypto.randomBytes(32).toString("hex");

  // Explicit select — only the id is consumed downstream, and a default
  // RETURNING * crashes with 42703 when prod is missing a later-migration
  // column the generated client knows about.
  const [webhook] = await adminDrizzle.insert(creator_webhooks).values({
      target_user_id: userId,
      url: data.url,
      secret,
      type: "balance_fill",
    }).returning({ id: creator_webhooks.id });
  if (!webhook) throw new Error("Webhook insert returned no row");

  // Audit: the admin-side createWebhook in creators/actions.ts logs the same
  // creator_webhooks insert; mirror it here so the self-service path leaves an
  // equal trail. Actor = the creator's own session; target = their user id.
  const session = await verifySession();
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_webhook_created",
    targetUserId: userId,
    metadata: { webhookId: webhook.id, url: data.url },
  });

  revalidatePath("/my-profile");
  return { id: webhook.id, secret };
}

export async function updateCreatorWebhook(
  webhookId: string,
  data: { url?: string; enabled?: boolean }
) {
  const userId = await getCreatorTargetUserId();

  // SSRF egress guard (SECURITY_AUDIT.md MEDIUM-1).
  if (data.url) {
    assertSafeWebhookUrl(data.url);
  }

  const [webhook] = await adminDrizzle.select().from(creator_webhooks)
    .where(and(eq(creator_webhooks.id, webhookId), eq(creator_webhooks.target_user_id, userId))).limit(1);
  if (!webhook || webhook.target_user_id !== userId) throw new Error("Webhook not found");

  await adminDrizzle.update(creator_webhooks).set({
      ...(data.url !== undefined && { url: data.url }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
      updated_at: new Date().toISOString(),
    }).where(and(eq(creator_webhooks.id, webhookId), eq(creator_webhooks.target_user_id, userId)));

  // Audit: editing the URL re-points where signed balance-fill payloads go,
  // so trace it like the admin-side updateWebhook does. Capture before/after
  // for the sensitive fields that actually changed.
  const session = await verifySession();
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_webhook_updated",
    targetUserId: userId,
    metadata: {
      webhookId,
      ...(data.url !== undefined && { url_before: webhook.url, url_after: data.url }),
      ...(data.enabled !== undefined && {
        enabled_before: webhook.enabled,
        enabled_after: data.enabled,
      }),
    },
  });

  revalidatePath("/my-profile");
}

export async function deleteCreatorWebhook(webhookId: string) {
  const userId = await getCreatorTargetUserId();

  const deleted = await adminDrizzle.delete(creator_webhooks)
    .where(and(eq(creator_webhooks.id, webhookId), eq(creator_webhooks.target_user_id, userId)))
    .returning({ id: creator_webhooks.id });
  if (deleted.length === 0) throw new Error("Webhook not found");

  // Audit: mirrors the admin-side deleteWebhook in creators/actions.ts so the
  // self-service path leaves the same trail.
  const session = await verifySession();
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_webhook_deleted",
    targetUserId: userId,
    metadata: { webhookId },
  });

  revalidatePath("/my-profile");
}

export async function testCreatorWebhook(webhookId: string) {
  const userId = await getCreatorTargetUserId();

  const [webhook] = await adminDrizzle.select().from(creator_webhooks)
    .where(and(eq(creator_webhooks.id, webhookId), eq(creator_webhooks.target_user_id, userId))).limit(1);
  if (!webhook || webhook.target_user_id !== userId) throw new Error("Webhook not found");

  // Fetch-time SSRF guard (SECURITY_AUDIT.md MEDIUM-1) — defends against any
  // URL stored before the store-time validation above.
  if (!isSafeWebhookUrl(webhook.url)) {
    return { success: false, status: 0, error: "Webhook URL host is not allowed" };
  }

  const isDiscord = webhook.url.includes("discord.com/api/webhooks/");

  const payload = isDiscord
    ? JSON.stringify({
        content: `✅ Test webhook from Pack.ygg — type: ${webhook.type}`,
      })
    : JSON.stringify({
        event: "test",
        type: webhook.type,
        timestamp: new Date().toISOString(),
        message: "This is a test webhook from Pack.ygg",
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

export async function unlinkSocial(socialId: string) {
  const userId = await getCreatorTargetUserId();

  const deleted = await adminDrizzle.delete(creator_socials)
    .where(and(eq(creator_socials.id, socialId), eq(creator_socials.target_user_id, userId)))
    .returning({ id: creator_socials.id, platform: creator_socials.platform, username: creator_socials.username });
  if (deleted.length === 0) throw new Error("Social connection not found");

  // Audit: unlinking removes a verification surface — trace it like the
  // webhook mutations above.
  const session = await verifySession();
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_social_unlinked",
    targetUserId: userId,
    metadata: { socialId, platform: deleted[0].platform, username: deleted[0].username },
  });

  revalidatePath("/my-profile");
}

export async function linkSocialByUsername(platform: string, username: string) {
  const userId = await getCreatorTargetUserId();
  const trimmed = username.trim().replace(/^@/, "");
  if (!trimmed) throw new Error("Username is required");

  const validPlatforms = ["twitter", "youtube", "kick", "instagram"];
  if (!validPlatforms.includes(platform)) throw new Error("Invalid platform");

  const stats = await fetchPublicStats(platform, trimmed);

  const socialPlatform = platform as "twitter" | "youtube" | "kick" | "instagram";
  await adminDrizzle.insert(creator_socials).values({
      target_user_id: userId,
      platform: socialPlatform,
      username: trimmed,
      platform_user_id: stats.platformUserId ?? null,
      follower_count: stats.followerCount ?? 0,
      last_fetched_at: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: [creator_socials.target_user_id, creator_socials.platform],
      set: {
      username: trimmed,
      platform_user_id: stats.platformUserId ?? null,
      follower_count: stats.followerCount ?? 0,
      last_fetched_at: new Date().toISOString(),
    },
  });

  // Audit: linking attaches an external identity to the creator profile —
  // same trail as the webhook create/update above.
  const session = await verifySession();
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_social_linked",
    targetUserId: userId,
    metadata: {
      platform: socialPlatform,
      username: trimmed,
      followerCount: stats.followerCount ?? 0,
    },
  });

  revalidatePath("/my-profile");
  return stats.followerCount;
}
