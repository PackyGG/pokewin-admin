import "server-only";

import { cache } from "react";
import { unstable_cache } from "next/cache";

import { getReadDrizzleDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { queryRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import {
  kpiWindowToCacheCutoff,
  type DashboardKpiWindow,
} from "./dashboard-period";
import {
  fiatPartialRefundAmountPresentSql,
  fiatRefundCreditCentsSql,
} from "./fiat-refund-credits";

/** Webhooks normally settle in seconds. Keep fresh paid rows out of exceptions. */
export const FIAT_SETTLEMENT_GRACE_MINUTES = 15;

export type DashboardFiatException = {
  intentId: string;
  grossPaidUsd: number;
};

export type DashboardFiatMetrics = {
  providerGrossPaidUsd: number;
  providerNetPaidUsd: number;
  providerFeesUsd: number;
  providerPaymentCount: number;
  grossCreditedUsd: number;
  refundCreditsUsd: number;
  netCreditedUsd: number;
  creditedPaymentCount: number;
  refundCount: number;
  partialRefundCount: number;
  unresolvedPartialRefundCount: number;
  reviewCount: number;
  disputeCount: number;
  uncreditedExceptionCount: number;
  uncreditedExceptionGrossUsd: number;
  uncreditedExceptions: DashboardFiatException[];
};

type RawDashboardFiatMetrics = {
  provider_gross_paid_usd: string;
  provider_net_paid_usd: string;
  provider_payment_count: string;
  gross_credited_cents: string;
  refund_credit_cents: string;
  credited_payment_count: string;
  refund_count: string;
  partial_refund_count: string;
  unresolved_partial_refund_count: string;
  review_count: string;
  dispute_count: string;
  uncredited_exception_count: string;
  uncredited_exception_gross_usd: string;
  uncredited_exceptions: unknown;
};

function parseExceptions(value: unknown): DashboardFiatException[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.intent_id !== "string") return [];
    const grossPaidUsd = toNumber(row.gross_paid_usd);
    return Number.isFinite(grossPaidUsd)
      ? [{ intentId: row.intent_id, grossPaidUsd }]
      : [];
  });
}

/**
 * Provider volume and balance credit are deliberately separate:
 *
 * - Whop paid volume is deduped by provider payment id and windowed on
 *   provider `paid_at`. `usd_total` is the provider's USD equivalent even
 *   when the buyer was charged EUR. Net USD prorates that USD equivalent by
 *   `amount_after_fees / total`.
 * - credited volume is the distinct completed deposit ledger. A current
 *   intent status never proves that money reached the user's balance.
 * - operational exceptions require a non-staff intent, every authoritative
 *   link to have no completed ledger, a terminal paid webhook older than the
 *   grace window, and no canceled/refunded/disputed lifecycle state.
 *
 * This query is read-only reporting. It never repairs or credits MAIN.
 */
