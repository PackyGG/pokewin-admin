"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { backendApiRequest } from "@/lib/backend-api";

export async function processWithdrawal(withdrawalId: string, totpCode: string) {
  const db = await getDb();
  const session = await requirePageAccess("/withdrawals");
  await requireCapability(session, "__can_process_withdrawals", "process withdrawal requests");
  // Initiates a real Fireblocks crypto transfer (or marks the physical
  // withdrawal as ready to ship). Money-moving action → TOTP gate.
  await require2FA(session.userId, totpCode);

  const withdrawal = await db.card_withdrawal_requests.findUnique({
    where: { id: withdrawalId },
  });
  if (!withdrawal || withdrawal.status !== "pending") {
    throw new Error("Withdrawal not found or not in pending status");
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
      // Revert status back to pending since the transfer failed to initiate
      await db.card_withdrawal_requests.update({
        where: { id: withdrawalId },
        data: {
          status: "pending",
          processing_at: null,
        },
      });
      throw error;
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

  revalidatePath("/withdrawals");
  revalidatePath(`/withdrawals/${withdrawalId}`);
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

  revalidatePath("/withdrawals");
  revalidatePath(`/withdrawals/${withdrawalId}`);
}

export async function cancelWithdrawal(
  withdrawalId: string,
  reason: string,
  totpCode: string,
) {
  const db = await getDb();
  const session = await requirePageAccess("/withdrawals");
  await requireCapability(session, "__can_cancel_withdrawals", "cancel withdrawals");
  // Cancelling refunds the user (balance + inventory restore via the
  // backend) — money-moving, so TOTP-gated.
  await require2FA(session.userId, totpCode);

  const withdrawal = await db.card_withdrawal_requests.findUnique({
    where: { id: withdrawalId },
  });
  if (!withdrawal || !["pending", "processing"].includes(withdrawal.status)) {
    throw new Error("Withdrawal cannot be cancelled from current status");
  }

  await backendApiRequest("/admin/cancel", {
    method: "POST",
    body: { withdrawal_id: withdrawalId, reason },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "withdrawal_cancelled",
    targetUserId: withdrawal.user_id,
    metadata: { withdrawal_id: withdrawalId, reason },
  });

  revalidatePath("/withdrawals");
  revalidatePath(`/withdrawals/${withdrawalId}`);
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

  revalidatePath("/withdrawals");
  revalidatePath(`/withdrawals/${withdrawalId}`);
}
