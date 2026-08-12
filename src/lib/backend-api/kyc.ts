import "server-only";

import { z } from "zod";

import { backendApi } from "./client";
import {
  getSumsubApplicantReview,
  type SumsubApplicantReview,
} from "@/lib/antifraud/sumsub-review-api";

/**
 * Sumsub KYC — admin control surface. The backend owns the KYC state machine:
 * it is admin-driven and NOTHING auto-unlocks. An admin flags a user for
 * verification (`require`), the user verifies through the Sumsub SDK, the
 * provider webhook records the RESULT (informational only), and an admin then
 * marks the current verification cycle `safe` (lifts the withdrawal gate) or
 * `rejected` (keeps it locked).
 *
 * The `verificationCycle` counter is the concurrency guard: every new trigger
 * bumps it, and a review decision targets a SPECIFIC cycle — so a stale
 * approval can't clear a newer fraud trigger. `review` therefore sends the
 * cycle the admin is acting on; a mismatch returns 409 (surface as "refresh").
 *
 * Source of truth (request/response shapes):
 *   PackyGG/backend/src/routes/v1/admin/kyc/index.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are `/admin/...`.
 * Errors surface as BackendApiError (`.status`, `.isConflict`, `.isNotFound`)
 * / BackendNetworkError — callers degrade gracefully.
 */
const KYC_ADMIN_DECISIONS = ["pending", "safe", "rejected"] as const;
const KYC_STATUSES = [
  "none",
  "pending",
  "on_hold",
  "approved",
  "rejected",
] as const;

export type KycAdminDecision = (typeof KYC_ADMIN_DECISIONS)[number];
export type KycStatus = (typeof KYC_STATUSES)[number];

export type UserKycStatus = {
  /** Our control flag — whether the user must currently pass KYC. */
  kycRequired: boolean;
  /** The admin's review decision for the current cycle. */
  adminDecision: KycAdminDecision;
  /** Coarse provider status, mirrored from Sumsub webhooks (informational). */
  status: KycStatus;
  /** Latest Sumsub answer: GREEN / RED (or null before any result). */
  reviewAnswer: string | null;
  /** Provider moderation comment shown to the user on retry. */
  moderationComment: string | null;
  /** Current verification cycle — echoed back into `review` as a guard. */
  verificationCycle: number;
  /** Sumsub applicant id, learned from the first webhook (null until then). */
  applicantId: string | null;
  /** Sanitized live provider detail. Never includes names, DOB, IDs or images. */
  sumsubReview: SumsubApplicantReview | null;
};

/**
 * Response validation, mirroring `parseFeatureLocks` in `feature-locks.ts`.
 *
 * `backendApi` only throws on a non-2xx status: any 2xx body — including `{}`
 * for a non-JSON response — used to be handed back through a bare TypeScript
 * cast. A `{ success: false }` body, or a body missing `data` entirely, was
 * therefore reported to staff as a completed KYC decision, and the cast made it
 * unobservable. `success: z.literal(true)` and the field shapes below mirror
 * `KycStatusResponseSchema` / `SuccessWithDataSchema` in
 * `PackyGG/backend/src/schemas`, which is what the route actually serialises.
 *
 * The KYC payload carries no user id, so — unlike the feature-lock parser —
 * there is nothing here to cross-check the response against the requested
 * account. Callers must keep treating a thrown error as "not applied".
 */
const BackendKycStatusSchema = z.object({
  kycRequired: z.boolean(),
  adminDecision: z.enum(KYC_ADMIN_DECISIONS),
  status: z.enum(KYC_STATUSES),
  reviewAnswer: z.string().nullable(),
  moderationComment: z.string().nullable(),
  verificationCycle: z.number().int().nonnegative(),
  applicantId: z.string().nullable(),
});

const KycStatusResponseSchema = z.object({
  success: z.literal(true),
  data: BackendKycStatusSchema,
});

const RequireKycResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({ verificationCycle: z.number().int() }),
});

const ReviewKycResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
});

function parseBackendResponse<T>(
  schema: z.ZodType<T>,
  response: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(response);
  if (!parsed.success) {
    throw new Error(`Backend returned an invalid ${what} response`);
  }
  return parsed.data;
}

export const getUserKyc = async (userId: string): Promise<UserKycStatus> => {
  const status = await backendApi
    .get<unknown>(`/admin/kyc/${encodeURIComponent(userId)}`)
    .then((response) =>
      parseBackendResponse(KycStatusResponseSchema, response, "KYC status").data,
    );
  return {
    ...status,
    sumsubReview: status.applicantId
      ? await getSumsubApplicantReview(status.applicantId)
      : null,
  };
};

/**
 * Flag a user for KYC. Opens a new verification cycle (returned), resets the
 * admin decision to `pending`, and re-locks withdrawals until reviewed.
 * `adminId` is required by the backend for its audit trail. `levelName`
 * overrides the Sumsub flow; omit to use the backend's env default.
 */
export const requireUserKyc = (params: {
  userId: string;
  adminId: string;
  reason: string;
  levelName?: string;
}) =>
  backendApi
    .post<unknown>(
      `/admin/kyc/${encodeURIComponent(params.userId)}/require`,
      {
        admin_id: params.adminId,
        reason: params.reason,
        ...(params.levelName ? { level_name: params.levelName } : {}),
      },
    )
    .then(
      (response) =>
        parseBackendResponse(
          RequireKycResponseSchema,
          response,
          "KYC requirement",
        ).data,
    );

/**
 * Record the admin's review of the CURRENT cycle. `safe` clears the
 * requirement (lifts the withdrawal gate); `rejected` keeps it locked.
 * `expectedCycle` MUST be the cycle the admin is acting on — the backend
 * rejects a stale/mismatched cycle with 409.
 */
export const reviewUserKyc = (params: {
  userId: string;
  adminId: string;
  decision: "safe" | "rejected";
  expectedCycle: number;
}) =>
  backendApi
    .post<unknown>(`/admin/kyc/${encodeURIComponent(params.userId)}/review`, {
      admin_id: params.adminId,
      decision: params.decision,
      verification_cycle: params.expectedCycle,
    })
    .then((response) =>
      parseBackendResponse(ReviewKycResponseSchema, response, "KYC review"),
    );
