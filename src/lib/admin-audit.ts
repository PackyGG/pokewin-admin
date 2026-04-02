import { adminDb } from "@/lib/admin-db";
import type { Prisma } from "@/generated/admin-prisma/client";

export async function createAdminAuditEvent(params: {
  adminUserId: string;
  eventType: string;
  targetUserId?: string;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await adminDb.admin_audit_events.create({
    data: {
      admin_user_id: params.adminUserId,
      event_type: params.eventType,
      target_user_id: params.targetUserId ?? null,
      ip: params.ip ?? null,
      metadata: (params.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
