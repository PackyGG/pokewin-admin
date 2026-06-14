import { verifySession, sessionIsOwner } from "@/lib/dal";
import { isOwnerById } from "@/lib/owners";
import type { SessionPayload } from "@/lib/session";

/**
 * Editing balance-adjustment tags + descriptions on the user detail page is now
 * OWNER-gated (was `motha`-only by username). Only an owner may mutate ledger
 * metadata after the fact.
 */

/**
 * Throwing server-side gate for balance-adjustment edit actions. THROWS (does
 * not redirect) because the caller is an RPC-style Server Action, not a route
 * render. `session.isOwner` is read DB-fresh by verifySession; the permanent
 * `motha` username is owner regardless.
 */
export async function requireBalanceAdjustmentEditAdmin(): Promise<
  SessionPayload & { username: string }
> {
  const session = await verifySession();
  if (!sessionIsOwner(session)) {
    throw new Error("Not permitted.");
  }
  return { ...session, username: session.username };
}

/** Non-throwing owner check for conditionally rendering the edit affordance. */
export async function canEditBalanceAdjustments(
  userId: string,
): Promise<boolean> {
  return isOwnerById(userId);
}
