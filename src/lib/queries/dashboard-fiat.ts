import "server-only";

import { cache } from "react";
import { unstable_cache } from "next/cache";

import { getReadDrizzleDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { queryRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { excludeStaffAndBlacklistedSqlFromIds } from "./_blacklist";
import {
  kpiWindowToCutoff,
  type DashboardKpiWindow,
} from "./dashboard-period";
import {
  fiatPartialRefundAmountPresentSql,
  fiatRefundCreditCentsSql,
} from "./fiat-refund-credits";

export type DashboardFiatMetrics = {
  grossCreditedUsd: number;
  refundCreditsUsd: number;
  netCreditedUsd: number;
  providerFeesUsd: number;
  paymentCount: number;
  refundCount: number;
  partialRefundCount: number;
  unresolvedPartialRefundCount: number;
  reviewCount: number;
  disputeCount: number;
};

type RawDashboardFiatMetrics = {
  gross_credited_cents: string;
  refund_credit_cents: string;
  payment_count: string;
  refund_count: string;
  partial_refund_count: string;
  unresolved_partial_refund_count: string;
  review_count: string;
  dispute_count: string;
  provider_fee_cents: string;
};

/**
 * Convert provider refund data into the amount of Packy credit reversed.
 *
 * Full refunds always reverse the whole credited amount. Partial refunds
 * prefer an explicit reversed-credit field. If the provider only supplies
 * the buyer-currency refund, the credited amount is reduced proportionally
 * to the original customer total. This keeps EUR and other adaptive-pricing
 * payments from being treated as though their provider amount were USD.
 */
async function computeDashboardFiatMetrics(
  cutoff: Date,
  blacklist: string[],
): Promise<DashboardFiatMetrics> {
  return withTiming("dashboard.fiat", async () => {
    const db = await getReadDrizzleDb();
    const scope = excludeStaffAndBlacklistedSqlFromIds(blacklist).replace(
      /^user_id\b/,
      "i.user_id",
    );
    const rows = await queryRows<RawDashboardFiatMetrics[]>(
      db,
      `WITH intent_stats AS (
         SELECT
           COALESCE(SUM(i.credited_amount_cents) FILTER (
             WHERE i.completed_at >= $1
               AND i.status IN ('completed', 'partially_refunded', 'refunded', 'disputed')
           ), 0)::text AS gross_credited_cents,
           COALESCE(SUM(${fiatRefundCreditCentsSql()}) FILTER (
             WHERE i.updated_at >= $1
               AND i.status IN ('partially_refunded', 'refunded')
           ), 0)::text AS refund_credit_cents,
           COUNT(*) FILTER (
             WHERE i.completed_at >= $1
               AND i.status IN ('completed', 'partially_refunded', 'refunded', 'disputed')
           )::text AS payment_count,
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
               AND NOT ${fiatPartialRefundAmountPresentSql()}
           )::text AS unresolved_partial_refund_count,
           COUNT(*) FILTER (
             WHERE i.updated_at >= $1 AND i.status = 'review'
           )::text AS review_count,
           COUNT(*) FILTER (
             WHERE i.updated_at >= $1 AND i.status = 'disputed'
           )::text AS dispute_count
         FROM fiat_deposit_intents i
         WHERE ${scope}
           AND (
             (
               i.completed_at >= $1
               AND i.status IN ('completed', 'partially_refunded', 'refunded', 'disputed')
             )
             OR (
               i.updated_at >= $1
               AND i.status IN ('partially_refunded', 'refunded', 'review', 'disputed')
             )
           )
       ),
       fee_stats AS (
         SELECT COALESCE(SUM(pf.amount_cents), 0)::text AS provider_fee_cents
         FROM payment_provider_fees pf
         INNER JOIN fiat_deposit_intents i ON i.id = pf.deposit_intent_id
         WHERE pf.created_at >= $1 AND ${scope}
       )
       SELECT intent_stats.*, fee_stats.provider_fee_cents
       FROM intent_stats
       CROSS JOIN fee_stats`,
      cutoff,
    );
    const row = rows[0];
    const grossCreditedUsd = toNumber(row?.gross_credited_cents) / 100;
    const refundCreditsUsd = toNumber(row?.refund_credit_cents) / 100;

    return {
      grossCreditedUsd,
      refundCreditsUsd,
      netCreditedUsd: grossCreditedUsd - refundCreditsUsd,
      providerFeesUsd: toNumber(row?.provider_fee_cents) / 100,
      paymentCount: Number(row?.payment_count ?? 0),
      refundCount: Number(row?.refund_count ?? 0),
      partialRefundCount: Number(row?.partial_refund_count ?? 0),
      unresolvedPartialRefundCount: Number(
        row?.unresolved_partial_refund_count ?? 0,
      ),
      reviewCount: Number(row?.review_count ?? 0),
      disputeCount: Number(row?.dispute_count ?? 0),
    };
  });
}

const cachedDashboardFiatMetrics = unstable_cache(
  async (
    _window: DashboardKpiWindow,
    cutoffIso: string,
    blacklist: string[],
  ): Promise<DashboardFiatMetrics> => {
    void _window;
    return computeDashboardFiatMetrics(new Date(cutoffIso), blacklist);
  },
  ["dashboard-fiat-v1"],
  { revalidate: 60, tags: ["dashboard-activity", "fiat-operations"] },
);

async function loadDashboardFiatMetrics(
  window: DashboardKpiWindow,
  now: Date = new Date(),
): Promise<DashboardFiatMetrics> {
  const cutoff = kpiWindowToCutoff(window, now);
  const blacklist = await getExcludedUserIds();
  const env = await readDbEnv();
  if (env !== "prod") return computeDashboardFiatMetrics(cutoff, blacklist);
  return cachedDashboardFiatMetrics(window, cutoff.toISOString(), blacklist);
}

/** Request-local dedupe across the top Fiat card and the KPI/P&L branches. */
export const getDashboardFiatMetrics = cache(loadDashboardFiatMetrics);
