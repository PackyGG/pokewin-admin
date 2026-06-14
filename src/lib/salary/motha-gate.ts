import type { SessionPayload } from "@/lib/session";
import { requireOwner, isOwnerById, MAIN_OWNER_USERNAME } from "@/lib/owners";

/**
 * Salary access is now OWNER-gated. It used to be a hard-coded founder
 * username allowlist (`motha`, `void`, `kotha`); with the owner tier it admits
 * any owner instead — `void` / `kotha` lose access until made owners (intended
 * per the owner-tier rollout). The salary system still holds an Ethereum
 * private key + broadcasts on-chain USDT transfers, so this stays strictly
 * above "any admin": a plain admin who is NOT an owner cannot see the page or
 * call the actions.
 *
 * Export kept for backward-compat; it now reflects only the permanent root
 * owner. The live owner set is the `is_owner` flag, not this constant.
 */
export const SALARY_ADMIN_USERNAMES = [MAIN_OWNER_USERNAME] as const;

/**
 * Server-side gate. Redirects out to /dashboard if the caller isn't an owner.
 * Returns the session augmented with the verified username so call sites don't
 * have to re-query. Function name kept as `requireMotha` for historical
 * stability — it now checks owner status, not a username literal.
 */
export async function requireMotha(): Promise<
  SessionPayload & { username: string }
> {
  return requireOwner();
}

/** Non-throwing owner check for conditionally rendering UI elsewhere. */
export async function isMotha(userId: string): Promise<boolean> {
  return isOwnerById(userId);
}
