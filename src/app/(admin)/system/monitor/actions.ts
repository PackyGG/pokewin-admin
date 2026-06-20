"use server";

import { z } from "zod";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  setMonitorEvent,
  createMonitorApiKey,
  revokeMonitorApiKey,
  type CreatedMonitorApiKey,
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
