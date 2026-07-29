"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  updateWithdrawalReview,
  type WithdrawalReviewAction,
  type WithdrawalReviewStatus,
} from "@/lib/antifraud/withdrawals-api";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";

const inputSchema = z
  .object({
    withdrawalId: z.string().uuid("Invalid withdrawal id"),
    action: z.enum(["start_review", "clear", "recommend_block"]),
    note: z.string().trim().max(1_000, "Keep notes under 1,000 characters"),
    expectedStatus: z.enum([
      "unreviewed",
      "in_review",
      "cleared",
      "block_recommended",
    ]),
    idempotencyKey: z.string().uuid("Invalid idempotency key"),
  })
  .superRefine((value, context) => {
    if (value.action !== "start_review" && value.note.length < 4) {
      context.addIssue({
        code: "custom",
        path: ["note"],
        message: "Write what you concluded before recording this decision.",
      });
    }
  });

export async function setWithdrawalReviewState(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const data = parsed.data;

  await updateWithdrawalReview({
    withdrawalId: data.withdrawalId,
    action: data.action as WithdrawalReviewAction,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
    note: data.note || undefined,
    expectedStatus: data.expectedStatus as WithdrawalReviewStatus,
    idempotencyKey: data.idempotencyKey,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_withdrawal_reviewed",
    metadata: {
      withdrawalId: data.withdrawalId,
      action: data.action,
      note: data.note || null,
      expectedStatus: data.expectedStatus,
      idempotencyKey: data.idempotencyKey,
    },
  });

  revalidatePath("/antifraud/withdrawals");
  revalidatePath(`/antifraud/withdrawals/${data.withdrawalId}`);
}
