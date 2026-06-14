"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { WITHDRAWALS_LIST_TAG } from "@/lib/queries/withdrawals";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { backendApiRequest } from "@/lib/backend-api";
import { ok, fail, type ServerActionResult } from "@/lib/errors/server-action-result";
import { logError } from "@/lib/errors/logger";

/**
 * Process a pending withdrawal (pending → processing). For crypto
 * withdrawals this kicks the Fireblocks transfer; for physical ones
 * it just flips status so the warehouse picks it up.
 *
 * Returns ServerActionResult — callers must check `result.success`.
 * Capability + TOTP failures surface their error verbatim (verified
 * business state); unexpected crashes (backend down, DB blip) return
 * a generic message and log the cause to Vercel.
 */
export async function processWithdrawal(
  withdrawalId: string,
  totpCode: string,
): Promise<ServerActionResult<{ withdrawalId: string }>> {
  const db = await getDb();
  const session = await requirePageAccess("/withdrawals");
  try {
    await requireCapability(
      session,
      "__can_process_withdrawals",
      "process withdrawal requests",
    );
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }
  // Initiates a real Fireblocks crypto transfer (or marks the physical
  // withdrawal as ready to ship). Money-moving action → TOTP gate.
  try {
    await require2FA(session.userId, totpCode);
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "2FA verification failed",
      "TOTP_INVALID",
    );
  }

  const withdrawal = await db.card_withdrawal_requests.findUnique({
    where: { id: withdrawalId },
  });
  if (!withdrawal) {
    return fail("Withdrawal not found", "NOT_FOUND");
  }
  if (withdrawal.status !== "pending") {
    return fail(
      "This withdrawal is no longer pending — refresh and check its current status.",
      "INVALID_STATE",
    );
  }

  await db.card_withdrawal_requests.update({
    where: { id: withdrawalId },
    data: {
      status: "processing",
      processing_at: new Date(),
      metadata: {
        ...((withdrawal.metadata as Record<string, unknown>) ?? {}),
        processed_by_admin: session.username,
      },
    },
  });

  // For crypto withdrawals, call backend to initiate the Fireblocks transfer
  if (withdrawal.method === "crypto") {
    let result: { data?: { fireblocks_tx_id?: string } };

    try {
      result = await backendApiRequest("/admin/process-approved", {
        method: "POST",
        body: { withdrawal_id: withdrawalId },
      });
    } catch (error) {
      // Revert status back to pending since the transfer failed to initiate.
      // The error itself is logged server-side; the user gets a sanitized
      // message instead of the raw backend payload (which can include URLs,
      // tx ids, internal error codes).
      await db.card_withdrawal_requests.update({
        where: { id: withdrawalId },
        data: {
          status: "pending",
          processing_at: null,
        },
      });
      logError(
        "withdrawals.process",
        `Fireblocks transfer init failed for ${withdrawalId}`,
        error,
      );
      return fail(
        "Couldn't initiate the Fireblocks transfer — withdrawal reverted to pending. Check the backend and retry.",
        "BACKEND_FAILED",
      );
    }

    // Store the Fireblocks transfer ID
    await db.card_withdrawal_requests.update({
      where: { id: withdrawalId },
      data: {
        fireblocks_tx_id: result.data?.fireblocks_tx_id ?? null,
        metadata: {
          ...((withdrawal.metadata as Record<string, unknown>) ?? {}),
          processed_by_admin: session.username,
        },
      },
    });
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "withdrawal_processed",
    targetUserId: withdrawal.user_id,
    metadata: { withdrawal_id: withdrawalId, action: "process" },
  });

  // Evict the cached Withdrawals-tab list so the just-actioned row shows
  // its new status immediately — `revalidatePath` alone does NOT clear
  // the `unstable_cache` entry behind getWithdrawals (it clears only on a
  // matching tag or its 60s TTL).
  revalidateTag(WITHDRAWALS_LIST_TAG);
  revalidatePath("/withdrawals");
  revalidatePath(`/withdrawals/${withdrawalId}`);
  return ok({ withdrawalId });
}

