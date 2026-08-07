import type { SessionPayload } from "@/lib/session";

/**
 * Ultra Lossback is deliberately narrower than owner/admin access. These are
 * exact canonical admin usernames: no owner flag, role capability, trimming,
 * or case-folding may widen this list.
 */
export const ULTRA_LOSSBACK_ADMIN_USERNAMES = ["motha", "hifoen"] as const;

const ULTRA_LOSSBACK_ADMINS = new Set<string>(
  ULTRA_LOSSBACK_ADMIN_USERNAMES,
);

export function hasUltraLossbackUsernameAccess(
  username: string | null | undefined,
): boolean {
  return typeof username === "string" && ULTRA_LOSSBACK_ADMINS.has(username);
}

/** Exact two-admin gate. Generic admins, owners, and capabilities do not pass. */
export function canUseUltraLossback(
  session: Pick<SessionPayload, "role" | "roles" | "username">,
): boolean {
  const effectiveRoles = session.roles?.length
    ? session.roles
    : [session.role];
  return effectiveRoles.includes("admin") &&
    hasUltraLossbackUsernameAccess(session.username);
}
