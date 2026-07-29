"use server";

import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { adminDrizzle } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  MAX_REFUNDS_PER_BATCH,
  resolveRefundSelection,
} from "@/lib/queries/whop-refunds";
import { require2FA } from "@/lib/require-2fa";
import { requireOwner } from "@/lib/owners";
import { safeWhopError, whopAdminClient } from "@/lib/whop-admin";
import {
  fail,
  ok,
  type ServerActionResult,
} from "@/lib/errors/server-action-result";

type Selection =
  | { mode: "all"; ids?: never }
  | { mode: "users"; ids: string[] }
  | { mode: "payments"; ids: string[] };

export type RefundBatchProgress = {
  batchId: string;
  pending: number;
  processing: number;
  succeeded: number;
  alreadyRefunded: number;
  notRefundable: number;
  failed: number;
  unknown: number;
  done: boolean;
};

function validateSelection(selection: Selection): Selection {
  if (selection.mode === "all") return selection;
  const ids = [...new Set(selection.ids.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new Error("Select at least one payment or user.");
  if (ids.length > MAX_REFUNDS_PER_BATCH) {
    throw new Error(`Select at most ${MAX_REFUNDS_PER_BATCH} records.`);
  }
  return { mode: selection.mode, ids } as Selection;
}

function actionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    /(?:2FA|passkey|verification|already used|refund reason|select at least|select at most|currently flagged selection|refundable deposits|already in refund batches|more than [\d,]+ refundable)/i.test(
      message,
    )
  ) {
    return message;
  }
  return "The refund operation could not be completed. No automatic retry was made.";
}

