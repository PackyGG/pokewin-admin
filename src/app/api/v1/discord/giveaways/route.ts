import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { createDiscordGiveaway, GiveawayError } from "@/lib/discord-giveaways";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Snowflake = z.string().trim().regex(/^\d{17,20}$/);
const BodySchema = z.object({
  interactionId: Snowflake,
  guildId: Snowflake,
  channelId: Snowflake,
  creatorDiscordUserId: Snowflake,
  prize: z.string().trim().min(1).max(1_000),
  winnerCount: z.number().int().min(1).max(20),
  entryRequirement: z.enum(["none", "linked_packy_account"]).default("none"),
  endsAt: z.iso.datetime({ offset: true }),
}).strict();

export const POST = withApiKey(
  { scopes: ["discord:giveaways"] },
  async (request) => {
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError(400, "invalid_request", "Invalid giveaway payload.");
    try {
      return await createDiscordGiveaway(parsed.data);
    } catch (error) {
      if (error instanceof GiveawayError) return apiError(409, error.code, error.message);
      throw error;
    }
  },
);
