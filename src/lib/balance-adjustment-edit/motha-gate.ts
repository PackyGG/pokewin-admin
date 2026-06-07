import { adminDb } from "@/lib/admin-db";
import { verifySession } from "@/lib/dal";
import type { SessionPayload } from "@/lib/session";

/**
 * Single-account allowlist for editing balance-adjustment tags +
 * descriptions on the user detail page. ONLY the `motha` admin may
 * mutate ledger metadata after the fact — tighter than the salary
 * founder allowlist because the user explicitly asked for motha-only
 * access to this surface.
 */
const ALLOWED_USERNAMES = ["motha"] as const;

/**
 * Throwing server-side gate for balance-adjustment edit actions.
 * Re-reads the live username from the ADMIN DB (verifySession only
 * carries id + role).
 */
export async function requireBalanceAdjustmentEditAdmin(): Promise<
  SessionPayload & { username: string }
> {
  const session = await verifySession();

  const user = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { username: true, is_active: true },
  });

  if (!user?.is_active || !isAllowed(user.username)) {
    throw new Error("Not permitted.");
  }

  return { ...session, username: user.username };
}

/** Non-throwing variant for conditionally rendering the edit affordance. */
export async function canEditBalanceAdjustments(
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