export async function shipWithdrawal(
  withdrawalId: string,
  trackingNumber: string,
  carrier: string
) {
  const db = await getDb();
  const session = await requirePageAccess("/withdrawals");
  await requireCapability(session, "__can_ship_withdrawals", "mark withdrawals as shipped");

  const withdrawal = await db.card_withdrawal_requests.findUnique({
    where: { id: withdrawalId },
  });
  if (!withdrawal || withdrawal.status !== "processing") {
    throw new Error("Withdrawal not found or not in processing status");
  }
  if (withdrawal.method !== "physical") {
    throw new Error("Only physical withdrawals can be shipped");
  }

  await db.card_withdrawal_requests.update({
    where: { id: withdrawalId },
    data: {
      status: "shipped",
      shipped_at: new Date(),
      tracking_number: trackingNumber || null,
      carrier: carrier || null,
      metadata: {
        ...((withdrawal.metadata as Record<string, unknown>) ?? {}),
        shipped_by_admin: session.username,
      },
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "withdrawal_shipped",
    targetUserId: withdrawal.user_id,
    metadata: { withdrawal_id: withdrawalId, tracking_number: trackingNumber, carrier },
  });

  // Evict the cached Withdrawals-tab list so the just-actioned row shows
  // its new status immediately — `revalidatePath` alone does NOT clear
  // the `unstable_cache` entry behind getWithdrawals (it clears only on a
  // matching tag or its 60s TTL).
  revalidateTag(WITHDRAWALS_LIST_TAG);
  revalidatePath("/withdrawals");
  revalidatePath(`/withdrawals/${withdrawalId}`);
}

export async function completeWithdrawal(withdrawalId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/withdrawals");
  await requireCapability(session, "__can_complete_withdrawals", "mark withdrawals as complete");

  const withdrawal = await db.card_withdrawal_requests.findUnique({
    where: { id: withdrawalId },
  });
  if (!withdrawal || !["processing", "shipped"].includes(withdrawal.status)) {
    throw new Error("Withdrawal cannot be completed from current status");
  }

  await backendApiRequest("/admin/complete", {
    method: "POST",
    body: { withdrawal_id: withdrawalId },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "withdrawal_completed",
    targetUserId: withdrawal.user_id,
    metadata: { withdrawal_id: withdrawalId },
  });

  // Evict the cached Withdrawals-tab list so the just-actioned row shows
  // its new status immediately — `revalidatePath` alone does NOT clear
  // the `unstable_cache` entry behind getWithdrawals (it clears only on a
  // matching tag or its 60s TTL).
  revalidateTag(WITHDRAWALS_LIST_TAG);
  revalidatePath("/withdrawals");
  revalidatePath(`/withdrawals/${withdrawalId}`);
}

/**
 * Cancel a pending or processing withdrawal. Refunds the user (balance
 * + inventory restore via the backend) so this is money-moving and
 * TOTP-gated. Returns ServerActionResult — callers must check
 * `result.success`.
 */
export async function cancelWithdrawal(
  withdrawalId: string,
  reason: string,
  totpCode: string,
): Promise<ServerActionResult<{ withdrawalId: string }>> {
  const db = await getDb();
  const session = await requirePageAccess("/withdrawals");
  try {
    await requireCapability(
      session,
      "__can_cancel_withdrawals",
      "cancel withdrawals",
    );
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "Permission denied",
      "FORBIDDEN",
    );
  }
  // Cancelling refunds the user (balance + inventory restore via the
  // backend) — money-moving, so TOTP-gated.
  try {
    await require2FA(session.userId, totpCode);
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : "2FA verification failed",
      "TOTP_INVALID",
    );
  }

  const withdrawal = await db.card_withdrawal_requests.findUnique({
    where: { id: withdrawalId },
  });
  if (!withdrawal) {
    return fail("Withdrawal not found", "NOT_FOUND");
  }
  if (!["pending", "processing"].includes(withdrawal.status)) {
    return fail(
      "This withdrawal can no longer be cancelled — refresh and check its current status.",
      "INVALID_STATE",
    );
  }

  try {
    await backendApiRequest("/admin/cancel", {
      method: "POST",
      body: { withdrawal_id: withdrawalId, reason },
    });
  } catch (err) {
    logError(
      "withdrawals.cancel",
      `backend refund call failed for ${withdrawalId}`,
      err,
    );
    return fail(
      "Couldn't refund the user via the backend — withdrawal NOT cancelled. Check the backend and retry.",
      "BACKEND_FAILED",
    );
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "withdrawal_cancelled",
    targetUserId: withdrawal.user_id,
    metadata: { withdrawal_id: withdrawalId, reason },
  });

  // Evict the cached Withdrawals-tab list so the just-actioned row shows
  // its new status immediately — `revalidatePath` alone does NOT clear
  // the `unstable_cache` entry behind getWithdrawals (it clears only on a
  // matching tag or its 60s TTL).
  revalidateTag(WITHDRAWALS_LIST_TAG);
  revalidatePath("/withdrawals");
  revalidatePath(`/withdrawals/${withdrawalId}`);
  return ok({ withdrawalId });
}

export async function failWithdrawal(
  withdrawalId: string,
  reason: string,
  totpCode: string,
) {
  const db = await getDb();
  const session = await requirePageAccess("/withdrawals");
  await requireCapability(session, "__can_fail_withdrawals", "mark withdrawals as failed");
  // Marking shipped-as-failed refunds the user (backend reverts the
  // physical send + restores balance/inventory). Money-moving, gated.
  await require2FA(session.userId, totpCode);

  const withdrawal = await db.card_withdrawal_requests.findUnique({
    where: { id: withdrawalId },
  });
  if (!withdrawal || withdrawal.status !== "shipped") {
    throw new Error("Only shipped withdrawals can be marked as failed");
  }

  await backendApiRequest("/admin/fail", {
    method: "POST",
    body: { withdrawal_id: withdrawalId, reason },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "withdrawal_failed",
    targetUserId: withdrawal.user_id,
    metadata: { withdrawal_id: withdrawalId, reason },
  });

  // Evict the cached Withdrawals-tab list so the just-actioned row shows
  // its new status immediately — `revalidatePath` alone does NOT clear
  // the `unstable_cache` entry behind getWithdrawals (it clears only on a
  // matching tag or its 60s TTL).
  revalidateTag(WITHDRAWALS_LIST_TAG);
  revalidatePath("/withdrawals");
  revalidatePath(`/withdrawals/${withdrawalId}`);
}
