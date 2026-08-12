import "server-only";

import { getExcludedUserIdsStrict } from "@/lib/excluded-users/fetch";
import { queryMainRows } from "@/lib/drizzle-query";

export type FiatDepositOverviewItem = {
  rowId: string;
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
  row_id: string;
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
 * MAIN intents and their Whop webhook history are the source of truth for this
 * overview. A checkout can create more than one provider payment, so the feed
 * is deliberately one row per provider payment attempt. Intents without a
 * payment event remain visible as a single row while they are being created.
 * Risk assessments are enrichment and must never decide visibility.
 */
export async function listFiatDeposits(input: {
  page: number;
  limit: number;
}): Promise<FiatDepositsOverviewResult> {
  const page = Math.max(1, Math.trunc(input.page) || 1);
  const limit = Math.min(100, Math.max(10, Math.trunc(input.limit) || 20));
  const offset = (page - 1) * limit;
  const excludedUserIds = await getExcludedUserIdsStrict();

  const visibleDepositsCtes = `
    WITH eligible_intents AS (
      SELECT i.*, u.username, u.email AS account_email, u.country_code,
        u.signup_ip
      FROM fiat_deposit_intents i
      JOIN "user" u ON u.id = i.user_id
      WHERE COALESCE(u.role::text, '') <> 'creator'
        AND 'creator' <> ALL(COALESCE(u.roles::text[], ARRAY[]::text[]))
        AND i.user_id <> ALL($1::text[])
    ), intent_resources AS (
      SELECT id, provider_checkout_id AS resource_id
      FROM eligible_intents
      WHERE provider_checkout_id IS NOT NULL
      UNION ALL
      SELECT id, provider_payment_id AS resource_id
      FROM eligible_intents
      WHERE provider_payment_id IS NOT NULL
    ), candidate_events AS (
      SELECT
        pwe.*,
        NULLIF(
          pwe.payload #>> '{data,metadata,deposit_intent_id}',
          ''
        ) AS metadata_intent_id,
        COALESCE(
          NULLIF(pwe.payload #>> '{data,id}', ''),
          NULLIF(pwe.provider_resource_id, '')
        ) AS payment_id
      FROM payment_webhook_events pwe
      WHERE pwe.provider = 'whop'
        AND pwe.event_type IN (
          'payment.created',
          'payment.failed',
          'payment.succeeded'
        )
        AND COALESCE(
          NULLIF(pwe.payload #>> '{data,id}', ''),
          NULLIF(pwe.provider_resource_id, '')
        ) IS NOT NULL
    ), attempt_events AS (
      SELECT
        i.*,
        pwe.id AS event_id,
        pwe.event_type,
        pwe.received_at,
        pwe.payload,
        pwe.payment_id
      FROM eligible_intents i
      JOIN candidate_events pwe ON pwe.metadata_intent_id = i.id::text
      UNION ALL
      SELECT
        i.*,
        pwe.id AS event_id,
        pwe.event_type,
        pwe.received_at,
        pwe.payload,
        pwe.payment_id
      FROM intent_resources resource
      JOIN eligible_intents i ON i.id = resource.id
      JOIN candidate_events pwe
        ON pwe.provider_resource_id = resource.resource_id
      WHERE pwe.metadata_intent_id IS DISTINCT FROM i.id::text
    ), attempts AS (
      SELECT DISTINCT ON (id, payment_id)
        id,
        user_id,
        username,
        account_email,
        country_code,
        signup_ip,
        payment_id,
        CASE event_type
          WHEN 'payment.failed' THEN 'failed'
          WHEN 'payment.succeeded' THEN 'completed'
          ELSE COALESCE(NULLIF(payload #>> '{data,status}', ''), 'pending')
        END AS status,
        CASE event_type
          WHEN 'payment.failed' THEN 'failed'
          WHEN 'payment.succeeded' THEN 'paid'
          ELSE NULLIF(payload #>> '{data,status}', '')
        END AS provider_payment_status,
        CASE WHEN event_type = 'payment.failed' THEN COALESCE(
          NULLIF(payload #>> '{data,failure_message}', ''),
          NULLIF(payload #>> '{data,failure_reason}', ''),
          NULLIF(payload #>> '{data,error,message}', ''),
          failure_reason
        ) END AS failure_reason,
        requested_amount_cents,
        CASE WHEN event_type = 'payment.succeeded'
          THEN actual_customer_total_cents
        END AS actual_customer_total_cents,
        CASE WHEN event_type = 'payment.succeeded'
          THEN credited_amount_cents
        END AS credited_amount_cents,
        received_at AS occurred_at,
        NULLIF(BTRIM(payload #>> '{data,user,email}'), '') AS checkout_email,
        NULLIF(BTRIM(payload #>> '{data,billing_address,country}'), '')
          AS checkout_country
      FROM attempt_events
      ORDER BY id, payment_id, received_at DESC, event_id DESC
    ), visible_deposits AS (
      SELECT
        attempts.id::text || ':payment:' || attempts.payment_id AS row_id,
        attempts.*
      FROM attempts
      UNION ALL
      SELECT
        i.id::text || ':intent' AS row_id,
        i.id,
        i.user_id,
        i.username,
        i.account_email,
        i.country_code,
        i.signup_ip,
        i.provider_payment_id AS payment_id,
        i.status,
        i.provider_payment_status,
        i.failure_reason,
        i.requested_amount_cents,
        CASE WHEN i.paid_at IS NOT NULL
          THEN i.actual_customer_total_cents
        END AS actual_customer_total_cents,
        CASE WHEN i.paid_at IS NOT NULL
          THEN i.credited_amount_cents
        END AS credited_amount_cents,
        COALESCE(i.paid_at, i.updated_at, i.created_at) AS occurred_at,
        NULL::text AS checkout_email,
        NULL::text AS checkout_country
      FROM eligible_intents i
      WHERE NOT EXISTS (
        SELECT 1 FROM attempts WHERE attempts.id = i.id
      )
    )
  `;

  const [rows, counts] = await Promise.all([
    queryMainRows<RawDeposit[]>(
      `${visibleDepositsCtes}, deposits AS (
         SELECT *
         FROM visible_deposits
         ORDER BY occurred_at DESC, row_id DESC
         LIMIT $2 OFFSET $3
       )
       SELECT
         deposits.row_id,
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
         COALESCE(deposits.checkout_email, checkout.checkout_email)
           AS checkout_email,
         COALESCE(deposits.checkout_country, checkout.checkout_country)
           AS checkout_country,
         deposits.status::text AS status,
         deposits.provider_payment_status,
         deposits.failure_reason,
         deposits.requested_amount_cents::text AS requested_amount_cents,
         deposits.actual_customer_total_cents::text AS customer_paid_cents,
         deposits.credited_amount_cents::text AS credited_amount_cents,
         deposits.occurred_at AT TIME ZONE 'UTC' AS occurred_at
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
             deposits.payment_id
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
       ORDER BY deposits.occurred_at DESC, deposits.row_id DESC`,
      excludedUserIds,
      limit,
      offset,
    ),
    queryMainRows<{ total: string }[]>(
      `${visibleDepositsCtes}
       SELECT COUNT(*)::text AS total FROM visible_deposits`,
      excludedUserIds,
    ),
  ]);

  const total = Number(counts[0]?.total ?? 0);
  return {
    data: rows.map((row) => ({
      rowId: row.row_id,
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
