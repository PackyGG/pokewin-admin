import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import {
  creator_webhooks,
  webhook_deliveries,
  webhook_type,
} from "@/lib/db-schema/admin/schema";
import { isSafeWebhookUrl } from "@/lib/security/webhook-url";

type WebhookType = (typeof webhook_type.enumValues)[number];

const RETRY_DELAYS = [1000, 5000, 30000]; // 1s, 5s, 30s
const TIMEOUT_MS = 10000;

export async function dispatchWebhook(
  userId: string,
  type: WebhookType,
  payload: Record<string, unknown>
): Promise<{ sent: number; failed: number }> {
  const webhooks = await adminDrizzle
    .select({
      id: creator_webhooks.id,
      url: creator_webhooks.url,
      secret: creator_webhooks.secret,
    })
    .from(creator_webhooks)
    .where(
      and(
        eq(creator_webhooks.target_user_id, userId),
        eq(creator_webhooks.enabled, true),
      ),
    );

  let sent = 0;
  let failed = 0;

  for (const webhook of webhooks) {
    const success = await sendWithRetry(webhook.id, webhook.url, webhook.secret, type, payload);
    if (success) sent++;
    else failed++;
  }

  return { sent, failed };
}

async function sendWithRetry(
  webhookId: string,
  url: string,
  secret: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  // SSRF egress guard (SECURITY_AUDIT.md MEDIUM-1) — never POST to a private /
  // internal address, even for a URL stored before store-time validation.
  if (!isSafeWebhookUrl(url)) {
    await adminDrizzle.insert(webhook_deliveries).values({
        webhook_id: webhookId,
        event_type: eventType,
        payload,
        status_code: null,
        response: "blocked: webhook URL host is not allowed",
        success: false,
        attempt: 1,
    });
    return false;
  }

  const isDiscord = url.includes("discord.com/api/webhooks/");

  const body = isDiscord
    ? JSON.stringify({
        content: formatDiscordMessage(eventType, payload),
      })
    : JSON.stringify({
        event: eventType,
        timestamp: new Date().toISOString(),
        data: payload,
      });

  const signature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt - 1]));
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      // Log delivery
      await adminDrizzle.insert(webhook_deliveries).values({
          webhook_id: webhookId,
          event_type: eventType,
          payload,
          status_code: response.status,
          success: response.ok,
          attempt: attempt + 1,
      });

      if (response.ok) return true;

      // Don't retry on 4xx (client errors) except 429 (rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return false;
      }
    } catch (error) {
      // Log failed delivery
      await adminDrizzle.insert(webhook_deliveries).values({
          webhook_id: webhookId,
          event_type: eventType,
          payload,
          status_code: null,
          response: error instanceof Error ? error.message : "Unknown error",
          success: false,
          attempt: attempt + 1,
      });

      // If this was the last attempt, return false
      if (attempt >= RETRY_DELAYS.length) return false;
    }
  }

  return false;
}

function formatDiscordMessage(eventType: string, payload: Record<string, unknown>): string {
  switch (eventType) {
    case "balance_fill":
      return `**Balance Fill** — $${payload.amount} added to ${payload.username ?? payload.userId}`;
    case "deal_data":
      return `**Deal Update** — ${payload.action ?? "updated"} for ${payload.username ?? payload.userId}`;
    default:
      return `**${eventType}** — ${JSON.stringify(payload)}`;
  }
}
