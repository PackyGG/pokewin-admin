import { and, count, desc, eq, sql } from "drizzle-orm";
import { auditActorVisibilityPredicate } from "@/lib/audit-visibility";
import { adminDrizzle } from "@/lib/drizzle";
import {
  admin_audit_events,
  admin_users,
} from "@/lib/db-schema/admin/schema";

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
 * (see the checked-in Admin Drizzle schema).
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
  /**
   * Set only on BULK rows (one audit row covering many accounts): how many
   * accounts that single action hit. The individual ids are stripped before
   * they ever reach the client — a bulk ban can carry 25k of them.
   */
  bulkCount: number | null;
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

/**
 * BULK actions write ONE audit row for the whole batch: `target_user_id` is
 * null and the affected ids live in `metadata.user_ids` (see bulkBanUsers in
 * users/actions.ts — a 5k-account ban is a single row). Without this second
 * lookup a bulk-banned user shows the later UNBAN with no ban in sight, which
 * is exactly the "banned by whom, and why?" gap this tab exists to close.
 *
 * Cheap: `event_type` is indexed, the containment check then runs over a
 * handful of rows (verified by EXPLAIN: bitmap index scan, sub-ms).
 */
const BULK_BAN_EVENT = "accounts_bulk_banned";

/** Raw shape of the bulk lookup below. */
type BulkAuditRow = {
  id: string;
  event_type: string;
  ip: string | null;
  metadata: unknown;
  created_at: Date | string;
  admin_id: string | null;
  admin_username: string | null;
  admin_role: string | null;
  bulk_count: number | null;
};

export async function getUserAdminAuditFeed(
  userId: string,
  canViewProtectedActors = false,
): Promise<UserAdminAuditFeed> {
  const actorVisible = auditActorVisibilityPredicate(canViewProtectedActors);
  const aliasedActorVisible = auditActorVisibilityPredicate(
    canViewProtectedActors,
    sql`e.admin_user_id`,
  );
  const [rows, total, bulkRows] = await Promise.all([
    adminDrizzle
      .select({
        id: admin_audit_events.id,
        event_type: admin_audit_events.event_type,
        ip: admin_audit_events.ip,
        metadata: admin_audit_events.metadata,
        created_at: admin_audit_events.created_at,
        admin_id: admin_users.id,
        admin_username: admin_users.username,
        admin_role: admin_users.role,
      })
      .from(admin_audit_events)
      .leftJoin(admin_users, eq(admin_users.id, admin_audit_events.admin_user_id))
      .where(and(eq(admin_audit_events.target_user_id, userId), actorVisible))
      .orderBy(desc(admin_audit_events.created_at))
      .limit(USER_ADMIN_AUDIT_MAX),
    adminDrizzle
      .select({ value: count() })
      .from(admin_audit_events)
      .where(and(eq(admin_audit_events.target_user_id, userId), actorVisible))
      .then((result) => result[0]?.value ?? 0),
    // `metadata - 'user_ids'` strips the id array server-side so the batch's
    // other 5,000 account ids never travel to the browser; the count is kept
    // separately so the row can say how wide the action was.
    adminDrizzle
      .execute<BulkAuditRow>(sql`
        SELECT e.id,
               e.event_type,
               e.ip,
               e.created_at,
               (e.metadata - 'user_ids') AS metadata,
               jsonb_array_length(COALESCE(e.metadata -> 'user_ids', '[]'::jsonb)) AS bulk_count,
               u.id AS admin_id,
               u.username AS admin_username,
               u.role::text AS admin_role
        FROM admin_audit_events e
        LEFT JOIN admin_users u ON u.id = e.admin_user_id
        WHERE e.event_type = ${BULK_BAN_EVENT}
          AND ${aliasedActorVisible}
          AND e.metadata -> 'user_ids' @> to_jsonb(${userId}::text)
        ORDER BY e.created_at DESC
        LIMIT ${USER_ADMIN_AUDIT_MAX}
      `)
      .then((result) => result.rows),
  ]);

  const events: UserAdminAuditEvent[] = [
    ...rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      adminUserId: r.admin_id,
      adminUsername: r.admin_username,
      adminRole: r.admin_role,
      ip: r.ip,
      metadata: r.metadata,
      createdAt: new Date(r.created_at).toISOString(),
      bulkCount: null,
    })),
    ...bulkRows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      adminUserId: r.admin_id,
      adminUsername: r.admin_username,
      adminRole: r.admin_role,
      ip: r.ip,
      metadata: r.metadata,
      createdAt: new Date(r.created_at).toISOString(),
      bulkCount: r.bulk_count ?? null,
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const grandTotal = total + bulkRows.length;

  return {
    events: events.slice(0, USER_ADMIN_AUDIT_MAX),
    total: grandTotal,
    truncated: grandTotal > Math.min(events.length, USER_ADMIN_AUDIT_MAX),
  };
}
