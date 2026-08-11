import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";

export type WhopAutoBanRow = {
  id: string;
  userId: string;
  username: string | null;
  paymentId: string | null;
  depositIntentId: string | null;
  priorDisputes: number;
  priorRefunds: number;
  priorFraudDeclines: number;
  highRiskSessions: number;
  providerRiskScore: number | null;
  paymentStatus: string | null;
  declineCode: string | null;
  status: "pending" | "applied" | "failed" | "skipped";
  attempts: number;
  error: string | null;
  detectedAt: string;
  appliedAt: string | null;
  reviewId: string | null;
};

type RawRow = {
  id: string;
  target_user_id: string;
  target_username: string | null;
  payment_id: string | null;
  deposit_intent_id: string | null;
  prior_disputes: string;
  prior_refunds: string;
  prior_fraud_declines: string;
  high_risk_sessions: string;
  provider_risk_score: string | null;
  payment_status: string | null;
  decline_code: string | null;
  containment_outbox_status: string | null;
  containment_outbox_attempts: number;
  containment_outbox_error: string | null;
  received_at: string;
  containment_applied_at: string | null;
  review_id: string | null;
};

function state(value: string | null): WhopAutoBanRow["status"] {
  return value === "applied" ||
    value === "failed" ||
    value === "skipped"
    ? value
    : "pending";
}

function mapRow(row: RawRow): WhopAutoBanRow {
  return {
    id: row.id,
    userId: row.target_user_id,
    username: row.target_username,
    paymentId: row.payment_id,
    depositIntentId: row.deposit_intent_id,
    priorDisputes: Number(row.prior_disputes) || 0,
    priorRefunds: Number(row.prior_refunds) || 0,
    priorFraudDeclines: Number(row.prior_fraud_declines) || 0,
    highRiskSessions: Number(row.high_risk_sessions) || 0,
    providerRiskScore:
      row.provider_risk_score === null
        ? null
        : Number(row.provider_risk_score),
    paymentStatus: row.payment_status,
    declineCode: row.decline_code,
    status: state(row.containment_outbox_status),
    attempts: row.containment_outbox_attempts,
    error: row.containment_outbox_error,
    detectedAt: row.received_at,
    appliedAt: row.containment_applied_at,
    reviewId: row.review_id,
  };
}

export async function listWhopAutoBans(input: {
  page?: number;
  search?: string;
  status?: string;
}): Promise<{
  data: WhopAutoBanRow[];
  pagination: { page: number; pages: number; total: number; limit: number };
  counts: Record<WhopAutoBanRow["status"], number>;
}> {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const limit = 50;
  const offset = (page - 1) * limit;
  const search = input.search?.trim().slice(0, 200) || null;
  const selectedStatus = ["pending", "applied", "failed", "skipped"].includes(
    input.status ?? "",
  )
    ? input.status!
    : null;
  const statusSql = sql`COALESCE(containment_outbox_status, 'pending')`;
  const searchFilter = search
    ? sql`AND (
        target_user_id ILIKE ${`%${search}%`}
        OR COALESCE(target_username, '') ILIKE ${`%${search}%`}
        OR COALESCE(payload->>'paymentId', '') ILIKE ${`%${search}%`}
        OR COALESCE(payload->>'depositIntentId', '') ILIKE ${`%${search}%`}
      )`
    : sql``;
  const statusFilter = selectedStatus
    ? sql`AND ${statusSql} = ${selectedStatus}`
    : sql``;

  const [rows, totals, states] = await Promise.all([
    adminDrizzle.execute<RawRow>(sql`
      SELECT
        id::text,
        target_user_id,
        target_username,
        payload->>'paymentId' AS payment_id,
        payload->>'depositIntentId' AS deposit_intent_id,
        COALESCE(payload->>'priorDisputeCount', '0') AS prior_disputes,
        COALESCE(payload->>'priorRefundCount', '0') AS prior_refunds,
        COALESCE(payload->>'priorFraudDeclines', '0')
          AS prior_fraud_declines,
        COALESCE(payload->>'highRiskSessions', '0') AS high_risk_sessions,
        payload->>'providerRiskScore' AS provider_risk_score,
        payload->>'paymentStatus' AS payment_status,
        payload->>'declineCode' AS decline_code,
        containment_outbox_status,
        containment_outbox_attempts,
        containment_outbox_error,
        received_at::text,
        containment_applied_at::text,
        review_id::text
      FROM antifraud_signals
      WHERE kind='whop_history_auto_ban'
        ${searchFilter}
        ${statusFilter}
      ORDER BY received_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `),
    adminDrizzle.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM antifraud_signals
      WHERE kind='whop_history_auto_ban'
        ${searchFilter}
        ${statusFilter}
    `),
    adminDrizzle.execute<{ status: string; total: string }>(sql`
      SELECT ${statusSql} AS status, COUNT(*)::text AS total
      FROM antifraud_signals
      WHERE kind='whop_history_auto_ban'
      GROUP BY ${statusSql}
    `),
  ]);
  const total = Number(totals.rows[0]?.total ?? 0);
  const counts = {
    pending: 0,
    applied: 0,
    failed: 0,
    skipped: 0,
  } satisfies Record<WhopAutoBanRow["status"], number>;
  for (const row of states.rows) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = Number(row.total) || 0;
    }
  }
  return {
    data: rows.rows.map(mapRow),
    pagination: {
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      total,
      limit,
    },
    counts,
  };
}
