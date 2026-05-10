import { redirect } from "next/navigation";
import { adminDb } from "@/lib/admin-db";
import { verifySession } from "@/lib/dal";
import type { SessionPayload } from "@/lib/session";

/**
 * Single-account allowlist for the excluded-users page + its server
 * actions. ONLY the `motha` admin can read or mutate the blacklist —
 * tighter than the salary founder allowlist (which also includes void
 * + kotha) because the user explicitly asked for motha-only access.
 *
 * If ownership ever needs to widen, change this constant; everything
 * downstream (page render, actions, sidebar entry) goes through this
 * one gate.
 */
const ALLOWED_USERNAMES = ["motha"] as const;

export async function requireExcludedUsersAccess(): Promise<
  SessionPayload & { username: string }
> {
  const session = await verifySession();

  const user = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { username: true, is_active: true },
  });

  if (!user?.is_active || !isAllowed(user.username)) {
    redirect("/dashboard");
  }

  return { ...session, username: user.username };
}

/** Non-throwing variant for conditional UI bits. */
export async function canManageExcludedUsers(
  userId: string,
): Promise<boolean> {
  const user = await adminDb.admin_users.findUnique({
    where: { id: userId },
    select: { username: true, is_active: true },
  });
  return Boolean(user?.is_active && isAllowed(user.username));
}

function isAllowed(username: string): boolean {
  const lower = username.toLowerCase();
  return ALLOWED_USERNAMES.some((u) => u === lower);
}
