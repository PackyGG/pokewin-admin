import "server-only";

import { z } from "zod";

import { getExcludedUserIdsStrict } from "@/lib/excluded-users/fetch";

const numeric = z
  .union([z.number(), z.string()])
  .transform(Number)
  .pipe(z.number().finite());
const category = z.enum([
  "provider",
  "funding",
  "velocity",
  "account",
  "network",
  "behavior",
]);
const reviewStatusSchema = z.enum([
  "unreviewed",
  "in_review",
  "cleared",
  "escalated",
  "hold_recommended",
]);
const signalSchema = z.object({
  key: z.string(),
  label: z.string(),
  detail: z.string(),
  points: z.number(),
  tone: z.enum(["good", "neutral", "warning", "bad"]),
  category,
});
const checkSchema = z.object({
  key: category,
  label: z.string(),
  description: z.string(),
  status: z.enum(["pass", "review", "block"]),
  score: z.number(),
  evidence: z.array(z.string()),
});
const providerEvidenceSchema = z.object({
  eventType: z.string().nullable(),
  eventReceivedAt: z.string().nullable(),
  checkoutEmail: z
    .string()
    .email()
    .max(320)
    .nullable()
    .optional()
    .default(null),
  threeDsVerified: z.boolean().nullable(),
  riskScore: z.number().nullable(),
  riskSignals: z.array(
    z.object({
      key: z.string(),
      category: z.string(),
      label: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    }),
  ),
  disputeCount: z.number(),
  refundCount: z.number(),
  autoRefunded: z.boolean(),
  billingCountry: z.string().nullable(),
  paymentMethodType: z.string().nullable(),
  cardBrand: z.string().nullable().optional().default(null),
  cardLast4: z.string().nullable().optional().default(null),
});
const fundingEvidenceSchema = z.object({
  priorCryptoDeposits: z.number(),
  priorCryptoUsd: z.number(),
  priorFiatDeposits: z.number(),
  priorFiatUsd: z.number(),
  priorDepositAverageUsd: z.number(),
  currentVsAverageRatio: z.number().nullable(),
});
const behaviorEvidenceSchema = z.object({
  observedHours: z.number(),
  gameWagerUsd: z.number(),
  gamePayoutUsd: z.number(),
  rewardsUsd: z.number(),
  gameEvents: z.number(),
  withdrawalRequests: z.number(),
  withdrawalUsd: z.number(),
  minutesToFirstWithdrawal: z.number().nullable(),
  playthroughRatio: z.number(),
});
const accountEvidenceSchema = z.object({
  accountAgeDays: z.number(),
  countryCode: z.string().nullable(),
  kycRequired: z.boolean(),
  kycStatus: z.string(),
  kycAdminDecision: z.string(),
  isBanned: z.boolean(),
  isLocked: z.boolean(),
  isSuspectedAlt: z.boolean(),
  sharedDeviceUsers: z.number(),
  sharedSignupIpUsers: z.number(),
  fiatAttempts1h: z.number(),
  fiatAttempts24h: z.number(),
  failedFiatAttempts24h: z.number(),
  priorDisputedFiat: z.number(),
  priorRefundedFiat: z.number(),
});
const breakdownSchema = z.record(category, z.number());

const assessmentSchema = z.object({
  deposit_intent_id: z.string().uuid(),
  user_id: z.string(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
  provider: z.string(),
  provider_payment_id: z.string().nullable(),
  provider_payment_status: z.string().nullable(),
  status: z.string(),
  currency: z.string(),
  requested_amount_usd: numeric,
  credited_amount_usd: numeric,
  customer_total_usd: numeric.nullable(),
  provider_net_usd: numeric.nullable(),
  occurred_at: z.string(),
  source_updated_at: z.string(),
  provider_risk_score: z.number().nullable(),
  three_ds_verified: z.boolean().nullable(),
  risk_score: z.number(),
  verdict: z.enum(["good", "review", "bad"]),
  recommendation: z.string(),
  summary: z.string(),
  signals: z.array(signalSchema),
  provider_evidence: providerEvidenceSchema,
  funding_evidence: fundingEvidenceSchema,
  behavior_evidence: behaviorEvidenceSchema,
  account_evidence: accountEvidenceSchema,
  score_breakdown: breakdownSchema,
  flow_checks: z.array(checkSchema),
  review_status: reviewStatusSchema,
  review_decision: z.string().nullable(),
  reviewed_by: z.string().nullable(),
  reviewed_by_username: z.string().nullable(),
  review_note: z.string().nullable(),
  review_started_at: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  score_version: z.string(),
  assessed_at: z.string(),
});
const timelineSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
  amountUsd: z.number(),
  occurredAt: z.string(),
  category: z.enum([
    "crypto_deposit",
    "fiat_deposit",
    "play",
    "win",
    "reward",
    "withdrawal",
    "account",
  ]),
  tone: z.enum(["good", "neutral", "warning", "bad"]),
  isCurrent: z.boolean(),
});
const reviewEventSchema = z.object({
  id: z.string().uuid(),
  deposit_intent_id: z.string().uuid(),
  action: z.enum([
    "start_review",
    "clear",
    "escalate",
    "recommend_hold",
  ]),
  actor_id: z.string(),
  actor_username: z.string().nullable(),
  note: z.string().nullable(),
  created_at: z.string(),
});
const summarySchema = z.object({
  total: z.number(),
  good: z.number(),
  review: z.number(),
  bad: z.number(),
  unreviewed: z.number(),
  in_review: z.number(),
  hold_recommended: z.number(),
  provider_high_risk: z.number(),
  three_ds_failed: z.number(),
  disputed: z.number(),
  normal: z.number(),
  fraud: z.number(),
  refunded: z.number(),
  amount_usd: numeric,
});
const listResponseSchema = z.object({
  data: z.array(assessmentSchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    pages: z.number(),
  }),
  summary: summarySchema,
});
const detailResponseSchema = z.object({
  data: z.object({
    assessment: assessmentSchema,
    timeline: z.array(timelineSchema),
    reviewEvents: z.array(reviewEventSchema),
  }),
});

