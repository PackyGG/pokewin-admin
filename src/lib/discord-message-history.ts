import "server-only";

import { sql } from "drizzle-orm";

import { adminDrizzle } from "@/lib/admin-db";
import { logError } from "@/lib/errors/logger";

const CREATOR_MESSAGE_LOG_GUILD_ID = "1402743122789929022";
const VIP_MESSAGE_LOG_GUILD_ID = "1505650386894327919";
const MESSAGE_LOG_GUILD_IDS = new Set([
  CREATOR_MESSAGE_LOG_GUILD_ID,
  VIP_MESSAGE_LOG_GUILD_ID,
]);
type DiscordMessageAttachment = {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size: number | null;
};

export type DiscordMessageEventInput = {
  eventId: string;
  eventType: "create" | "update" | "delete";
  observedAt: string;
  previous?: DiscordMessageState | null;
  message: {
    messageId: string;
    guildId: string;
    channelId: string;
    authorId: string | null;
    authorUsername: string | null;
    authorDisplayName: string | null;
    authorIsBot: boolean | null;
    webhookId: string | null;
    content: string | null;
    createdAt: string;
    editedAt: string | null;
    referencedMessageId: string | null;
    attachments: DiscordMessageAttachment[];
  };
};

type DiscordMessageState = {
  content: string | null;
  attachments: DiscordMessageAttachment[];
};

type DiscordMessageEventRecord = {
  eventId: string;
  eventType: "create" | "update" | "delete";
  messageId: string;
  guildId: string;
  channelId: string;
  authorId: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  createdAt: string;
  observedAt: string;
  before: DiscordMessageState;
  after: DiscordMessageState | null;
};

export type DiscordMessageEventResult =
  | { eventId: string; ignored: true }
  | { eventId: string; ignored: false; record: DiscordMessageEventRecord };

type SnapshotRow = {
  message_id: string;
  guild_id: string;
  channel_id: string;
  author_id: string | null;
  author_username: string | null;
  author_display_name: string | null;
  author_is_bot: boolean | null;
  webhook_id: string | null;
  excluded_from_logging: boolean;
  content: string | null;
  attachments: DiscordMessageAttachment[];
  referenced_message_id: string | null;
  discord_created_at: string | null;
  discord_edited_at: string | null;
  deleted_at: string | null;
  first_observed_at: string;
  last_observed_at: string;
};

type EventRow = {
  event_id: string;
  event_type: "create" | "update" | "delete";
  message_id: string;
  guild_id: string;
  channel_id: string;
  author_id: string | null;
  author_username: string | null;
  author_display_name: string | null;
  before_state: DiscordMessageState;
  after_state: DiscordMessageState | null;
  discord_created_at: string | null;
  observed_at: string;
};

export class DiscordMessageHistoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DiscordMessageHistoryError";
  }
}

function state(
  content: string | null,
  attachments: DiscordMessageAttachment[] | null | undefined,
): DiscordMessageState {
  return { content, attachments: Array.isArray(attachments) ? attachments : [] };
}

function recordFromRow(row: EventRow): DiscordMessageEventRecord {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    messageId: row.message_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    authorId: row.author_id,
    authorUsername: row.author_username,
    authorDisplayName: row.author_display_name,
    createdAt: row.discord_created_at
      ? new Date(row.discord_created_at).toISOString()
      : new Date(row.observed_at).toISOString(),
    observedAt: new Date(row.observed_at).toISOString(),
    before: state(row.before_state?.content ?? null, row.before_state?.attachments),
    after: row.after_state
      ? state(row.after_state.content ?? null, row.after_state.attachments)
      : null,
  };
}

function sameState(left: DiscordMessageState, right: DiscordMessageState): boolean {
  return left.content === right.content
    && JSON.stringify(left.attachments) === JSON.stringify(right.attachments);
}

function idempotencyConflict(row: EventRow, input: DiscordMessageEventInput): boolean {
  return row.event_type !== input.eventType
    || row.message_id !== input.message.messageId
    || row.guild_id !== input.message.guildId
    || row.channel_id !== input.message.channelId;
}

export function isMessageHistoryGuildAllowed(guildId: string): boolean {
  return MESSAGE_LOG_GUILD_IDS.has(guildId);
}

/**
 * Stores a bounded batch in one transaction. Locks are acquired in sorted
 * message-id order before any row work, preventing cross-batch deadlocks.
 */
