import { adminDb } from "@/lib/admin-db";

/**
 * ADMIN-side action trail for ONE game user — "who did what to this
 * account, and why".
 *
 * Source: `admin_audit_events` in the ADMIN DB (never the main/game DB),
 * filtered on `target_user_id`. Every admin mutation against a user
 * (ban / unban / lock / balance adjustment / role change / chat mute /
 * KYC / feature lock / note …) writes one row here via
 * `createAdminAuditEvent`, so this is the authoritative answer to
 * "who banned this user and for what reason".
 *
 * The acting admin is resolved through the modelled `admin_user`
 * relation (same DB → a real join, no cross-DB stitching). `admin_user_id`
 * is nullable, so system/unattributed rows resolve to `null` and the UI
 * shows "system".
 *
 * Index: `admin_audit_events_target_user_id_idx` covers the filter
 * (see prisma/admin/schema.prisma).
 */

export type UserAdminAuditEvent = {
  id: string;
  eventType: string;
  /** Acting admin (admin-DB id) — null for unattributed/system rows. */
  adminUserId: string | null;
  adminUsername: string | null;
  adminRole: string | null;
  ip: string | null;
  metadata: unknown;
  createdAt: string;
};

export type UserAdminAuditFeed = {
  events: UserAdminAuditEvent[];
  /** Total rows targeting this user (may exceed `events.length`). */
  total: number;
  /** True when `total` exceeds the fetched window. */
  truncated: boolean;
};

/**
 * Newest-N window. Admin actions against a single user are rare (tens at
 * most for a heavily-moderated account), so one bounded fetch feeds the
 * whole tab — filtering + paging happen client-side on this slice, and
 * the tab states plainly when older rows exist beyond it.
 */
export const USER_ADMIN_AUDIT_MAX = 200;

export const EMPTY_USER_ADMIN_AUDIT: UserAdminAuditFeed = {
  events: [],
  total: 0,
  truncated: false,
};

export async function getUserAdminAuditFeed(
  userId: string,
): Promise<UserAdminAuditFeed> {
  const [rows, total] = await Promise.all([
    adminDb.admin_audit_events.findMany({
      where: { target_user_id: userId },
      orderBy: { created_at: "desc" },
      take: USER_ADMIN_AUDIT_MAX,
      select: {
        id: true,
        event_type: true,
        ip: true,
        metadata: true,
        created_at: true,
        admin_user: { select: { id: true, username: true, role: true } },
      },
    }),
    adminDb.admin_audit_events.count({ where: { target_user_id: userId } }),
  ]);

  return {
    events: rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      adminUserId: r.admin_user?.id ?? null,
      adminUsername: r.admin_user?.username ?? null,
      adminRole: r.admin_user?.role ?? null,
      ip: r.ip,
      metadata: r.metadata,
      createdAt: r.created_at.toISOString(),
    })),
    total,
    truncated: total > rows.length,
  };
}
