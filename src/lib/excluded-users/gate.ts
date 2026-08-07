import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { verifySession } from "@/lib/dal";
import { admin_users } from "@/lib/db-schema/admin/schema";
import { hasExcludedUsersAccess } from "@/lib/excluded-users/access-shared";
import type { SessionPayload } from "@/lib/session";

/**
 * Gate for the Excluded Users page and every mutation on it. Access uses a
 * narrow username allowlist that grants no unrelated owner or role powers.
 */
export async function requireExcludedUsersAccess(): Promise<
  SessionPayload & { username: string }
> {
  const session = await verifySession();
  if (!hasExcludedUsersAccess(session.username)) {
    redirect("/dashboard");
  }
  return { ...session, username: session.username };
}

/** DB-fresh, fail-closed access check for conditional UI. */
async function canManageExcludedUsers(
  userId: string,
): Promise<boolean> {
  try {
    const [row] = await adminDrizzle
      .select({ username: admin_users.username })
      .from(admin_users)
      .where(
        and(eq(admin_users.id, userId), eq(admin_users.is_active, true)),
      )
      .limit(1);
    return row ? hasExcludedUsersAccess(row.username) : false;
  } catch {
    return false;
  }
}
