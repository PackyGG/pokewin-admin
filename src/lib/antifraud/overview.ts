import "server-only";

import { eq, sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import { antifraud_reviews } from "@/lib/db-schema/admin/schema";
import { adminDrizzle } from "@/lib/drizzle";
import { readDrizzleForEnv } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { pgArrayParam } from "@/lib/drizzle-array-param";

export type AntifraudOverviewMetrics = {
  totalFiatDepositCents: number;
  fraudAccountFiatDepositCents: number;
  kycAccountCount: number;
  automatedFraudKycCount: number;
};

/**
 * Lifetime overview totals.
 *
 * "Fraud accounts" are accounts an analyst has closed as flagged, rather than
 * every account that merely entered the review queue. KYC totals exclude the
 * untouched default user_kyc rows; the automated subset is identified by the
 * durable system actor written by Antifraud containment. Production-mirror
 * EXPLAIN ANALYZE on 2026-07-29 completed in 1.012 ms: the exact lifetime fiat
 * aggregate scanned the 68 paid rows, the one flagged-user lookup used
 * idx_fiat_deposit_intents_user_created, and both tiny KYC aggregates used the
 * planner's cheaper sequential scan.
 */
async function computeAntifraudOverviewMetrics(
  env: DbEnv,
): Promise<AntifraudOverviewMetrics> {
  const flaggedAccounts = await adminDrizzle
    .selectDistinct({ userId: antifraud_reviews.target_user_id })
    .from(antifraud_reviews)
    .where(eq(antifraud_reviews.status, "flagged"));
  const flaggedUserIds = flaggedAccounts.map((account) => account.userId);
  const flaggedScope =
    flaggedUserIds.length > 0
      ? sql`user_id = ANY(${pgArrayParam(flaggedUserIds)}::text[])`
      : sql`FALSE`;

  const db = readDrizzleForEnv(env);
  const result = await db.execute<{
    total_fiat_deposit_cents: string;
    fraud_account_fiat_deposit_cents: string;
    kyc_account_count: string;
    automated_fraud_kyc_count: string;
  }>(sql`
    SELECT
      COALESCE((
        SELECT SUM(
          COALESCE(actual_customer_total_cents, requested_amount_cents)
        )
        FROM fiat_deposit_intents
        WHERE paid_at IS NOT NULL
      ), 0)::text AS total_fiat_deposit_cents,
      COALESCE((
        SELECT SUM(
          COALESCE(actual_customer_total_cents, requested_amount_cents)
        )
        FROM fiat_deposit_intents
        WHERE paid_at IS NOT NULL
          AND ${flaggedScope}
      ), 0)::text AS fraud_account_fiat_deposit_cents,
      (
        SELECT COUNT(*)
        FROM user_kyc
        WHERE (
          kyc_required
          OR kyc_required_at IS NOT NULL
          OR kyc_required_by IS NOT NULL
          OR NULLIF(BTRIM(kyc_required_reason), '') IS NOT NULL
          OR verification_cycle > 0
          OR admin_decision <> 'pending'
          OR admin_reviewed_at IS NOT NULL
          OR admin_reviewed_by IS NOT NULL
          OR applicant_id IS NOT NULL
          OR status <> 'none'
          OR review_answer IS NOT NULL
          OR reject_type IS NOT NULL
          OR moderation_comment IS NOT NULL
          OR last_webhook_created_at IS NOT NULL
          OR last_webhook_digest IS NOT NULL
        )
      )::text AS kyc_account_count,
      (
        SELECT COUNT(*)
        FROM user_kyc
        WHERE kyc_required_by LIKE 'system:antifraud-%'
      )::text AS automated_fraud_kyc_count
  `);
  const row = result.rows[0];

  return {
    totalFiatDepositCents: Number(row?.total_fiat_deposit_cents ?? 0),
    fraudAccountFiatDepositCents: Number(
      row?.fraud_account_fiat_deposit_cents ?? 0,
    ),
    kycAccountCount: Number(row?.kyc_account_count ?? 0),
    automatedFraudKycCount: Number(row?.automated_fraud_kyc_count ?? 0),
  };
}

const cachedAntifraudOverviewMetrics = unstable_cache(
  computeAntifraudOverviewMetrics,
  ["antifraud-overview-metrics-v1"],
  {
    revalidate: 60,
    tags: ["antifraud-overview", "fiat-operations"],
  },
);

export async function getAntifraudOverviewMetrics(): Promise<AntifraudOverviewMetrics> {
  const env = await readDbEnv();
  return env === "prod"
    ? cachedAntifraudOverviewMetrics(env)
    : computeAntifraudOverviewMetrics(env);
}
