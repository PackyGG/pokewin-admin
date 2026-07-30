import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { claimDiscordChannelCreationJobs } from "@/lib/discord-notifications/channel-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  guildId: z.string().trim().regex(/^\d{15,21}$/),
  workerId: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(10),
});

export const POST = withApiKey(
  { scopes: ["discord:antifraud"] },
  async (request) => {
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Invalid channel-job claim payload.",
      );
    }
    const configuredGuildId = process.env.ADMIN_GUILD_ID;
    if (!configuredGuildId) {
      return apiError(503, "not_configured", "Admin guild routing is not configured.");
    }
    if (parsed.data.guildId !== configuredGuildId) {
      return apiError(403, "guild_not_allowed", "This guild is not allowed.");
    }
    return { jobs: await claimDiscordChannelCreationJobs(parsed.data) };
  },
);
