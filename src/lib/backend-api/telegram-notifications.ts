import "server-only";

import { backendApi } from "./client";

/**
 * Telegram admin-notification settings API.
 *
 * Two knobs for the admin-chat alerts the game backend sends:
 *  - `depositMinUsd` — deposits below this USD value are still credited
 *    normally, they just don't announce, so the chat isn't flooded by small
 *    deposits. 0 alerts on every deposit.
 *  - `signupNotificationsEnabled` — whether each new user registration
 *    posts an alert.
 *
 * The backend reads both per-call (not cached at construction), so a change
 * here takes effect on the next notification with no restart or redeploy.
 *
 * These live in the MAIN-DB `site_config` table, which this panel must never
 * write directly (MAIN is strictly read-only here) — the write goes through
 * the backend admin API, which owns the table and refreshes its own cache.
 *
 * Source of truth (request/response shapes):
 *   packygg-backend/src/routes/v1/admin/telegram-notifications.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are
 * `/admin/...`. Errors surface as BackendApiError / BackendNetworkError —
 * callers degrade gracefully.
 */

/** Current Telegram notification settings. */
export type TelegramNotificationSettings = {
  /** Minimum deposit USD that triggers a "deposit confirmed" alert. */
  depositMinUsd: number;
  /** Whether new-signup alerts are sent. */
  signupNotificationsEnabled: boolean;
};

/**
 * PUT payload — both fields optional (partial update), but the backend
 * requires at least one. `depositMinUsd` must be >= 0.
 */
export type UpdateTelegramNotificationSettingsInput = {
  depositMinUsd?: number;
  signupNotificationsEnabled?: boolean;
};

type Success<T> = { success: boolean; data: T };

export const getTelegramNotificationSettings = () =>
  backendApi
    .get<Success<TelegramNotificationSettings>>("/admin/telegram-notifications")
    .then((r) => r.data);

export const updateTelegramNotificationSettings = (
  input: UpdateTelegramNotificationSettingsInput,
) =>
  backendApi
    .put<Success<TelegramNotificationSettings>>(
      "/admin/telegram-notifications",
      input,
    )
    .then((r) => r.data);
