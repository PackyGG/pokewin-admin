import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { COMMUNITY_XP_GUILD_ID, listCommunityLevelRoles, removeCommunityLevelRole, setCommunityLevelRole } from "@/lib/discord-community-xp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Snowflake = z.string().regex(/^\d{17,20}$/);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), guildId: Snowflake }).strict(),
  z.object({ action: z.literal("set"), guildId: Snowflake, level: z.number().int().min(0).max(100), roleId: Snowflake, actorDiscordUserId: Snowflake }).strict(),
  z.object({ action: z.literal("remove"), guildId: Snowflake, level: z.number().int().min(0).max(100), actorDiscordUserId: Snowflake }).strict(),
]);
export const POST = withApiKey({ scopes: ["discord:community-xp"] }, async (request) => {
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(400, "invalid_request", "Invalid level-role request.");
  if (body.data.guildId !== COMMUNITY_XP_GUILD_ID) return apiError(403, "guild_not_allowed", "Level roles are not enabled here.");
  if (body.data.action === "set") return { roles: await setCommunityLevelRole(body.data) };
  if (body.data.action === "remove") return { roles: await removeCommunityLevelRole(body.data.guildId, body.data.level) };
  return { roles: await listCommunityLevelRoles(body.data.guildId) };
});
