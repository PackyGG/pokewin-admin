import { adminDb } from "@/lib/admin-db";

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
    const events = await adminDb.admin_audit_events.findMany({
      where: { target_user_id: userId, event_type: "role_changed" },
      orderBy: { created_at: "asc" },
      select: { metadata: true, created_at: true },
    });
    for (const e of events) {
      const meta =
        e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata)
          ? (e.metadata as Record<string, unknown>)
          : {};
      if (meta.new_role === "creator") {
        return {
          everCreatorByAudit: true,
          creatorSince: e.created_at.toISOString(),
        };
      }
    }
    return { everCreatorByAudit: false, creatorSince: null };
  } catch {
    return { everCreatorByAudit: false, creatorSince: null };
  }
}
