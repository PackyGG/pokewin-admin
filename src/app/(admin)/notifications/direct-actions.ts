"use server";

import { eq, ilike, or } from "drizzle-orm";

import { getReadDrizzleDb } from "@/lib/db";
import { user } from "@/lib/db-schema/main/schema";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import type { DbEnv } from "@/lib/db-env";
import { BackendApiError } from "@/lib/backend-api/errors";
import { getDirectNotificationAvailability } from "@/lib/backend-api/user-notifications-availability";
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
 * Hard env gate. Resolves the env the request would ACTUALLY go to rather
 * than the `admin_db_env` cookie — see the note in
 * `@/lib/backend-api/user-notifications-availability`: the cookie is run
 * through a fallback that can resolve "dev" to the prod backend when no dev
 * backend is configured, so gating on the cookie would not have held.
 *
 * Returns an operator-facing reason, or null when the send may proceed.
 */
async function requireSendableBackend(): Promise<
  { error: string } | { env: DbEnv }
> {
  const availability = await getDirectNotificationAvailability();
  if (!availability.ready || !availability.backendEnv) {
    return { error: availability.reason ?? "Sending is not available." };
  }
  return { env: availability.backendEnv };
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
  const target = await requireSendableBackend();
  if ("error" in target) return { success: false, error: target.error };

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
      // Which site actually received it — the admin dash can be pointed at
      // either backend, and the history table is read from the admin DB in
      // both, so without this a dev send is indistinguishable from a prod one.
      env: target.env,
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
  const target = await requireSendableBackend();
  if ("error" in target) return { success: false, error: target.error };

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
      env: target.env,
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
      // One representative item so the history can answer "what did I
      // actually send?" without storing 1000 payloads per chunk.
      sampleItem: items[0] ?? null,
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
 * User search for the recipient picker. MAIN DB, SELECT only.
 *
 * Matches username, email, an EXACT id, or an id PREFIX — a better-auth id is
 * 32 opaque characters, so pasting a partial one (or the first chunk of a
 * spreadsheet cell) has to resolve, otherwise the operator is left retyping a
 * random string. Exact id stays first so a full paste is an index hit.
 *
 * Read shape: bounded `findMany` with `take: 10` over `users`, the same shape
 * the /vouchers picker already uses on this table. The `contains` / prefix
 * legs are a sequential scan, which is optimal here — the table is ~16.5k
 * rows and any index would be ignored for a leading-wildcard match at that
 * size. Nothing about this is unbounded: worst case is one small scan capped
 * at 10 returned rows, behind a capability gate, fired only while the picker
 * popover is open.
 */
export async function searchNotificationUsers(
  query: string,
): Promise<NotificationUserOption[]> {
  await authorize();

  const q = query.trim();
  if (q.length < 2) return [];

  const conditions = [
    eq(user.id, q),
    ilike(user.username, `%${q}%`),
    ilike(user.email, `%${q}%`),
  ];
  // Prefix matching only past 4 characters — below that nearly every id in
  // the table would match and the 10-row cap would return noise.
  if (q.length >= 4) conditions.push(ilike(user.id, `${q}%`));

  const db = await getReadDrizzleDb();
  const users = await db
    .select({ id: user.id, username: user.username, email: user.email })
    .from(user)
    .where(or(...conditions))
    .limit(10);

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
  }));
}
