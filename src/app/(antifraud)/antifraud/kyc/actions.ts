"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import { createAdminAuditEventDurable } from "@/lib/admin-audit";
import { BackendApiError } from "@/lib/backend-api/errors";
import {
  getUserKyc,
  requireUserKyc,
  reviewUserKyc,
  type UserKycStatus,
} from "@/lib/backend-api/kyc";
import { getPrimaryDrizzleDb, getReadDrizzleDb } from "@/lib/db";
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
import { requireCapability } from "@/lib/require-capability";
import { blockKnownUserIdentifiers } from "@/lib/antifraud/user-identifier-blocking";
import { enqueueKycRequiredReview } from "@/lib/discord-notifications/kyc-required";

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

const banSchema = z.object({
  userId: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(4).max(500),
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
  // Tips are part of the same Require-KYC containment package as deposits
  // and withdrawals. Soft-failing here used to let the action report success
  // while tip rails stayed open — hard-fail before KYC so staff never see a
  // false "locked" outcome.
  try {
    const currentLocks = await getUserFeatureLocks(userId);
    if (!currentLocks.locked_reward_categories.includes("tips")) {
      const updated = await updateUserRewardLocks(
        userId,
        [...currentLocks.locked_reward_categories, "tips"],
        actorMainUserId ?? undefined,
      );
      if (!updated.locked_reward_categories.includes("tips")) {
        throw new Error("Backend did not confirm the tips reward lock");
      }
    }
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Tips could not be locked. KYC was not required.",
    };
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
    // Durable: retries, then a fallback row, so a transient ADMIN-DB blip
    // can't leave this KYC mutation without a per-target audit row.
    const outcome = await createAdminAuditEventDurable({
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
        tipsLocked: true,
      },
    });
    if (outcome.status === "lost") {
      console.error(
        "[antifraud-kyc] secondary require audit failed:",
        outcome.error,
      );
    }
  } catch (error) {
    // The backend owns the authoritative KYC audit trail. Do not invite a
    // duplicate require/retry after that mutation succeeded just because the
    // dashboard's secondary ADMIN-DB audit mirror was temporarily unavailable.
    console.error("[antifraud-kyc] secondary require audit failed:", error);
  }

  try {
    await enqueueKycRequiredReview({
      userId,
      reason: parsed.data.reason,
      levelName: parsed.data.levelName || undefined,
      verificationCycle: data.verificationCycle,
    });
  } catch (error) {
    // KYC is already authoritative in the backend. Keep the successful staff
    // action and surface a delivery failure through application monitoring.
    console.error("[antifraud-kyc] Discord notification failed:", error);
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
    const outcome = await createAdminAuditEventDurable({
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
    if (outcome.status === "lost") {
      console.error(
        "[antifraud-kyc] secondary review audit failed:",
        outcome.error,
      );
    }
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

/**
 * Ban the player and close the current KYC cycle as rejected. The KYC row is
 * retained as history; only the Active/Waiting queue entry disappears.
 *
 * MAIN and the backend KYC state cannot share a transaction. Ban first so a
 * failed follow-up never leaves a known-bad account active. A retry recognizes
 * the existing ban and only finishes the KYC decision.
 */
export async function banAccountFromKyc(
  input: z.input<typeof banSchema>,
): Promise<ActionResult> {
  const session = await requireAntifraudManager(
    "Only owners and admins can ban accounts from KYC.",
  );
  await requireCapability(session, "__can_ban_users", "ban users from KYC");
  const parsed = banSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }
  await require2FA(session.userId, parsed.data.credential);

  let current: UserKycStatus;
  try {
    current = await getUserKyc(parsed.data.userId);
  } catch (error) {
    return { success: false, error: friendlyError(error) };
  }
  if (current.verificationCycle !== parsed.data.expectedCycle) {
    return {
      success: false,
      error: "KYC changed since this page loaded. Refresh and try again.",
    };
  }

  const db = await getPrimaryDrizzleDb();
  const existing = await db.execute<{ is_banned: boolean }>(sql`
    SELECT is_banned FROM "user" WHERE id = ${parsed.data.userId} LIMIT 1
  `);
  const account = existing.rows[0];
  if (!account) return { success: false, error: "Account was not found." };

  const reason = `KYC review: ${parsed.data.reason}`.slice(0, 500);
  let newlyBanned = false;
  let identifiers: Awaited<ReturnType<typeof blockKnownUserIdentifiers>> | null = null;
  if (!account.is_banned) {
    const actorMainUserId = await resolveAdminMainUserId(session.userId);
    try {
      identifiers = await blockKnownUserIdentifiers({
        db,
        userId: parsed.data.userId,
        reason,
        actorId: session.userId,
        actorUsername: session.username ?? undefined,
      });
      const updated = await db.transaction(async (tx) => {
        const result = await tx.execute<{ id: string }>(sql`
          UPDATE "user"
             SET is_banned = TRUE,
                 banned_reason = ${reason},
                 banned_at = NOW(),
                 banned_by = ${actorMainUserId},
                 updated_at = NOW()
           WHERE id = ${parsed.data.userId}
             AND is_banned = FALSE
           RETURNING id
        `);
        await tx.execute(sql`
          DELETE FROM session WHERE "userId" = ${parsed.data.userId}
        `);
        return result.rows.length;
      });
      newlyBanned = updated > 0;
    } catch (error) {
      console.error("[antifraud-kyc] account ban failed:", error);
      if (identifiers) {
        const partialAudit = await createAdminAuditEventDurable({
          adminUserId: session.userId,
          eventType: "antifraud_ban_partial_failure",
          targetUserId: parsed.data.userId,
          metadata: {
            source: "antifraud_kyc_workspace",
            reason,
            verificationCycle: parsed.data.expectedCycle,
            idempotencyKey: parsed.data.idempotencyKey,
            identifier_blocklist_applied: true,
            blacklisted_ip_count: identifiers.ipCount,
            blacklisted_fingerprint_count: identifiers.fingerprintCount,
            blocklist_changes: identifiers.changedCount,
            identifier_delivery_status: identifiers.deliveryStatus,
            identifier_operation_id: identifiers.operationId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        if (partialAudit.status === "lost") {
          console.error("[antifraud-kyc] partial ban audit lost:", partialAudit.error);
        }
      }
      return {
        success: false,
        error: "The account could not be banned. Its KYC record was left active.",
      };
    }

    if (newlyBanned) {
      const outcome = await createAdminAuditEventDurable({
        adminUserId: session.userId,
        eventType: "account_banned",
        targetUserId: parsed.data.userId,
        metadata: {
          source: "antifraud_kyc_workspace",
          reason,
          verificationCycle: parsed.data.expectedCycle,
          idempotencyKey: parsed.data.idempotencyKey,
          blacklisted_ip_count: identifiers?.ipCount ?? 0,
          blacklisted_fingerprint_count: identifiers?.fingerprintCount ?? 0,
          blocklist_changes: identifiers?.changedCount ?? 0,
        },
      });
      if (outcome.status === "lost") {
        console.error("[antifraud-kyc] ban audit lost:", outcome.error);
      }
    }
  }

  try {
    if (current.adminDecision !== "rejected") {
      await reviewUserKyc({
        userId: parsed.data.userId,
        adminId: session.userId,
        decision: "rejected",
        expectedCycle: parsed.data.expectedCycle,
      });
    }
    current = await getUserKyc(parsed.data.userId);
  } catch (error) {
    const outcome = await createAdminAuditEventDurable({
      adminUserId: session.userId,
      eventType: "user_kyc_reviewed",
      targetUserId: parsed.data.userId,
      metadata: {
        source: "antifraud_kyc_workspace",
        decision: "rejected",
        outcome: "partial_failure",
        accountBanned: newlyBanned || account.is_banned,
        verificationCycle: parsed.data.expectedCycle,
        idempotencyKey: parsed.data.idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    if (outcome.status === "lost") {
      console.error("[antifraud-kyc] partial failure audit lost:", outcome.error);
    }
    return {
      success: false,
      error:
        "The account is banned, but KYC could not be removed from the active list. Retry the Ban action.",
    };
  }

  const reviewAudit = await createAdminAuditEventDurable({
    adminUserId: session.userId,
    eventType: "user_kyc_reviewed",
    targetUserId: parsed.data.userId,
    metadata: {
      source: "antifraud_kyc_workspace",
      decision: "rejected",
      reason,
      accountBanned: true,
      verificationCycle: parsed.data.expectedCycle,
      idempotencyKey: parsed.data.idempotencyKey,
    },
  });
  if (reviewAudit.status === "lost") {
    console.error("[antifraud-kyc] ban review audit lost:", reviewAudit.error);
  }

  revalidatePath("/antifraud/kyc");
  revalidateTag("users-list");
  revalidateTag("users-list-stats");
  revalidateTag(userDetailTag(parsed.data.userId));
  return { success: true, data: current, userId: parsed.data.userId };
}
