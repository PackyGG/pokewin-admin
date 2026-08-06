"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { blockKnownUserIdentifiers } from "@/lib/antifraud/user-identifier-blocking";
import { getPrimaryDrizzleDb } from "@/lib/db";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";
import { require2FA } from "@/lib/require-2fa";
import { resolveAdminMainUserId } from "@/lib/resolve-admin-main-user-id";
import { userDetailTag } from "@/lib/queries/users-detail-cache";
import { safeWhopError, whopAdminClient } from "@/lib/whop-admin";

const schema = z.object({
  caseId: z.string().uuid(),
  action: z.enum(["refund", "ban", "refund_and_ban"]),
  reason: z.string().trim().min(3).max(500),
  credential: z.string().trim().min(1).max(4_096),
  confirmation: z.string(),
  idempotencyKey: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
});

export type DeclinedDepositResolutionResult =
  | { success: true; status: "resolved" | "resolution_failed"; message: string }
  | { success: false; error: string };

type ClaimedCase = {
  id: string;
  deposit_intent_id: string;
  user_id: string;
  provider_payment_id: string;
  amount_cents: number;
};

async function banAccount(input: {
  userId: string;
  reason: string;
  adminUserId: string;
  adminUsername?: string;
}) {
  const db = await getPrimaryDrizzleDb();
  const issuerMainUserId = await resolveAdminMainUserId(input.adminUserId);
  const current = (await db.execute<{ is_banned: boolean }>(sql`
    SELECT is_banned FROM "user" WHERE id = ${input.userId}
  `)).rows[0];
  if (!current) throw new Error("The player account no longer exists.");
  if (current.is_banned) return "already_banned" as const;
  const identifiers = await blockKnownUserIdentifiers({
    db,
    userId: input.userId,
    reason: input.reason,
    actorId: input.adminUserId,
    actorUsername: input.adminUsername,
  });
  await db.transaction(async (tx) => {
    const updated = await tx.execute<{ id: string }>(sql`
      UPDATE "user"
      SET is_banned = TRUE, banned_reason = ${input.reason}, banned_at = NOW(),
          banned_by = ${issuerMainUserId}, updated_at = NOW()
      WHERE id = ${input.userId} AND is_banned = FALSE
      RETURNING id
    `);
    if (updated.rows.length === 0) {
      const readback = (await tx.execute<{ is_banned: boolean }>(sql`
        SELECT is_banned FROM "user" WHERE id = ${input.userId}
      `)).rows[0];
      if (!readback?.is_banned) throw new Error("The account could not be banned.");
    }
    await tx.execute(sql`DELETE FROM session WHERE "userId" = ${input.userId}`);
  });
  return { status: "succeeded" as const, identifiers, issuerMainUserId };
}