export async function createRefundBatch(input: {
  selection: Selection;
  reason: string;
  credential: string;
}): Promise<ServerActionResult<RefundBatchProgress>> {
  const session = await requireOwner();
  try {
    await require2FA(session.userId, input.credential);

    const reason = input.reason.trim();
    if (reason.length < 8 || reason.length > 500) {
      throw new Error("Enter a refund reason between 8 and 500 characters.");
    }
    const selection = validateSelection(input.selection);
    const candidates = await resolveRefundSelection(selection);
    if (candidates.length === 0) {
      throw new Error(
        "No new refundable deposits remain in that currently flagged selection.",
      );
    }

    const batch = await adminDrizzle.transaction(async (tx) => {
    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO admin_whop_refund_batches (
        requested_by, selection_mode, reason, status, requested_count
      )
      VALUES (
        ${session.userId}::uuid,
        ${selection.mode},
        ${reason},
        'pending',
        ${candidates.length}
      )
      RETURNING id::text
    `);
    const batchId = inserted.rows[0]?.id;
    if (!batchId) throw new Error("Could not create the refund batch.");

    const values = candidates.map(
      (candidate) => sql`(
        ${batchId}::uuid,
        ${candidate.userId},
        ${candidate.depositIntentId}::uuid,
        ${candidate.providerPaymentId},
        ${candidate.currency.toLowerCase()},
        ${candidate.amountCents}
      )`,
    );
    const items = await tx.execute(sql`
      INSERT INTO admin_whop_refund_items (
        batch_id,
        user_id,
        deposit_intent_id,
        provider_payment_id,
        currency,
        original_amount_cents
      )
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (provider_payment_id) DO NOTHING
      RETURNING id
    `);
    if (items.rows.length === 0) {
      throw new Error("Those deposits are already in refund batches.");
    }
    await tx.execute(sql`
      UPDATE admin_whop_refund_batches
      SET requested_count = ${items.rows.length}, updated_at = now()
      WHERE id = ${batchId}::uuid
    `);
    return { id: batchId, count: items.rows.length };
    });

    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "whop_refund_batch_created",
      metadata: {
        batchId: batch.id,
        selectionMode: selection.mode,
        paymentCount: batch.count,
        reason,
      },
    });
    revalidatePath("/antifraud/refunds");
    return ok(await getRefundBatchProgress(batch.id));
  } catch (error) {
    return fail(actionErrorMessage(error));
  }
}

async function finalizeBatch(batchId: string, adminUserId: string) {
  const result = await adminDrizzle.execute<{
    status: string;
    requested_count: number;
  }>(sql`
    WITH counts AS (
      SELECT
        COUNT(*) FILTER (
          WHERE status IN ('pending', 'processing')
        )::integer AS unfinished,
        COUNT(*) FILTER (
          WHERE status NOT IN ('succeeded', 'already_refunded')
        )::integer AS issues
      FROM admin_whop_refund_items
      WHERE batch_id = ${batchId}::uuid
    )
    UPDATE admin_whop_refund_batches b
    SET
      status = CASE
        WHEN counts.issues = 0 THEN 'completed'
        ELSE 'completed_with_issues'
      END,
      completed_at = now(),
      updated_at = now()
    FROM counts
    WHERE b.id = ${batchId}::uuid
      AND b.status IN ('pending', 'processing')
      AND counts.unfinished = 0
    RETURNING b.status, b.requested_count
  `);
  const completed = result.rows[0];
  if (completed) {
    await createAdminAuditEvent({
      adminUserId,
      eventType: "whop_refund_batch_completed",
      metadata: {
        batchId,
        status: completed.status,
        paymentCount: completed.requested_count,
      },
    });
  }
}

export async function processNextRefund(
  batchId: string,
): Promise<ServerActionResult<RefundBatchProgress>> {
  const session = await requireOwner();
  try {
    if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error("Invalid batch.");

  const claimed = await adminDrizzle.execute<{
    id: string;
    provider_payment_id: string;
  }>(sql`
    WITH next_item AS (
      SELECT id
      FROM admin_whop_refund_items
      WHERE batch_id = ${batchId}::uuid
        AND (
          status = 'pending'
          OR (status = 'processing' AND leased_until < now())
        )
      ORDER BY created_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE admin_whop_refund_items item
    SET
      status = 'processing',
      attempt_count = attempt_count + 1,
      lease_token = gen_random_uuid(),
      leased_until = now() + interval '45 seconds',
      error_code = NULL,
      error_message = NULL,
      updated_at = now()
    FROM next_item
    WHERE item.id = next_item.id
    RETURNING item.id::text, item.provider_payment_id
  `);
  const item = claimed.rows[0];
  if (!item) {
    await finalizeBatch(batchId, session.userId);
    return ok(await getRefundBatchProgress(batchId));
  }

  await adminDrizzle.execute(sql`
    UPDATE admin_whop_refund_batches
    SET status = 'processing', updated_at = now()
    WHERE id = ${batchId}::uuid AND status = 'pending'
  `);

  let refundRequested = false;
  try {
    const client = whopAdminClient();
    const payment = await client.payments.retrieve(item.provider_payment_id);
    if (!payment.refundable) {
      const fullyRefunded =
        payment.substatus === "refunded" ||
        (payment.total !== null &&
          payment.refunded_amount !== null &&
          payment.refunded_amount >= payment.total);
      await adminDrizzle.execute(sql`
        UPDATE admin_whop_refund_items
        SET
          status = ${fullyRefunded ? "already_refunded" : "not_refundable"},
          provider_status = ${payment.status},
          provider_substatus = ${payment.substatus},
          refunded_amount = ${payment.refunded_amount},
          completed_at = now(),
          lease_token = NULL,
          leased_until = NULL,
          updated_at = now()
        WHERE id = ${item.id}::uuid
          AND status = 'processing'
      `);
    } else {
      // Omit partial_amount intentionally: Whop defines this as a full refund.
      refundRequested = true;
      const refunded = await client.payments.refund(item.provider_payment_id);
      await adminDrizzle.execute(sql`
        UPDATE admin_whop_refund_items
        SET
          status = 'succeeded',
          provider_status = ${refunded.status},
          provider_substatus = ${refunded.substatus},
          refunded_amount = ${refunded.refunded_amount},
          completed_at = now(),
          lease_token = NULL,
          leased_until = NULL,
          updated_at = now()
        WHERE id = ${item.id}::uuid
          AND status = 'processing'
      `);
    }
  } catch (error) {
    const safe = safeWhopError(error);
    await adminDrizzle.execute(sql`
      UPDATE admin_whop_refund_items
      SET
        status = ${safe.outcomeUnknown || refundRequested ? "unknown" : "failed"},
        error_code = ${safe.code},
        error_message = ${safe.message},
        completed_at = now(),
        lease_token = NULL,
        leased_until = NULL,
        updated_at = now()
      WHERE id = ${item.id}::uuid
        AND status = 'processing'
    `);
  }

  await finalizeBatch(batchId, session.userId);
  revalidatePath("/antifraud/refunds");
    return ok(await getRefundBatchProgress(batchId));
  } catch (error) {
    return fail(actionErrorMessage(error));
  }
}

export async function getRefundBatchProgress(
  batchId: string,
): Promise<RefundBatchProgress> {
  await requireOwner();
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error("Invalid batch.");
  const result = await adminDrizzle.execute<{
    pending: number;
    processing: number;
    succeeded: number;
    already_refunded: number;
    not_refundable: number;
    failed: number;
    unknown: number;
  }>(sql`
    SELECT
      COUNT(i.id) FILTER (WHERE i.status = 'pending')::integer AS pending,
      COUNT(i.id) FILTER (WHERE i.status = 'processing')::integer AS processing,
      COUNT(i.id) FILTER (WHERE i.status = 'succeeded')::integer AS succeeded,
      COUNT(i.id) FILTER (WHERE i.status = 'already_refunded')::integer
        AS already_refunded,
      COUNT(i.id) FILTER (WHERE i.status = 'not_refundable')::integer
        AS not_refundable,
      COUNT(i.id) FILTER (WHERE i.status = 'failed')::integer AS failed,
      COUNT(i.id) FILTER (WHERE i.status = 'unknown')::integer AS unknown
    FROM admin_whop_refund_batches b
    LEFT JOIN admin_whop_refund_items i ON i.batch_id = b.id
    WHERE b.id = ${batchId}::uuid
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Refund batch not found.");
  const progress = {
    batchId,
    pending: Number(row.pending ?? 0),
    processing: Number(row.processing ?? 0),
    succeeded: Number(row.succeeded ?? 0),
    alreadyRefunded: Number(row.already_refunded ?? 0),
    notRefundable: Number(row.not_refundable ?? 0),
    failed: Number(row.failed ?? 0),
    unknown: Number(row.unknown ?? 0),
    done: false,
  };
  progress.done = progress.pending + progress.processing === 0;
  return progress;
}
