import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB } from "./_shared";

export const CARD_PAYMENT_STATUSES = [
  "created",
  "checkout_creating",
  "checkout_ready",
  "pending",
  "completed",
  "review",
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
  paid_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type RawDetailRow = RawListRow & {
  client_idempotency_key: string;
  pricing_metadata: unknown;
  provider_metadata: unknown;
  ledger_amount: string | null;
  ledger_balance_before: string | null;
  ledger_balance_after: string | null;
  ledger_status: string | null;
  ledger_description: string | null;
};

type RawFeeRow = {
  id: string;
  fee_key: string;
  fee_type: string;
  fee_name: string;
  amount_cents: string;
  currency: string;
  created_at: string;
  raw_payload: unknown;
};

type RawWebhookRow = {
  id: string;
  provider_event_id: string;
  event_type: string;
  provider_resource_id: string | null;
  processing_status: string;
  attempt_count: string;
  last_error: string | null;
  received_at: string;
  processed_at: string | null;
  payload: unknown;
};

function asOptionalNumber(value: string | null): number | null {
  return value == null ? null : Number(value);
}

function asUtcIso(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  return new Date(normalized.endsWith("Z") ? normalized : `${normalized}Z`).toISOString();
}

function mapListRow(row: RawListRow): CardPaymentListItem {
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
    completedLedgerId: row.completed_ledger_id,
    failureReason: row.failure_reason,
    paidAt: asUtcIso(row.paid_at),
    completedAt: asUtcIso(row.completed_at),
    createdAt: asUtcIso(row.created_at)!,
    updatedAt: asUtcIso(row.updated_at)!,
  };
}

function buildWhere(filters: CardPaymentListFilters): {
  sql: string;
  params: Record<string, unknown>;
} {
  const clauses = ["i._peerdb_is_deleted = 0"];
  const params: Record<string, unknown> = {};

  if (filters.status) {
    clauses.push("i.status = {status:String}");
    params.status = filters.status;
  }

  const search = filters.search?.trim();
  if (search) {
    clauses.push(`(
      positionCaseInsensitiveUTF8(toString(i.id), {search:String}) > 0
      OR positionCaseInsensitiveUTF8(i.user_id, {search:String}) > 0
      OR positionCaseInsensitiveUTF8(ifNull(u.username, ''), {search:String}) > 0
      OR positionCaseInsensitiveUTF8(ifNull(u.email, ''), {search:String}) > 0
      OR positionCaseInsensitiveUTF8(ifNull(i.provider_payment_id, ''), {search:String}) > 0
      OR positionCaseInsensitiveUTF8(ifNull(i.provider_checkout_id, ''), {search:String}) > 0
    )`);
    params.search = search;
  }

  return { sql: clauses.join(" AND "), params };
}

