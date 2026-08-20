import { z } from "zod";

import { DiscordIdSchema, jsonBody } from "@/app/api/v1/discord/creator-setups/_shared";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { VIPS_GUILD_ID } from "@/lib/discord-vip-channel-links";
import { getVipPerksSyncPage } from "@/lib/vip-perks";
import { perksError } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BodySchema = z.object({
  guildId: DiscordIdSchema,
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const POST = withApiKey(
  { scopes: ["discord:vips:perks"] },
  async (request) => {
    const raw = await jsonBody(request);
    if (raw instanceof Response) return raw;
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid VIP perk sync request.");
    }
    if (parsed.data.guildId !== VIPS_GUILD_ID) {
      return apiError(403, "wrong_guild", "VIP perks are not enabled in this server.");
    }
    try {
      const page = await getVipPerksSyncPage({
        afterLinkId: parsed.data.cursor,
        limit: parsed.data.limit,
      });
      return Response.json({
        data: {
          members: page.members
            .filter((member) => member.discordUserId != null)
            .map((member) => ({
              discordUserId: member.discordUserId,
              userId: member.userId,
              active: member.active,
              status: member.status,
            })),
          nextCursor: page.nextCursor,
        },
      });
    } catch (error) {
      return perksError(error);
    }
  },
);
