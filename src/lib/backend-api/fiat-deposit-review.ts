import "server-only";

import { z } from "zod";

import { backendApi } from "./client";

const FiatDepositAutomaticCreditConfigSchema = z.object({
  fiat_deposit_automatic_credit_enabled: z.boolean(),
});

const ResponseSchema = z.object({
  success: z.literal(true),
  data: FiatDepositAutomaticCreditConfigSchema,
});

const FiatDepositReviewStatusSchema = z.enum([
  "created",
  "checkout_creating",
  "checkout_ready",
  "pending",
  "review",
  "approval_processing",
  "refund_pending",
  "refund_failed",
  "completed",
  "failed",
  "canceled",
  "partially_refunded",
  "refunded",
  "disputed",
]);

const FiatDepositReviewItemSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().min(1),
  provider: z.string().min(1),
  status: FiatDepositReviewStatusSchema,
  currency: z.string().min(1),
  requested_amount_cents: z.number().int(),
  credited_amount_cents: z.number().int(),
  actual_customer_total_cents: z.number().int().nullable(),
  provider_checkout_id: z.string().nullable(),
  provider_payment_id: z.string().nullable(),
  provider_payment_status: z.string().nullable(),
  failure_reason: z.string().nullable(),
  review_requested_at: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  reviewed_by: z.string().nullable(),
  review_decision: z.enum(["approved", "rejected"]).nullable(),
  review_reason: z.string().nullable(),
  paid_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const FiatDepositReviewListResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(FiatDepositReviewItemSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  }),
});

const FiatDepositReviewItemResponseSchema = z.object({
  success: z.literal(true),
  data: FiatDepositReviewItemSchema,
});

export type FiatDepositAutomaticCreditConfig = z.infer<
  typeof FiatDepositAutomaticCreditConfigSchema
>;
type FiatDepositReviewStatus = z.infer<
  typeof FiatDepositReviewStatusSchema
>;
type FiatDepositReviewItem = z.infer<
  typeof FiatDepositReviewItemSchema
>;

function parseResponse(response: unknown): FiatDepositAutomaticCreditConfig {
  const parsed = ResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error(
      "Backend returned an invalid Fiat automatic-credit response",
    );
  }
  return parsed.data.data;
}

export async function getFiatDepositAutomaticCreditConfig(): Promise<FiatDepositAutomaticCreditConfig> {
  const response = await backendApi.get<unknown>("/admin/fiat-deposits/config");
  return parseResponse(response);
}

export async function updateFiatDepositAutomaticCreditConfig(
  enabled: boolean,
  adminUserId?: string,
): Promise<FiatDepositAutomaticCreditConfig> {
  const response = await backendApi.put<unknown>(
    "/admin/fiat-deposits/config",
    { fiat_deposit_automatic_credit_enabled: enabled },
    adminUserId ? { headers: { "x-admin-user-id": adminUserId } } : {},
  );
  return parseResponse(response);
}

async function getFiatDepositReviewQueue(input: {
  status?: FiatDepositReviewStatus;
  limit: number;
  offset: number;
}): Promise<{
  items: FiatDepositReviewItem[];
  total: number;
  limit: number;
  offset: number;
}> {
  const response = await backendApi.get<unknown>("/admin/fiat-deposits", {
    query: input,
  });
  const parsed = FiatDepositReviewListResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error("Backend returned an invalid Fiat review queue response");
  }
  return parsed.data.data;
}

async function getFiatDepositReview(
  intentId: string,
): Promise<FiatDepositReviewItem> {
  const response = await backendApi.get<unknown>(
    `/admin/fiat-deposits/${encodeURIComponent(intentId)}`,
  );
  const parsed = FiatDepositReviewItemResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error("Backend returned an invalid Fiat deposit response");
  }
  return parsed.data.data;
}

async function decideFiatDepositReview(input: {
  intentId: string;
  decision: "approve" | "reject";
  reason: string;
  adminUserId: string;
}): Promise<FiatDepositReviewItem> {
  const response = await backendApi.post<unknown>(
    `/admin/fiat-deposits/${encodeURIComponent(input.intentId)}/decision`,
    { decision: input.decision, reason: input.reason },
    { headers: { "x-admin-user-id": input.adminUserId } },
  );
  const parsed = FiatDepositReviewItemResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error("Backend returned an invalid Fiat review decision response");
  }
  return parsed.data.data;
}
