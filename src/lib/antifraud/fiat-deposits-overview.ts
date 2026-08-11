import "server-only";

import { getExcludedUserIdsStrict } from "@/lib/excluded-users/fetch";
import { queryMainRows } from "@/lib/drizzle-query";

export type FiatDepositOverviewItem = {
  id: string;
  userId: string;
  username: string | null;
  accountEmail: string | null;
  signupEmail: string | null;
  accountCountry: string | null;
  latestAuthIp: string | null;
  latestAuthEvent: "login" | "register" | null;
  checkoutEmail: string | null;
  checkoutCountry: string | null;
  status: string;
  requestedAmountUsd: number;
  customerPaidUsd: number | null;
  creditedAmountUsd: number | null;
  paidAt: string;
};

export type FiatDepositsOverviewResult = {
  data: FiatDepositOverviewItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
};

type RawDeposit = {
  id: string;
  user_id: string;
  username: string | null;
  account_email: string | null;
  signup_email: string | null;
  account_country: string | null;
  latest_auth_ip: string | null;
  latest_auth_event: "login" | "register" | null;
  checkout_email: string | null;
  checkout_country: string | null;
  status: string;
  requested_amount_cents: string;
  customer_paid_cents: string | null;
  credited_amount_cents: string | null;
  paid_at: Date | string;
};

function optionalUsd(cents: string | null): number | null {
  return cents == null ? null : Number(cents) / 100;
}

/**
 * Paid MAIN intents are the source of truth for this overview. Risk
 * assessments are enrichment and may legitimately arrive after a payment, so
 * they must never decide whether the deposit itself is visible.
 */
export async function listPaidFiatDeposits(input: {
  page: number;
  limit: number;
}): Promise<FiatDepositsOverviewResult> {
  const page = Math.max(1, Math.trunc(input.page) || 1);
  const limit = Math.min(100, Math.max(10, Math.trunc(input.limit) || 20));
  const offset = (page - 1) * limit;
  const excludedUserIds = await getExcludedUserIdsStrict();

  const baseWhere = `
    i.paid_at IS NOT NULL
    AND COALESCE(u.role::text, '') <> 'creator'
    AND 'creator' <> ALL(COALESCE(u.roles::text[], ARRAY[]::text[]))
    AND i.user_id <> ALL($1::text[])
  `;

  const [rows, counts] = await Promise.all([
    queryMainRows<RawDeposit[]>(
      `WITH paid AS (
         SELECT i.*, u.username, u.email AS account_email, u.country_code,
           u.signup_ip
         FROM fiat_deposit_intents i
         JOIN "user" u ON u.id = i.user_id
         WHERE ${baseWhere}
         ORDER BY i.paid_at DESC, i.id DESC
         LIMIT $2 OFFSET $3
       )
       SELECT
         paid.id::text AS id,
         paid.user_id::text AS user_id,
         paid.username,
         paid.account_email,
         COALESCE(auth.signup_email, paid.account_email) AS signup_email,
         paid.country_code AS account_country,
         COALESCE(auth.latest_auth_ip, NULLIF(paid.signup_ip, ''))
           AS latest_auth_ip,
         COALESCE(
           auth.latest_auth_event,
           CASE WHEN NULLIF(paid.signup_ip, '') IS NOT NULL THEN 'register' END
         ) AS latest_auth_event,
         checkout.checkout_email,
         checkout.checkout_country,
         paid.status::text AS status,
         paid.requested_amount_cents::text AS requested_amount_cents,
         paid.actual_customer_total_cents::text AS customer_paid_cents,
         paid.credited_amount_cents::text AS credited_amount_cents,
         paid.paid_at AT TIME ZONE 'UTC' AS paid_at
       FROM paid
       LEFT JOIN LATERAL (
         SELECT
           (array_agg(NULLIF(BTRIM(pwe.payload #>> '{data,user,email}'), '')
             ORDER BY pwe.received_at DESC, pwe.id DESC)
             FILTER (WHERE NULLIF(BTRIM(
               pwe.payload #>> '{data,user,email}'
             ), '') IS NOT NULL))[1] AS checkout_email,
           (array_agg(NULLIF(BTRIM(
             pwe.payload #>> '{data,billing_address,country}'
           ), '') ORDER BY pwe.received_at DESC, pwe.id DESC)
             FILTER (WHERE NULLIF(BTRIM(
               pwe.payload #>> '{data,billing_address,country}'
             ), '') IS NOT NULL))[1] AS checkout_country
         FROM payment_webhook_events pwe
         WHERE pwe.provider = 'whop'
           AND pwe.provider_resource_id IN (
             paid.provider_checkout_id,
             paid.provider_payment_id
           )
       ) checkout ON TRUE
       LEFT JOIN LATERAL (
         SELECT
           (array_agg(audit.metadata->>'email' ORDER BY audit.created_at)
             FILTER (
               WHERE audit.event_type = 'register'
                 AND NULLIF(audit.metadata->>'email', '') IS NOT NULL
             ))[1] AS signup_email,
           (array_agg(host(audit.ip) ORDER BY audit.created_at DESC)
             FILTER (WHERE audit.ip IS NOT NULL))[1] AS latest_auth_ip,
           (array_agg(audit.event_type::text ORDER BY audit.created_at DESC)
             FILTER (WHERE audit.ip IS NOT NULL))[1] AS latest_auth_event
         FROM audit_events audit
         WHERE audit.user_id = paid.user_id
           AND audit.event_type IN ('login', 'register')
       ) auth ON TRUE
       ORDER BY paid.paid_at DESC, paid.id DESC`,
      excludedUserIds,
      limit,
      offset,
    ),
    queryMainRows<{ total: string }[]>(
      `SELECT COUNT(*)::text AS total
       FROM fiat_deposit_intents i
       JOIN "user" u ON u.id = i.user_id
       WHERE ${baseWhere}`,
      excludedUserIds,
    ),
  ]);

  const total = Number(counts[0]?.total ?? 0);
  return {
    data: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      username: row.username,
      accountEmail: row.account_email,
      signupEmail: row.signup_email,
      accountCountry: row.account_country,
      latestAuthIp: row.latest_auth_ip,
      latestAuthEvent: row.latest_auth_event,
      checkoutEmail: row.checkout_email,
      checkoutCountry: row.checkout_country,
      status: row.status,
      requestedAmountUsd: Number(row.requested_amount_cents) / 100,
      customerPaidUsd: optionalUsd(row.customer_paid_cents),
      creditedAmountUsd: optionalUsd(row.credited_amount_cents),
      paidAt: new Date(row.paid_at).toISOString(),
    })),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
}
