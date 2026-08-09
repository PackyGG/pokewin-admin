import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { GiveawayError, rerollDiscordGiveaway } from "@/lib/discord-giveaways";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Uuid = z.uuid();
const Snowflake = z.string().trim().regex(/^\d{17,20}$/);
const BodySchema = z.object({
  interactionId: Snowflake,
  guildId: Snowflake,
  actorDiscordUserId: Snowflake,
  winnerDiscordUserId: Snowflake.optional(),
}).strict();

export const POST = withApiKey<{ id: string }>(
  { scopes: ["discord:giveaways"] },
  async (request, context) => {
    const id = Uuid.safeParse(context.params.id);
    const body = BodySchema.safeParse(await request.json().catch(() => null));
    if (!id.success || !body.success) {
      return apiError(400, "invalid_request", "Invalid giveaway reroll payload.");
    }
    try {
      return await rerollDiscordGiveaway({ giveawayId: id.data, ...body.data });
    } catch (error) {
      if (error instanceof GiveawayError) {
        const status = error.code === "giveaway_not_found" ? 404 : 409;
        return apiError(status, error.code, error.message);
      }
      throw error;
    }
  },
);
