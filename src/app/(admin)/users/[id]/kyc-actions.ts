"use server";

// TAG-ONLY invalidation for the user-detail surface — same rationale as
// other user-control actions. The card updates in place from the action's return
// value, so a current-route `revalidatePath('/users/[id]')` would only
// re-render + re-suspend the page and lose the admin's scroll. Busting the
// per-user `users-detail-${userId}` tag keeps the cached reads fresh.
import { revalidateTag } from "next/cache";
import { requirePageAccess } from "@/lib/dal";
import type { UserKycStatus } from "@/lib/backend-api/kyc";
import {
  requireAccountKyc,
  reviewAccountKyc,
} from "@/app/(antifraud)/antifraud/kyc/actions";

/**
 * KYC admin actions. The backend owns the KYC state machine (require / review),
 * so the panel never writes it directly — every mutation goes through the
 * canonical Antifraud action, which applies the full containment package,
 * writes a durable audit, and enforces the verification-cycle guard.
 *
 * Both entry points therefore share the same manager + fresh-2FA boundary.
 */
export async function requireKycAction(params: {
  userId: string;
  reason: string;
  levelName?: string;
  credential: string;
  idempotencyKey: string;
}): Promise<
  | { success: true; data: UserKycStatus | null }
  | { success: false; error: string }
> {
  await requirePageAccess("/users");
  const result = await requireAccountKyc({
    account: params.userId,
    reason: params.reason,
    levelName: params.levelName,
    credential: params.credential,
    idempotencyKey: params.idempotencyKey,
  });
  if (!result.success) return result;
  revalidateTag(`users-detail-${params.userId}`);
  return { success: true, data: result.data };
}

export async function reviewKycAction(params: {
  userId: string;
  decision: "safe" | "rejected";
  expectedCycle: number;
  credential: string;
  idempotencyKey: string;
}): Promise<
  | { success: true; data: UserKycStatus | null }
  | { success: false; error: string }
> {
  await requirePageAccess("/users");
  const result = await reviewAccountKyc(params);
  if (!result.success) return result;
  revalidateTag(`users-detail-${params.userId}`);
  return { success: true, data: result.data };
}
