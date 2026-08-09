import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { enterDiscordGiveaway, GiveawayError } from "@/lib/discord-giveaways";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Uuid = z.uuid();
const Snowflake = z.string().trim().regex(/^\d{17,20}$/);
const BodySchema = z.object({
  guildId: Snowflake,
  channelId: Snowflake,
  discordUserId: Snowflake,
}).strict();

export const POST = withApiKey<{ id: string }>(
  { scopes: ["discord:giveaways"] },
  async (request, context) => {
    const id = Uuid.safeParse(context.params.id);
    const body = BodySchema.safeParse(await request.json().catch(() => null));
    if (!id.success || !body.success) {
      return apiError(400, "invalid_request", "Invalid giveaway entry payload.");
    }
    try {
      return await enterDiscordGiveaway({ giveawayId: id.data, ...body.data });
    } catch (error) {
      if (error instanceof GiveawayError) {
        const status = error.code === "giveaway_not_found"
          ? 404
          : error.code === "giveaway_requirement_not_met"
            ? 403
            : 409;
        return apiError(status, error.code, error.message);
      }
      throw error;
    }
  },
);
