import type { SessionPayload } from "@/lib/session";
import { requireOwner, isOwnerById, isMainOwnerUsername } from "@/lib/owners";

/**
 * The Insights section (/insights/**, /ggr) is now OWNER-gated (was `motha`-only
 * by username). Any owner can view + navigate these routes; a plain admin who
 * is not an owner is redirected to /dashboard.
 *
 * Export kept for backward-compat; it now reflects only the permanent root
 * owner. The live owner set is the `is_owner` flag.
 */
export const INSIGHTS_OWNER_USERNAMES = ["motha"] as const;

export async function requireInsightsOwner(): Promise<
  SessionPayload & { username: string }
> {
  return requireOwner();
}

/** Non-throwing owner check for conditional UI bits. */
export async function canAccessInsights(userId: string): Promise<boolean> {
  return isOwnerById(userId);
}

/**
 * Pure username predicate — can only confirm the permanent MAIN owner from a
 * bare username (full owner status otherwise needs the DB `is_owner` flag).
 * Kept for callers that hold only a username.
 */
export function isInsightsOwnerUsername(
  username: string | null | undefined,
): boolean {
  return isMainOwnerUsername(username);
}
