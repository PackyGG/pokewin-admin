"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { BackendApiError } from "@/lib/backend-api/errors";
import {
  getUserKyc,
  requireUserKyc,
  reviewUserKyc,
  type UserKycStatus,
} from "@/lib/backend-api/kyc";
import { getReadDrizzleDb } from "@/lib/db";
import { user } from "@/lib/db-schema/main/schema";
import { lockFiatAndWithdrawals } from "@/lib/antifraud/fiat-credit-review";
import {
  getUserFeatureLocks,
  updateUserRewardLocks,
} from "@/lib/backend-api/feature-locks";
import { resolveAdminMainUserId } from "@/lib/resolve-admin-main-user-id";
import { userDetailTag } from "@/lib/queries/users-detail-cache";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";
import { require2FA } from "@/lib/require-2fa";

type ActionResult =
  | { success: true; data: UserKycStatus; userId: string }
  | { success: false; error: string };

const requireSchema = z.object({
  account: z.string().trim().min(1).max(320),
  reason: z.string().trim().min(3).max(500),
  levelName: z.string().trim().max(100).optional(),
  credential: z.string().trim().min(1).max(4_096),
  idempotencyKey: z.string().uuid(),
});

const reviewSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  decision: z.enum(["safe", "rejected"]),
  expectedCycle: z.number().int().positive(),
  credential: z.string().trim().min(1).max(4_096),
  idempotencyKey: z.string().uuid(),
});

function friendlyError(error: unknown): string {
  if (error instanceof BackendApiError) {
    if (error.isNotFound) return "Account was not found by the backend.";
    if (error.isConflict) {
      return "KYC changed since this page loaded. Refresh and try again.";
    }
    return error.message;
  }
  return "The backend KYC service could not be reached.";
}

async function resolveAccount(account: string): Promise<string | null> {
  const db = await getReadDrizzleDb();
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(
      or(
        eq(user.id, account),
        sql`lower(${user.username}) = lower(${account})`,
        sql`lower(${user.display_username}) = lower(${account})`,
        sql`lower(${user.email}) = lower(${account})`,
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0].id : null;
}

export async function requireAccountKyc(
  input: z.input<typeof requireSchema>,
): Promise<ActionResult> {
  const session = await requireAntifraudManager(
    "Only owners and admins can change KYC requirements.",
  );
  const parsed = requireSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  await require2FA(session.userId, parsed.data.credential);

  const userId = await resolveAccount(parsed.data.account);
  if (!userId) {
    return {
      success: false,
      error: "Enter one exact player ID, username, display name, or email.",
    };
  }

  // Order matters: lock first, KYC second — same sequence the automated Fiat
  // identity containment path uses (see fiat-identity-containment.ts). The
  // lock is what actually stops money leaving, so it must not wait on the
  // backend's KYC API, and it must be in place before we ask the player to
  // verify. This used to instead REFUSE unless the account was already
  // locked by some other path; now requiring KYC locks the account itself.
  const actorMainUserId = await resolveAdminMainUserId(session.userId);
  try {
    await lockFiatAndWithdrawals({
      userId,
      actorMainUserId,
      reason: parsed.data.reason,
    });
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Deposits and withdrawals could not be locked. KYC was not required.",
    };
  }
  let tipsLocked = true;
  try {
    const currentLocks = await getUserFeatureLocks(userId);
    if (!currentLocks.locked_reward_categories.includes("tips")) {
      await updateUserRewardLocks(
        userId,
        [...currentLocks.locked_reward_categories, "tips"],
        actorMainUserId ?? undefined,
      );
    }
  } catch (error) {
    tipsLocked = false;
    console.error("[antifraud-kyc] failed to lock tips alongside KYC:", error);
  }

  let data: UserKycStatus;
  try {
    await requireUserKyc({
      userId,
      adminId: session.userId,
      reason: parsed.data.reason,
      levelName: parsed.data.levelName || undefined,
    });
    data = await getUserKyc(userId);
  } catch (error) {
    return { success: false, error: friendlyError(error) };
  }

  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "user_kyc_required",
      targetUserId: userId,
      metadata: {
        source: "antifraud_kyc_workspace",
        reason: parsed.data.reason,
        levelName: parsed.data.levelName || null,
        verificationCycle: data.verificationCycle,
        idempotencyKey: parsed.data.idempotencyKey,
        depositsWithdrawalsLocked: true,
        tipsLocked,
      },
    });
  } catch (error) {
    // The backend owns the authoritative KYC audit trail. Do not invite a
    // duplicate require/retry after that mutation succeeded just because the
    // dashboard's secondary ADMIN-DB audit mirror was temporarily unavailable.
    console.error("[antifraud-kyc] secondary require audit failed:", error);
  }

  revalidatePath("/antifraud/kyc");
  revalidateTag(userDetailTag(userId));
  return { success: true, data, userId };
}

export async function reviewAccountKyc(
  input: z.input<typeof reviewSchema>,
): Promise<ActionResult> {
  const session = await requireAntifraudManager(
    "Only owners and admins can review KYC decisions.",
  );
  const parsed = reviewSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  await require2FA(session.userId, parsed.data.credential);

  let data: UserKycStatus;
  try {
    await reviewUserKyc({
      userId: parsed.data.userId,
      adminId: session.userId,
      decision: parsed.data.decision,
      expectedCycle: parsed.data.expectedCycle,
    });
    data = await getUserKyc(parsed.data.userId);
  } catch (error) {
    return { success: false, error: friendlyError(error) };
  }

  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "user_kyc_reviewed",
      targetUserId: parsed.data.userId,
      metadata: {
        source: "antifraud_kyc_workspace",
        decision: parsed.data.decision,
        verificationCycle: parsed.data.expectedCycle,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });
  } catch (error) {
    console.error("[antifraud-kyc] secondary review audit failed:", error);
  }

  revalidatePath("/antifraud/kyc");
  revalidateTag(userDetailTag(parsed.data.userId));
  return {
    success: true,
    data,
    userId: parsed.data.userId,
  };
}
