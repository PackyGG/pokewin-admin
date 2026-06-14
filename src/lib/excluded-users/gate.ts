import type { SessionPayload } from "@/lib/session";
import { requireOwner, isOwnerById } from "@/lib/owners";

/**
 * Access to the excluded-users (blacklist) page + its server actions is now
 * OWNER-gated. Previously hard-coded to the `motha` username alone; it now
 * admits any owner (motha is the permanent root owner). The throwing gate
 * redirects to /dashboard for a non-owner — identical behaviour to before,
 * just driven by the owner flag instead of a username literal.
 *
 * Name + signature kept (`requireExcludedUsersAccess` returning the session +
 * verified username) so the page + actions call sites are unchanged.
 */
export async function requireExcludedUsersAccess(): Promise<
  SessionPayload & { username: string }
> {
  return requireOwner();
}

/** Non-throwing owner check for conditional UI bits. */
export async function canManageExcludedUsers(
  userId: string,
): Promise<boolean> {
  return isOwnerById(userId);
}
