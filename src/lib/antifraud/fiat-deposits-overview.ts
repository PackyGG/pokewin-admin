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
  providerPaymentStatus: string | null;
  failureReason: string | null;
  requestedAmountUsd: number;
  customerPaidUsd: number | null;
  creditedAmountUsd: number | null;
  occurredAt: string;
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
  provider_payment_status: string | null;
  failure_reason: string | null;
  requested_amount_cents: string;
  customer_paid_cents: string | null;
  credited_amount_cents: string | null;
  occurred_at: Date | string;
};

function optionalUsd(cents: string | null): number | null {
  return cents == null ? null : Number(cents) / 100;
}

/**
 * MAIN intents are the source of truth for this overview. Alongside paid
 * deposits, terminal failed/canceled Whop attempts remain visible so provider
 * declines do not disappear from the operational history. Risk assessments
 * are enrichment and must never decide whether an intent itself is visible.
 */
export async function listFiatDeposits(input: {
  page: number;
  limit: number;
}): Promise<FiatDepositsOverviewResult> {
  const page = Math.max(1, Math.trunc(input.page) || 1);
  const limit = Math.min(100, Math.max(10, Math.trunc(input.limit) || 20));
  const offset = (page - 1) * limit;
  const excludedUserIds = await getExcludedUserIdsStrict();

  const baseWhere = `
    (
      i.paid_at IS NOT NULL
      OR i.status IN ('failed', 'canceled')
      OR COALESCE(i.provider_payment_status, '')
        ~* '(failed|declined|denied|canceled|cancelled)'
    )
    AND COALESCE(u.role::text, '') <> 'creator'
    AND 'creator' <> ALL(COALESCE(u.roles::text[], ARRAY[]::text[]))
    AND i.user_id <> ALL($1::text[])
  `;

  const [rows, counts] = await Promise.all([
    queryMainRows<RawDeposit[]>(
      `WITH deposits AS (
         SELECT i.*, u.username, u.email AS account_email, u.country_code,
           u.signup_ip
         FROM fiat_deposit_intents i
         JOIN "user" u ON u.id = i.user_id
         WHERE ${baseWhere}
         ORDER BY COALESCE(i.paid_at, i.updated_at) DESC, i.id DESC
         LIMIT $2 OFFSET $3
       )
       SELECT
         deposits.id::text AS id,
         deposits.user_id::text AS user_id,
         deposits.username,
         deposits.account_email,
         COALESCE(auth.signup_email, deposits.account_email) AS signup_email,
         deposits.country_code AS account_country,
         COALESCE(auth.latest_auth_ip, NULLIF(deposits.signup_ip, ''))
           AS latest_auth_ip,
         COALESCE(
           auth.latest_auth_event,
           CASE WHEN NULLIF(deposits.signup_ip, '') IS NOT NULL THEN 'register' END
         ) AS latest_auth_event,
         checkout.checkout_email,
         checkout.checkout_country,
         deposits.status::text AS status,
         deposits.provider_payment_status,
         deposits.failure_reason,
         deposits.requested_amount_cents::text AS requested_amount_cents,
         deposits.actual_customer_total_cents::text AS customer_paid_cents,
         deposits.credited_amount_cents::text AS credited_amount_cents,
         COALESCE(deposits.paid_at, deposits.updated_at)
           AT TIME ZONE 'UTC' AS occurred_at
       FROM deposits
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
             deposits.provider_checkout_id,
             deposits.provider_payment_id
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
         WHERE audit.user_id = deposits.user_id
           AND audit.event_type IN ('login', 'register')
       ) auth ON TRUE
       ORDER BY COALESCE(deposits.paid_at, deposits.updated_at) DESC,
         deposits.id DESC`,
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
      providerPaymentStatus: row.provider_payment_status,
      failureReason: row.failure_reason,
      requestedAmountUsd: Number(row.requested_amount_cents) / 100,
      customerPaidUsd: optionalUsd(row.customer_paid_cents),
      creditedAmountUsd: optionalUsd(row.credited_amount_cents),
      occurredAt: new Date(row.occurred_at).toISOString(),
    })),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
}
