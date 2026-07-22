"use server";

import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { readDbEnvFromCookie } from "@/lib/db-env";
import { BackendApiError } from "@/lib/backend-api/errors";
import {
  sendBulkNotifications,
  sendUserNotification,
  type BulkNotificationResult,
} from "@/lib/backend-api/user-notifications";
import {
  BULK_MAX_ITEMS,
  isUserNotificationCategory,
  jsonByteSize,
  validateDedupeKey,
  validateNotificationPayload,
  validateNotificationType,
  type BulkNotificationItem,
  type NotificationPayload,
  type UserNotificationCategory,
} from "@/lib/user-notification";

/**
 * Server actions behind the "Direct" tab of /notifications — the per-user
 * notification endpoints (PackyGG/backend#461).
 *
 * Every action re-runs the same validation the composer already ran. The
 * client checks are there to keep a bad value inside the form; these are the
 * real boundary (a client can call a server action directly).
 *
 * Gates, in order:
 *   1. page access to /notifications
 *   2. `__can_send_user_notifications` — deliberately its own capability, not
 *      `__can_manage_announcements`: a bulk personal send writes one row per
 *      recipient and can carry per-user money-adjacent content (promo codes),
 *      which is a different blast radius from a single broadcast row.
 *   3. dev environment only (see requireDevEnv)
 */

const PAGE_KEY = "/notifications";
const CAPABILITY = "__can_send_user_notifications";

export type DirectSendResult =
  | { success: true; message: string }
  | { success: false; error: string; notFound?: boolean };

export type BulkChunkResult =
  | { success: true; result: BulkNotificationResult }
  | { success: false; error: string; status?: number };

/**
 * Per-user notification sends are restricted to the DEV backend for now
 * (owner directive, 2026-07-22 — "this is for dev db and site only atm").
 * The backend endpoints are merged to `dev`; prod hasn't taken them yet, and
 * a real send reaches real users' feeds.
 *
 * The env comes from the `admin_db_env` cookie, which the header toggle sets
 * and which `backendApi` already uses to pick the base URL + admin key — so
 * this gate and the request target can never disagree. Same shape as the
 * /test/creator tools' `requireDevEnv`. Lifting the restriction is one
 * constant away once the endpoints ship to prod.
 */
const DEV_ENV_ONLY = true;

async function requireDevEnv(): Promise<string | null> {
  if (!DEV_ENV_ONLY) return null;
  const env = await readDbEnvFromCookie();
  if (env !== "dev") {
    return "Direct notifications are dev-only right now. Switch the environment toggle in the header to DEV before sending.";
  }
  return null;
}

async function authorize() {
  const session = await requirePageAccess(PAGE_KEY);
  await requireCapability(session, CAPABILITY, "send user notifications");
  return session;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof BackendApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unknown error";
}

// ── Single send ─────────────────────────────────────────────────────────

export type SendDirectNotificationInput = {
  userId: string;
  category: UserNotificationCategory;
  type: string;
  /** Already-parsed object from the composer's JSON editor. */
  payload?: NotificationPayload;
  dedupeKey?: string;
};

export async function sendDirectNotificationAction(
  input: SendDirectNotificationInput,
): Promise<DirectSendResult> {
  const session = await authorize();
  const envError = await requireDevEnv();
  if (envError) return { success: false, error: envError };

  const userId = input.userId.trim();
  if (!userId) return { success: false, error: "User id is required" };

  if (!isUserNotificationCategory(input.category)) {
    return { success: false, error: "Category must be rewards or system" };
  }

  const type = input.type.trim();
  const typeError = validateNotificationType(type);
  if (typeError) return { success: false, error: typeError };

  const payloadCheck = validateNotificationPayload(input.payload);
  if (!payloadCheck.ok) return { success: false, error: payloadCheck.error };

  // Optional here (unlike bulk) — but when set it still has to be in range.
  const dedupeKey = input.dedupeKey?.trim() || undefined;
  if (dedupeKey) {
    const keyError = validateDedupeKey(dedupeKey);
    if (keyError) return { success: false, error: keyError };
  }

  try {
    await sendUserNotification({
      user_id: userId,
      category: input.category,
      type,
      ...(payloadCheck.payload ? { payload: payloadCheck.payload } : {}),
      ...(dedupeKey ? { dedupe_key: dedupeKey } : {}),
    });
  } catch (err) {
    // The backend checks the user explicitly, so 404 is unambiguous: the id
    // doesn't exist. Surface that as its own state rather than a generic fail.
    if (err instanceof BackendApiError && err.status === 404) {
      return {
        success: false,
        notFound: true,
        error: `No user with id "${userId}" exists on this environment.`,
      };
    }
    return { success: false, error: toErrorMessage(err) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_notification_sent",
    targetUserId: userId,
    metadata: {
      category: input.category,
      type,
      dedupeKey: dedupeKey ?? null,
      payload: payloadCheck.payload ?? null,
    },
  });

  return {
    success: true,
    // Deliberately not "delivered": the single endpoint rides the
    // fire-and-forget notify() path and cannot report created-vs-deduped.
    message:
      "Accepted — the user exists and the request was valid. This endpoint can't report created vs deduped; use a 1-item bulk send for exact accounting.",
  };
}

