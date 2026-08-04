import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import {
  createDiscordReminder,
  reminderChannelForGuild,
  REMINDER_USER_IDS,
} from "@/lib/discord-reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Snowflake = z.string().trim().regex(/^\d{17,20}$/);
const BodySchema = z.object({
  interactionId: Snowflake,
  guildId: Snowflake,
  sourceChannelId: Snowflake,
  userId: Snowflake,
});

export const POST = withApiKey(
  { scopes: ["discord:reminders"] },
  async (request) => {
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError(400, "invalid_request", "Invalid reminder payload.");
    }
    if (!reminderChannelForGuild(parsed.data.guildId)) {
      return apiError(403, "guild_not_allowed", "This guild is not allowed.");
    }
    if (!REMINDER_USER_IDS.includes(parsed.data.userId as typeof REMINDER_USER_IDS[number])) {
      return apiError(403, "user_not_allowed", "This user is not allowed.");
    }
    try {
      return await createDiscordReminder(parsed.data);
    } catch (error) {
      if (error instanceof Error && error.message.includes("conflicts")) {
        return apiError(409, "interaction_conflict", "This interaction is already assigned.");
      }
      throw error;
    }
  },
);
