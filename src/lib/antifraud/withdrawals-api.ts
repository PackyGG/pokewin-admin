import "server-only";

import { z } from "zod";

import { getExcludedUserIdsStrict } from "@/lib/excluded-users/fetch";

const numeric = z
  .union([z.number(), z.string()])
  .transform(Number)
  .pipe(z.number().finite());

const signalSchema = z.object({
  key: z.string(),
  label: z.string(),
  detail: z.string(),
  points: z.number(),
  tone: z.enum(["good", "neutral", "warning", "bad"]),
  category: z
    .enum(["integrity", "funding", "behavior", "account", "network"])
    .default("behavior"),
});

const flowCheckSchema = z.object({
  key: z.enum(["integrity", "funding", "behavior", "account", "network"]),
  label: z.string(),
  description: z.string(),
  status: z
    .enum(["pass", "watch", "alert", "not_applicable", "review", "block"])
    .transform((status) => {
      if (status === "review") return "watch" as const;
      if (status === "block") return "alert" as const;
      return status;
    }),
  score: z.number(),
  evidence: z.array(z.string()),
});

const scoreBreakdownSchema = z.object({
  integrity: z.number().default(0),
  funding: z.number().default(0),
  behavior: z.number().default(0),
  account: z.number().default(0),
  network: z.number().default(0),
});

const reviewStatusSchema = z.enum([
  "unreviewed",
  "in_review",
  "cleared",
  "escalated",
  "block_recommended",
]);

const flowSchema = z.object({
  originType: z.string().nullable().default(null),
  originLabel: z.string().default("No funding origin found"),
  originAt: z.string().nullable().default(null),
  originAmountUsd: z.number().default(0),
  depositsUsd: z.number(),
  gameWinsUsd: z.number(),
  gameLossesUsd: z.number(),
  playReturnsUsd: z.number().default(0),
  wageredUsd: z.number().default(0),
  grossCreditsUsd: z.number().default(0),
  rewardsUsd: z.number(),
  withdrawalUsd: z.number(),
  gameEvents: z.number(),
  minutesSinceLastDeposit: z.number().nullable(),
  accountAgeDays: z.number(),
  tracedAssetUsd: z.number(),
  untracedAssetUsd: z.number(),
  coverageKind: z
    .enum(["balance_ledger", "attached_assets"])
    .default("attached_assets"),
  modelVersion: z.number().int().default(1),
});

const sourceSchema = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number(),
  valueUsd: z.number(),
  traceable: z.boolean(),
});

const withdrawalSchema = z.object({
  withdrawal_id: z.string().uuid(),
  user_id: z.string(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
  method: z.string(),
  status: z.string(),
  amount_usd: numeric,
  asset_count: z.number(),
  requested_at: z.string(),
  risk_score: z.number(),
  verdict: z.enum(["good", "review", "bad"]),
  summary: z.string(),
  signals: z.array(signalSchema),
  flow: flowSchema,
  source_breakdown: z.array(sourceSchema),
  score_breakdown: scoreBreakdownSchema.default({
    integrity: 0,
    funding: 0,
    behavior: 0,
    account: 0,
    network: 0,
  }),
  flow_checks: z.array(flowCheckSchema).default([]),
  model_version: z.number().int().default(1),
  review_status: reviewStatusSchema.default("unreviewed"),
  review_decision: z.string().nullable().default(null),
  reviewed_by: z.string().nullable().default(null),
  reviewed_by_username: z.string().nullable().default(null),
  review_note: z.string().nullable().default(null),
  review_started_at: z.string().nullable().default(null),
  reviewed_at: z.string().nullable().default(null),
  assessed_at: z.string(),
});

const timelineEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  detail: z.string().nullable(),
  amountUsd: z.number(),
  occurredAt: z.string(),
  category: z.enum([
    "deposit",
    "play",
    "win",
    "reward",
    "withdrawal",
    "account",
  ]),
  tone: z.enum(["good", "neutral", "warning", "bad"]),
  isOrigin: z.boolean().default(false),
});

const reviewEventSchema = z.object({
  id: z.string().uuid(),
  withdrawal_id: z.string().uuid(),
  action: z.enum(["start_review", "clear", "escalate", "recommend_block"]),
  actor_id: z.string(),
  actor_username: z.string().nullable(),
  note: z.string().nullable(),
  created_at: z.string(),
});

const responseSchema = z.object({
  data: z.array(withdrawalSchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    pages: z.number(),
  }),
  summary: z.object({
    total: z.number(),
    good: z.number(),
    review: z.number(),
    bad: z.number(),
    unreviewed: z.number().default(0),
    in_review: z.number().default(0),
    escalated: z.number().default(0),
    block_recommended: z.number().default(0),
    amount_usd: numeric,
  }),
});

