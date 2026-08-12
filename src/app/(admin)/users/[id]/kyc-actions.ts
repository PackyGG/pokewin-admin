"use server";

// TAG-ONLY invalidation for the user-detail surface — same rationale as
// other user-control actions. The card updates in place from the action's return
// value, so a current-route `revalidatePath('/users/[id]')` would only
// re-render + re-suspend the page and lose the admin's scroll. Busting the
// per-user `users-detail-${userId}` tag keeps the cached reads fresh.
import { revalidateTag } from "next/cache";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { BackendApiError } from "@/lib/backend-api/errors";
import {
  getUserKyc,
  requireUserKyc,
  reviewUserKyc,
  type UserKycStatus,
} from "@/lib/backend-api/kyc";
import { enqueueKycRequiredReview } from "@/lib/discord-notifications/kyc-required";

/**
 * KYC admin actions. The backend owns the KYC state machine (require / review),
 * so the panel never writes it directly — every mutation goes through the
 * backend admin API, which audit-logs and enforces the verification-cycle
 * guard on its side. These actions ALSO write the panel's own audit event.
 *
 * Admin-only — requiring KYC re-locks a user's withdrawals and marking `safe`
 * lifts a real-money gate, so both sit behind requireAdmin() (same gate as the
 * fraud-locks + wager-requirement overrides) on top of the /users page gate.
 */
function friendlyError(err: unknown): string {
  if (err instanceof BackendApiError) {
    if (err.isNotFound) return "User not found in backend";
    if (err.isConflict) {
      return "KYC state changed since this loaded — refresh and try again";
    }
    return err.message;
  }
  return "Backend not updated yet — feature awaiting backend deploy";
}

export async function requireKycAction(params: {
  userId: string;
  reason: string;
  levelName?: string;
}): Promise<
  { success: true; data: UserKycStatus } | { success: false; error: string }
> {
  await requirePageAccess("/users");
  const session = await requireAdmin();

  const userId = params.userId;
  if (!userId || typeof userId !== "string") {
    return { success: false, error: "Invalid user id" };
  }
  const reason = params.reason?.trim() ?? "";
  // Mirror the backend's own bound (reason: 3..500) so a bad input fails here
  // with a clear message instead of a raw 400 round-trip.
  if (reason.length < 3 || reason.length > 500) {
    return {
      success: false,
      error: "Reason must be between 3 and 500 characters",
    };
  }
  const levelName = params.levelName?.trim() || undefined;

  try {
    await requireUserKyc({
      userId,
      adminId: session.userId,
      reason,
      levelName,
    });
  } catch (err) {
    return { success: false, error: friendlyError(err) };
  }

  // Re-read the fresh status so the card reflects the new cycle + pending
  // decision (the require endpoint only returns the cycle number).
  let data: UserKycStatus;
  try {
    data = await getUserKyc(userId);
  } catch (err) {
    return { success: false, error: friendlyError(err) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_kyc_required",
    targetUserId: userId,
    metadata: {
      reason,
      levelName: levelName ?? null,
      verificationCycle: data.verificationCycle,
    },
  });

  try {
    await enqueueKycRequiredReview({
      userId,
      reason,
      levelName,
      verificationCycle: data.verificationCycle,
    });
  } catch (error) {
    console.error("[user-kyc] Discord notification failed:", error);
  }

  revalidateTag(`users-detail-${userId}`);
  return { success: true, data };
}

export async function reviewKycAction(params: {
  userId: string;
  decision: "safe" | "rejected";
  expectedCycle: number;
}): Promise<
  { success: true; data: UserKycStatus } | { success: false; error: string }
> {
  await requirePageAccess("/users");
  const session = await requireAdmin();

  const userId = params.userId;
  if (!userId || typeof userId !== "string") {
    return { success: false, error: "Invalid user id" };
  }
  if (params.decision !== "safe" && params.decision !== "rejected") {
    return { success: false, error: "Invalid decision" };
  }
  if (!Number.isInteger(params.expectedCycle) || params.expectedCycle < 1) {
    return { success: false, error: "Invalid verification cycle" };
  }

  try {
    await reviewUserKyc({
      userId,
      adminId: session.userId,
      decision: params.decision,
      expectedCycle: params.expectedCycle,
    });
  } catch (err) {
    return { success: false, error: friendlyError(err) };
  }

  let data: UserKycStatus;
  try {
    data = await getUserKyc(userId);
  } catch (err) {
    return { success: false, error: friendlyError(err) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_kyc_reviewed",
    targetUserId: userId,
    metadata: {
      decision: params.decision,
      verificationCycle: params.expectedCycle,
    },
  });

  revalidateTag(`users-detail-${userId}`);
  return { success: true, data };
}
