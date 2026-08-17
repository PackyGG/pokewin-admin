import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { getCreatorCurrentConversion } from "@/lib/discord-creator-last-deals";
import {
  DiscordIdSchema,
  jsonBody,
  rejectWrongGuild,
  setupError,
} from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BodySchema = z.object({
  guildId: DiscordIdSchema,
  categoryId: DiscordIdSchema,
  channelId: DiscordIdSchema,
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
        parsed.error.issues[0]?.message ?? "Invalid creator conversion request.",
      );
    }
    const wrongGuild = rejectWrongGuild(parsed.data.guildId);
    if (wrongGuild) return wrongGuild;

    try {
      return Response.json({
        data: await getCreatorCurrentConversion(parsed.data),
      });
    } catch (error) {
      return setupError(error);
    }
  },
);
