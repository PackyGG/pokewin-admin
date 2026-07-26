import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";

/**
 * Whether a user was ever promoted to the creator role, derived from the
 * admin audit trail (event_type = "role_changed", metadata.new_role =
 * "creator"). Returns the earliest such promotion date so the UI can
 * show "Creator since …".
 *
 * NOTE: this only sees role changes made through the admin panel. A
 * creator promoted on the main site and never touched here won't have an
 * audit row — the caller supplements this with the user's owned
 * affiliate codes (a creator-only artifact) for the final flag.
 *
 * Admin-DB only; failures degrade to "no history" so the user page never
 * breaks over an audit lookup.
 */
export async function getUserCreatorHistory(userId: string): Promise<{
  everCreatorByAudit: boolean;
  creatorSince: string | null;
}> {
  try {
    const result = await adminDrizzle.execute<{ created_at: Date }>(sql`
      SELECT created_at
      FROM admin_audit_events
      WHERE target_user_id = ${userId}
        AND event_type = 'role_changed'
        AND metadata->>'new_role' = 'creator'
      ORDER BY created_at ASC
      LIMIT 1
    `);
    const event = result.rows[0];
    if (event) {
      return {
        everCreatorByAudit: true,
        creatorSince: new Date(event.created_at).toISOString(),
      };
    }
    return { everCreatorByAudit: false, creatorSince: null };
  } catch {
    return { everCreatorByAudit: false, creatorSince: null };
  }
}
