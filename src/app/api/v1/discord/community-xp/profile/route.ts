import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { getCommunityXpProfile } from "@/lib/discord-community-xp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Body = z.object({ discordUserId: z.string().regex(/^\d{17,20}$/) }).strict();
export const POST = withApiKey({ scopes: ["discord:community-xp"] }, async (request) => {
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return apiError(400, "invalid_request", "Invalid community XP profile request.");
  return getCommunityXpProfile(body.data.discordUserId);
});
