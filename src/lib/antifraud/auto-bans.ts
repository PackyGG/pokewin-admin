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

/** Highest page this list will serve, and therefore the deepest OFFSET. */
const MAX_PAGE = 10_000;

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
  // `?page=` reaches this function straight from the URL (`Number(params.page)
  // || 1` in auto-bans/page.tsx), so without a ceiling `?page=1e30` became
  // `OFFSET 5e31` — an arbitrarily deep offset over a table this query already
  // has to scan in full. MAX_PAGE bounds the offset at the last row the pager
  // can reach; `pages` is capped to the same value so "next" can never offer a
  // page the clamp would silently redirect back to page MAX_PAGE.
  const page = Math.max(1, Math.min(Math.trunc(input.page ?? 1) || 1, MAX_PAGE));
  const limit = 50;
  const offset = (page - 1) * limit;
  const search = input.search?.trim().slice(0, 200) || null;
  const selectedStatus = ["pending", "applied", "failed", "skipped"].includes(
    input.status ?? "",
  )
    ? input.status!
    : null;
  const statusSql = sql`COALESCE(containment_outbox_status, 'pending')`;
  // Substring ILIKE is kept deliberately; do NOT "optimize" it into the
  // prefix form used by staff-audit.ts/reviews.ts. That form pays off there
  // because MAIN ships matching `lower(col) text_pattern_ops` prefix indexes.
  // Nothing equivalent exists here: `antifraud_signals` has no index on
  // `kind`, none on the two `payload->>` expressions, and its only
  // target_user_id index is plain `text_ops` — unusable for LIKE prefix
  // matching. So every arm of this filter is a scan either way, and narrowing
  // to prefixes would buy no plan change while costing operators the ability
  // to find a signal by a fragment of a Whop paymentId or deposit intent id,
  // which is how those two arms are actually used. The real fix is a partial
  // index on `kind = 'whop_history_auto_ban'` (owner-applied migration).
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
  // `antifraud_signals` has no index on `kind`, so every one of these queries
  // is a full pass over the signal stream. The unfiltered status GROUP BY
  // already visits every whop auto-ban row, so without a search term its group
  // totals *are* the count — running COUNT(*) beside it buys a second scan and
  // no new information. Only a search narrows the set in a way the GROUP BY
  // cannot express, and only then is the extra pass earned.
  const needsCountScan = search !== null;

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
    needsCountScan
      ? adminDrizzle.execute<{ total: string }>(sql`
          SELECT COUNT(*)::text AS total
          FROM antifraud_signals
          WHERE kind='whop_history_auto_ban'
            ${searchFilter}
            ${statusFilter}
        `)
      : null,
    adminDrizzle.execute<{ status: string; total: string }>(sql`
      SELECT ${statusSql} AS status, COUNT(*)::text AS total
      FROM antifraud_signals
      WHERE kind='whop_history_auto_ban'
      GROUP BY ${statusSql}
    `),
  ]);
  const counts = {
    pending: 0,
    applied: 0,
    failed: 0,
    skipped: 0,
  } satisfies Record<WhopAutoBanRow["status"], number>;
  let unfilteredTotal = 0;
  for (const row of states.rows) {
    unfilteredTotal += Number(row.total) || 0;
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = Number(row.total) || 0;
    }
  }
  const total = totals
    ? Number(totals.rows[0]?.total ?? 0)
    : selectedStatus
      ? counts[selectedStatus as WhopAutoBanRow["status"]]
      : unfilteredTotal;
  return {
    data: rows.rows.map(mapRow),
    pagination: {
      page,
      pages: Math.max(1, Math.min(Math.ceil(total / limit), MAX_PAGE)),
      total,
      limit,
    },
    counts,
  };
}