export type FiatAssessment = z.infer<typeof assessmentSchema>;
export type FiatVerdict = FiatAssessment["verdict"];
export type FiatReviewStatus = z.infer<typeof reviewStatusSchema>;
export type FiatReviewAction =
  | "start_review"
  | "clear"
  | "recommend_hold";
export type FiatDetail = z.infer<typeof detailResponseSchema>["data"];
export type FiatSummary = z.infer<typeof summarySchema>;

const TIMEOUT_MS = 12_000;

async function monitorHeaders(token: string): Promise<Record<string, string>> {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "x-antifraud-excluded-users": JSON.stringify(
      await getExcludedUserIdsStrict(),
    ),
  };
}

function config(admin = false): { baseUrl: string; token: string } | null {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = admin
    ? process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN
    : process.env.ANTIFRAUD_MONITOR_API_TOKEN;
  return baseUrl && token ? { baseUrl, token } : null;
}

export async function listFiatAssessments(input: {
  page: number;
  view?: "normal" | "fraud" | "refunded";
  status?: string;
  verdict?: FiatVerdict;
  reviewStatus?: FiatReviewStatus;
  search?: string;
  excludeKycRequired?: boolean;
}) {
  const upstream = config();
  if (!upstream) {
    return {
      configured: false,
      error: false,
      data: [] as FiatAssessment[],
      pagination: null,
      summary: null,
    };
  }
  const params = new URLSearchParams({
    page: String(input.page),
    limit: "20",
  });
  if (input.status) params.set("status", input.status);
  if (input.view) params.set("view", input.view);
  if (input.verdict) params.set("verdict", input.verdict);
  if (input.reviewStatus) params.set("reviewStatus", input.reviewStatus);
  if (input.search) params.set("search", input.search);
  if (input.excludeKycRequired) params.set("excludeKycRequired", "true");
  try {
    const response = await fetch(
      `${upstream.baseUrl}/v1/fiat-deposits?${params}`,
      {
        headers: await monitorHeaders(upstream.token),
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new Error(`Monitor API returned ${response.status}`);
    const payload = listResponseSchema.parse(await response.json());
    return { configured: true, error: false, ...payload };
  } catch (error) {
    console.error("[antifraud-fiat] list failed:", error);
    return {
      configured: true,
      error: true,
      data: [] as FiatAssessment[],
      pagination: null,
      summary: null,
    };
  }
}

export async function getFiatAssessment(id: string) {
  const upstream = config();
  if (!upstream) {
    return { configured: false, notFound: false, error: false, data: null };
  }
  try {
    const response = await fetch(
      `${upstream.baseUrl}/v1/fiat-deposits/${encodeURIComponent(id)}`,
      {
        headers: await monitorHeaders(upstream.token),
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (response.status === 404) {
      return { configured: true, notFound: true, error: false, data: null };
    }
    if (!response.ok) throw new Error(`Monitor API returned ${response.status}`);
    const payload = detailResponseSchema.parse(await response.json());
    return {
      configured: true,
      notFound: false,
      error: false,
      data: payload.data,
    };
  } catch (error) {
    console.error("[antifraud-fiat] detail failed:", error);
    return { configured: true, notFound: false, error: true, data: null };
  }
}

export async function updateFiatReview(input: {
  depositIntentId: string;
  action: FiatReviewAction;
  actorId: string;
  actorUsername?: string;
  note?: string;
  expectedStatus: FiatReviewStatus;
  idempotencyKey: string;
}): Promise<void> {
  const upstream = config(true);
  if (!upstream) throw new Error("The Antifraud monitor is not configured.");
  const response = await fetch(
    `${upstream.baseUrl}/v1/fiat-deposits/${encodeURIComponent(input.depositIntentId)}/review`,
    {
      method: "POST",
      headers: {
        ...(await monitorHeaders(upstream.token)),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: input.action,
        actorId: input.actorId,
        actorUsername: input.actorUsername,
        note: input.note,
        expectedStatus: input.expectedStatus,
        idempotencyKey: input.idempotencyKey,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (response.status === 409) {
    throw new Error("This review changed. Refresh and try again.");
  }
  if (!response.ok) throw new Error("The fiat review could not be updated.");
}
