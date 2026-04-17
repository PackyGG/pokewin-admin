import { adminDb } from "@/lib/admin-db";
import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { EXCLUDE_STAFF_USER_RELATION } from "./_exclude-staff";

/**
 * Notification configs + pending-event lookups used by the
 * /notifications settings page and the /api/cron/notifications endpoint.
 *
 * Two-DB split:
 *   - Configs live in `adminDb.notification_configs` (admin-only state).
 *   - Actual events (deposits, withdrawals, signups) come from the main
 *     `db` tables — we never read user data through adminDb.
 *
 * Cursor semantics are per-event-type:
 *   - deposit / withdrawal: cursor = last seen ledger_transactions.id (uuid).
 *     Ledger ids are uuids so they don't sort chronologically; we compare by
 *     created_at but remember the exact timestamp + id to avoid re-emitting
 *     rows that share a millisecond tick with the last one we sent.
 *   - signup: cursor = last seen user.created_at (ISO timestamp). User ids
 *     aren't uuids, so we fall back to strict timestamp compare.
 *
 * Pre-migration fallback: every `notification_configs` touch is wrapped in
 * a try/catch that recognises Postgres "relation does not exist" / Prisma
 * P2021 and returns a safe default instead of crashing the admin UI.
 */

export type NotificationEvent = "deposit" | "withdrawal" | "signup";

export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
  "deposit",
  "withdrawal",
  "signup",
] as const;

export type NotificationConfig = {
  eventType: NotificationEvent;
  enabled: boolean;
  botToken: string | null;
  chatId: string | null;
  cursor: string | null;
  updatedAt: Date;
};

export type NotificationConfigSummary = {
  eventType: NotificationEvent;
  enabled: boolean;
  hasToken: boolean;
  hasChatId: boolean;
  updatedAt: Date;
};

export type PendingEvent = {
  /** Unique id used to advance the cursor (ledger id / user id). */
  id: string;
  createdAt: Date;
  userId: string;
  username: string | null;
  /** USD amount; 0 for signup events. */
  amountUsd: number;
  extra?: Record<string, string>;
};

/** Custom error raised when the table isn't migrated yet. */
export class NotificationConfigsTableMissingError extends Error {
  constructor() {
    super(
      "notification_configs table is not yet available. Run the migration " +
        "at prisma/admin/migrations/20260418000001_notification_configs/ on the admin DB.",
    );
    this.name = "NotificationConfigsTableMissingError";
  }
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("notification_configs") &&
    (msg.includes("does not exist") ||
      msg.includes("UndefinedTable") ||
      msg.includes("P2021") ||
      msg.includes("ColumnNotFound"))
  );
}

