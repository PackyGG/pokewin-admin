"use server";

import { z } from "zod";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { setMonitorEvent } from "@/lib/backend-api/monitor";

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