async function computeDashboardFiatMetrics(
  cutoff: Date,
): Promise<DashboardFiatMetrics> {
  return withTiming("dashboard.fiat", async () => {
    const db = await getReadDrizzleDb();
    const rows = await queryRows<RawDashboardFiatMetrics[]>(
      db,
      `WITH succeeded_events AS (
         SELECT
           pwe.id,
           pwe.received_at,
           pwe.provider_resource_id,
           pwe.payload #>> '{data,id}' AS payment_id,
           pwe.payload #>> '{data,metadata,deposit_intent_id}' AS metadata_intent_id,
           (pwe.payload #>> '{data,paid_at}')::timestamptz AS provider_paid_at,
           CASE
             WHEN pwe.payload #>> '{data,usd_total}' ~ '^[0-9]+([.][0-9]+)?$'
             THEN (pwe.payload #>> '{data,usd_total}')::numeric
             ELSE NULL
           END AS gross_paid_usd,
           CASE
             WHEN pwe.payload #>> '{data,total}' ~ '^[0-9]+([.][0-9]+)?$'
             THEN (pwe.payload #>> '{data,total}')::numeric
             ELSE NULL
           END AS charged_total,
           CASE
             WHEN pwe.payload #>> '{data,amount_after_fees}' ~ '^[0-9]+([.][0-9]+)?$'
             THEN (pwe.payload #>> '{data,amount_after_fees}')::numeric
             ELSE NULL
           END AS amount_after_fees
         FROM payment_webhook_events pwe
         WHERE pwe.provider = 'whop'
           AND pwe.event_type = 'payment.succeeded'
           AND pwe.payload #>> '{data,status}' = 'paid'
           AND NULLIF(pwe.payload #>> '{data,id}', '') IS NOT NULL
           AND NULLIF(pwe.payload #>> '{data,paid_at}', '') IS NOT NULL
       ),
       provider_paid AS (
         SELECT DISTINCT ON (payment_id)
           payment_id,
           provider_resource_id,
           metadata_intent_id,
           provider_paid_at,
           gross_paid_usd,
           CASE
             WHEN charged_total > 0
               AND amount_after_fees >= 0
               AND gross_paid_usd >= 0
             THEN gross_paid_usd * amount_after_fees / charged_total
             ELSE NULL
           END AS net_paid_usd
         FROM succeeded_events
         WHERE provider_paid_at >= $1
           AND provider_paid_at <= CURRENT_TIMESTAMP
         ORDER BY payment_id, received_at DESC, id DESC
       ),
       linked_paid AS (
         SELECT
           paid.*,
           intent.id AS intent_id,
           intent.user_id,
           intent.status AS intent_status,
           intent.completed_ledger_id
         FROM provider_paid paid
         LEFT JOIN LATERAL (
           SELECT i.*
           FROM fiat_deposit_intents i
           WHERE i.provider = 'whop'
             AND (
               i.provider_payment_id = paid.payment_id
               OR i.provider_payment_id = paid.provider_resource_id
               OR i.id::text = paid.metadata_intent_id
             )
           ORDER BY
             (i.provider_payment_id = paid.payment_id) DESC,
             (i.id::text = paid.metadata_intent_id) DESC,
             i.updated_at DESC
           LIMIT 1
         ) intent ON TRUE
       ),
       provider_stats AS (
         SELECT
           COALESCE(SUM(gross_paid_usd), 0)::text AS provider_gross_paid_usd,
           COALESCE(SUM(net_paid_usd), 0)::text AS provider_net_paid_usd,
           COUNT(*)::text AS provider_payment_count
         FROM provider_paid
       ),
       credited_ledgers AS (
         SELECT DISTINCT ON (lt.id)
           lt.id,
           lt.amount::numeric AS credited_usd
         FROM fiat_deposit_intents i
         INNER JOIN "user" u ON u.id = i.user_id
         INNER JOIN ledger_transactions lt
           ON lt.id = i.completed_ledger_id
          AND lt.type = 'deposit'
          AND lt.status = 'completed'
         WHERE u.role NOT IN ('admin', 'support')
           AND lt.created_at >= $1
           AND lt.created_at <= CURRENT_TIMESTAMP
         ORDER BY lt.id
       ),
       credit_stats AS (
         SELECT
           COALESCE(SUM(credited_usd) * 100, 0)::text AS gross_credited_cents,
           COUNT(*)::text AS credited_payment_count
         FROM credited_ledgers
       ),
       lifecycle_stats AS (
         SELECT
           COALESCE(SUM(${fiatRefundCreditCentsSql("i")}) FILTER (
             WHERE i.updated_at >= $1
               AND i.status IN ('partially_refunded', 'refunded')
           ), 0)::text AS refund_credit_cents,
           COUNT(*) FILTER (
             WHERE i.updated_at >= $1
               AND i.status IN ('partially_refunded', 'refunded')
           )::text AS refund_count,
           COUNT(*) FILTER (
             WHERE i.updated_at >= $1
               AND i.status = 'partially_refunded'
           )::text AS partial_refund_count,
           COUNT(*) FILTER (
             WHERE i.updated_at >= $1
               AND i.status = 'partially_refunded'
               AND NOT ${fiatPartialRefundAmountPresentSql("i")}
           )::text AS unresolved_partial_refund_count,
           COUNT(*) FILTER (
             WHERE i.updated_at >= $1 AND i.status = 'review'
           )::text AS review_count,
           COUNT(*) FILTER (
             WHERE i.updated_at >= $1 AND i.status = 'disputed'
           )::text AS dispute_count
         FROM fiat_deposit_intents i
         INNER JOIN "user" u ON u.id = i.user_id
         WHERE u.role NOT IN ('admin', 'support')
           AND i.updated_at >= $1
       ),
       proven_exceptions AS (
         SELECT
           paid.intent_id,
           paid.gross_paid_usd
         FROM linked_paid paid
         INNER JOIN "user" u ON u.id = paid.user_id
         WHERE u.role NOT IN ('admin', 'support')
           AND paid.intent_id IS NOT NULL
           AND paid.provider_paid_at <
             CURRENT_TIMESTAMP - INTERVAL '${FIAT_SETTLEMENT_GRACE_MINUTES} minutes'
           AND paid.intent_status NOT IN (
             'canceled', 'partially_refunded', 'refunded', 'disputed'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM ledger_transactions lt
             WHERE lt.id = paid.completed_ledger_id
               AND lt.type = 'deposit'
               AND lt.status = 'completed'
           )
       ),
       exception_stats AS (
         SELECT
           COUNT(*)::text AS uncredited_exception_count,
           COALESCE(SUM(gross_paid_usd), 0)::text
             AS uncredited_exception_gross_usd,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'intent_id', intent_id,
                 'gross_paid_usd', gross_paid_usd
               )
               ORDER BY gross_paid_usd DESC, intent_id
             ),
             '[]'::jsonb
           ) AS uncredited_exceptions
         FROM proven_exceptions
       )
       SELECT
         provider_stats.*,
         credit_stats.*,
         lifecycle_stats.*,
         exception_stats.*
       FROM provider_stats
       CROSS JOIN credit_stats
       CROSS JOIN lifecycle_stats
       CROSS JOIN exception_stats`,
      cutoff,
    );
    const row = rows[0];
    const providerGrossPaidUsd = toNumber(row?.provider_gross_paid_usd);
    const providerNetPaidUsd = toNumber(row?.provider_net_paid_usd);
    const grossCreditedUsd = toNumber(row?.gross_credited_cents) / 100;
    const refundCreditsUsd = toNumber(row?.refund_credit_cents) / 100;

    return {
      providerGrossPaidUsd,
      providerNetPaidUsd,
      providerFeesUsd: providerGrossPaidUsd - providerNetPaidUsd,
      providerPaymentCount: Number(row?.provider_payment_count ?? 0),
      grossCreditedUsd,
      refundCreditsUsd,
      netCreditedUsd: grossCreditedUsd - refundCreditsUsd,
      creditedPaymentCount: Number(row?.credited_payment_count ?? 0),
      refundCount: Number(row?.refund_count ?? 0),
      partialRefundCount: Number(row?.partial_refund_count ?? 0),
      unresolvedPartialRefundCount: Number(
        row?.unresolved_partial_refund_count ?? 0,
      ),
      reviewCount: Number(row?.review_count ?? 0),
      disputeCount: Number(row?.dispute_count ?? 0),
      uncreditedExceptionCount: Number(
        row?.uncredited_exception_count ?? 0,
      ),
      uncreditedExceptionGrossUsd: toNumber(
        row?.uncredited_exception_gross_usd,
      ),
      uncreditedExceptions: parseExceptions(row?.uncredited_exceptions),
    };
  });
}

