"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

export async function processWithdrawal(withdrawalId: string) {
  const session = await requirePageAccess("/withdrawals");

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
    const res = await fetch(
      `${process.env.BACKEND_API_URL}/admin/process-approved`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.BACKEND_API_KEY!,
        },
        body: JSON.stringify({ withdrawal_id: withdrawalId }),
      }
    );

    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: "Unknown error" }));
      // Revert status back to pending since the transfer failed to initiate
      await db.card_withdrawal_requests.update({
        where: { id: withdrawalId },
        data: {
          status: "pending",
          processing_at: null,
        },
      });
      throw new Error(
        `Failed to initiate crypto transfer: ${error.message || res.statusText}`
      );
    }

    const result = await res.json();

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
  const session = await requirePageAccess("/withdrawals");

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
  const session = await requirePageAccess("/withdrawals");

  const withdrawal = await db.card_withdrawal_requests.findUnique({
    where: { id: withdrawalId },
  });
  if (!withdrawal || !["processing", "shipped"].includes(withdrawal.status)) {
    throw new Error("Withdrawal cannot be completed from current status");
  }

  await db.card_withdrawal_requests.update({
    where: { id: withdrawalId },
    data: {
      status: "completed",
      completed_at: new Date(),
    },
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

export async function cancelWithdrawal(withdrawalId: string, reason: string) {
  const session = await requirePageAccess("/withdrawals");

  const withdrawal = await db.card_withdrawal_requests.findUnique({
    where: { id: withdrawalId },
  });
  if (!withdrawal || !["pending", "processing"].includes(withdrawal.status)) {
    throw new Error("Withdrawal cannot be cancelled from current status");
  }

  await db.$transaction([
    db.card_withdrawal_requests.update({
      where: { id: withdrawalId },
      data: {
        status: "cancelled",
        cancelled_at: new Date(),
        failure_reason: reason,
      },
    }),
    ...(withdrawal.inventory_item_ids.length > 0
      ? [
          db.user_inventory.updateMany({
            where: { id: { in: withdrawal.inventory_item_ids } },
            data: { withdrawal_locked_at: null },
          }),
        ]
      : []),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "withdrawal_cancelled",
    targetUserId: withdrawal.user_id,
    metadata: { withdrawal_id: withdrawalId, reason },
  });

  revalidatePath("/withdrawals");
  revalidatePath(`/withdrawals/${withdrawalId}`);
}

export async function failWithdrawal(withdrawalId: string, reason: string) {
  const session = await requirePageAccess("/withdrawals");

  const withdrawal = await db.card_withdrawal_requests.findUnique({
    where: { id: withdrawalId },
  });
  if (!withdrawal || withdrawal.status !== "shipped") {
    throw new Error("Only shipped withdrawals can be marked as failed");
  }

  await db.card_withdrawal_requests.update({
    where: { id: withdrawalId },
    data: {
      status: "failed",
      failed_at: new Date(),
      failure_reason: reason,
    },
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
