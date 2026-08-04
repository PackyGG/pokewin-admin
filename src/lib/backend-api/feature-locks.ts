import "server-only";

import { z } from "zod";

import {
  REWARD_LOCK_CATEGORIES,
  type RewardLockCategory,
} from "@/lib/contracts/reward-locks";

import { backendApi } from "./client";

/**
 * Fraud-signal deposit + withdrawal locks, applied by the game backend when
 * a card deposit is refunded or disputed (VersolitePayWebhookService.
 * handleRefund/handleDispute). Distinct from the admin panel's own manual
 * per-feature toggle switches (inventory sales / exchanges / openings /
 * vault, written directly to the main DB via Drizzle) — these two fields are
 * backend-owned and can only be read/cleared through this API.
 *
 * Source of truth (request/response shapes):
 *   PackyGG/backend/src/routes/v1/admin/user-feature-locks.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are
 * `/admin/...`. Errors surface as BackendApiError (`.status`,
 * `.isNotFound`) / BackendNetworkError — callers degrade gracefully.
 */
const RewardLockCategorySchema = z.enum(REWARD_LOCK_CATEGORIES);

export type { RewardLockCategory } from "@/lib/contracts/reward-locks";

const UserFeatureLocksSchema = z.object({
  user_id: z.string().min(1),
  fiat_deposits_enabled: z.boolean(),
  fiat_deposit_auto_approval_enabled: z.boolean(),
  locked_deposits_crypto: z.array(z.string()),
  locked_deposits_fiat: z.array(z.string()),
  locked_deposits_at: z.string().nullable(),
  locked_deposits_reason: z.string().nullable(),
  locked_withdrawals_crypto: z.array(z.string()),
  locked_withdrawals_items: z.boolean(),
  locked_withdrawals_at: z.string().nullable(),
  locked_withdrawals_reason: z.string().nullable(),
  locked_inventory_sales: z.boolean(),
  locked_exchanges: z.boolean(),
  locked_openings: z.boolean(),
  locked_vault: z.boolean(),
  locked_reward_categories: z.array(RewardLockCategorySchema),
  available_reward_categories: z.array(RewardLockCategorySchema),
  locked_rewards_at: z.string().nullable(),
  locked_rewards_by: z.string().nullable(),
  locked_rewards_reason: z.string().nullable(),
});

const FeatureLocksResponseSchema = z.object({
  success: z.literal(true),
  data: UserFeatureLocksSchema,
});

const FiatAutoApprovalResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    user_id: z.string().min(1),
    enabled: z.boolean(),
  }),
});

export type UserFeatureLocks = z.infer<typeof UserFeatureLocksSchema>;
export type FiatDepositAutoApproval = z.infer<
  typeof FiatAutoApprovalResponseSchema
>["data"];

function parseFeatureLocks(
  response: unknown,
  requestedUserId: string,
): UserFeatureLocks {
  const parsed = FeatureLocksResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.data.user_id !== requestedUserId) {
    throw new Error("Backend returned an invalid feature-lock response");
  }
  return parsed.data.data;
}

function parseFiatAutoApproval(
  response: unknown,
  requestedUserId: string,
): FiatDepositAutoApproval {
  const parsed = FiatAutoApprovalResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.data.user_id !== requestedUserId) {
    throw new Error(
      "Backend returned an invalid Fiat auto-approval response",
    );
  }
  return parsed.data.data;
}

export const getUserFeatureLocks = (userId: string) =>
  backendApi
    .get<unknown>(
      `/admin/users/${encodeURIComponent(userId)}/feature-locks`,
    )
    .then((response) => parseFeatureLocks(response, userId));

export const updateUserRewardLocks = (
  userId: string,
  categories: RewardLockCategory[],
  adminUserId?: string,
  reason: string | null = null,
) =>
  backendApi
    .put<unknown>(
      `/admin/users/${encodeURIComponent(userId)}/rewards-lock`,
      { categories, reason },
      adminUserId ? { headers: { "x-admin-user-id": adminUserId } } : {},
    )
    .then((response) => parseFeatureLocks(response, userId));

export const updateUserFiatDepositAutoApproval = (
  userId: string,
  enabled: boolean,
  adminUserId?: string,
) =>
  backendApi
    .put<unknown>(
      `/admin/users/${encodeURIComponent(userId)}/fiat-deposit-auto-approval`,
      { enabled },
      adminUserId ? { headers: { "x-admin-user-id": adminUserId } } : {},
    )
    .then((response) => parseFiatAutoApproval(response, userId));

/**
 * Clear the fraud-signal deposit + withdrawal locks. Does not touch the
 * unrelated inventory-sales / exchanges / openings / vault locks.
 * `adminUserId` is forwarded as `x-admin-user-id` for the backend's own log
 * line — it's advisory only, the panel's own audit event is authoritative.
 */
export const clearUserFraudLocks = (userId: string, adminUserId?: string) =>
  backendApi
    .post<unknown>(
      `/admin/users/${encodeURIComponent(userId)}/feature-locks/clear`,
      {},
      adminUserId ? { headers: { "x-admin-user-id": adminUserId } } : {},
    )
    .then((response) => parseFeatureLocks(response, userId));
