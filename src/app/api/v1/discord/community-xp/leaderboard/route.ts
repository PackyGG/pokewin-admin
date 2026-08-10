import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { getCommunityXpLeaderboard } from "@/lib/discord-community-xp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Body = z.object({ limit: z.number().int().min(1).max(30).default(10) }).strict();
export const POST = withApiKey({ scopes: ["discord:community-xp"] }, async (request) => {
  const body = Body.safeParse(await request.json().catch(() => ({})));
  if (!body.success) return apiError(400, "invalid_request", "Invalid community XP leaderboard request.");
  return { profiles: await getCommunityXpLeaderboard(body.data.limit) };
});
