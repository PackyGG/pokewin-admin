"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getFiatAssessment } from "@/lib/antifraud/fiat-deposits-api";
import {
  assessmentSnapshot,
  creditReviewedFiatDeposit,
  lockFiatAndWithdrawals,
} from "@/lib/antifraud/fiat-credit-review";
import { adminDrizzle } from "@/lib/admin-db";
import { sql } from "drizzle-orm";
import { whopAdminClient } from "@/lib/whop-admin";
import { resolveAdminMainUserId } from "@/lib/resolve-admin-main-user-id";
import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { require2FA } from "@/lib/require-2fa";

const creditDecisionSchema = z.object({
  intentId: z.string().uuid(),
  decision: z.enum(["approve", "decline"]),
  reason: z.string().trim().min(3).max(500),
  stepUpCredential: z.string().trim().min(1).max(4_096),
  idempotencyKey: z.string().uuid(),
});

export type FiatDepositDecisionResult =
  | { success: true; status: string }
  | { success: false; error: string };

export async function decideFiatDepositAction(
  input: unknown,
): Promise<FiatDepositDecisionResult> {
  const session = await requireAntifraudAccess();
  const parsed = creditDecisionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid review decision.",
    };
  }

  try {
    await require2FA(session.userId, parsed.data.stepUpCredential);
    const assessmentResult = await getFiatAssessment(parsed.data.intentId);
    const assessment = assessmentResult.data?.assessment;
    if (
      !assessmentResult.configured ||
      assessmentResult.error ||
      assessmentResult.notFound ||
      !assessment ||
      assessment.status !== "review"
    ) {
      return {
        success: false,
        error: "This Fiat deposit is no longer active in the Antifraud review queue.",
      };
    }
    const snapshot = assessmentSnapshot(assessment);
    if (snapshot.provider !== "whop") {
      return { success: false, error: "Only Whop Fiat deposits can be reviewed here." };
    }

    const claimed = await adminDrizzle.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`fiat-credit-review:${snapshot.depositIntentId}`}, 0)
        )
      `);
      const existing = (await tx.execute<{
        status: string;
        staff_decision: string | null;
        decision_idempotency_key: string | null;
      }>(sql`
        SELECT status, staff_decision, decision_idempotency_key::text
        FROM admin_fiat_credit_reviews
        WHERE deposit_intent_id = ${snapshot.depositIntentId}::uuid
        FOR UPDATE
      `)).rows[0];
      if (existing?.decision_idempotency_key === parsed.data.idempotencyKey) {
        return { replay: true, status: existing.status };
      }
      const retryable =
        (parsed.data.decision === "approve" && existing?.status === "approval_failed" && existing.staff_decision === "approve") ||
        (parsed.data.decision === "decline" && existing?.status === "containment_failed" && existing.staff_decision === "decline");
      if (existing && !retryable) {
        throw new Error("Another staff member already decided this deposit.");
      }
      const nextStatus = parsed.data.decision === "approve" ? "approving" : "containing";
      if (existing) {
        await tx.execute(sql`
          UPDATE admin_fiat_credit_reviews
          SET status = ${nextStatus}, decision_reason = ${parsed.data.reason},
              decided_by = ${session.userId}::uuid,
              decision_idempotency_key = ${parsed.data.idempotencyKey}::uuid,
              decided_at = NOW(), last_error = NULL, updated_at = NOW(), version = version + 1
          WHERE deposit_intent_id = ${snapshot.depositIntentId}::uuid
        `);
      } else {
        await tx.execute(sql`
          INSERT INTO admin_fiat_credit_reviews (
            deposit_intent_id, user_id, provider, provider_payment_id,
            currency, amount_cents, customer_total_cents, status,
            staff_decision, decision_reason, decided_by,
            decision_idempotency_key, decided_at
          ) VALUES (
            ${snapshot.depositIntentId}::uuid, ${snapshot.userId}, ${snapshot.provider},
            ${snapshot.providerPaymentId}, ${snapshot.currency}, ${snapshot.amountCents},
            ${snapshot.customerTotalCents}, ${nextStatus}, ${parsed.data.decision},
            ${parsed.data.reason}, ${session.userId}::uuid,
            ${parsed.data.idempotencyKey}::uuid, NOW()
          )
        `);
      }
      return { replay: false, status: nextStatus };
    });
    if (claimed.replay) return { success: true, status: claimed.status };

    if (parsed.data.decision === "approve") {
      const payment = await whopAdminClient().payments.retrieve(snapshot.providerPaymentId);
      const expectedCompany = process.env.WHOP_COMPANY_ID?.trim();
      if (expectedCompany && payment.company?.id !== expectedCompany) {
        throw new Error("The Whop payment belongs to another company.");
      }
      if (payment.status !== "paid" || payment.substatus !== "succeeded") {
        throw new Error("The Whop payment is no longer successful.");
      }
      if (
        payment.dispute_alerted_at ||
        (payment.disputes?.length ?? 0) > 0 ||
        (payment.refunded_amount ?? 0) > 0
      ) {
        throw new Error("Refunded or disputed Whop payments cannot be approved.");
      }
      if (
        payment.metadata?.deposit_intent_id &&
        payment.metadata.deposit_intent_id !== snapshot.depositIntentId
      ) {
        throw new Error("The Whop payment does not match this deposit intent.");
      }
      await creditReviewedFiatDeposit({
        ...snapshot,
        providerStatus: payment.substatus,
        reviewedBy: session.userId,
        reason: parsed.data.reason,
      });
      await adminDrizzle.execute(sql`
        UPDATE admin_fiat_credit_reviews
        SET status = 'approved', contained_at = NULL, last_error = NULL,
            updated_at = NOW(), version = version + 1
        WHERE deposit_intent_id = ${snapshot.depositIntentId}::uuid
          AND status = 'approving'
      `);
    } else {
      const actorMainUserId = await resolveAdminMainUserId(session.userId);
      await lockFiatAndWithdrawals({
        userId: snapshot.userId,
        actorMainUserId,
        reason: `Declined Fiat deposit ${snapshot.depositIntentId}: ${parsed.data.reason}`.slice(0, 500),
      });
      await adminDrizzle.execute(sql`
        UPDATE admin_fiat_credit_reviews
        SET status = 'declined', contained_at = NOW(), containment_error = NULL,
            updated_at = NOW(), version = version + 1
        WHERE deposit_intent_id = ${snapshot.depositIntentId}::uuid
          AND status = 'containing'
      `);
    }

    try {
      await createAdminAuditEvent({
        adminUserId: session.userId,
        targetUserId: snapshot.userId,
        eventType:
          parsed.data.decision === "approve"
            ? "fiat_deposit_credit_approved"
            : "fiat_deposit_declined_for_admin_review",
        metadata: {
          intentId: snapshot.depositIntentId,
          providerPaymentId: snapshot.providerPaymentId,
          previousStatus: assessment.status,
          status: parsed.data.decision === "approve" ? "approved" : "declined",
          decision: parsed.data.decision,
          reason: parsed.data.reason,
          creditedAmountCents: snapshot.amountCents,
          currency: snapshot.currency,
          futureAutoApprovalChanged: false,
          ...(parsed.data.decision === "decline"
            ? { fiatDepositsLocked: true, cryptoWithdrawalsLocked: true, itemWithdrawalsLocked: true }
            : {}),
          idempotencyKey: parsed.data.idempotencyKey,
        },
      });
    } catch (auditError) {
      console.error("[fiat-deposit-review] secondary admin audit failed", {
        auditError,
        intentId: snapshot.depositIntentId,
        adminUserId: session.userId,
      });
    }

    revalidatePath("/antifraud/fiat-deposits");
    revalidatePath("/antifraud/admin/deposits");
    revalidatePath(`/transactions/card-payments/${snapshot.depositIntentId}`);
    return {
      success: true,
      status: parsed.data.decision === "approve" ? "approved" : "declined",
    };
  } catch (error) {
    console.error("[fiat-deposit-review] decision failed", {
      error,
      intentId: parsed.data.intentId,
      decision: parsed.data.decision,
      adminUserId: session.userId,
    });
    const failedStatus = parsed.data.decision === "approve"
      ? "approval_failed"
      : "containment_failed";
    await adminDrizzle.execute(sql`
      UPDATE admin_fiat_credit_reviews
      SET status = ${failedStatus},
          containment_error = CASE WHEN ${parsed.data.decision} = 'decline' THEN ${error instanceof Error ? error.message : "Containment failed"} ELSE containment_error END,
          last_error = ${error instanceof Error ? error.message : "Decision failed"},
          updated_at = NOW(), version = version + 1
      WHERE deposit_intent_id = ${parsed.data.intentId}::uuid
        AND status IN ('approving', 'containing')
    `).catch(() => undefined);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "The Fiat deposit decision could not be completed.",
    };
  }
}
