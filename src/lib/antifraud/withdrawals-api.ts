import "server-only";

import { z } from "zod";

const numeric = z.union([z.number(), z.string()]).transform(Number);

const signalSchema = z.object({
  key: z.string(),
  label: z.string(),
  detail: z.string(),
  points: z.number(),
  tone: z.enum(["good", "neutral", "warning", "bad"]),
});

const flowSchema = z.object({
  depositsUsd: z.number(),
  gameWinsUsd: z.number(),
  gameLossesUsd: z.number(),
  rewardsUsd: z.number(),
  withdrawalUsd: z.number(),
  gameEvents: z.number(),
  minutesSinceLastDeposit: z.number().nullable(),
  accountAgeDays: z.number(),
  tracedAssetUsd: z.number(),
  untracedAssetUsd: z.number(),
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
  assessed_at: z.string(),
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
    amount_usd: numeric,
  }),
});

export type WithdrawalAssessment = z.infer<typeof withdrawalSchema>;
export type WithdrawalVerdict = WithdrawalAssessment["verdict"];

const UPSTREAM_TIMEOUT_MS = 12_000;

export async function listWithdrawalAssessments(input: {
  page: number;
  status?: string;
  verdict?: WithdrawalVerdict;
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
  if (input.search) params.set("search", input.search);

  try {
    const response = await fetch(`${baseUrl}/v1/withdrawals?${params}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
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
