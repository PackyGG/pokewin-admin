import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { completeCreatorSetup } from "@/lib/discord-creator-setups";
import {
  DiscordIdSchema,
  jsonBody,
  rejectWrongGuild,
  ReservationIdSchema,
  setupError,
} from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  reservationId: ReservationIdSchema,
  guildId: DiscordIdSchema,
  creatorDiscordUserId: DiscordIdSchema,
  categoryId: DiscordIdSchema,
  chatChannelId: DiscordIdSchema,
  logsChannelId: DiscordIdSchema,
  categoryName: z.string().trim().min(1).max(100),
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
        parsed.error.issues[0]?.message ?? "Invalid completed creator setup.",
      );
    }

    const wrongGuild = rejectWrongGuild(parsed.data.guildId);
    if (wrongGuild) return wrongGuild;

    try {
      return await completeCreatorSetup(parsed.data);
    } catch (error) {
      return setupError(error);
    }
  },
);
