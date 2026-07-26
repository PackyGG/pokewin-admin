import type { SessionPayload } from "@/lib/session";
import { requireMainOwner, isMainOwnerUsername } from "@/lib/owners";
import { and, eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users } from "@/lib/db-schema/admin/schema";

/**
 * Access to the excluded-users (blacklist) page + its server actions is
 * MAIN-OWNER-ONLY — restricted to the root `motha` account, NOT to every owner.
 * (Owner-management surfaces like Salaries admit any owner; the blacklist is
 * intentionally tighter — only the root owner may see or mutate it.) The
 * throwing gate redirects to /dashboard for anyone else via `requireMainOwner`.
 *
 * Name + signature kept (`requireExcludedUsersAccess` returning the session +
 * verified username) so the page + actions call sites are unchanged.
 */
export async function requireExcludedUsersAccess(): Promise<
  SessionPayload & { username: string }
> {
  return requireMainOwner();
}

/**
 * Non-throwing MAIN-OWNER check for conditional UI bits — true only for the
 * root `motha` account. Resolves the username from the admin id (DB-fresh,
 * gated on `is_active`); fail-closed on any read error.
 */
export async function canManageExcludedUsers(
  userId: string,
): Promise<boolean> {
  try {
    const [row] = await adminDrizzle.select({ username: admin_users.username })
      .from(admin_users).where(and(eq(admin_users.id, userId),
        eq(admin_users.is_active, true))).limit(1);
    if (!row) return false;
    return isMainOwnerUsername(row.username);
  } catch {
    return false;
  }
}
