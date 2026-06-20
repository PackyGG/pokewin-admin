"use server";

import { z } from "zod";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  setMonitorEvent,
  createMonitorApiKey,
  revokeMonitorApiKey,
  setMonitorChannel,
  type CreatedMonitorApiKey,
  type MonitorChannel,
  type SetChannelInput,
} from "@/lib/backend-api/monitor";

const toggleSchema = z.object({
  // The notification source name (upgrader / pack / battle / deposit /
  // withdrawal / signup). Kept permissive — the monitor is the source of
  // truth for valid names; we just reject empty / oversized input here.
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
});

/**
 * Toggle a backend-monitor notification event on/off via
 * PUT {MONITOR_API_URL}/v1/admin/events/{name}. Server-only: the token
 * stays server-side. Gated by the same page-access check as the monitor
 * page, and every toggle is recorded as an admin audit event.
 */
export async function toggleMonitorEvent(data: {
  name: string;
  enabled: boolean;
}): Promise<{ success: true; enabled: boolean } | { success: false; error: string }> {
  const session = await requirePageAccess("/system/monitor");

  const parsed = toggleSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const result = await setMonitorEvent(parsed.data.name, parsed.data.enabled);
  if (!result.ok) {
    return { success: false, error: result.message };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "monitor_event_toggled",
    metadata: {
      event: parsed.data.name,
      enabled: result.enabled,
    },
  });

  return { success: true, enabled: result.enabled };
}

const createKeySchema = z.object({
  label: z.string().trim().min(1).max(100),
});

const revokeKeySchema = z.object({
  id: z.string().trim().min(1),
});

/**
 * Mint a new monitor API key (master-token, server-side). Gated by the same
 * page-access check as the monitor page; the creation is audited (label +
 * id + prefix only — the raw secret is NEVER stored or logged). The raw key
 * is returned to the caller once so the UI can show a one-time copy modal.
 */
export async function createApiKey(data: {
  label: string;
}): Promise<
  | { success: true; created: CreatedMonitorApiKey }
  | { success: false; error: string }
> {
  const session = await requirePageAccess("/system/monitor");

  const parsed = createKeySchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const result = await createMonitorApiKey(parsed.data.label);
  if (!result.ok) {
    return { success: false, error: result.message };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "monitor_api_key_created",
    metadata: {
      label: result.created.label,
      key_id: result.created.id,
      key_prefix: result.created.key_prefix,
    },
  });

  return { success: true, created: result.created };
}

/**
 * Revoke a monitor API key by id. Gated + audited like the other monitor
 * mutations.
 */
export async function revokeApiKey(data: {
  id: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess("/system/monitor");

  const parsed = revokeKeySchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const result = await revokeMonitorApiKey(parsed.data.id);
  if (!result.ok) {
    return { success: false, error: result.message };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "monitor_api_key_revoked",
    metadata: { key_id: parsed.data.id },
  });

  return { success: true };
}

// ─── Notification channels (per-event fan-out: ntfy AND/OR Discord) ─

// Validation rules mirror the monitor backend exactly (see the
// notification-channels handoff doc). Empty optional secrets mean
// "clear / inherit the env default".
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HTTP_URL_RE = /^https?:\/\/.+/i;
const DISCORD_WEBHOOK_RE =
  /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/i;

const setChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    ntfyEnabled: z.boolean().optional(),
    ntfyTopic: z
      .string()
      .trim()
      .regex(NTFY_TOPIC_RE, "Topic must be 1–64 letters, numbers, _ or -")
      .optional(),
    ntfyServer: z
      .string()
      .trim()
      .regex(HTTP_URL_RE, "Server must be an http(s):// URL")
      .optional(),
    ntfyToken: z.string().trim().min(1).optional(),
    discordEnabled: z.boolean().optional(),
    discordWebhookUrl: z
      .string()
      .trim()
      .regex(DISCORD_WEBHOOK_RE, "Enter a valid Discord webhook URL")
      .optional(),
  });

/** Drop empty-string optionals so blank fields are treated as "inherit". */
function pruneEmpty<T extends Record<string, unknown>>(obj: T): T {
  const out = { ...obj };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === "string" && (out[k] as string).trim() === "") {
      delete out[k];
    }
  }
  return out;
}

/**
 * Update one monitored event's notification channels (ntfy AND/OR Discord)
 * via PUT {MONITOR_API_URL}/v1/admin/channels/{name}. Partial patch — only the
 * provided fields change. Server-only: secrets stay server-side. Gated by the
 * monitor page access check and audited (which channels changed — never the
 * secret value itself). This is also the on/off switch for `fraud` alerts.
 */
export async function updateMonitorChannel(data: {
  name: string;
  ntfyEnabled?: boolean;
  ntfyTopic?: string;
  ntfyServer?: string;
  ntfyToken?: string;
  discordEnabled?: boolean;
  discordWebhookUrl?: string;
}): Promise<
  | { success: true; channel: MonitorChannel }
  | { success: false; error: string }
> {
  const session = await requirePageAccess("/system/monitor");

  const parsed = setChannelSchema.safeParse(pruneEmpty(data));
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { name, ...patch } = parsed.data;
  const input: SetChannelInput = {
    ntfyEnabled: patch.ntfyEnabled,
    ntfyTopic: patch.ntfyTopic,
    ntfyServer: patch.ntfyServer,
    ntfyToken: patch.ntfyToken,
    discordEnabled: patch.discordEnabled,
    discordWebhookUrl: patch.discordWebhookUrl,
  };

  const result = await setMonitorChannel(name, input);
  if (!result.ok) {
    return { success: false, error: result.message };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "monitor_channel_updated",
    metadata: {
      event: name,
      ntfy_enabled: patch.ntfyEnabled ?? null,
      discord_enabled: patch.discordEnabled ?? null,
      // Record only whether a secret was provided — never the value itself.
      ntfy_token_provided: patch.ntfyToken != null,
      discord_webhook_provided: patch.discordWebhookUrl != null,
    },
  });

  return { success: true, channel: result.channel };
}