export async function getCardPaymentsFromClickHouse(
  filters: CardPaymentListFilters,
): Promise<CardPaymentListResult> {
  const offset = (filters.page - 1) * filters.perPage;
  const where = buildWhere(filters);
  const params = { ...where.params, limit: filters.perPage, offset };
  const feeAggregate = `
    SELECT deposit_intent_id, sum(amount_cents) AS fee_amount_cents
    FROM ${CH_DB}.public_payment_provider_fees FINAL
    WHERE _peerdb_is_deleted = 0
    GROUP BY deposit_intent_id`;

  const [rows, countRows] = await Promise.all([
    clickhouseRead.query<RawListRow>({
      queryName: "transactions.card_payments.list",
      sql: `
        SELECT
          toString(i.id) AS id,
          i.user_id,
          u.username,
          u.email,
          i.provider,
          i.currency,
          toString(i.requested_amount_cents) AS requested_amount_cents,
          if(i.actual_customer_total_cents IS NULL, NULL, toString(i.actual_customer_total_cents)) AS actual_customer_total_cents,
          if(i.credited_amount_cents IS NULL, NULL, toString(i.credited_amount_cents)) AS credited_amount_cents,
          if(i.provider_net_amount_cents IS NULL, NULL, toString(i.provider_net_amount_cents)) AS provider_net_amount_cents,
          toString(ifNull(f.fee_amount_cents, 0)) AS fee_amount_cents,
          i.status,
          i.provider_payment_status,
          i.provider_checkout_id,
          i.provider_payment_id,
          if(i.completed_ledger_id IS NULL, NULL, toString(i.completed_ledger_id)) AS completed_ledger_id,
          i.failure_reason,
          if(i.paid_at IS NULL, NULL, toString(i.paid_at)) AS paid_at,
          if(i.completed_at IS NULL, NULL, toString(i.completed_at)) AS completed_at,
          toString(i.created_at) AS created_at,
          toString(i.updated_at) AS updated_at
        FROM ${CH_DB}.public_fiat_deposit_intents AS i FINAL
        LEFT JOIN ${CH_DB}.public_user AS u FINAL
          ON u.id = i.user_id AND u._peerdb_is_deleted = 0
        LEFT JOIN (${feeAggregate}) AS f ON f.deposit_intent_id = i.id
        WHERE ${where.sql}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
      params,
    }),
    clickhouseRead.query<{ total: string }>({
      queryName: "transactions.card_payments.count",
      sql: `
        SELECT toString(count()) AS total
        FROM ${CH_DB}.public_fiat_deposit_intents AS i FINAL
        LEFT JOIN ${CH_DB}.public_user AS u FINAL
          ON u.id = i.user_id AND u._peerdb_is_deleted = 0
        WHERE ${where.sql}`,
      params: where.params,
    }),
  ]);

  const total = Number(countRows[0]?.total ?? 0);
  return {
    data: rows.map(mapListRow),
    total,
    page: filters.page,
    perPage: filters.perPage,
    totalPages: Math.ceil(total / filters.perPage),
  };
}

export async function getCardPaymentDetailFromClickHouse(
  intentId: string,
): Promise<CardPaymentDetail | null> {
  const rows = await clickhouseRead.query<RawDetailRow>({
    queryName: "transactions.card_payments.detail",
    sql: `
      SELECT
        toString(i.id) AS id,
        i.user_id,
        u.username,
        u.email,
        i.provider,
        i.currency,
        toString(i.requested_amount_cents) AS requested_amount_cents,
        if(i.actual_customer_total_cents IS NULL, NULL, toString(i.actual_customer_total_cents)) AS actual_customer_total_cents,
        if(i.credited_amount_cents IS NULL, NULL, toString(i.credited_amount_cents)) AS credited_amount_cents,
        if(i.provider_net_amount_cents IS NULL, NULL, toString(i.provider_net_amount_cents)) AS provider_net_amount_cents,
        '0' AS fee_amount_cents,
        i.status,
        i.provider_payment_status,
        i.provider_checkout_id,
        i.provider_payment_id,
        if(i.completed_ledger_id IS NULL, NULL, toString(i.completed_ledger_id)) AS completed_ledger_id,
        i.failure_reason,
        if(i.paid_at IS NULL, NULL, toString(i.paid_at)) AS paid_at,
        if(i.completed_at IS NULL, NULL, toString(i.completed_at)) AS completed_at,
        toString(i.created_at) AS created_at,
        toString(i.updated_at) AS updated_at,
        i.client_idempotency_key,
        i.pricing_metadata,
        i.provider_metadata,
        if(lt.id IS NULL, NULL, toString(lt.amount)) AS ledger_amount,
        if(lt.id IS NULL, NULL, toString(lt.balance_before)) AS ledger_balance_before,
        if(lt.id IS NULL, NULL, toString(lt.balance_after)) AS ledger_balance_after,
        lt.status AS ledger_status,
        lt.description AS ledger_description
      FROM ${CH_DB}.public_fiat_deposit_intents AS i FINAL
      LEFT JOIN ${CH_DB}.public_user AS u FINAL
        ON u.id = i.user_id AND u._peerdb_is_deleted = 0
      LEFT JOIN ${CH_DB}.public_ledger_transactions AS lt FINAL
        ON lt.id = i.completed_ledger_id AND lt._peerdb_is_deleted = 0
      WHERE i._peerdb_is_deleted = 0 AND toString(i.id) = {intentId:String}
      LIMIT 1`,
    params: { intentId },
  });

  const row = rows[0];
  if (!row) return null;

  const [feeRows, webhookRows] = await Promise.all([
    clickhouseRead.query<RawFeeRow>({
      queryName: "transactions.card_payments.detail.fees",
      sql: `
        SELECT toString(id) AS id, fee_key, fee_type, fee_name,
               toString(amount_cents) AS amount_cents, currency,
               toString(created_at) AS created_at, raw_payload
        FROM ${CH_DB}.public_payment_provider_fees FINAL
        WHERE _peerdb_is_deleted = 0 AND toString(deposit_intent_id) = {intentId:String}
        ORDER BY created_at ASC`,
      params: { intentId },
    }),
    clickhouseRead.query<RawWebhookRow>({
      queryName: "transactions.card_payments.detail.webhooks",
      sql: `
        SELECT toString(id) AS id, provider_event_id, event_type,
               provider_resource_id, processing_status,
               toString(attempt_count) AS attempt_count, last_error,
               toString(received_at) AS received_at,
               if(processed_at IS NULL, NULL, toString(processed_at)) AS processed_at,
               payload
        FROM ${CH_DB}.public_payment_webhook_events FINAL
        WHERE _peerdb_is_deleted = 0
          AND provider = {provider:String}
          AND provider_resource_id IN {resourceIds:Array(String)}
        ORDER BY received_at ASC`,
      params: {
        provider: row.provider,
        resourceIds: [row.provider_payment_id, row.provider_checkout_id].filter(Boolean),
      },
    }),
  ]);

  const fees = feeRows.map((fee): CardPaymentFee => ({
    id: fee.id,
    feeKey: fee.fee_key,
    feeType: fee.fee_type,
    feeName: fee.fee_name,
    amountCents: Number(fee.amount_cents),
    currency: fee.currency,
    createdAt: asUtcIso(fee.created_at)!,
    rawPayload: fee.raw_payload,
  }));

  return {
    ...mapListRow({
      ...row,
      fee_amount_cents: String(fees.reduce((sum, fee) => sum + fee.amountCents, 0)),
    }),
    clientIdempotencyKey: row.client_idempotency_key,
    pricingMetadata: row.pricing_metadata,
    providerMetadata: row.provider_metadata,
    ledgerAmount: asOptionalNumber(row.ledger_amount),
    ledgerBalanceBefore: asOptionalNumber(row.ledger_balance_before),
    ledgerBalanceAfter: asOptionalNumber(row.ledger_balance_after),
    ledgerStatus: row.ledger_status,
    ledgerDescription: row.ledger_description,
    fees,
    webhookEvents: webhookRows.map((event) => ({
      id: event.id,
      providerEventId: event.provider_event_id,
      eventType: event.event_type,
      providerResourceId: event.provider_resource_id,
      processingStatus: event.processing_status,
      attemptCount: Number(event.attempt_count),
      lastError: event.last_error,
      receivedAt: asUtcIso(event.received_at)!,
      processedAt: asUtcIso(event.processed_at),
      payload: event.payload,
    })),
  };
}
