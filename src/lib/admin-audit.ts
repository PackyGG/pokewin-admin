import { adminDb } from "@/lib/admin-db";
import type { Prisma } from "@/generated/admin-prisma/client";

export async function createAdminAuditEvent(params: {
  adminUserId: string;
  eventType: string;
  targetUserId?: string;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}) {
  // If the caller didn't pass an explicit IP, try to read it from the
  // current request headers. This is best-effort: `headers()` only works
  // inside a request scope (Server Component / Route Handler / Server
  // Action), and throws elsewhere — we swallow that and fall back to null
  // so the call site doesn't have to care.
  let ip = params.ip;
  if (ip === undefined) {
    try {
      const { headers } = await import("next/headers");
      const h = await headers();
      ip =
        h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        h.get("x-real-ip") ||
        null;
    } catch {
      ip = null;
    }
  }

  await adminDb.admin_audit_events.create({
    data: {
      admin_user_id: params.adminUserId,
      event_type: params.eventType,
      target_user_id: params.targetUserId ?? null,
      ip: ip ?? null,
      metadata: (params.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
