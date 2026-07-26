"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { and, eq } from "drizzle-orm";

import { getDrizzleDb } from "@/lib/db";
import { card_withdrawal_requests } from "@/lib/db-schema/main/schema";
import { WITHDRAWALS_LIST_TAG } from "@/lib/queries/withdrawals";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { backendApiRequest } from "@/lib/backend-api";
import { ok, fail, type ServerActionResult } from "@/lib/errors/server-action-result";
import { logError } from "@/lib/errors/logger";
import {
  assertWithdrawalNotLocked,
  isWithdrawalLocked,
  WITHDRAWAL_LOCKED_MESSAGE,
} from "@/lib/withdrawal-lock/lock";

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
  const db = await getDrizzleDb();
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

  const [withdrawal] = await db
    .select()
    .from(card_withdrawal_requests)
    .where(eq(card_withdrawal_requests.id, withdrawalId))
    .limit(1);
  if (!withdrawal) {
    return fail("Withdrawal not found", "NOT_FOUND");
  }
  // Withdrawal lock: excluded users are locked by default; only a
  // motha-granted unlock override lifts it. A locked user's withdrawal can
  // never be processed through the admin panel. Fail-safe (see lock.ts).
  if (await isWithdrawalLocked(withdrawal.user_id)) {
    return fail(WITHDRAWAL_LOCKED_MESSAGE, "WITHDRAWAL_LOCKED");
  }
  if (withdrawal.status !== "pending") {
    return fail(
      "This withdrawal is no longer pending — refresh and check its current status.",
      "INVALID_STATE",
    );
  }

  const claimed = await db
    .update(card_withdrawal_requests)
    .set({
      status: "processing",
      processing_at: new Date().toISOString(),
      metadata: {
        ...((withdrawal.metadata as Record<string, unknown>) ?? {}),
        processed_by_admin: session.username,
      },
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(card_withdrawal_requests.id, withdrawalId),
        eq(card_withdrawal_requests.status, "pending"),
      ),
    )
    .returning({ id: card_withdrawal_requests.id });
  if (!claimed[0]) {
    return fail(
      "This withdrawal is no longer pending — refresh and check its current status.",
      "INVALID_STATE",
    );
  }

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
      await db
        .update(card_withdrawal_requests)
        .set({
          status: "pending",
          processing_at: null,
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(card_withdrawal_requests.id, withdrawalId),
            eq(card_withdrawal_requests.status, "processing"),
          ),
        );
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
    await db
      .update(card_withdrawal_requests)
      .set({
        fireblocks_tx_id: result.data?.fireblocks_tx_id ?? null,
        metadata: {
          ...((withdrawal.metadata as Record<string, unknown>) ?? {}),
          processed_by_admin: session.username,
        },
        updated_at: new Date().toISOString(),
      })
      .where(eq(card_withdrawal_requests.id, withdrawalId));
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
  const db = await getDrizzleDb();
  const session = await requirePageAccess("/withdrawals");
  await requireCapability(session, "__can_ship_withdrawals", "mark withdrawals as shipped");

  const [withdrawal] = await db
    .select()
    .from(card_withdrawal_requests)
    .where(eq(card_withdrawal_requests.id, withdrawalId))
    .limit(1);
  if (!withdrawal || withdrawal.status !== "processing") {
    throw new Error("Withdrawal not found or not in processing status");
  }
  // Withdrawal lock: excluded users are locked by default (motha-only
  // unlock). Blocks shipping a locked user's withdrawal.
  await assertWithdrawalNotLocked(withdrawal.user_id);
  if (withdrawal.method !== "physical") {
    throw new Error("Only physical withdrawals can be shipped");
  }

  const shipped = await db
    .update(card_withdrawal_requests)
    .set({
      status: "shipped",
      shipped_at: new Date().toISOString(),
      tracking_number: trackingNumber || null,
      carrier: carrier || null,
      metadata: {
        ...((withdrawal.metadata as Record<string, unknown>) ?? {}),
        shipped_by_admin: session.username,
      },
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(card_withdrawal_requests.id, withdrawalId),
        eq(card_withdrawal_requests.status, "processing"),
        eq(card_withdrawal_requests.method, "physical"),
      ),
    )
    .returning({ id: card_withdrawal_requests.id });
  if (!shipped[0]) {
    throw new Error("Withdrawal state changed — refresh and retry");
  }

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
  const db = await getDrizzleDb();
  const session = await requirePageAccess("/withdrawals");
  await requireCapability(session, "__can_complete_withdrawals", "mark withdrawals as complete");

  const [withdrawal] = await db
    .select()
    .from(card_withdrawal_requests)
    .where(eq(card_withdrawal_requests.id, withdrawalId))
    .limit(1);
  if (!withdrawal || !["processing", "shipped"].includes(withdrawal.status)) {
    throw new Error("Withdrawal cannot be completed from current status");
  }
  // Withdrawal lock: excluded users are locked by default (motha-only
  // unlock). Blocks completing a locked user's withdrawal.
  await assertWithdrawalNotLocked(withdrawal.user_id);

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
  const db = await getDrizzleDb();
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

  const [withdrawal] = await db
    .select()
    .from(card_withdrawal_requests)
    .where(eq(card_withdrawal_requests.id, withdrawalId))
    .limit(1);
  if (!withdrawal) {
    return fail("Withdrawal not found", "NOT_FOUND");
  }
  // Withdrawal lock: a locked user's withdrawal cannot be actioned at all —
  // process, cancel, ship, complete, or fail — until motha unlocks them.
  if (await isWithdrawalLocked(withdrawal.user_id)) {
    return fail(WITHDRAWAL_LOCKED_MESSAGE, "WITHDRAWAL_LOCKED");
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
  const db = await getDrizzleDb();
  const session = await requirePageAccess("/withdrawals");
  await requireCapability(session, "__can_fail_withdrawals", "mark withdrawals as failed");
  // Marking shipped-as-failed refunds the user (backend reverts the
  // physical send + restores balance/inventory). Money-moving, gated.
  await require2FA(session.userId, totpCode);

  const [withdrawal] = await db
    .select()
    .from(card_withdrawal_requests)
    .where(eq(card_withdrawal_requests.id, withdrawalId))
    .limit(1);
  if (!withdrawal || withdrawal.status !== "shipped") {
    throw new Error("Only shipped withdrawals can be marked as failed");
  }
  // Withdrawal lock: excluded users are locked by default (motha-only
  // unlock). Blocks marking a locked user's withdrawal failed.
  await assertWithdrawalNotLocked(withdrawal.user_id);

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
