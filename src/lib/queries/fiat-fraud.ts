import "server-only";

import { getReadDrizzleDb } from "@/lib/db";
import {
  queryRows,
  sql,
} from "@/lib/queries/insights-rewards/_drizzle-query";

export type FiatFraudUserDepositTotal = {
  userId: string;
  paidDepositCount: number;
  paidTotalCents: number;
};

type RawFiatFraudUserDepositTotal = {
  user_id: string;
  paid_deposit_count: string;
  paid_total_cents: string;
};

/**
 * Lifetime paid fiat deposit totals per user. Bounded by the id list
 * (max 200) and index-backed via idx_fiat_deposit_intents_user_created
 * (user_id prefix), so no full-table scan is possible.
 */
export async function getFiatFraudUserDepositTotals(
  userIds: string[],
): Promise<FiatFraudUserDepositTotal[]> {
  const uniqueIds = [...new Set(userIds)].slice(0, 200);
  if (uniqueIds.length === 0) return [];

  const db = await getReadDrizzleDb();
  const rows = await queryRows<RawFiatFraudUserDepositTotal[]>(db, sql`
    SELECT
      user_id,
      COUNT(*) FILTER (WHERE paid_at IS NOT NULL)::text
        AS paid_deposit_count,
      COALESCE(
        SUM(COALESCE(actual_customer_total_cents, requested_amount_cents))
          FILTER (WHERE paid_at IS NOT NULL),
        0
      )::text AS paid_total_cents
    FROM fiat_deposit_intents
    WHERE user_id IN (
      ${sql.join(uniqueIds.map((id) => sql`${id}`), sql`, `)}
    )
    GROUP BY user_id
  `);

  return rows.map((row) => ({
    userId: row.user_id,
    paidDepositCount: Number(row.paid_deposit_count),
    paidTotalCents: Number(row.paid_total_cents),
  }));
}
