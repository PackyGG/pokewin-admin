import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import {
  getDiscordModerationSettings,
  PACKY_DISCORD_GUILD_ID,
} from "@/lib/discord-moderation-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  guildId: z.string().trim().regex(/^\d{17,20}$/),
}).strict();

export const POST = withApiKey(
  { scopes: ["discord:message-events"] },
  async (request) => {
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError(400, "invalid_request", "Expected a valid Discord guildId.");
    }
    if (parsed.data.guildId !== PACKY_DISCORD_GUILD_ID) {
      return apiError(403, "guild_not_allowed", "Moderation is not enabled in this server.");
    }
    return { settings: await getDiscordModerationSettings() };
  },
);
