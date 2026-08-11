"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEventDurable } from "@/lib/admin-audit";
import { actionErrorMessage } from "@/lib/antifraud/action-error-message";
import { isFiatAutoCreditEligible } from "@/lib/antifraud/fiat-auto-credit-eligibility";
import { getFiatAssessment } from "@/lib/antifraud/fiat-deposits-api";
import {
  getUserFeatureLocks,
  updateUserFiatDepositAutoApproval,
} from "@/lib/backend-api/feature-locks";
import { getFiatDepositReviewUsers } from "@/lib/queries/fiat-deposit-review-users";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";
import { require2FA } from "@/lib/require-2fa";

const autoCreditSchema = z.object({
  intentId: z.string().uuid(),
  userId: z.string().trim().min(1).max(128),
  stepUpCredential: z.string().trim().min(1).max(4_096),
  idempotencyKey: z.string().uuid(),
});

export async function allowFutureFiatAutoCreditAction(
  input: unknown,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireAntifraudManager(
    "Only owners and admins can allow future automatic Fiat credit.",
  );
  const parsed = autoCreditSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid auto-credit request.",
    };
  }

  try {
    await require2FA(session.userId, parsed.data.stepUpCredential);
    const [assessmentResult, users, currentLocks] = await Promise.all([
      getFiatAssessment(parsed.data.intentId),
      getFiatDepositReviewUsers([parsed.data.userId]),
      getUserFeatureLocks(parsed.data.userId),
    ]);
    const assessment = assessmentResult.data?.assessment;
    const user = users.get(parsed.data.userId);
    if (
      !assessment
      || assessment.deposit_intent_id !== parsed.data.intentId
      || assessment.user_id !== parsed.data.userId
      || assessment.status !== "review"
      || assessment.verdict !== "good"
      || assessment.risk_score >= 50
    ) {
      return {
        success: false,
        error: "This deposit no longer has a clean, active risk assessment.",
      };
    }
    if (currentLocks.fiat_deposit_auto_approval_enabled) {
      return { success: true };
    }
    if (!user || !isFiatAutoCreditEligible(user)) {
      return {
        success: false,
        error: "This account no longer meets the clean Fiat-history requirements.",
      };
    }

    const updated = await updateUserFiatDepositAutoApproval(
      parsed.data.userId,
      true,
      session.userId,
    );
    if (!updated.enabled) {
      throw new Error("The backend did not enable the Fiat auto-credit override.");
    }

    const auditOutcome = await createAdminAuditEventDurable({
      adminUserId: session.userId,
      targetUserId: parsed.data.userId,
      eventType: "user_fiat_auto_approval_updated",
      metadata: {
        old: false,
        new: true,
        source: "fiat_deposit_review",
        intentId: parsed.data.intentId,
        cleanFiatDeposits: user.cleanFiatDeposits,
        reversedFiatDeposits: user.reversedFiatDeposits,
        firstCleanFiatAt: user.firstCleanFiatAt,
        riskScore: assessment.risk_score,
        verdict: assessment.verdict,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });
    if (auditOutcome.status === "lost") {
      console.error("[fiat-auto-credit] durable audit failed", {
        userId: parsed.data.userId,
        intentId: parsed.data.intentId,
        adminUserId: session.userId,
      });
    }

    revalidatePath("/antifraud/fiat-deposits");
    revalidatePath(`/users/${parsed.data.userId}`);
    return { success: true };
  } catch (error) {
    console.error("[fiat-auto-credit] enable failed", {
      error,
      userId: parsed.data.userId,
      intentId: parsed.data.intentId,
      adminUserId: session.userId,
    });
    return {
      success: false,
      error: actionErrorMessage(
        error,
        "Future automatic Fiat credit could not be enabled.",
      ),
    };
  }
}
