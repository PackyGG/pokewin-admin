import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { claimDiscordRainNotificationJobs } from "@/lib/discord-rain-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  workerId: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(10),
});

export const POST = withApiKey(
  { scopes: ["discord:rains"] },
  async (request) => {
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError(400, "invalid_request", "Invalid rain notification claim payload.");
    }
    return { jobs: await claimDiscordRainNotificationJobs(parsed.data) };
  },
);
