import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { DiscordIdSchema, jsonBody } from "@/app/api/v1/discord/creator-setups/_shared";
import {
  getVipDashboardContext,
  VIPS_GUILD_ID,
  VipChannelLinkError,
} from "@/lib/discord-vip-channel-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  guildId: DiscordIdSchema,
  channelId: DiscordIdSchema,
  actorDiscordUserId: DiscordIdSchema,
});

export const POST = withApiKey(
  { scopes: ["discord:vips:link"] },
  async (request) => {
    const raw = await jsonBody(request);
    if (raw instanceof Response) return raw;
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid dashboard context request.");
    }
    if (parsed.data.guildId !== VIPS_GUILD_ID) {
      return apiError(403, "wrong_guild", "VIP dashboard access is not enabled in this server.");
    }
    try {
      return Response.json({ data: await getVipDashboardContext(parsed.data) });
    } catch (error) {
      if (error instanceof VipChannelLinkError) {
        return apiError(error.status, error.code, error.message);
      }
      throw error;
    }
  },
);
