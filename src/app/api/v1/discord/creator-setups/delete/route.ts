import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { deleteCreatorSetup } from "@/lib/discord-creator-setups";
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
  categoryId: DiscordIdSchema,
  chatChannelId: DiscordIdSchema,
  logsChannelId: DiscordIdSchema,
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
        parsed.error.issues[0]?.message ?? "Invalid creator setup deletion.",
      );
    }

    const wrongGuild = rejectWrongGuild(parsed.data.guildId);
    if (wrongGuild) return wrongGuild;

    try {
      return await deleteCreatorSetup({
        ...parsed.data,
        apiKeyId: principal.keyId,
        apiKeyPrefix: principal.prefix,
      });
    } catch (error) {
      return setupError(error);
    }
  },
);
