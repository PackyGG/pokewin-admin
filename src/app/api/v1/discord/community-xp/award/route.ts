import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { awardCommunityMessageXp, COMMUNITY_XP_GUILD_ID } from "@/lib/discord-community-xp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Snowflake = z.string().regex(/^\d{17,20}$/);
const Body = z.object({
  sourceEventId: Snowflake,
  guildId: Snowflake,
  channelId: Snowflake,
  discordUserId: Snowflake,
  content: z.string().max(4_000),
  occurredAt: z.iso.datetime({ offset: true }),
}).strict();

export const POST = withApiKey({ scopes: ["discord:community-xp"] }, async (request) => {
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(400, "invalid_request", "Invalid community XP message.");
  if (body.data.guildId !== COMMUNITY_XP_GUILD_ID) return apiError(403, "guild_not_allowed", "Community XP is not enabled here.");
  return awardCommunityMessageXp({
    source: "discord",
    sourceEventId: body.data.sourceEventId,
    discordUserId: body.data.discordUserId,
    channelId: body.data.channelId,
    content: body.data.content,
    occurredAt: body.data.occurredAt,
  });
});