function isValidEvent(value: string): value is NotificationEvent {
  return (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Config CRUD
// ---------------------------------------------------------------------------

/**
 * Returns the full config for an event type, including the secret token.
 * Returns `null` if the table isn't migrated yet — callers can show a
 * pre-migration banner. Intended for server-side use only (never ship
 * the token to the client).
 */
export async function getNotificationConfig(
  eventType: NotificationEvent,
): Promise<NotificationConfig | null> {
  try {
    const row = await adminDb.notification_configs.findUnique({
      where: { event_type: eventType },
    });
    if (!row) return null;
    return {
      eventType: row.event_type as NotificationEvent,
      enabled: row.enabled,
      botToken: row.bot_token,
      chatId: row.chat_id,
      cursor: row.cursor,
      updatedAt: row.updated_at,
    };
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
}

/**
 * Returns a sanitised summary of every event type's config. The raw bot
 * token is intentionally NOT returned — only a `hasToken` boolean — so
 * this function is safe to call from server components that render a
 * page shell for the client.
 *
 * Returns `null` if the table isn't migrated so the page can render a
 * "run the migration" banner instead of crashing.
 */
export async function getAllNotificationConfigs(): Promise<
  NotificationConfigSummary[] | null
> {
  try {
    const rows = await adminDb.notification_configs.findMany({
      orderBy: { event_type: "asc" },
    });
    const byType = new Map<NotificationEvent, NotificationConfigSummary>();
    for (const row of rows) {
      if (!isValidEvent(row.event_type)) continue;
      byType.set(row.event_type, {
        eventType: row.event_type,
        enabled: row.enabled,
        hasToken: row.bot_token !== null && row.bot_token.length > 0,
        hasChatId: row.chat_id !== null && row.chat_id.length > 0,
        updatedAt: row.updated_at,
      });
    }
    // Ensure every known event type has a row even if the seed was skipped.
    return NOTIFICATION_EVENTS.map(
      (ev) =>
        byType.get(ev) ?? {
          eventType: ev,
          enabled: false,
          hasToken: false,
          hasChatId: false,
          updatedAt: new Date(0),
        },
    );
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
}

type SaveNotificationConfigInput = {
  eventType: NotificationEvent;
  enabled: boolean;
  /** `null` clears, `undefined` leaves untouched. */
  botToken?: string | null;
  /** `null` clears, `undefined` leaves untouched. */
  chatId?: string | null;
  updatedBy: string;
};

/**
 * Upserts a config row. Treats `undefined` on `botToken` / `chatId` as
 * "don't touch" so the UI can toggle `enabled` without clobbering a
 * previously saved secret.
 *
 * Throws `NotificationConfigsTableMissingError` when the table is absent.
 */
export async function saveNotificationConfig(
  input: SaveNotificationConfigInput,
): Promise<void> {
  const data: {
    enabled: boolean;
    bot_token?: string | null;
    chat_id?: string | null;
    updated_by: string;
  } = {
    enabled: input.enabled,
    updated_by: input.updatedBy,
  };
  if (input.botToken !== undefined) data.bot_token = input.botToken;
  if (input.chatId !== undefined) data.chat_id = input.chatId;

  try {
    await adminDb.notification_configs.upsert({
      where: { event_type: input.eventType },
      update: data,
      create: {
        event_type: input.eventType,
        enabled: data.enabled,
        bot_token: data.bot_token ?? null,
        chat_id: data.chat_id ?? null,
        updated_by: data.updated_by,
      },
    });
  } catch (err) {
    if (isMissingTableError(err)) {
      throw new NotificationConfigsTableMissingError();
    }
    throw err;
  }
}

/**
 * Persists the new cursor after a successful cron tick. Stored as a
 * stringified Date for signups and as the ledger id for deposits /
 * withdrawals — the format is opaque to the caller, only `fetchPendingEvents`
 * and `advanceCursor` need to agree on it.
 */
export async function advanceCursor(
  eventType: NotificationEvent,
  newCursor: string,
): Promise<void> {
  try {
    await adminDb.notification_configs.update({
      where: { event_type: eventType },
      data: { cursor: newCursor },
    });
  } catch (err) {
    if (isMissingTableError(err)) {
      throw new NotificationConfigsTableMissingError();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pending-event queries (main DB)
// ---------------------------------------------------------------------------

const MAX_BATCH_SIZE = 100;

/**
 * Fetch the next `limit` events since the last cursor. All sources hit
 * the main DB — configs stay in adminDb but events live where the real
 * users / transactions do.
 *
 * Staff users are excluded so internal test traffic doesn't trigger
 * notifications — same rule the rest of the dashboard follows.
 */
export async function fetchPendingEvents(
  eventType: NotificationEvent,
  cursor: string | null,
  limit: number,
): Promise<PendingEvent[]> {
  const capped = Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(limit)));

  if (eventType === "signup") {
    return fetchPendingSignups(cursor, capped);
  }

  const ledgerType =
    eventType === "deposit" ? "deposit" : "card_withdrawal";
  return fetchPendingLedger(ledgerType, cursor, capped);
}

async function fetchPendingLedger(
  ledgerType: "deposit" | "card_withdrawal",
  cursor: string | null,
  limit: number,
): Promise<PendingEvent[]> {
  // Ledger ids are uuids so we can't order by id. Cursor is an ISO
  // timestamp of the last-seen created_at; use strict gt so we never
  // re-send a row we already emitted. Ties on created_at are handled
  // by the secondary sort on id — the cron emits in ascending order,
  // so on the next tick cursor is the maximum we saw and any row
  // with that same timestamp has been flushed already.
  const since = cursor ? new Date(cursor) : null;

  const rows = await db.ledger_transactions.findMany({
    where: {
      type: ledgerType,
      status: "completed",
      ...(since && !Number.isNaN(since.getTime())
        ? { created_at: { gt: since } }
        : {}),
      user: EXCLUDE_STAFF_USER_RELATION,
    },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
    take: limit,
    include: {
      user: {
        select: {
          username: true,
          email: true,
          country_code: true,
        },
      },
    },
  });

  return rows.map((r) => {
    // Withdrawal amounts are stored negative (ledger sign convention).
    // Absolute the value so the Telegram message shows a positive USD
    // figure — the event type itself carries the direction.
    const amountUsd = Math.abs(toNumber(r.amount));
    const extra: Record<string, string> = {};
    if (r.crypto_asset) extra.crypto_asset = r.crypto_asset;
    if (r.user?.country_code) extra.country_code = r.user.country_code;
    return {
      id: r.id,
      createdAt: r.created_at,
      userId: r.user_id,
      username: r.user?.username ?? r.user?.email ?? null,
      amountUsd,
      extra,
    };
  });
}

async function fetchPendingSignups(
  cursor: string | null,
  limit: number,
): Promise<PendingEvent[]> {
  const since = cursor ? new Date(cursor) : null;

  const rows = await db.user.findMany({
    where: {
      role: { notIn: ["admin", "creator"] },
      ...(since && !Number.isNaN(since.getTime())
        ? { created_at: { gt: since } }
        : {}),
    },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
    take: limit,
    select: {
      id: true,
      username: true,
      email: true,
      country_code: true,
      created_at: true,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    userId: r.id,
    username: r.username ?? r.email ?? null,
    amountUsd: 0,
    extra: r.country_code ? { country_code: r.country_code } : undefined,
  }));
}
