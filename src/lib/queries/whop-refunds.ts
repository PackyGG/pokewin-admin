import "server-only";

import { eq, sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { antifraud_reviews } from "@/lib/db-schema/admin/schema";
import { readDrizzleForEnv } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { pgArrayParam } from "@/lib/drizzle-array-param";

const MAX_VISIBLE_DEPOSITS = 500;
export const MAX_REFUNDS_PER_BATCH = 1_000;

export type RefundCandidate = {
  depositIntentId: string;
  providerPaymentId: string;
  userId: string;
  username: string | null;
  email: string | null;
  currency: string;
  amountCents: number;
  status: string;
  providerStatus: string | null;
  createdAt: string;
  flagReason: string;
  alreadyQueued: boolean;
};

export type RefundBatchSummary = {
  batchId: string;
  status: string;
  reason: string;
  createdAt: string;
  requestedCount: number;
  pending: number;
  succeeded: number;
  issues: number;
};

async function currentlyFlaggedUsers(): Promise<Map<string, string>> {
  const analystRows = await adminDrizzle
    .select({
      userId: antifraud_reviews.target_user_id,
      reason: antifraud_reviews.reason,
    })
    .from(antifraud_reviews)
    .where(eq(antifraud_reviews.status, "flagged"));

  const reasons = new Map<string, string>();
  for (const row of analystRows) {
    reasons.set(row.userId, row.reason || "Flagged by Antifraud");
  }

  const db = readDrizzleForEnv(await readDbEnv());
  const automated = await db.execute<{
    user_id: string;
    reason: string | null;
  }>(sql`
    SELECT user_id, kyc_required_reason AS reason
    FROM user_kyc
    WHERE kyc_required = true
      AND (
        kyc_required_by LIKE 'system:antifraud-%'
        OR COALESCE(kyc_required_reason, '') ~*
          '(fraud|scam|chargeback|dispute|blacklist|suspicious|free battle|sponsored battle|linked alt)'
      )
  `);
  for (const row of automated.rows) {
    if (!reasons.has(row.user_id)) {
      reasons.set(
        row.user_id,
        row.reason || "KYC required by automated Antifraud",
      );
    }
  }
  return reasons;
}

async function existingRefundPayments(
  paymentIds: readonly string[],
): Promise<Set<string>> {
  if (paymentIds.length === 0) return new Set();
  const rows = await adminDrizzle.execute<{ provider_payment_id: string }>(sql`
    SELECT provider_payment_id
    FROM admin_whop_refund_items
    WHERE provider_payment_id =
      ANY(${pgArrayParam(paymentIds)}::text[])
  `);
  return new Set(rows.rows.map((row) => row.provider_payment_id));
}

async function queryCandidates(
  flagged: Map<string, string>,
  filter:
    | { mode: "all" }
    | { mode: "users"; ids: readonly string[] }
    | { mode: "payments"; ids: readonly string[] },
  limit: number,
  strictLimit = true,
): Promise<RefundCandidate[]> {
  const allFlaggedIds = [...flagged.keys()];
  if (allFlaggedIds.length === 0) return [];

  let scopedUserIds = allFlaggedIds;
  if (filter.mode === "users") {
    const requested = new Set(filter.ids);
    scopedUserIds = allFlaggedIds.filter((id) => requested.has(id));
  }
  if (scopedUserIds.length === 0) return [];

  const paymentFilter =
    filter.mode === "payments"
      ? sql`AND i.provider_payment_id =
          ANY(${pgArrayParam(filter.ids)}::text[])`
      : sql``;
  const db = readDrizzleForEnv(await readDbEnv());
  const result = await db.execute<{
    deposit_intent_id: string;
    provider_payment_id: string;
    user_id: string;
    username: string | null;
    email: string | null;
    currency: string;
    amount_cents: number;
    status: string;
    provider_status: string | null;
    created_at: string;
  }>(sql`
    SELECT
      i.id::text AS deposit_intent_id,
      i.provider_payment_id,
      i.user_id,
      u.username,
      u.email,
      i.currency,
      COALESCE(i.actual_customer_total_cents, i.requested_amount_cents)
        AS amount_cents,
      i.status,
      i.provider_payment_status AS provider_status,
      i.created_at::text
    FROM fiat_deposit_intents i
    JOIN "user" u ON u.id = i.user_id
    WHERE i.provider = 'whop'
      AND i.status IN ('completed', 'partially_refunded')
      AND i.provider_payment_id IS NOT NULL
      AND i.user_id = ANY(${pgArrayParam(scopedUserIds)}::text[])
      ${paymentFilter}
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT ${limit + 1}
  `);

  if (strictLimit && result.rows.length > limit) {
    throw new Error(
      `This selection contains more than ${limit.toLocaleString()} refundable deposits. Select fewer users or payments.`,
    );
  }
  const visibleRows = result.rows.slice(0, limit);
  const queued = await existingRefundPayments(
    visibleRows.map((row) => row.provider_payment_id),
  );
  return visibleRows.map((row) => ({
    depositIntentId: row.deposit_intent_id,
    providerPaymentId: row.provider_payment_id,
    userId: row.user_id,
    username: row.username,
    email: row.email,
    currency: row.currency,
    amountCents: Number(row.amount_cents),
    status: row.status,
    providerStatus: row.provider_status,
    createdAt: row.created_at,
    flagReason: flagged.get(row.user_id) ?? "Flagged by Antifraud",
    alreadyQueued: queued.has(row.provider_payment_id),
  }));
}

export async function getRefundCandidates(): Promise<RefundCandidate[]> {
  const flagged = await currentlyFlaggedUsers();
  return queryCandidates(
    flagged,
    { mode: "all" },
    MAX_VISIBLE_DEPOSITS,
    false,
  );
}

export async function resolveRefundSelection(input:
  | { mode: "all" }
  | { mode: "users"; ids: readonly string[] }
  | { mode: "payments"; ids: readonly string[] }): Promise<RefundCandidate[]> {
  const flagged = await currentlyFlaggedUsers();
  const candidates = await queryCandidates(
    flagged,
    input,
    MAX_REFUNDS_PER_BATCH,
  );
  return candidates.filter((candidate) => !candidate.alreadyQueued);
}

export async function getRecentRefundBatches(): Promise<RefundBatchSummary[]> {
  const result = await adminDrizzle.execute<{
    batch_id: string;
    status: string;
    reason: string;
    created_at: string;
    requested_count: number;
    pending: number;
    succeeded: number;
    issues: number;
  }>(sql`
    SELECT
      b.id::text AS batch_id,
      b.status,
      b.reason,
      b.created_at::text,
      b.requested_count,
      COUNT(i.id) FILTER (
        WHERE i.status IN ('pending', 'processing')
      )::integer AS pending,
      COUNT(i.id) FILTER (
        WHERE i.status IN ('succeeded', 'already_refunded')
      )::integer AS succeeded,
      COUNT(i.id) FILTER (
        WHERE i.status IN ('not_refundable', 'failed', 'unknown')
      )::integer AS issues
    FROM admin_whop_refund_batches b
    LEFT JOIN admin_whop_refund_items i ON i.batch_id = b.id
    GROUP BY b.id
    ORDER BY b.created_at DESC
    LIMIT 10
  `);
  return result.rows.map((row) => ({
    batchId: row.batch_id,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    requestedCount: Number(row.requested_count),
    pending: Number(row.pending),
    succeeded: Number(row.succeeded),
    issues: Number(row.issues),
  }));
}
