import { sql, type SQL } from "drizzle-orm";

import { pgArrayParam } from "@/lib/drizzle-array-param";
import type { MainDrizzleDb } from "@/lib/db";

export type UserFiatIntentFilter = {
  userId: string;
  types?: string[];
  status?: "pending" | "completed" | "failed";
  dateFrom?: Date;
  dateTo?: Date;
};

export type PendingFiatIntentRow = {
  id: string;
  user_id: string;
  status: string;
  requested_amount_cents: number;
  credited_amount_cents: number;
  actual_customer_total_cents: number | null;
  provider_payment_id: string | null;
  provider_payment_status: string | null;
  failure_reason: string | null;
  paid_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  checkout_email: string | null;
};

export function fiatIntentEventAt(alias = "i"): SQL {
  return sql`COALESCE(${sql.identifier(alias)}.paid_at, ${sql.identifier(alias)}.updated_at, ${sql.identifier(alias)}.created_at)`;
}

/** Paid Fiat intents without a ledger credit are real deposits in flight. */
export function fiatIntentWhereSql(filter: UserFiatIntentFilter): SQL {
  if (filter.types && !filter.types.includes("deposit")) return sql`false`;

  const eventAt = fiatIntentEventAt();
  const clauses: SQL[] = [
    sql`i.user_id = ${filter.userId}`,
    // Once crediting succeeds the canonical ledger row owns display.
    sql`i.completed_ledger_id IS NULL`,
    // Checkout-only/abandoned intents are not deposits and stay hidden.
    sql`(i.paid_at IS NOT NULL OR lower(COALESCE(i.provider_payment_status, '')) = 'paid')`,
  ];
  if (filter.status === "completed") {
    clauses.push(sql`i.status = 'completed'`);
  } else if (filter.status === "failed") {
    clauses.push(
      sql`i.status = ANY(ARRAY['failed', 'canceled', 'refunded', 'disputed']::text[])`,
    );
  } else if (filter.status === "pending") {
    clauses.push(
      sql`i.status <> ALL(ARRAY['completed', 'failed', 'canceled', 'refunded', 'disputed']::text[])`,
    );
  }
  if (filter.dateFrom) clauses.push(sql`${eventAt} >= ${filter.dateFrom}`);
  if (filter.dateTo) clauses.push(sql`${eventAt} <= ${filter.dateTo}`);
  return sql.join(clauses, sql` AND `);
}

/** Exact intent lookup for only the ids selected by the merged page. */
export async function fetchPendingFiatIntentsByIds(
  db: MainDrizzleDb,
  userId: string,
  ids: string[],
): Promise<PendingFiatIntentRow[]> {
  if (ids.length === 0) return [];
  const result = await db.execute<PendingFiatIntentRow>(sql`
    SELECT
      i.id::text, i.user_id, i.status, i.requested_amount_cents,
      i.credited_amount_cents, i.actual_customer_total_cents,
      i.provider_payment_id, i.provider_payment_status, i.failure_reason,
      i.paid_at, i.created_at, i.updated_at, checkout.checkout_email
    FROM unnest(${pgArrayParam(ids)}::uuid[]) WITH ORDINALITY requested(id, ord)
    JOIN fiat_deposit_intents i ON i.id = requested.id
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN length(btrim(pwe.payload #>> '{data,user,email}')) <= 320
          AND position('@' IN btrim(pwe.payload #>> '{data,user,email}')) > 1
        THEN btrim(pwe.payload #>> '{data,user,email}')
        ELSE NULL
      END AS checkout_email
      FROM payment_webhook_events pwe
      WHERE pwe.provider = 'whop'
        AND pwe.event_type = 'payment.created'
        AND NULLIF(pwe.payload #>> '{data,metadata,deposit_intent_id}', '') = i.id::text
      ORDER BY pwe.received_at DESC, pwe.id DESC
      LIMIT 1
    ) checkout ON TRUE
    WHERE i.user_id = ${userId}
    ORDER BY requested.ord
  `);
  return result.rows;
}

export function pendingFiatStatusLabel(status: string): string {
  if (status === "review") return "in credit review";
  if (status === "approval_processing") return "credit approval processing";
  if (status === "refund_pending") return "refund pending";
  if (["failed", "canceled", "refund_failed"].includes(status)) {
    return "crediting failed";
  }
  return "awaiting credit";
}
