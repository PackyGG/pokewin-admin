import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { acknowledgeDiscordChannelCreationJob } from "@/lib/discord-notifications/channel-operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.uuid() });
const BodySchema = z.object({
  leaseToken: z.uuid(),
  status: z.enum(["created", "failed"]),
  channelId: z.string().trim().regex(/^\d{15,21}$/).optional(),
  channelName: z.string().trim().min(1).max(100).optional(),
  errorCode: z.string().trim().max(80).optional(),
  errorMessage: z.string().trim().max(500).optional(),
}).superRefine((value, context) => {
  if (value.status === "created" && (!value.channelId || !value.channelName)) {
    context.addIssue({
      code: "custom",
      message: "Created channel jobs require channelId and channelName.",
    });
  }
});

export const POST = withApiKey<{ id: string }>(
  { scopes: ["discord:antifraud"] },
  async (request, context) => {
    const params = ParamsSchema.safeParse(context.params);
    const body = BodySchema.safeParse(await request.json().catch(() => null));
    if (!params.success || !body.success) {
      return apiError(400, "invalid_request", "Invalid channel-job acknowledgement.");
    }
    const configuredGuildId = process.env.ADMIN_GUILD_ID;
    if (!configuredGuildId) {
      return apiError(503, "not_configured", "Admin guild routing is not configured.");
    }
    try {
      return await acknowledgeDiscordChannelCreationJob({
        id: params.data.id,
        guildId: configuredGuildId,
        ...body.data,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Lease not found.") {
        return apiError(409, "lease_not_found", "The job lease is no longer active.");
      }
      throw error;
    }
  },
);
