import { z } from "zod";

import { DiscordIdSchema, jsonBody } from "@/app/api/v1/discord/creator-setups/_shared";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { VIPS_GUILD_ID } from "@/lib/discord-vip-channel-links";
import { getVipPerksForUsers, VipPerksError } from "@/lib/vip-perks";
import { perksError } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const BodySchema = z.object({
  guildId: DiscordIdSchema,
  userId: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
});

export const POST = withApiKey(
  { scopes: ["discord:vips:perks"] },
  async (request) => {
    const raw = await jsonBody(request);
    if (raw instanceof Response) return raw;
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid VIP perk status request.");
    }
    if (parsed.data.guildId !== VIPS_GUILD_ID) {
      return apiError(403, "wrong_guild", "VIP perks are not enabled in this server.");
    }
    try {
      const entitlement = (await getVipPerksForUsers([parsed.data.userId])).get(parsed.data.userId);
      if (!entitlement) throw new VipPerksError(404, "vip_link_not_found", "That user has no VIP channel link.");
      return Response.json({ data: entitlement });
    } catch (error) {
      return perksError(error);
    }
  },
);
