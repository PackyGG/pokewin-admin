import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { previewCreatorSetupDelete } from "@/lib/discord-creator-setups";
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
  actorDiscordUserId: DiscordIdSchema,
});

export const POST = withApiKey(
  { scopes: ["discord:creator:setup"] },
  async (request) => {
    const raw = await jsonBody(request);
    if (raw instanceof Response) return raw;

    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Invalid creator setup deletion preview.",
      );
    }

    const wrongGuild = rejectWrongGuild(parsed.data.guildId);
    if (wrongGuild) return wrongGuild;

    try {
      return await previewCreatorSetupDelete(parsed.data);
    } catch (error) {
      return setupError(error);
    }
  },
);
