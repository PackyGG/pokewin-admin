import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { linkCreatorSetup } from "@/lib/discord-creator-setups";
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
  categoryId: DiscordIdSchema,
  channelId: DiscordIdSchema,
  creatorUserId: z
    .string()
    .trim()
    .min(8)
    .max(64)
    .regex(
      /^[A-Za-z0-9_-]+$/,
      "creatorUserId must contain only letters, numbers, underscores, or hyphens",
    ),
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
        parsed.error.issues[0]?.message ?? "Invalid creator link request.",
      );
    }

    const wrongGuild = rejectWrongGuild(parsed.data.guildId);
    if (wrongGuild) return wrongGuild;

    try {
      return await linkCreatorSetup({
        ...parsed.data,
        apiKeyId: principal.keyId,
        apiKeyPrefix: principal.prefix,
      });
    } catch (error) {
      return setupError(error);
    }
  },
);
