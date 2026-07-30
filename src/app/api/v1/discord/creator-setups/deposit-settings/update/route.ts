import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { updateCreatorDepositSettings } from "@/lib/discord-creator-deposits";
import {
  DiscordIdSchema,
  jsonBody,
  rejectWrongGuild,
  setupError,
} from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  guildId: DiscordIdSchema,
  categoryId: DiscordIdSchema,
  channelId: DiscordIdSchema,
  actorDiscordUserId: DiscordIdSchema,
  interactionId: DiscordIdSchema,
  enabled: z.boolean(),
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
        parsed.error.issues[0]?.message ?? "Invalid creator settings update.",
      );
    }
    const wrongGuild = rejectWrongGuild(parsed.data.guildId);
    if (wrongGuild) return wrongGuild;

    try {
      return await updateCreatorDepositSettings({
        ...parsed.data,
        apiKeyId: principal.keyId,
        apiKeyPrefix: principal.prefix,
      });
    } catch (error) {
      return setupError(error);
    }
  },
);
