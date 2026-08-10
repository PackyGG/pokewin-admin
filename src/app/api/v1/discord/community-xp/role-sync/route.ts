import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { COMMUNITY_XP_GUILD_ID, getCommunityRoleSync } from "@/lib/discord-community-xp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Snowflake = z.string().regex(/^\d{17,20}$/);
const Body = z.object({ guildId: Snowflake, afterUserId: z.string().regex(/^\d{0,20}$/).default(""), limit: z.number().int().min(1).max(250).default(100) }).strict();
export const POST = withApiKey({ scopes: ["discord:community-xp"] }, async (request) => {
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(400, "invalid_request", "Invalid role-sync request.");
  if (body.data.guildId !== COMMUNITY_XP_GUILD_ID) return apiError(403, "guild_not_allowed", "Level roles are not enabled here.");
  return getCommunityRoleSync(body.data.guildId, body.data.afterUserId, body.data.limit);
});
