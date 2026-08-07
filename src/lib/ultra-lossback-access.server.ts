import "server-only";

import { eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users } from "@/lib/db-schema/admin/schema";
import type { SessionPayload } from "@/lib/session";
import { canUseUltraLossback } from "@/lib/ultra-lossback-access";

/**
 * DB-fresh form of the exact two-admin gate. The signed session username can
 * be up to 12 hours old, so the exceptional no-2FA money path and its private
 * readers re-confirm the active canonical admin row by immutable user id.
 */
export async function canUseUltraLossbackFresh(
  session: Pick<SessionPayload, "userId" | "role" | "roles" | "username">,
): Promise<boolean> {
  if (!canUseUltraLossback(session)) return false;
  try {
    const row = (
      await adminDrizzle
        .select({
          username: admin_users.username,
          role: admin_users.role,
          roles: admin_users.roles,
          isActive: admin_users.is_active,
        })
        .from(admin_users)
        .where(eq(admin_users.id, session.userId))
        .limit(1)
    )[0];
    return row?.isActive === true && canUseUltraLossback({
      username: row.username,
      role: row.role,
      roles: row.roles,
    });
  } catch {
    return false;
  }
}