export async function recordDiscordMessageEvents(
  inputs: DiscordMessageEventInput[],
): Promise<DiscordMessageEventResult[]> {
  try {
    return await adminDrizzle.transaction(async (tx) => {
    const messageIds = [...new Set(inputs.map((input) => input.message.messageId))].sort();
    for (const messageId of messageIds) {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`discord-message-history:${messageId}`}, 0)
        )
      `);
    }

    const results: DiscordMessageEventResult[] = [];
    for (const input of inputs) {
      const existingEventResult = await tx.execute<EventRow>(sql`
        SELECT
          event_id::text,
          event_type,
          message_id,
          guild_id,
          channel_id,
          author_id,
          author_username,
          author_display_name,
          before_state,
          after_state,
          discord_created_at::text,
          observed_at::text
        FROM discord_message_events
        WHERE event_id = ${input.eventId}::uuid
        FOR UPDATE
      `);
      const existingEvent = existingEventResult.rows[0];
      if (existingEvent) {
        if (idempotencyConflict(existingEvent, input)) {
          throw new DiscordMessageHistoryError(
            409,
            "idempotency_conflict",
            "That message event ID is already assigned to another event.",
          );
        }
        results.push({
          eventId: input.eventId,
          ignored: false,
          record: recordFromRow(existingEvent),
        });
        continue;
      }

      const snapshotResult = await tx.execute<SnapshotRow>(sql`
        SELECT
          message_id,
          guild_id,
          channel_id,
          author_id,
          author_username,
          author_display_name,
          author_is_bot,
          webhook_id,
          excluded_from_logging,
          content,
          attachments,
          referenced_message_id,
          discord_created_at::text,
          discord_edited_at::text,
          deleted_at::text,
          first_observed_at::text,
          last_observed_at::text
        FROM discord_message_snapshots
        WHERE message_id = ${input.message.messageId}
        FOR UPDATE
      `);
      const snapshot = snapshotResult.rows[0];
      if (
        snapshot
        && (
          snapshot.guild_id !== input.message.guildId
          || snapshot.channel_id !== input.message.channelId
          || (
            snapshot.author_id !== null
            && input.message.authorId !== null
            && snapshot.author_id !== input.message.authorId
          )
        )
      ) {
        throw new DiscordMessageHistoryError(
          409,
          "message_identity_conflict",
          "That Discord message ID is already assigned to another channel.",
        );
      }

      const authorId = input.message.authorId ?? snapshot?.author_id ?? null;
      const authorIsBot = input.message.authorIsBot ?? snapshot?.author_is_bot ?? null;
      const webhookId = input.message.webhookId ?? snapshot?.webhook_id ?? null;
      const excludedFromLogging = snapshot?.excluded_from_logging === true
        || authorIsBot === true
        || webhookId !== null;
      if (excludedFromLogging) {
        const observedAt = new Date(input.observedAt).toISOString();
        const createdAt = snapshot?.discord_created_at
          ?? new Date(input.message.createdAt).toISOString();
        if (!snapshot) {
          await tx.execute(sql`
            INSERT INTO discord_message_snapshots (
              message_id,
              guild_id,
              channel_id,
              author_id,
              author_username,
              author_display_name,
              author_is_bot,
              webhook_id,
              excluded_from_logging,
              content,
              attachments,
              referenced_message_id,
              discord_created_at,
              discord_edited_at,
              deleted_at,
              first_observed_at,
              last_observed_at
            ) VALUES (
              ${input.message.messageId},
              ${input.message.guildId},
              ${input.message.channelId},
              ${authorId},
              NULL,
              NULL,
              ${authorIsBot},
              ${webhookId},
              true,
              NULL,
              '[]'::jsonb,
              NULL,
              ${createdAt}::timestamptz,
              NULL,
              NULL,
              ${observedAt}::timestamptz,
              ${observedAt}::timestamptz
            )
          `);
        } else {
          await tx.execute(sql`
            UPDATE discord_message_snapshots
            SET
              author_id = COALESCE(${input.message.authorId}, author_id),
              author_is_bot = COALESCE(${input.message.authorIsBot}, author_is_bot),
              webhook_id = COALESCE(${input.message.webhookId}, webhook_id),
              excluded_from_logging = true,
              content = NULL,
              attachments = '[]'::jsonb,
              referenced_message_id = NULL,
              last_observed_at = GREATEST(last_observed_at, ${observedAt}::timestamptz),
              updated_at = now()
            WHERE message_id = ${input.message.messageId}
          `);
        }
        results.push({ eventId: input.eventId, ignored: true });
        continue;
      }
      if (!snapshot && authorId === null) {
        // A partial mutation with no baseline cannot be safely classified. It
        // may belong to an excluded bot/webhook, so fail closed instead
        // of creating an "unknown user" audit record.
        results.push({ eventId: input.eventId, ignored: true });
        continue;
      }
      const currentState = snapshot
        ? state(snapshot.content, snapshot.attachments)
        : state(null, []);
      const suppliedState = state(input.message.content, input.message.attachments);
      if (
        (input.eventType === "create" || input.eventType === "update")
        && snapshot
        && snapshot.deleted_at === null
        && sameState(currentState, suppliedState)
      ) {
        results.push({ eventId: input.eventId, ignored: true });
        continue;
      }
      if (input.eventType === "delete" && snapshot?.deleted_at) {
        results.push({ eventId: input.eventId, ignored: true });
        continue;
      }

      const before = input.eventType === "create"
        ? state(null, [])
        : snapshot
          ? currentState
          : input.previous
            ? state(input.previous.content, input.previous.attachments)
            : suppliedState;
      const after = input.eventType === "delete" ? null : suppliedState;
      const observedAt = new Date(input.observedAt).toISOString();
      const createdAt = snapshot?.discord_created_at
        ?? new Date(input.message.createdAt).toISOString();
      const authorUsername = input.message.authorUsername ?? snapshot?.author_username ?? null;
      const authorDisplayName = input.message.authorDisplayName
        ?? snapshot?.author_display_name
        ?? null;

      await tx.execute(sql`
        INSERT INTO discord_message_events (
          event_id,
          event_type,
          message_id,
          guild_id,
          channel_id,
          author_id,
          author_username,
          author_display_name,
          before_state,
          after_state,
          discord_created_at,
          observed_at
        ) VALUES (
          ${input.eventId}::uuid,
          ${input.eventType},
          ${input.message.messageId},
          ${input.message.guildId},
          ${input.message.channelId},
          ${authorId},
          ${authorUsername},
          ${authorDisplayName},
          ${JSON.stringify(before)}::jsonb,
          ${after ? JSON.stringify(after) : null}::jsonb,
          ${createdAt}::timestamptz,
          ${observedAt}::timestamptz
        )
      `);

      if (!snapshot) {
        await tx.execute(sql`
          INSERT INTO discord_message_snapshots (
            message_id,
            guild_id,
            channel_id,
            author_id,
            author_username,
            author_display_name,
            author_is_bot,
            webhook_id,
            excluded_from_logging,
            content,
            attachments,
            referenced_message_id,
            discord_created_at,
            discord_edited_at,
            deleted_at,
            first_observed_at,
            last_observed_at
          ) VALUES (
            ${input.message.messageId},
            ${input.message.guildId},
            ${input.message.channelId},
            ${authorId},
            ${authorUsername},
            ${authorDisplayName},
            ${authorIsBot},
            ${webhookId},
            false,
            ${input.message.content},
            ${JSON.stringify(input.message.attachments)}::jsonb,
            ${input.message.referencedMessageId},
            ${createdAt}::timestamptz,
            ${input.message.editedAt}::timestamptz,
            ${input.eventType === "delete" ? observedAt : null}::timestamptz,
            ${observedAt}::timestamptz,
            ${observedAt}::timestamptz
          )
        `);
      } else if (Date.parse(observedAt) >= Date.parse(snapshot.last_observed_at)) {
        await tx.execute(sql`
          UPDATE discord_message_snapshots
          SET
            channel_id = ${input.message.channelId},
            author_id = COALESCE(${input.message.authorId}, author_id),
            author_username = COALESCE(${input.message.authorUsername}, author_username),
            author_display_name = COALESCE(
              ${input.message.authorDisplayName},
              author_display_name
            ),
            author_is_bot = COALESCE(${input.message.authorIsBot}, author_is_bot),
            webhook_id = COALESCE(${input.message.webhookId}, webhook_id),
            content = CASE
              WHEN ${input.eventType} = 'delete' THEN content
              ELSE ${input.message.content}
            END,
            attachments = CASE
              WHEN ${input.eventType} = 'delete' THEN attachments
              ELSE ${JSON.stringify(input.message.attachments)}::jsonb
            END,
            referenced_message_id = COALESCE(
              ${input.message.referencedMessageId},
              referenced_message_id
            ),
            discord_edited_at = COALESCE(
              ${input.message.editedAt}::timestamptz,
              discord_edited_at
            ),
            deleted_at = CASE
              WHEN ${input.eventType} = 'delete' THEN ${observedAt}::timestamptz
              ELSE NULL
            END,
            last_observed_at = ${observedAt}::timestamptz,
            updated_at = now()
          WHERE message_id = ${input.message.messageId}
        `);
      }

      results.push({
        eventId: input.eventId,
        ignored: false,
        record: {
          eventId: input.eventId,
          eventType: input.eventType,
          messageId: input.message.messageId,
          guildId: input.message.guildId,
          channelId: input.message.channelId,
          authorId,
          authorUsername,
          authorDisplayName,
          createdAt,
          observedAt,
          before,
          after,
        },
      });
    }
      return results;
    });
  } catch (error) {
    if (error instanceof DiscordMessageHistoryError) throw error;
    // Drizzle's outer error may contain SQL parameters, including message text.
    // The shared logger walks to the PostgreSQL cause and redacts query details.
    logError("discord.message-history", "Admin DB persistence failed", error);
    throw new Error("Discord message history persistence failed.");
  }
}
