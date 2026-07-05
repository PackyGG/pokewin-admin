import "server-only";

import { backendApi } from "./client";

/**
 * Fraud-signal deposit + withdrawal locks, applied by the game backend when
 * a card deposit is refunded or disputed (VersolitePayWebhookService.
 * handleRefund/handleDispute). Distinct from the admin panel's own manual
 * per-feature toggle switches (inventory sales / exchanges / openings /
 * vault, written directly to the main DB via Prisma) — these two fields are
 * backend-owned and can only be read/cleared through this API.
 *
 * Source of truth (request/response shapes):
 *   PackyGG/backend/src/routes/v1/admin/user-feature-locks.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are
 * `/admin/...`. Errors surface as BackendApiError (`.status`,
 * `.isNotFound`) / BackendNetworkError — callers degrade gracefully.
 */
export type UserFeatureLocks = {
  user_id: string;
  locked_deposits_crypto: string[];
  locked_deposits_fiat: string[];
  locked_deposits_at: string | null;
  locked_deposits_reason: string | null;
  locked_withdrawals_crypto: string[];
  locked_withdrawals_items: boolean;
  locked_withdrawals_at: string | null;
  locked_withdrawals_reason: string | null;
  locked_inventory_sales: boolean;
  locked_exchanges: boolean;
  locked_openings: boolean;
  locked_vault: boolean;
};

type Success<T> = { success: boolean; data: T };

export const getUserFeatureLocks = (userId: string) =>
  backendApi
    .get<Success<UserFeatureLocks>>(
      `/admin/users/${encodeURIComponent(userId)}/feature-locks`,
    )
    .then((r) => r.data);

/**
 * Clear the fraud-signal deposit + withdrawal locks. Does not touch the
 * unrelated inventory-sales / exchanges / openings / vault locks.
 * `adminUserId` is forwarded as `x-admin-user-id` for the backend's own log
 * line — it's advisory only, the panel's own audit event is authoritative.
 */
export const clearUserFraudLocks = (userId: string, adminUserId?: string) =>
  backendApi
    .post<Success<UserFeatureLocks>>(
      `/admin/users/${encodeURIComponent(userId)}/feature-locks/clear`,
      {},
      adminUserId ? { headers: { "x-admin-user-id": adminUserId } } : {},
    )
    .then((r) => r.data);
