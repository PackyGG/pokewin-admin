import "server-only";

import { readDbEnv } from "@/lib/db-env";
import {
  CARD_PAYMENT_STATUSES,
  getCardPaymentDetailFromClickHouse,
  getCardPaymentsFromClickHouse,
  type CardPaymentListFilters,
} from "@/lib/clickhouse/queries/card-payments";

export type {
  CardPaymentDetail,
  CardPaymentFee,
  CardPaymentListItem,
  CardPaymentListResult,
  CardPaymentWebhookEvent,
} from "@/lib/clickhouse/queries/card-payments";

export class CardPaymentMirrorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardPaymentMirrorUnavailableError";
  }
}

async function assertProductionMirror(): Promise<void> {
  const env = await readDbEnv();
  if (env === "dev") {
    throw new CardPaymentMirrorUnavailableError(
      "A development ClickHouse mirror is not configured.",
    );
  }
}

export async function getCardPayments(filters: CardPaymentListFilters) {
  await assertProductionMirror();
  const page = Math.max(1, Math.trunc(filters.page) || 1);
  const perPage = Math.min(200, Math.max(10, Math.trunc(filters.perPage) || 20));
  const status = CARD_PAYMENT_STATUSES.includes(
    filters.status as (typeof CARD_PAYMENT_STATUSES)[number],
  )
    ? filters.status
    : undefined;

  return getCardPaymentsFromClickHouse({
    page,
    perPage,
    search: filters.search?.trim() || undefined,
    status,
  });
}

export async function getCardPaymentDetail(intentId: string) {
  await assertProductionMirror();
  return getCardPaymentDetailFromClickHouse(intentId);
}
