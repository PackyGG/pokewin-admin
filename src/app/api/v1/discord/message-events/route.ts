import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import {
  DiscordMessageHistoryError,
  isMessageHistoryGuildAllowed,
  recordDiscordMessageEvents,
} from "@/lib/discord-message-history";
import {
  awardCommunityMessageXp,
  COMMUNITY_XP_GUILD_ID,
} from "@/lib/discord-community-xp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Snowflake = z.string().trim().regex(/^\d{17,20}$/);
const IsoTimestamp = z.string().datetime({ offset: true });
const AttachmentSchema = z.object({
  id: Snowflake,
  name: z.string().min(1).max(255),
  url: z.string().url().max(2_000).refine(
    (url) => url.startsWith("https://"),
    "Attachment URLs must use HTTPS",
  ),
  contentType: z.string().max(120).nullable(),
  size: z.number().int().min(0).max(1_000_000_000).nullable(),
}).strict();

const StateSchema = z.object({
  content: z.string().max(4_000).nullable(),
  attachments: z.array(AttachmentSchema).max(10),
}).strict();

const EventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.enum(["create", "update", "delete"]),
  observedAt: IsoTimestamp,
  previous: StateSchema.nullable().optional(),
  message: z.object({
    messageId: Snowflake,
    guildId: Snowflake,
    channelId: Snowflake,
    authorId: Snowflake.nullable(),
    authorUsername: z.string().max(100).nullable(),
    authorDisplayName: z.string().max(100).nullable(),
    authorIsBot: z.boolean().nullable(),
    webhookId: Snowflake.nullable(),
    content: z.string().max(4_000).nullable(),
    createdAt: IsoTimestamp,
    editedAt: IsoTimestamp.nullable(),
    referencedMessageId: Snowflake.nullable(),
    attachments: z.array(AttachmentSchema).max(10),
  }).strict(),
}).strict();

const BodySchema = z.object({
  events: z.array(EventSchema).min(1).max(25),
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const event of value.events) {
    if (ids.has(event.eventId)) {
      context.addIssue({
        code: "custom",
        message: "eventId values must be unique within a batch",
        path: ["events"],
      });
      return;
    }
    ids.add(event.eventId);
  }
});

export const POST = withApiKey(
  { scopes: ["discord:message-events"] },
  async (request) => {
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError(400, "invalid_request", "Invalid Discord message event batch.");
    }
    if (parsed.data.events.some((event) => !isMessageHistoryGuildAllowed(event.message.guildId))) {
      return apiError(403, "guild_not_allowed", "Message logging is not enabled in this server.");
    }

    try {
      const results = await recordDiscordMessageEvents(parsed.data.events);
      // Message history is delivered through the bot's fsynced retry queue.
      // Award after its idempotent write so an XP outage makes the caller retry
      // instead of silently losing an otherwise eligible Discord message.
      for (const event of parsed.data.events) {
        if (
          event.eventType !== "create"
          || event.message.guildId !== COMMUNITY_XP_GUILD_ID
          || !event.message.authorId
          || event.message.authorIsBot === true
          || event.message.webhookId !== null
        ) continue;
        await awardCommunityMessageXp({
          source: "discord",
          sourceEventId: event.message.messageId,
          discordUserId: event.message.authorId,
          channelId: event.message.channelId,
          content: event.message.content ?? "",
          occurredAt: event.message.createdAt,
        });
      }
      return { results };
    } catch (error) {
      if (error instanceof DiscordMessageHistoryError) {
        return apiError(error.status, error.code, error.message);
      }
      throw error;
    }
  },
);
