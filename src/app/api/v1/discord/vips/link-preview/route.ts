import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import {
  previewVipChannelLink,
  VIPS_GUILD_ID,
  VipChannelLinkError,
} from "@/lib/discord-vip-channel-links";
import {
  DiscordIdSchema,
  jsonBody,
} from "@/app/api/v1/discord/creator-setups/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UserIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(64)
  .regex(
    /^[A-Za-z0-9_-]+$/,
    "userId must contain only letters, numbers, underscores, or hyphens",
  );

const BodySchema = z.object({
  guildId: DiscordIdSchema,
  channelId: DiscordIdSchema,
  memberDiscordUserId: DiscordIdSchema.optional(),
  userId: UserIdSchema,
  actorDiscordUserId: DiscordIdSchema,
});

export const POST = withApiKey(
  { scopes: ["discord:vips:link"] },
  async (request) => {
    const raw = await jsonBody(request);
    if (raw instanceof Response) return raw;

    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Invalid VIP link preview request.",
      );
    }
    if (parsed.data.guildId !== VIPS_GUILD_ID) {
      return apiError(
        403,
        "wrong_guild",
        "VIP channel linking is not enabled in this server.",
      );
    }

    try {
      const user = await previewVipChannelLink(parsed.data.userId);
      return Response.json({ data: { user } });
    } catch (error) {
      if (error instanceof VipChannelLinkError) {
        return apiError(error.status, error.code, error.message);
      }
      throw error;
    }
  },
);
