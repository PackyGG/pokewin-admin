import "server-only";

import { inArray, sql, type SQL } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { getReadDrizzleDb } from "@/lib/db";
import { antifraud_reviews } from "@/lib/db-schema/admin/schema";
import {
  user_feature_locks,
  user_kyc,
} from "@/lib/db-schema/main/schema";
import { pgArrayParam } from "@/lib/drizzle-array-param";

export const REVIEW_QUEUE_STATES = [
  "priority",
  "normal",
  "waiting_kyc",
  "postponed",
] as const;

export type ReviewQueueState = (typeof REVIEW_QUEUE_STATES)[number];
export type PersistedReviewQueueState = Exclude<ReviewQueueState, "postponed">;

export const REVIEW_QUEUE_LABELS: Record<ReviewQueueState, string> = {
  priority: "High priority",
  normal: "Normal reviews",
  waiting_kyc: "Waiting KYC",
  postponed: "Postponed",
};

export const ULTRA_HIGH_REVIEW_SCORE = 70;
const SYNC_BATCH_SIZE = 500;
const SYNC_FRESHNESS_MS = 5 * 60 * 1_000;

export type ReviewWorkflowEvidence = {
  withdrawalsLocked: boolean;
  fullyLocked: boolean;
  cryptoWithdrawalsLocked: boolean;
  itemWithdrawalsLocked: boolean;
  kycRequired: boolean;
  kycStatus: "none" | "pending" | "on_hold" | "approved" | "rejected";
  kycDecision: "pending" | "safe" | "rejected";
  kycFinished: boolean;
  riskScore: number | null;
  reasonCodes: string[];
};

export type ReviewWorkflow = {
  queueState: ReviewQueueState;
  baseQueueState: PersistedReviewQueueState;
  evidence: ReviewWorkflowEvidence;
  postponedUntil: Date | null;
  postponedBy: string | null;
  stateUpdatedAt: Date;
};

type ReviewCandidate = {
  review_id: string;
  target_user_id: string;
  risk_score: number | null;
  signals: string[];
};

type WorkflowRow = {
  review_id: string;
  queue_state: PersistedReviewQueueState;
  evidence: ReviewWorkflowEvidence;
  postponed_until: string | null;
  postponed_by: string | null;
  state_updated_at: string;
};

function isFinishedKyc(
  status: ReviewWorkflowEvidence["kycStatus"],
): boolean {
  return status === "approved" || status === "rejected";
}

function deriveQueueState(
  evidence: ReviewWorkflowEvidence,
): PersistedReviewQueueState {
  if (
    evidence.kycRequired &&
    evidence.kycDecision === "pending" &&
    !evidence.kycFinished
  ) {
    return "waiting_kyc";
  }
  if (
    evidence.withdrawalsLocked ||
    evidence.kycFinished ||
    (evidence.riskScore ?? 0) >= ULTRA_HIGH_REVIEW_SCORE
  ) {
    return "priority";
  }
  return "normal";
}

/**
 * Refresh a bounded slice of the ADMIN staff projection from indexed MAIN
 * mirror reads. Missing/stale rows are processed oldest-first, so the ops tick
 * converges without an unbounded cross-database scan.
 */
