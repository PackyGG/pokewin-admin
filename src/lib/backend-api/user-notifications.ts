import "server-only";

import { backendApi } from "./client";
import type {
  BulkNotificationItem,
  NotificationPayload,
  UserNotificationCategory,
} from "@/lib/user-notification";

/**
 * Per-user notification admin API — the PERSONAL feed, one row per recipient
 * with its own payload. Distinct from `./announcements`, which writes one
 * shared row read by everyone and therefore cannot carry per-user content.
 *
 * Source of truth (request/response shapes):
 *   packy-backend `src/routes/v1/admin/notifications.ts` (PackyGG/backend#461)
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are `/admin/...`.
 * Errors surface as BackendApiError / BackendNetworkError.
 *
 * NOTE on retries: the shared client retries GETs only — a POST gets exactly
 * one attempt. That is the right default here: replaying is safe thanks to
 * `dedupe_key`, but the DECISION to replay belongs to the operator, who needs
 * to see `created` vs `deduped` for the chunk either way.
 */

export type SendUserNotificationInput = {
  user_id: string;
  category: UserNotificationCategory;
  type: string;
  payload?: NotificationPayload;
  dedupe_key?: string;
};

/**
 * Single-user send. A 200 means "valid request, user exists" — NOT "row
 * inserted": this goes through the backend's fire-and-forget `notify()` path,
 * which cannot report created-vs-deduped. Use the bulk endpoint with one item
 * when exact accounting matters. An unknown `user_id` is an explicit 404.
 */
export const sendUserNotification = (input: SendUserNotificationInput) =>
  backendApi.post<{ success: boolean; message?: string }>(
    "/admin/notifications",
    input,
    // Above the client's 8s default: a single notify() is quick, but the
    // operator would rather wait than see a spurious timeout on a send.
    { timeoutMs: 20_000 },
  );

export type SendBulkNotificationsInput = {
  category: UserNotificationCategory;
  type: string;
  items: BulkNotificationItem[];
};

export type BulkNotificationResult = {
  /** Items in the request, including any duplicate ids. */
  requested: number;
  /** Rows actually inserted. */
  created: number;
  /** Skipped because `(user_id, dedupe_key)` already existed — the replay
   * case, and entirely normal on a retry. */
  deduped: number;
  /** DISTINCT ids that don't exist and were dropped. The call still succeeds.
   * Because this list is de-duplicated, the three numbers do NOT sum to
   * `requested` when the same id was sent twice. */
  unknown_users: string[];
};

/**
 * Bulk send — up to 1000 items, each with its own payload and a REQUIRED
 * `dedupe_key`. One multi-row INSERT server-side, so chunks are sent
 * sequentially by the caller rather than in parallel.
 */
export const sendBulkNotifications = (input: SendBulkNotificationsInput) =>
  backendApi
    .post<{ success: boolean; data: BulkNotificationResult }>(
      "/admin/notifications/bulk",
      input,
      // A 1000-row INSERT is well inside this; the generous ceiling exists so
      // a slow chunk fails visibly rather than aborting mid-write, which would
      // leave the operator unsure whether to retry (it is always safe to).
      { timeoutMs: 60_000 },
    )
    .then((r) => r.data);
