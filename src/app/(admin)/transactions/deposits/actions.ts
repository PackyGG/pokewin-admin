"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  decideFiatDepositReview,
  getFiatDepositReview,
} from "@/lib/backend-api/fiat-deposit-review";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";
import { require2FA } from "@/lib/require-2fa";

const DecisionInputSchema = z.object({
  intentId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(3).max(500),
  stepUpCredential: z.string().trim().min(1).max(4096),
});

export type FiatDepositDecisionResult =
  | { success: true; status: string }
  | { success: false; error: string };

export async function decideFiatDepositAction(
  input: unknown,
): Promise<FiatDepositDecisionResult> {
  const session = await requireAntifraudManager(
    "Only owners and admins can approve or reject Fiat deposit credits.",
  );
  const parsed = DecisionInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid review decision.",
    };
  }

  try {
    await require2FA(session.userId, parsed.data.stepUpCredential);
    const before = await getFiatDepositReview(parsed.data.intentId);
    const updated = await decideFiatDepositReview({
      intentId: parsed.data.intentId,
      decision: parsed.data.decision,
      reason: parsed.data.reason,
      adminUserId: session.userId,
    });

    try {
      await createAdminAuditEvent({
        adminUserId: session.userId,
        targetUserId: before.user_id,
        eventType:
          parsed.data.decision === "approve"
            ? "fiat_deposit_credit_approved"
            : "fiat_deposit_credit_rejected",
        metadata: {
          intentId: before.id,
          providerPaymentId: before.provider_payment_id,
          previousStatus: before.status,
          status: updated.status,
          decision: parsed.data.decision,
          reason: parsed.data.reason,
          creditedAmountCents: before.credited_amount_cents,
          currency: before.currency,
        },
      });
    } catch (auditError) {
      console.error("[fiat-deposit-review] secondary admin audit failed", {
        auditError,
        intentId: before.id,
        adminUserId: session.userId,
      });
    }

    revalidatePath("/transactions/deposits");
    revalidatePath(`/transactions/card-payments/${before.id}`);
    return { success: true, status: updated.status };
  } catch (error) {
    console.error("[fiat-deposit-review] decision failed", {
      error,
      intentId: parsed.data.intentId,
      decision: parsed.data.decision,
      adminUserId: session.userId,
    });
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "The Fiat deposit decision could not be completed.",
    };
  }
}