export async function syncReviewWorkflowStates(): Promise<number> {
  const staleBefore = new Date(Date.now() - SYNC_FRESHNESS_MS);
  const candidates = await adminDrizzle.execute<ReviewCandidate>(sql`
    SELECT
      review.id::text AS review_id,
      review.target_user_id,
      review.risk_score,
      review.signals
    FROM antifraud_reviews AS review
    LEFT JOIN antifraud_review_workflow AS workflow
      ON workflow.review_id = review.id
    WHERE review.status IN ('open', 'in_review', 'escalated')
      AND (
        workflow.review_id IS NULL
        OR workflow.state_updated_at < ${staleBefore}
      )
    ORDER BY workflow.state_updated_at ASC NULLS FIRST, review.id
    LIMIT ${SYNC_BATCH_SIZE}
  `);
  if (candidates.rows.length === 0) return 0;

  const userIds = [...new Set(candidates.rows.map((row) => row.target_user_id))];
  const main = await getReadDrizzleDb();
  const [locks, kycRows] = await Promise.all([
    main
      .select({
        userId: user_feature_locks.user_id,
        crypto: user_feature_locks.locked_withdrawals_crypto,
        items: user_feature_locks.locked_withdrawals_items,
      })
      .from(user_feature_locks)
      .where(inArray(user_feature_locks.user_id, userIds)),
    main
      .select({
        userId: user_kyc.user_id,
        required: user_kyc.kyc_required,
        status: user_kyc.status,
        decision: user_kyc.admin_decision,
      })
      .from(user_kyc)
      .where(inArray(user_kyc.user_id, userIds)),
  ]);

  const lockByUser = new Map(locks.map((row) => [row.userId, row]));
  const kycByUser = new Map(kycRows.map((row) => [row.userId, row]));
  const projected = candidates.rows.map((review) => {
    const lock = lockByUser.get(review.target_user_id);
    const kyc = kycByUser.get(review.target_user_id);
    const cryptoLocked = (lock?.crypto.length ?? 0) > 0;
    const itemLocked = lock?.items === true;
    const kycStatus = kyc?.status ?? "none";
    const evidence: ReviewWorkflowEvidence = {
      withdrawalsLocked: cryptoLocked || itemLocked,
      fullyLocked: cryptoLocked && itemLocked,
      cryptoWithdrawalsLocked: cryptoLocked,
      itemWithdrawalsLocked: itemLocked,
      kycRequired: kyc?.required === true,
      kycStatus,
      kycDecision: kyc?.decision ?? "pending",
      kycFinished: isFinishedKyc(kycStatus),
      riskScore: review.risk_score,
      reasonCodes: review.signals.slice(0, 50),
    };
    return {
      reviewId: review.review_id,
      queueState: deriveQueueState(evidence),
      evidence,
    };
  });

  await adminDrizzle.execute(sql`
    WITH incoming AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(projected)}::jsonb) AS value(
        "reviewId" uuid,
        "queueState" text,
        evidence jsonb
      )
    )
    INSERT INTO antifraud_review_workflow (
      review_id,
      queue_state,
      evidence,
      state_updated_at,
      updated_at
    )
    SELECT
      "reviewId",
      "queueState",
      evidence,
      now(),
      now()
    FROM incoming
    ON CONFLICT (review_id) DO UPDATE SET
      queue_state = EXCLUDED.queue_state,
      evidence = EXCLUDED.evidence,
      state_updated_at = now(),
      updated_at = now()
  `);
  return projected.length;
}

export function reviewQueueCondition(state: ReviewQueueState): SQL {
  if (state === "postponed") {
    return sql`EXISTS (
      SELECT 1
      FROM antifraud_review_workflow AS workflow
      WHERE workflow.review_id = ${antifraud_reviews.id}
        AND workflow.postponed_until > now()
    )`;
  }
  return sql`
    NOT EXISTS (
      SELECT 1
      FROM antifraud_review_workflow AS postponed
      WHERE postponed.review_id = ${antifraud_reviews.id}
        AND postponed.postponed_until > now()
    )
    AND COALESCE((
      SELECT workflow.queue_state
      FROM antifraud_review_workflow AS workflow
      WHERE workflow.review_id = ${antifraud_reviews.id}
    ), 'normal') = ${state}
  `;
}

export async function loadReviewWorkflows(
  reviewIds: readonly string[],
): Promise<Map<string, ReviewWorkflow>> {
  if (reviewIds.length === 0) return new Map();
  const rows = await adminDrizzle.execute<WorkflowRow>(sql`
    SELECT
      review_id::text,
      queue_state,
      evidence,
      postponed_until::text,
      postponed_by::text,
      state_updated_at::text
    FROM antifraud_review_workflow
    WHERE review_id = ANY(${pgArrayParam(reviewIds)}::uuid[])
  `);
  const result = new Map<string, ReviewWorkflow>();
  for (const row of rows.rows) {
    const postponedUntil = row.postponed_until
      ? new Date(row.postponed_until)
      : null;
    result.set(row.review_id, {
      baseQueueState: row.queue_state,
      queueState:
        postponedUntil && postponedUntil.getTime() > Date.now()
          ? "postponed"
          : row.queue_state,
      evidence: row.evidence,
      postponedUntil,
      postponedBy: row.postponed_by,
      stateUpdatedAt: new Date(row.state_updated_at),
    });
  }
  return result;
}
