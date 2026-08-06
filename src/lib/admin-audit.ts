import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";

export async function createAdminAuditEvent(params: {
  /**
   * null = no human actor. `admin_audit_events.admin_user_id` is nullable (the
   * FK is ON DELETE SET NULL) and every reader already handles it, so an
   * automated origin records honestly instead of being booked against whoever
   * happened to be handy. Such callers put the real origin in `metadata`.
   */
  adminUserId: string | null;
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

  const metadata =
    params.metadata === undefined ? null : JSON.stringify(params.metadata);
  await adminDrizzle.execute(sql`
    INSERT INTO admin_audit_events (
      admin_user_id, event_type, target_user_id, ip, metadata
    )
    VALUES (
      ${params.adminUserId ?? null}::uuid,
      ${params.eventType},
      ${params.targetUserId ?? null},
      ${ip ?? null},
      ${metadata}::jsonb
    )
  `);
}
