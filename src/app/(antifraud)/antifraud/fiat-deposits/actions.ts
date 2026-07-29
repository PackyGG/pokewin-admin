"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getFiatAssessment,
  updateFiatReview,
} from "@/lib/antifraud/fiat-deposits-api";
import { BackendApiError } from "@/lib/backend-api/errors";
import { getUserKyc, requireUserKyc } from "@/lib/backend-api/kyc";
import { userDetailTag } from "@/lib/queries/users-detail-cache";
import {
  requireAntifraudAccess,
  requireAntifraudManager,
} from "@/lib/require-antifraud-access";

const schema = z
  .object({
    depositIntentId: z.string().uuid(),
    action: z.enum(["start_review", "clear", "escalate", "recommend_hold"]),
    note: z.string().trim().max(1_000),
    expectedStatus: z.enum([
      "unreviewed",
      "in_review",
      "cleared",
      "escalated",
      "hold_recommended",
    ]),
    idempotencyKey: z.string().uuid(),
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

const requireKycSchema = z.object({
  depositIntentId: z.string().uuid(),
  userId: z.string().trim().min(1).max(128),
});

type RequireFiatKycResult =
  | {
      success: true;
      alreadyRequired: boolean;
      readbackConfirmed: boolean;
      verificationCycle: number;
    }
  | { success: false; error: string };

function friendlyKycError(error: unknown): string {
  if (error instanceof BackendApiError) {
    if (error.isNotFound) return "Account was not found by the backend.";
    if (error.isConflict) {
      return "KYC changed since this page loaded. Refresh and try again.";
    }
    return error.message;
  }
  return "The backend KYC service could not be reached.";
}

export async function setFiatReviewState(input: unknown): Promise<void> {
  const session = await requireAntifraudAccess();
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  await updateFiatReview({
    ...parsed.data,
    actorId: session.userId,
    actorUsername: session.username ?? undefined,
    note: parsed.data.note || undefined,
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "antifraud_fiat_deposit_reviewed",
    metadata: parsed.data,
  });
  revalidatePath("/antifraud/fiat-deposits");
  revalidatePath(`/antifraud/fiat-deposits/${parsed.data.depositIntentId}`);
}

export async function requireFiatDepositKyc(
  input: unknown,
): Promise<RequireFiatKycResult> {
  const session = await requireAntifraudManager(
    "Only owners and admins can require KYC.",
  );
  const parsed = requireKycSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }

  const assessment = await getFiatAssessment(parsed.data.depositIntentId);
  if (
    !assessment.configured ||
    assessment.error ||
    assessment.notFound ||
    !assessment.data ||
    assessment.data.assessment.user_id !== parsed.data.userId
  ) {
    return {
      success: false,
      error: "This Fiat deposit no longer matches that account. Refresh and try again.",
    };
  }

  try {
    const current = await getUserKyc(parsed.data.userId);
    if (current.kycRequired) {
      return {
        success: true,
        alreadyRequired: true,
        readbackConfirmed: true,
        verificationCycle: current.verificationCycle,
      };
    }
  } catch (error) {
    return { success: false, error: friendlyKycError(error) };
  }

  const reason = `Fiat deposit risk review: ${parsed.data.depositIntentId}`;
  let verificationCycle: number;
  try {
    const result = await requireUserKyc({
      userId: parsed.data.userId,
      adminId: session.userId,
      reason,
    });
    verificationCycle = result.verificationCycle;
  } catch (error) {
    return { success: false, error: friendlyKycError(error) };
  }

  let readbackConfirmed = false;
  try {
    const confirmed = await getUserKyc(parsed.data.userId);
    readbackConfirmed =
      confirmed.kycRequired &&
      confirmed.verificationCycle === verificationCycle;
  } catch (error) {
    console.error("[antifraud-fiat] KYC readback failed:", error);
  }

  try {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "user_kyc_required",
      targetUserId: parsed.data.userId,
      metadata: {
        source: "antifraud_fiat_deposits",
        depositIntentId: parsed.data.depositIntentId,
        reason,
        verificationCycle,
      },
    });
  } catch (error) {
    console.error("[antifraud-fiat] secondary KYC audit failed:", error);
  }

  revalidatePath("/antifraud/fiat-deposits");
  revalidatePath(
    `/antifraud/fiat-deposits/${parsed.data.depositIntentId}`,
  );
  revalidatePath("/antifraud/kyc");
  revalidateTag(userDetailTag(parsed.data.userId));
  return {
    success: true,
    alreadyRequired: false,
    readbackConfirmed,
    verificationCycle,
  };
}