// ── Bulk send (one chunk per call) ──────────────────────────────────────

export type SendBulkChunkInput = {
  category: UserNotificationCategory;
  type: string;
  items: BulkNotificationItem[];
  /** Campaign slug the dedupe keys were derived from — audit context only. */
  campaign: string;
  /** 0-based, for the audit trail of a multi-chunk campaign. */
  chunkIndex: number;
  chunkCount: number;
};

/**
 * Sends ONE chunk. The client drives the sequence so progress is live and a
 * long campaign can't blow a single server-action budget — 17 chunks for the
 * ~16.5k-user case. Chunks go one at a time by design: each is one multi-row
 * INSERT server-side and there is no reason to stampede it.
 *
 * Safe to retry verbatim on failure — `(user_id, dedupe_key)` is backed by a
 * partial unique index, so already-delivered items come back as `deduped`.
 */
export async function sendBulkNotificationChunkAction(
  input: SendBulkChunkInput,
): Promise<BulkChunkResult> {
  const session = await authorize();
  const envError = await requireDevEnv();
  if (envError) return { success: false, error: envError };

  if (!isUserNotificationCategory(input.category)) {
    return { success: false, error: "Category must be rewards or system" };
  }

  const type = input.type.trim();
  const typeError = validateNotificationType(type);
  if (typeError) return { success: false, error: typeError };

  const items = input.items;
  if (!Array.isArray(items) || items.length === 0) {
    return { success: false, error: "Chunk is empty" };
  }
  if (items.length > BULK_MAX_ITEMS) {
    return {
      success: false,
      error: `Chunk has ${items.length} items — the limit is ${BULK_MAX_ITEMS}`,
    };
  }

  for (const item of items) {
    if (!item?.user_id?.trim()) {
      return { success: false, error: "Every item needs a user_id" };
    }
    const keyError = validateDedupeKey(item.dedupe_key ?? "");
    if (keyError) return { success: false, error: `${item.user_id}: ${keyError}` };
    const payloadCheck = validateNotificationPayload(item.payload);
    if (!payloadCheck.ok) {
      return { success: false, error: `${item.user_id}: ${payloadCheck.error}` };
    }
  }

  const body = { category: input.category, type, items };
  const bodyBytes = jsonByteSize(body);

  let result: BulkNotificationResult;
  try {
    result = await sendBulkNotifications(body);
  } catch (err) {
    if (err instanceof BackendApiError) {
      // 413 means the byte cap bound before the item cap — actionable advice
      // beats a bare status code.
      if (err.status === 413) {
        return {
          success: false,
          status: 413,
          error: `Chunk body was ${bodyBytes} bytes and the backend rejected it as too large. Lower the chunk size and retry — retrying is safe.`,
        };
      }
      return { success: false, status: err.status, error: err.message };
    }
    return { success: false, error: toErrorMessage(err) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_notifications_bulk_sent",
    metadata: {
      campaign: input.campaign,
      category: input.category,
      type,
      chunkIndex: input.chunkIndex,
      chunkCount: input.chunkCount,
      requested: result.requested,
      created: result.created,
      deduped: result.deduped,
      unknownUsers: result.unknown_users,
      bodyBytes,
    },
  });

  return { success: true, result };
}

// ── Recipient lookup ────────────────────────────────────────────────────

export type NotificationUserOption = {
  id: string;
  username: string | null;
  email: string | null;
};

/**
 * User search for the recipient picker — the same bounded, index-served
 * lookup shape the /vouchers picker uses (username / email prefix-contains or
 * exact id, capped at 10 rows). MAIN DB, SELECT only.
 */
export async function searchNotificationUsers(
  query: string,
): Promise<NotificationUserOption[]> {
  await authorize();

  const q = query.trim();
  if (q.length < 2) return [];

  const db = await getDb();
  const users = await db.user.findMany({
    where: {
      OR: [
        { username: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { id: q },
      ],
    },
    select: { id: true, username: true, email: true },
    take: 10,
  });

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
  }));
}
