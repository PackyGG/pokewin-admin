"use server";

// TAG-ONLY invalidation for the user-detail surface — same rationale as
// wager-requirement-actions.ts. The card updates in place from the action's
// return value, so a current-route `revalidatePath('/users/[id]')` would
// only re-render + re-suspend the page and lose the admin's scroll. Busting
// the per-user `users-detail-${userId}` tag keeps the cached reads fresh.
import { revalidateTag } from "next/cache";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { BackendApiError } from "@/lib/backend-api/errors";
import {
  getUserFeatureLocks,
  clearUserFraudLocks,
  type UserFeatureLocks,
} from "@/lib/backend-api/feature-locks";

/**
 * Clear a user's fraud-signal deposit + withdrawal locks (applied by the
 * backend after a card deposit refund/chargeback).
 *
 * Admin-only — lifting the lock re-enables real-money deposits/withdrawals,
 * so it sits behind requireAdmin() (same gate as the wager-requirement
 * overrides) on top of the /users page-access gate. Goes through the
 * backend API, which owns the lock table; the panel never writes it directly.
 */
function friendlyError(err: unknown): string {
  if (err instanceof BackendApiError) {
    if (err.isNotFound) return "User not found in backend";
    return err.message;
  }
  return "Backend not updated yet — feature awaiting backend deploy";
}

export async function clearUserFraudLocksAction(
  userId: string,
): Promise<
  { success: true; data: UserFeatureLocks } | { success: false; error: string }
> {
  await requirePageAccess("/users");
  const session = await requireAdmin();

  if (!userId || typeof userId !== "string") {
    return { success: false, error: "Invalid user id" };
  }

  // Read current for the audit old side (best-effort).
  let oldLocks: UserFeatureLocks | undefined;
  try {
    oldLocks = await getUserFeatureLocks(userId);
  } catch {
    oldLocks = undefined;
  }

  let result: UserFeatureLocks;
  try {
    result = await clearUserFraudLocks(userId, session.userId);
  } catch (err) {
    return { success: false, error: friendlyError(err) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_fraud_locks_cleared",
    targetUserId: userId,
    metadata: {
      old: oldLocks
        ? {
            locked_deposits_crypto: oldLocks.locked_deposits_crypto,
            locked_deposits_fiat: oldLocks.locked_deposits_fiat,
            locked_deposits_reason: oldLocks.locked_deposits_reason,
            locked_withdrawals_crypto: oldLocks.locked_withdrawals_crypto,
            locked_withdrawals_items: oldLocks.locked_withdrawals_items,
            locked_withdrawals_reason: oldLocks.locked_withdrawals_reason,
          }
        : null,
    },
  });

  revalidateTag(`users-detail-${userId}`);
  return { success: true, data: result };
}
