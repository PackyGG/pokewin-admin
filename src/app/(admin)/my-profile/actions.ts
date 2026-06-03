"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { verifySession, sessionHasRole } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { fetchPublicStats } from "@/lib/socials-public";

/**
 * Get the main site user_id linked to the current admin creator.
 * We match by email between admin_users and the target_user_id stored in socials/webhooks.
 * For the my-profile page, the session contains the admin_user id + email.
 * We need a way to find the corresponding main site user_id.
 *
 * Convention: when makeCreator() creates the admin_user, we store the main site
 * user_id in admin_notes or we can look it up. For simplicity, we'll store
 * the main user_id in the admin_users username field as "creator_{username}"
 * and match by email. We query the main DB to find the user by email.
 */
import { getDb } from "@/lib/db";

async function getCreatorTargetUserId(): Promise<string> {
  const db = await getDb();
  const session = await verifySession();
  // Holds the creator role (primary OR secondary in a multi-role set).
  if (!sessionHasRole(session, "creator")) throw new Error("Not a creator");

  // Look up the admin_user to get email, then find main user by email
  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { email: true },
  });
  if (!adminUser) throw new Error("Admin user not found");

  const mainUser = await db.user.findFirst({
    where: { email: adminUser.email, role: "creator" },
    select: { id: true },
  });

  // Use main user id if linked, otherwise use admin user id
  return mainUser?.id ?? session.userId;
}

// --- Webhooks (creator self-service) ---

export async function createCreatorWebhook(data: { url: string }) {
  const userId = await getCreatorTargetUserId();

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
      target_user_id: userId,
      url: data.url,
      secret,
      type: "balance_fill",
    },
    select: { id: true },
  });

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

  if (data.url) {
    try {
      new URL(data.url);
    } catch {
      throw new Error("Invalid webhook URL");
    }
  }

  const webhook = await adminDb.creator_webhooks.findUnique({ where: { id: webhookId } });
  if (!webhook || webhook.target_user_id !== userId) throw new Error("Webhook not found");

  await adminDb.creator_webhooks.update({
    where: { id: webhookId },
    data: {
      ...(data.url !== undefined && { url: data.url }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
      updated_at: new Date(),
    },
    select: { id: true },
  });

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

  const webhook = await adminDb.creator_webhooks.findUnique({ where: { id: webhookId } });
  if (!webhook || webhook.target_user_id !== userId) throw new Error("Webhook not found");

  await adminDb.creator_webhooks.delete({ where: { id: webhookId }, select: { id: true } });
  revalidatePath("/my-profile");
}

export async function testCreatorWebhook(webhookId: string) {
  const userId = await getCreatorTargetUserId();

  const webhook = await adminDb.creator_webhooks.findUnique({ where: { id: webhookId } });
  if (!webhook || webhook.target_user_id !== userId) throw new Error("Webhook not found");

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

  const social = await adminDb.creator_socials.findUnique({ where: { id: socialId } });
  if (!social || social.target_user_id !== userId) throw new Error("Social connection not found");

  await adminDb.creator_socials.delete({ where: { id: socialId }, select: { id: true } });
  revalidatePath("/my-profile");
}

export async function linkSocialByUsername(platform: string, username: string) {
  const userId = await getCreatorTargetUserId();
  const trimmed = username.trim().replace(/^@/, "");
  if (!trimmed) throw new Error("Username is required");

  const validPlatforms = ["twitter", "youtube", "kick", "instagram"];
  if (!validPlatforms.includes(platform)) throw new Error("Invalid platform");

  const stats = await fetchPublicStats(platform, trimmed);

  await adminDb.creator_socials.upsert({
    where: {
      target_user_id_platform: { target_user_id: userId, platform: platform as "twitter" | "youtube" | "kick" | "instagram" },
    },
    create: {
      target_user_id: userId,
      platform: platform as "twitter" | "youtube" | "kick" | "instagram",
      username: trimmed,
      platform_user_id: stats.platformUserId ?? null,
      follower_count: stats.followerCount ?? 0,
      last_fetched_at: new Date(),
    },
    update: {
      username: trimmed,
      platform_user_id: stats.platformUserId ?? null,
      follower_count: stats.followerCount ?? 0,
      last_fetched_at: new Date(),
    },
    select: { id: true },
  });

  revalidatePath("/my-profile");
  return stats.followerCount;
}