export async function resolveDeclinedDepositAction(
  input: unknown,
): Promise<DeclinedDepositResolutionResult> {
  const session = await requireAntifraudManager(
    "Only owners and admins can resolve declined Fiat deposits.",
  );
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0].message };
  const expectedConfirmation =
    parsed.data.action === "refund"
      ? "REFUND"
      : parsed.data.action === "ban"
        ? "BAN"
        : "REFUND AND BAN";
  if (parsed.data.confirmation !== expectedConfirmation) {
    return { success: false, error: `Type ${expectedConfirmation} exactly to confirm.` };
  }

  try {
    await require2FA(session.userId, parsed.data.credential);
    const wantsRefund = parsed.data.action !== "ban";
    const wantsBan = parsed.data.action !== "refund";
    const claimed = await adminDrizzle.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`fiat-decline-resolution:${parsed.data.caseId}`}, 0))
      `);
      const replay = (await tx.execute<{ status: string }>(sql`
        SELECT status FROM admin_fiat_credit_reviews
        WHERE id = ${parsed.data.caseId}::uuid
          AND resolution_idempotency_key = ${parsed.data.idempotencyKey}::uuid
      `)).rows[0];
      if (replay?.status === "resolved") return null;
      const result = await tx.execute<ClaimedCase>(sql`
        UPDATE admin_fiat_credit_reviews
        SET status = 'resolving', resolution_action = ${parsed.data.action},
            resolution_reason = ${parsed.data.reason},
            resolution_idempotency_key = ${parsed.data.idempotencyKey}::uuid,
            resolution_requested_by = ${session.userId}::uuid,
            resolution_requested_at = NOW(),
            refund_status = CASE WHEN ${wantsRefund} THEN 'processing' ELSE 'not_requested' END,
            ban_status = CASE WHEN ${wantsBan} THEN 'processing' ELSE 'not_requested' END,
            attempt_count = attempt_count + 1, last_error = NULL,
            updated_at = NOW(), version = version + 1
        WHERE id = ${parsed.data.caseId}::uuid
          AND status IN ('declined', 'resolution_failed')
          AND version = ${parsed.data.expectedVersion}
        RETURNING id::text, deposit_intent_id::text, user_id,
                  provider_payment_id, amount_cents
      `);
      if (!result.rows[0]) {
        throw new Error("This declined deposit changed. Refresh and try again.");
      }
      return result.rows[0];
    });
    if (!claimed) return { success: true, status: "resolved", message: "This decision was already completed." };

    let banStatus = wantsBan ? "failed" : "not_requested";
    let banError: string | null = null;
    if (wantsBan) {
      try {
        const result = await banAccount({
          userId: claimed.user_id,
          reason: `Declined Fiat deposit ${claimed.deposit_intent_id}: ${parsed.data.reason}`.slice(0, 500),
          adminUserId: session.userId,
          adminUsername: session.username ?? undefined,
        });
        banStatus = typeof result === "string" ? result : result.status;
      } catch (error) {
        banError = error instanceof Error ? error.message : "The account could not be banned.";
      }
      await adminDrizzle.execute(sql`
        UPDATE admin_fiat_credit_reviews
        SET ban_status = ${banStatus}, ban_error_message = ${banError},
            ban_completed_at = CASE WHEN ${banStatus} IN ('succeeded', 'already_banned') THEN NOW() ELSE NULL END,
            updated_at = NOW()
        WHERE id = ${claimed.id}::uuid AND status = 'resolving'
      `);
    }

    let refundStatus = wantsRefund ? "failed" : "not_requested";
    let refundErrorCode: string | null = null;
    let refundErrorMessage: string | null = null;
    let providerStatus: string | null = null;
    let providerSubstatus: string | null = null;
    let refundedAmount: number | null = null;
    if (wantsRefund) {
      let requestSent = false;
      try {
        const client = whopAdminClient();
        const current = await client.payments.retrieve(claimed.provider_payment_id);
        providerStatus = current.status;
        providerSubstatus = current.substatus;
        refundedAmount = current.refunded_amount;
        const fullyRefunded =
          current.substatus === "refunded" ||
          (current.total != null && current.refunded_amount != null && current.refunded_amount >= current.total);
        if (fullyRefunded) {
          refundStatus = "already_refunded";
        } else if (!current.refundable) {
          refundStatus = "not_refundable";
          refundErrorMessage = "Whop reports that this payment is not refundable.";
        } else {
          requestSent = true;
          const refunded = await client.payments.refund(claimed.provider_payment_id);
          providerStatus = refunded.status;
          providerSubstatus = refunded.substatus;
          refundedAmount = refunded.refunded_amount;
          refundStatus = "succeeded";
        }
      } catch (error) {
        const safe = safeWhopError(error);
        refundStatus = safe.outcomeUnknown || requestSent ? "unknown" : "failed";
        refundErrorCode = safe.code;
        refundErrorMessage = safe.message;
      }
      await adminDrizzle.execute(sql`
        UPDATE admin_fiat_credit_reviews
        SET refund_status = ${refundStatus}, provider_status = ${providerStatus},
            provider_substatus = ${providerSubstatus}, refunded_amount = ${refundedAmount},
            refund_error_code = ${refundErrorCode}, refund_error_message = ${refundErrorMessage},
            refund_completed_at = CASE WHEN ${refundStatus} IN ('succeeded', 'already_refunded') THEN NOW() ELSE NULL END,
            updated_at = NOW()
        WHERE id = ${claimed.id}::uuid AND status = 'resolving'
      `);
      if (refundStatus === "succeeded" || refundStatus === "already_refunded") {
        const db = await getPrimaryDrizzleDb();
        await db.execute(sql`
          UPDATE fiat_deposit_intents
          SET status = 'refunded', provider_payment_status = ${providerSubstatus ?? providerStatus},
              provider_metadata = COALESCE(provider_metadata, '{}'::jsonb) ||
                ${JSON.stringify({
                  admin_decline_refund: true,
                  reviewed_by_admin_user_id: session.userId,
                  decline_case_id: claimed.id,
                })}::jsonb,
              review_decision = 'rejected', reviewed_at = COALESCE(reviewed_at, NOW()),
              updated_at = NOW()
          WHERE id = ${claimed.deposit_intent_id}::uuid
            AND provider_payment_id = ${claimed.provider_payment_id}
            AND status IN ('review', 'refund_pending', 'refund_failed')
        `);
      }
    }

    const banOk = !wantsBan || banStatus === "succeeded" || banStatus === "already_banned";
    const refundOk = !wantsRefund || refundStatus === "succeeded" || refundStatus === "already_refunded";
    const finalStatus = banOk && refundOk ? "resolved" : "resolution_failed";
    const errors = [banError, refundErrorMessage].filter(Boolean).join(" ") || null;
    await adminDrizzle.execute(sql`
      UPDATE admin_fiat_credit_reviews
      SET status = ${finalStatus}, last_error = ${errors},
          resolved_by = CASE WHEN ${finalStatus} = 'resolved' THEN ${session.userId}::uuid ELSE NULL END,
          resolved_at = CASE WHEN ${finalStatus} = 'resolved' THEN NOW() ELSE NULL END,
          updated_at = NOW(), version = version + 1
      WHERE id = ${claimed.id}::uuid AND status = 'resolving'
    `);
    await createAdminAuditEvent({
      adminUserId: session.userId,
      targetUserId: claimed.user_id,
      eventType: finalStatus === "resolved"
        ? "fiat_deposit_resolution_completed"
        : "fiat_deposit_resolution_failed",
      metadata: {
        caseId: claimed.id,
        intentId: claimed.deposit_intent_id,
        providerPaymentId: claimed.provider_payment_id,
        action: parsed.data.action,
        reason: parsed.data.reason,
        refundStatus,
        banStatus,
        idempotencyKey: parsed.data.idempotencyKey,
      },
    });
    revalidatePath("/antifraud/admin/deposits");
    revalidatePath("/antifraud/fiat-deposits");
    revalidatePath("/antifraud/banned-users");
    revalidateTag("users-list");
    revalidateTag("users-list-stats");
    revalidateTag(userDetailTag(claimed.user_id));
    return {
      success: true,
      status: finalStatus,
      message: finalStatus === "resolved"
        ? "The declined deposit decision was completed."
        : "Part of the decision failed. The completed part was kept and the case can be retried.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The declined deposit could not be resolved.";
    await adminDrizzle.execute(sql`
      UPDATE admin_fiat_credit_reviews
      SET status = 'resolution_failed', last_error = ${message},
          updated_at = NOW(), version = version + 1
      WHERE id = ${parsed.data.caseId}::uuid AND status = 'resolving'
    `).catch(() => undefined);
    return {
      success: false,
      error: message,
    };
  }
}
