import "server-only";

import { getReadDrizzleDb } from "@/lib/db";
import {
  queryRows,
  sql,
} from "@/lib/queries/insights-rewards/_drizzle-query";
import { whopPaymentMethodInfo } from "@/lib/whop-payment-method";

export const CARD_PAYMENT_STATUSES = [
  "created",
  "checkout_creating",
  "checkout_ready",
  "pending",
  "review",
  "approval_processing",
  "refund_pending",
  "refund_failed",
  "completed",
  "failed",
  "canceled",
  "partially_refunded",
  "refunded",
  "disputed",
] as const;

export type CardPaymentStatus = (typeof CARD_PAYMENT_STATUSES)[number];

export type CardPaymentListFilters = {
  page: number;
  perPage: number;
  search?: string;
  status?: string;
};

export type CardPaymentListItem = {
  id: string;
  userId: string;
  username: string | null;
  email: string | null;
  provider: string;
  currency: string;
  requestedAmountCents: number;
  actualCustomerTotalCents: number | null;
  creditedAmountCents: number | null;
  providerNetAmountCents: number | null;
  feeAmountCents: number;
  status: string;
  providerPaymentStatus: string | null;
  providerCheckoutId: string | null;
  providerPaymentId: string | null;
  paymentMethodType: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  completedLedgerId: string | null;
  failureReason: string | null;
  paidAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CardPaymentListResult = {
  data: CardPaymentListItem[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
};

export type CardPaymentFee = {
  id: string;
  feeKey: string;
  feeType: string;
  feeName: string;
  amountCents: number;
  currency: string;
  createdAt: string;
  rawPayload: unknown;
};

export type CardPaymentWebhookEvent = {
  id: string;
  providerEventId: string;
  eventType: string;
  providerResourceId: string | null;
  processingStatus: string;
  attemptCount: number;
  lastError: string | null;
  receivedAt: string;
  processedAt: string | null;
  payload: unknown;
};

export type CardPaymentDetail = CardPaymentListItem & {
  clientIdempotencyKey: string;
  pricingMetadata: unknown;
  providerMetadata: unknown;
  ledgerAmount: number | null;
  ledgerBalanceBefore: number | null;
  ledgerBalanceAfter: number | null;
  ledgerStatus: string | null;
  ledgerDescription: string | null;
  fees: CardPaymentFee[];
  webhookEvents: CardPaymentWebhookEvent[];
};

type RawListRow = {
  id: string;
  user_id: string;
  username: string | null;
  email: string | null;
  provider: string;
  currency: string;
  requested_amount_cents: string;
  actual_customer_total_cents: string | null;
  credited_amount_cents: string | null;
  provider_net_amount_cents: string | null;
  fee_amount_cents: string;
  status: string;
  provider_payment_status: string | null;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  completed_ledger_id: string | null;
  failure_reason: string | null;
  paid_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  provider_metadata: unknown;
};

type RawDetailRow = RawListRow & {
  client_idempotency_key: string;
  pricing_metadata: unknown;
  ledger_amount: string | null;
  ledger_balance_before: string | null;
  ledger_balance_after: string | null;
  ledger_status: string | null;
  ledger_description: string | null;
};

function asOptionalNumber(value: string | null): number | null {
  return value == null ? null : Number(value);
}

function asIso(value: Date | string | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function mapListRow(row: RawListRow): CardPaymentListItem {
  const paymentMethod = whopPaymentMethodInfo(row.provider_metadata);
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    email: row.email,
    provider: row.provider,
    currency: row.currency,
    requestedAmountCents: Number(row.requested_amount_cents),
    actualCustomerTotalCents: asOptionalNumber(row.actual_customer_total_cents),
    creditedAmountCents: asOptionalNumber(row.credited_amount_cents),
    providerNetAmountCents: asOptionalNumber(row.provider_net_amount_cents),
    feeAmountCents: Number(row.fee_amount_cents),
    status: row.status,
    providerPaymentStatus: row.provider_payment_status,
    providerCheckoutId: row.provider_checkout_id,
    providerPaymentId: row.provider_payment_id,
    paymentMethodType: paymentMethod.type,
    cardBrand: paymentMethod.cardBrand,
    cardLast4: paymentMethod.cardLast4,
    completedLedgerId: row.completed_ledger_id,
    failureReason: row.failure_reason,
    paidAt: asIso(row.paid_at),
    completedAt: asIso(row.completed_at),
    createdAt: asIso(row.created_at)!,
    updatedAt: asIso(row.updated_at)!,
  };
}

export async function getCardPayments(
  filters: CardPaymentListFilters,
): Promise<CardPaymentListResult> {
  const db = await getReadDrizzleDb();
  const page = Math.max(1, Math.trunc(filters.page) || 1);
  const perPage = Math.min(200, Math.max(10, Math.trunc(filters.perPage) || 20));
  const offset = (page - 1) * perPage;
  const status = CARD_PAYMENT_STATUSES.includes(
    filters.status as CardPaymentStatus,
  )
    ? filters.status!
    : null;
  const search = filters.search?.trim() || null;
  const statusFilter = status ? sql`AND i.status::text = ${status}` : sql``;
  const searchFilter = search
    ? sql`AND (
        i.id::text ILIKE ${`%${search}%`}
        OR i.user_id::text ILIKE ${`%${search}%`}
        OR COALESCE(u.username, '') ILIKE ${`%${search}%`}
        OR COALESCE(u.email, '') ILIKE ${`%${search}%`}
        OR COALESCE(i.provider_payment_id, '') ILIKE ${`%${search}%`}
        OR COALESCE(i.provider_checkout_id, '') ILIKE ${`%${search}%`}
      )`
    : sql``;

  const [rows, countRows] = await Promise.all([
    queryRows<RawListRow[]>(db, sql`
      SELECT
        i.id::text AS id,
        i.user_id::text AS user_id,
        u.username,
        u.email,
        i.provider::text AS provider,
        i.currency::text AS currency,
        i.requested_amount_cents::text AS requested_amount_cents,
        i.actual_customer_total_cents::text AS actual_customer_total_cents,
        i.credited_amount_cents::text AS credited_amount_cents,
        i.provider_net_amount_cents::text AS provider_net_amount_cents,
        COALESCE(f.fee_amount_cents, 0)::text AS fee_amount_cents,
        i.status::text AS status,
        i.provider_payment_status,
        i.provider_checkout_id,
        i.provider_payment_id,
        i.provider_metadata,
        i.completed_ledger_id::text AS completed_ledger_id,
        i.failure_reason,
        i.paid_at,
        i.completed_at,
        i.created_at,
        i.updated_at
      FROM fiat_deposit_intents i
      LEFT JOIN "user" u ON u.id = i.user_id
      LEFT JOIN LATERAL (
        SELECT SUM(pf.amount_cents) AS fee_amount_cents
        FROM payment_provider_fees pf
        WHERE pf.deposit_intent_id = i.id
      ) f ON TRUE
      WHERE TRUE ${statusFilter} ${searchFilter}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT ${perPage} OFFSET ${offset}
    `),
    queryRows<{ total: string }[]>(db, sql`
      SELECT COUNT(*)::text AS total
      FROM fiat_deposit_intents i
      LEFT JOIN "user" u ON u.id = i.user_id
      WHERE TRUE ${statusFilter} ${searchFilter}
    `),
  ]);

  const total = Number(countRows[0]?.total ?? 0);
  return {
    data: rows.map(mapListRow),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getCardPaymentDetail(
  intentId: string,
): Promise<CardPaymentDetail | null> {
  const db = await getReadDrizzleDb();
  const rows = await queryRows<RawDetailRow[]>(db, sql`
    SELECT
      i.id::text AS id,
      i.user_id::text AS user_id,
      u.username,
      u.email,
      i.provider::text AS provider,
      i.currency::text AS currency,
      i.requested_amount_cents::text AS requested_amount_cents,
      i.actual_customer_total_cents::text AS actual_customer_total_cents,
      i.credited_amount_cents::text AS credited_amount_cents,
      i.provider_net_amount_cents::text AS provider_net_amount_cents,
      '0'::text AS fee_amount_cents,
      i.status::text AS status,
      i.provider_payment_status,
      i.provider_checkout_id,
      i.provider_payment_id,
      i.provider_metadata,
      i.completed_ledger_id::text AS completed_ledger_id,
      i.failure_reason,
      i.paid_at,
      i.completed_at,
      i.created_at,
      i.updated_at,
      i.client_idempotency_key,
      i.pricing_metadata,
      lt.amount::text AS ledger_amount,
      lt.balance_before::text AS ledger_balance_before,
      lt.balance_after::text AS ledger_balance_after,
      lt.status::text AS ledger_status,
      lt.description AS ledger_description
    FROM fiat_deposit_intents i
    LEFT JOIN "user" u ON u.id = i.user_id
    LEFT JOIN ledger_transactions lt ON lt.id = i.completed_ledger_id
    WHERE i.id::text = ${intentId}
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return null;

  type FeeRow = {
    id: string;
    fee_key: string;
    fee_type: string;
    fee_name: string;
    amount_cents: string;
    currency: string;
    created_at: Date | string;
    raw_payload: unknown;
  };
  const resourceIds = [row.provider_payment_id, row.provider_checkout_id].filter(
    (value): value is string => Boolean(value),
  );
  const resourceFilter =
    resourceIds.length === 0
      ? sql`FALSE`
      : sql`provider_resource_id IN (${sql.join(
          resourceIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  type WebhookRow = {
    id: string;
    provider_event_id: string;
    event_type: string;
    provider_resource_id: string | null;
    processing_status: string;
    attempt_count: string;
    last_error: string | null;
    received_at: Date | string;
    processed_at: Date | string | null;
    payload: unknown;
  };

  const [feeRows, webhookRows] = await Promise.all([
    queryRows<FeeRow[]>(db, sql`
      SELECT id::text AS id, fee_key, fee_type, fee_name,
        amount_cents::text AS amount_cents, currency::text AS currency,
        created_at, raw_payload
      FROM payment_provider_fees
      WHERE deposit_intent_id::text = ${intentId}
      ORDER BY created_at ASC
    `),
    queryRows<WebhookRow[]>(db, sql`
      SELECT id::text AS id, provider_event_id, event_type,
        provider_resource_id, processing_status,
        attempt_count::text AS attempt_count, last_error,
        received_at, processed_at, payload
      FROM payment_webhook_events
      WHERE provider::text = ${row.provider}
        AND ${resourceFilter}
      ORDER BY received_at ASC
    `),
  ]);

  const fees = feeRows.map((fee): CardPaymentFee => ({
    id: fee.id,
    feeKey: fee.fee_key,
    feeType: fee.fee_type,
    feeName: fee.fee_name,
    amountCents: Number(fee.amount_cents),
    currency: fee.currency,
    createdAt: asIso(fee.created_at)!,
    rawPayload: fee.raw_payload,
  }));

  const webhookEvents = webhookRows.map((event) => ({
    id: event.id,
    providerEventId: event.provider_event_id,
    eventType: event.event_type,
    providerResourceId: event.provider_resource_id,
    processingStatus: event.processing_status,
    attemptCount: Number(event.attempt_count),
    lastError: event.last_error,
    receivedAt: asIso(event.received_at)!,
    processedAt: asIso(event.processed_at),
    payload: event.payload,
  }));
  const paymentMethod = whopPaymentMethodInfo(
    row.provider_metadata,
    ...webhookRows.map((event) => event.payload),
  );

  return {
    ...mapListRow({
      ...row,
      fee_amount_cents: String(fees.reduce((sum, fee) => sum + fee.amountCents, 0)),
    }),
    paymentMethodType: paymentMethod.type,
    cardBrand: paymentMethod.cardBrand,
    cardLast4: paymentMethod.cardLast4,
    clientIdempotencyKey: row.client_idempotency_key,
    pricingMetadata: row.pricing_metadata,
    providerMetadata: row.provider_metadata,
    ledgerAmount: asOptionalNumber(row.ledger_amount),
    ledgerBalanceBefore: asOptionalNumber(row.ledger_balance_before),
    ledgerBalanceAfter: asOptionalNumber(row.ledger_balance_after),
    ledgerStatus: row.ledger_status,
    ledgerDescription: row.ledger_description,
    fees,
    webhookEvents,
  };
}
