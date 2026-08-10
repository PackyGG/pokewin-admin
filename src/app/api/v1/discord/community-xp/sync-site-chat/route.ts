import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { syncSiteChatXp } from "@/lib/discord-community-xp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const Body = z.object({ limit: z.number().int().min(1).max(500).default(200) }).strict();
export const POST = withApiKey({ scopes: ["discord:community-xp"] }, async (request) => {
  const body = Body.safeParse(await request.json().catch(() => ({})));
  if (!body.success) return apiError(400, "invalid_request", "Invalid site-chat sync request.");
  return syncSiteChatXp(body.data.limit);
});