const detailResponseSchema = z.object({
  data: z.object({
    assessment: withdrawalSchema,
    timeline: z.array(timelineEventSchema),
    reviewEvents: z.array(reviewEventSchema),
  }),
});

export type WithdrawalAssessment = z.infer<typeof withdrawalSchema>;
export type WithdrawalVerdict = WithdrawalAssessment["verdict"];
export type WithdrawalReviewStatus = z.infer<typeof reviewStatusSchema>;
export type WithdrawalReviewAction = z.infer<
  typeof reviewEventSchema
>["action"];
export type WithdrawalDetail = z.infer<typeof detailResponseSchema>["data"];

const UPSTREAM_TIMEOUT_MS = 12_000;
const EXCLUDED_USERS_HEADER = "x-antifraud-excluded-users";

async function monitorHeaders(token: string): Promise<Record<string, string>> {
  const excludedUserIds = await getExcludedUserIdsStrict();
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    [EXCLUDED_USERS_HEADER]: JSON.stringify(excludedUserIds),
  };
}

export async function listWithdrawalAssessments(input: {
  page: number;
  status?: string;
  verdict?: WithdrawalVerdict;
  reviewStatus?: WithdrawalReviewStatus;
  search?: string;
}): Promise<{
  configured: boolean;
  error: boolean;
  data: WithdrawalAssessment[];
  pagination: z.infer<typeof responseSchema>["pagination"] | null;
  summary: z.infer<typeof responseSchema>["summary"] | null;
}> {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_TOKEN;
  if (!baseUrl || !token) {
    return {
      configured: false,
      error: false,
      data: [],
      pagination: null,
      summary: null,
    };
  }

  const params = new URLSearchParams({
    page: String(input.page),
    limit: "20",
  });
  if (input.status) params.set("status", input.status);
  if (input.verdict) params.set("verdict", input.verdict);
  if (input.reviewStatus) params.set("reviewStatus", input.reviewStatus);
  if (input.search) params.set("search", input.search);

  try {
    const response = await fetch(`${baseUrl}/v1/withdrawals?${params}`, {
      headers: await monitorHeaders(token),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Monitor API returned ${response.status}`);
    }
    const payload = responseSchema.parse(await response.json());
    return { configured: true, error: false, ...payload };
  } catch (error) {
    console.error("[antifraud-withdrawals] list failed:", error);
    return {
      configured: true,
      error: true,
      data: [],
      pagination: null,
      summary: null,
    };
  }
}

export async function getWithdrawalAssessment(withdrawalId: string): Promise<{
  configured: boolean;
  notFound: boolean;
  error: boolean;
  data: WithdrawalDetail | null;
}> {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_TOKEN;
  if (!baseUrl || !token) {
    return { configured: false, notFound: false, error: false, data: null };
  }
  try {
    const response = await fetch(
      `${baseUrl}/v1/withdrawals/${encodeURIComponent(withdrawalId)}`,
      {
        headers: await monitorHeaders(token),
        cache: "no-store",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );
    if (response.status === 404) {
      return { configured: true, notFound: true, error: false, data: null };
    }
    if (!response.ok) {
      throw new Error(`Monitor API returned ${response.status}`);
    }
    const payload = detailResponseSchema.parse(await response.json());
    return {
      configured: true,
      notFound: false,
      error: false,
      data: payload.data,
    };
  } catch (error) {
    console.error("[antifraud-withdrawals] detail failed:", error);
    return { configured: true, notFound: false, error: true, data: null };
  }
}

export async function updateWithdrawalReview(input: {
  withdrawalId: string;
  action: WithdrawalReviewAction;
  actorId: string;
  actorUsername?: string;
  note?: string;
  expectedStatus: WithdrawalReviewStatus;
  idempotencyKey: string;
}): Promise<void> {
  const baseUrl = process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, "");
  const token = process.env.ANTIFRAUD_MONITOR_API_ADMIN_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("The Antifraud monitor service is not configured.");
  }
  const response = await fetch(
    `${baseUrl}/v1/withdrawals/${encodeURIComponent(input.withdrawalId)}/review`,
    {
      method: "POST",
      headers: {
        ...(await monitorHeaders(token)),
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
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
  );
  if (response.status === 409) {
    throw new Error(
      "Someone else changed this withdrawal review. Refresh and try again.",
    );
  }
  if (!response.ok) {
    throw new Error("The withdrawal review could not be updated.");
  }
}