const cachedDashboardFiatMetrics = unstable_cache(
  async (
    _window: DashboardKpiWindow,
    cutoffIso: string,
  ): Promise<DashboardFiatMetrics> => {
    void _window;
    return computeDashboardFiatMetrics(new Date(cutoffIso));
  },
  ["dashboard-fiat-v2"],
  { revalidate: 60, tags: ["dashboard-activity", "fiat-operations"] },
);

/**
 * Request-local dedupe, keyed on the RESOLVED cutoff.
 *
 * React `cache()` keys on argument identity, so keying the memo on the raw
 * `now: Date` never deduped anything: `/dashboard` renders the Fiat tile with
 * `getDashboardFiatMetrics("today")` (one argument) while
 * `getDashboardCashflowFromPostgres` calls it as
 * `getDashboardFiatMetrics(window, now)` with a freshly constructed Date (two
 * arguments, never-equal identity). Two different memo entries → the heavy Whop
 * webhook CTE (DISTINCT ON over `payment_webhook_events` plus a per-payment
 * LATERAL into `fiat_deposit_intents`) ran TWICE per render, and on a cold
 * `unstable_cache` both misses raced each other into the mirror pool.
 *
 * Keying on `(window, cutoffIso)` makes the two call sites collapse to one
 * entry — "today" resolves to the same 00:00 UTC cutoff for both — without
 * changing which cutoff either caller asked for.
 */
const loadDashboardFiatMetricsForCutoff = cache(
  async (
    window: DashboardKpiWindow,
    cutoffIso: string,
  ): Promise<DashboardFiatMetrics> => {
    const env = await readDbEnv();
    if (env !== "prod") return computeDashboardFiatMetrics(new Date(cutoffIso));
    return cachedDashboardFiatMetrics(window, cutoffIso);
  },
);

/** Request-local dedupe across the top Fiat card and the KPI/P&L branches. */
export async function getDashboardFiatMetrics(
  window: DashboardKpiWindow,
  now: Date = new Date(),
): Promise<DashboardFiatMetrics> {
  return loadDashboardFiatMetricsForCutoff(
    window,
    kpiWindowToCacheCutoff(window, now).toISOString(),
  );
}
