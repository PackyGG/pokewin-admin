import type { SessionPayload } from "@/lib/session";
import { requireMainOwner, isMainOwnerUsername } from "@/lib/owners";
import { adminDb } from "@/lib/admin-db";

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
    const row = await adminDb.admin_users.findUnique({
      where: { id: userId },
      select: { username: true, is_active: true },
    });
    if (!row?.is_active) return false;
    return isMainOwnerUsername(row.username);
  } catch {
    return false;
  }
}
