import "server-only";

import { getReadDrizzleDb } from "@/lib/db";
import {
  queryRows,
  sql,
} from "@/lib/queries/insights-rewards/_drizzle-query";

export type FiatFraudDepositSummary = {
  intentId: string;
  currency: string;
  requestedAmountCents: number;
  actualCustomerTotalCents: number | null;
  creditedAmountCents: number | null;
  status: string;
  providerPaymentStatus: string | null;
};

type RawFiatFraudDepositSummary = {
  intent_id: string;
  currency: string;
  requested_amount_cents: string;
  actual_customer_total_cents: string | null;
  credited_amount_cents: string | null;
  status: string;
  provider_payment_status: string | null;
};

function optionalNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export async function getFiatFraudDepositSummaries(
  intentIds: string[],
): Promise<FiatFraudDepositSummary[]> {
  const uniqueIds = [...new Set(intentIds)].slice(0, 200);
  if (uniqueIds.length === 0) return [];

  const db = await getReadDrizzleDb();
  const rows = await queryRows<RawFiatFraudDepositSummary[]>(db, sql`
    SELECT
      id::text AS intent_id,
      currency::text AS currency,
      requested_amount_cents::text AS requested_amount_cents,
      actual_customer_total_cents::text AS actual_customer_total_cents,
      credited_amount_cents::text AS credited_amount_cents,
      status::text AS status,
      provider_payment_status
    FROM fiat_deposit_intents
    WHERE id::text IN (
      ${sql.join(uniqueIds.map((id) => sql`${id}`), sql`, `)}
    )
  `);

  return rows.map((row) => ({
    intentId: row.intent_id,
    currency: row.currency,
    requestedAmountCents: Number(row.requested_amount_cents),
    actualCustomerTotalCents: optionalNumber(
      row.actual_customer_total_cents,
    ),
    creditedAmountCents: optionalNumber(row.credited_amount_cents),
    status: row.status,
    providerPaymentStatus: row.provider_payment_status,
  }));
}
