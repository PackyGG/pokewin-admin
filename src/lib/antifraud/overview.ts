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
 * "Fraud accounts" includes every meaningful KYC account plus accounts an
 * analyst has closed as flagged. KYC totals exclude untouched default
 * user_kyc rows; the automated subset is identified by the durable system
 * actor written by Antifraud containment.
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
    WITH succeeded_events AS (
      SELECT
        pwe.id,
        pwe.received_at,
        pwe.provider_resource_id,
        pwe.payload #>> '{data,id}' AS payment_id,
        pwe.payload #>> '{data,metadata,deposit_intent_id}'
          AS metadata_intent_id,
        (pwe.payload #>> '{data,paid_at}')::timestamptz
          AS provider_paid_at,
        CASE
          WHEN pwe.payload #>> '{data,usd_total}'
            ~ '^[0-9]+([.][0-9]+)?$'
          THEN (pwe.payload #>> '{data,usd_total}')::numeric
          ELSE NULL
        END AS gross_paid_usd
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
        gross_paid_usd
      FROM succeeded_events
      WHERE provider_paid_at <= CURRENT_TIMESTAMP
      ORDER BY payment_id, received_at DESC, id DESC
    ),
    linked_paid AS (
      SELECT paid.*, intent.user_id
      FROM provider_paid paid
      LEFT JOIN LATERAL (
        SELECT i.user_id
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
    )
    SELECT
      COALESCE((
        SELECT SUM(gross_paid_usd) * 100
        FROM provider_paid
      ), 0)::text AS total_fiat_deposit_cents,
      COALESCE((
        SELECT SUM(gross_paid_usd) * 100
        FROM linked_paid
        WHERE user_id IS NOT NULL
          AND (
          ${flaggedScope}
          OR user_id IN (
            SELECT user_id
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
          )
        )
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
  ["antifraud-overview-metrics-v3"],
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
