import { redirect } from "next/navigation";
import { adminDb } from "@/lib/admin-db";
import { verifySession } from "@/lib/dal";
import type { SessionPayload } from "@/lib/session";

/**
 * Founder allowlist — usernames that are allowed to touch employee
 * salaries.
 *
 * The salary system holds an Ethereum private key in plaintext +
 * broadcasts on-chain USDT transfers. Restricting to a specific set
 * of usernames is intentionally stricter than "any admin" — even
 * other admin-role users won't see the page or be able to call the
 * actions. Match is case-insensitive against admin_users.username.
 *
 * Hard-coded by the user; if ownership ever changes, change this
 * single constant + audit who has the same admin_users.username.
 */
export const SALARY_ADMIN_USERNAMES = ["motha", "void", "kotha"] as const;

/**
 * Server-side gate. Resolves the current admin user, fetches their
 * username from the DB (verifySession only carries id + role), and
 * redirects out if it isn't in the founder allowlist.
 *
 * Returns the session augmented with the verified username so call
 * sites don't have to re-query.
 *
 * Function name kept as `requireMotha` for historical stability —
 * internally it now checks the wider founder allowlist.
 */
export async function requireMotha(): Promise<
  SessionPayload & { username: string }
> {
  const session = await verifySession();

  // verifySession is cached, but `username` isn't on its payload.
  // Doing a tiny lookup here keeps the check truthful — a freshly
  // renamed admin user would lose access without waiting for the
  // 8h JWT to expire.
  const user = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { username: true, is_active: true },
  });

  if (!user?.is_active || !isAllowedUsername(user.username)) {
    redirect("/dashboard");
  }

  return { ...session, username: user.username };
}

/** Non-throwing variant for conditionally rendering UI elsewhere. */
export async function isMotha(userId: string): Promise<boolean> {
  const user = await adminDb.admin_users.findUnique({
    where: { id: userId },
    select: { username: true, is_active: true },
  });
  return Boolean(user?.is_active && isAllowedUsername(user.username));
}

/**
 * Case-insensitive membership check against the founder allowlist.
 * Centralized so the gate + the isMotha() helper stay in sync.
 */
function isAllowedUsername(username: string): boolean {
  const lower = username.toLowerCase();
  return SALARY_ADMIN_USERNAMES.some((u) => u === lower);
}
