import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { repairCreatorSetup } from "@/lib/discord-creator-setups";
import {
  DiscordIdSchema,
  jsonBody,
  rejectWrongGuild,
  setupError,
} from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  guildId: DiscordIdSchema,
  creatorDiscordUserId: DiscordIdSchema,
  previousCategoryId: DiscordIdSchema,
  previousChatChannelId: DiscordIdSchema,
  previousLogsChannelId: DiscordIdSchema,
  categoryId: DiscordIdSchema,
  chatChannelId: DiscordIdSchema,
  logsChannelId: DiscordIdSchema,
  categoryName: z.string().trim().min(1).max(100),
  actorDiscordUserId: DiscordIdSchema,
  interactionId: DiscordIdSchema,
});

export const POST = withApiKey(
  { scopes: ["discord:creator:setup"] },
  async (request, { principal }) => {
    const raw = await jsonBody(request);
    if (raw instanceof Response) return raw;

    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Invalid creator setup repair.",
      );
    }

    const wrongGuild = rejectWrongGuild(parsed.data.guildId);
    if (wrongGuild) return wrongGuild;

    try {
      return await repairCreatorSetup({
        ...parsed.data,
        apiKeyId: principal.keyId,
        apiKeyPrefix: principal.prefix,
      });
    } catch (error) {
      return setupError(error);
    }
  },
);
