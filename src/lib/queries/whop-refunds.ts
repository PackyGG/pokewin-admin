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
  country: string | null;
  countryCode: string | null;
  state: string | null;
  city: string | null;
  currency: string;
  amountCents: number;
  status: string;
  providerStatus: string | null;
  createdAt: string;
  flagReason: string;
  kycRequired: boolean;
  isBanned: boolean;
  alreadyQueued: boolean;
};

export type RefundBatchSummary = {
  batchId: string;
  status: string;
  selectionMode: string;
  reason: string;
  createdAt: string;
  completedAt: string | null;
  requestedCount: number;
  pending: number;
  succeeded: number;
  issues: number;
  accounts: RefundBatchAccountSummary[];
};

export type RefundBatchAccountSummary = {
  userId: string;
  username: string | null;
  email: string | null;
  country: string | null;
  countryCode: string | null;
  state: string | null;
  city: string | null;
  items: RefundBatchItemSummary[];
};

export type RefundBatchItemSummary = {
  itemId: string;
  depositIntentId: string;
  providerPaymentId: string;
  currency: string;
  originalAmountCents: number;
  status: WhopRefundState;
  attemptCount: number;
  providerStatus: string | null;
  providerSubstatus: string | null;
  refundedAmount: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type WhopRefundState =
  | "pending"
  | "processing"
  | "succeeded"
  | "already_refunded"
  | "not_refundable"
  | "failed"
  | "unknown";

type RefundFlag = {
  reason: string;
  kycRequired: boolean;
  isBanned: boolean;
};

async function currentlyFlaggedUsers(): Promise<Map<string, RefundFlag>> {
  const analystRows = await adminDrizzle
    .select({
      userId: antifraud_reviews.target_user_id,
      reason: antifraud_reviews.reason,
    })
    .from(antifraud_reviews)
    .where(eq(antifraud_reviews.status, "flagged"));

  const reasons = new Map<string, RefundFlag>();
  for (const row of analystRows) {
    reasons.set(row.userId, {
      reason: row.reason || "Flagged by Antifraud",
      kycRequired: false,
      isBanned: false,
    });
  }

  const db = readDrizzleForEnv(await readDbEnv());
  const sourceFlags = await db.execute<{
    user_id: string;
    reason: string | null;
    kyc_required: boolean;
    is_banned: boolean;
  }>(sql`
    SELECT
      id AS user_id,
      NULLIF(BTRIM(banned_reason), '') AS reason,
      false AS kyc_required,
      true AS is_banned
    FROM "user"
    WHERE is_banned = true

    UNION ALL

    SELECT
      user_id,
      kyc_required_reason AS reason,
      true AS kyc_required,
      false AS is_banned
    FROM user_kyc
    WHERE kyc_required = true
      AND (
        kyc_required_by LIKE 'system:antifraud-%'
        OR COALESCE(kyc_required_reason, '') ~*
          '(fraud|abuse|chargeback|scam|stolen|alt[ -]?account)'
      )
  `);
  for (const row of sourceFlags.rows) {
    const existing = reasons.get(row.user_id);
    reasons.set(row.user_id, {
      reason:
        existing?.reason ||
        row.reason ||
        (row.is_banned ? "Banned account" : "Fraud-specific KYC containment"),
      kycRequired: existing?.kycRequired || row.kyc_required,
      isBanned: existing?.isBanned || row.is_banned,
    });
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

async function getWhopRefundStates(
  paymentIds: readonly string[],
): Promise<Map<string, WhopRefundState>> {
  const uniqueIds = [...new Set(paymentIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();
  const rows = await adminDrizzle.execute<{
    provider_payment_id: string;
    status: WhopRefundState;
  }>(sql`
    SELECT provider_payment_id, status
    FROM admin_whop_refund_items
    WHERE provider_payment_id =
      ANY(${pgArrayParam(uniqueIds)}::text[])
  `);
  return new Map(rows.rows.map((row) => [row.provider_payment_id, row.status]));
}

async function queryCandidates(
  flagged: Map<string, RefundFlag>,
  filter:
    | { mode: "all" }
    | { mode: "users"; ids: readonly string[] }
    | { mode: "payments"; ids: readonly string[] },
  limit: number,
  strictLimit = true,
): Promise<RefundCandidate[]> {
  // Fail closed on an unknown mode. Previously anything that was not
  // "users" / "payments" silently degraded to the unfiltered "every flagged
  // account" query, which the refund pipeline then bans and drains.
  if (
    filter.mode !== "all" &&
    filter.mode !== "users" &&
    filter.mode !== "payments"
  ) {
    throw new Error("Unsupported refund selection mode.");
  }

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
      ? sql`AND refundable.provider_payment_id =
          ANY(${pgArrayParam(filter.ids)}::text[])`
      : sql``;
  const db = readDrizzleForEnv(await readDbEnv());
  const result = await db.execute<{
    deposit_intent_id: string;
    provider_payment_id: string;
    user_id: string;
    username: string | null;
    email: string | null;
    country: string | null;
    country_code: string | null;
    state: string | null;
    city: string | null;
    currency: string;
    amount_cents: number;
    status: string;
    provider_status: string | null;
    created_at: string;
  }>(sql`
    WITH paid_unreconciled AS (
      SELECT DISTINCT ON (
        payload#>>'{data,metadata,deposit_intent_id}'
      )
        payload#>>'{data,metadata,deposit_intent_id}' AS intent_id,
        provider_resource_id AS provider_payment_id,
        payload#>>'{data,status}' AS provider_status,
        received_at
      FROM payment_webhook_events
      WHERE provider = 'whop'
        AND event_type = 'payment.succeeded'
        AND processing_status = 'failed'
        AND received_at >=
          (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '30 days'
        AND COALESCE(
          payload#>>'{data,metadata,deposit_intent_id}',
          ''
        ) <> ''
      ORDER BY
        payload#>>'{data,metadata,deposit_intent_id}',
        received_at DESC,
        id DESC
    ),
    refundable AS (
      SELECT
        i.id,
        i.provider_payment_id,
        i.user_id,
        i.currency,
        COALESCE(i.actual_customer_total_cents, i.requested_amount_cents)
          AS amount_cents,
        i.status::text AS status,
        i.provider_payment_status AS provider_status,
        i.created_at
      FROM fiat_deposit_intents i
      WHERE i.provider = 'whop'
        AND i.status IN ('completed', 'partially_refunded')
        AND i.provider_payment_id IS NOT NULL

      UNION ALL

      SELECT
        i.id,
        paid.provider_payment_id,
        i.user_id,
        i.currency,
        i.requested_amount_cents AS amount_cents,
        'paid_unreconciled'::text AS status,
        COALESCE(paid.provider_status, 'paid') AS provider_status,
        paid.received_at AS created_at
      FROM paid_unreconciled paid
      JOIN fiat_deposit_intents i ON i.id::text = paid.intent_id
      WHERE i.provider = 'whop'
        AND i.status NOT IN (
          'completed',
          'partially_refunded',
          'refunded',
          'disputed'
        )
    )
    SELECT
      refundable.id::text AS deposit_intent_id,
      refundable.provider_payment_id,
      refundable.user_id,
      u.username,
      u.email,
      u.country,
      u.country_code,
      u.state,
      u.city,
      refundable.currency,
      refundable.amount_cents,
      refundable.status,
      refundable.provider_status,
      refundable.created_at::text
    FROM refundable
    JOIN "user" u ON u.id = refundable.user_id
    WHERE refundable.user_id =
      ANY(${pgArrayParam(scopedUserIds)}::text[])
      ${paymentFilter}
    ORDER BY refundable.created_at DESC, refundable.id DESC
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
  return visibleRows.map((row) => {
    const flag = flagged.get(row.user_id);
    return {
      depositIntentId: row.deposit_intent_id,
      providerPaymentId: row.provider_payment_id,
      userId: row.user_id,
      username: row.username,
      email: row.email,
      country: row.country,
      countryCode: row.country_code,
      state: row.state,
      city: row.city,
      currency: row.currency,
      amountCents: Number(row.amount_cents),
      status: row.status,
      providerStatus: row.provider_status,
      createdAt: row.created_at,
      flagReason: flag?.reason ?? "Flagged by Antifraud",
      kycRequired: flag?.kycRequired ?? false,
      isBanned: flag?.isBanned ?? false,
      alreadyQueued: queued.has(row.provider_payment_id),
    };
  });
}

export async function getRefundCandidates(): Promise<RefundCandidate[]> {
  const flagged = await currentlyFlaggedUsers();
  const candidates = await queryCandidates(
    flagged,
    { mode: "all" },
    MAX_VISIBLE_DEPOSITS,
    false,
  );
  return candidates.filter((candidate) => !candidate.alreadyQueued);
}

export async function resolveRefundSelection(
  input:
    | { mode: "all" }
    | { mode: "users"; ids: readonly string[] }
    | { mode: "payments"; ids: readonly string[] },
): Promise<RefundCandidate[]> {
  const flagged = await currentlyFlaggedUsers();
  const candidates = await queryCandidates(
    flagged,
    input,
    MAX_REFUNDS_PER_BATCH,
  );
  return candidates.filter((candidate) => !candidate.alreadyQueued);
}

export async function getRecentRefundBatches(): Promise<RefundBatchSummary[]> {
  const batchResult = await adminDrizzle.execute<{
    batch_id: string;
    status: string;
    selection_mode: string;
    reason: string;
    created_at: string;
    completed_at: string | null;
    requested_count: number;
    pending: number;
    succeeded: number;
    issues: number;
  }>(sql`
    SELECT
      b.id::text AS batch_id,
      b.status,
      b.selection_mode,
      b.reason,
      b.created_at::text,
      b.completed_at::text,
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

  const batchIds = batchResult.rows.map((row) => row.batch_id);
  if (batchIds.length === 0) return [];

  const itemResult = await adminDrizzle.execute<{
    item_id: string;
    batch_id: string;
    user_id: string;
    deposit_intent_id: string;
    provider_payment_id: string;
    currency: string;
    original_amount_cents: number;
    status: WhopRefundState;
    attempt_count: number;
    provider_status: string | null;
    provider_substatus: string | null;
    refunded_amount: string | null;
    error_code: string | null;
    error_message: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  }>(sql`
    SELECT
      id::text AS item_id,
      batch_id::text,
      user_id,
      deposit_intent_id::text,
      provider_payment_id,
      currency,
      original_amount_cents,
      status,
      attempt_count,
      provider_status,
      provider_substatus,
      refunded_amount::text,
      error_code,
      error_message,
      created_at::text,
      updated_at::text,
      completed_at::text
    FROM admin_whop_refund_items
    WHERE batch_id = ANY(${pgArrayParam(batchIds)}::uuid[])
    ORDER BY created_at, id
  `);

  const userIds = [...new Set(itemResult.rows.map((row) => row.user_id))];
  const users = new Map<
    string,
    {
      username: string | null;
      email: string | null;
      country: string | null;
      countryCode: string | null;
      state: string | null;
      city: string | null;
    }
  >();
  if (userIds.length > 0) {
    const db = readDrizzleForEnv(await readDbEnv());
    const userResult = await db.execute<{
      user_id: string;
      username: string | null;
      email: string | null;
      country: string | null;
      country_code: string | null;
      state: string | null;
      city: string | null;
    }>(sql`
      SELECT
        id AS user_id,
        username,
        email,
        country,
        country_code,
        state,
        city
      FROM "user"
      WHERE id = ANY(${pgArrayParam(userIds)}::text[])
    `);
    for (const row of userResult.rows) {
      users.set(row.user_id, {
        username: row.username,
        email: row.email,
        country: row.country,
        countryCode: row.country_code,
        state: row.state,
        city: row.city,
      });
    }
  }

  const accountsByBatch = new Map<
    string,
    Map<string, RefundBatchAccountSummary>
  >();
  for (const row of itemResult.rows) {
    let accounts = accountsByBatch.get(row.batch_id);
    if (!accounts) {
      accounts = new Map();
      accountsByBatch.set(row.batch_id, accounts);
    }
    let account = accounts.get(row.user_id);
    if (!account) {
      const profile = users.get(row.user_id);
      account = {
        userId: row.user_id,
        username: profile?.username ?? null,
        email: profile?.email ?? null,
        country: profile?.country ?? null,
        countryCode: profile?.countryCode ?? null,
        state: profile?.state ?? null,
        city: profile?.city ?? null,
        items: [],
      };
      accounts.set(row.user_id, account);
    }
    account.items.push({
      itemId: row.item_id,
      depositIntentId: row.deposit_intent_id,
      providerPaymentId: row.provider_payment_id,
      currency: row.currency,
      originalAmountCents: Number(row.original_amount_cents),
      status: row.status,
      attemptCount: Number(row.attempt_count),
      providerStatus: row.provider_status,
      providerSubstatus: row.provider_substatus,
      refundedAmount: row.refunded_amount,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    });
  }

  return batchResult.rows.map((row) => ({
    batchId: row.batch_id,
    status: row.status,
    selectionMode: row.selection_mode,
    reason: row.reason,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    requestedCount: Number(row.requested_count),
    pending: Number(row.pending),
    succeeded: Number(row.succeeded),
    issues: Number(row.issues),
    accounts: [...(accountsByBatch.get(row.batch_id)?.values() ?? [])],
  }));
}
