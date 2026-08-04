import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { acknowledgeCreatorSignupJob } from "@/lib/discord-creator-signups";
import { CREATOR_SETUP_GUILD_ID } from "@/lib/discord-creator-setups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.uuid() });
const BodySchema = z.object({
  leaseToken: z.uuid(),
  status: z.enum(["delivered", "failed"]),
  discordMessageId: z.string().trim().regex(/^\d{15,21}$/).optional(),
  errorCode: z.string().trim().max(80).optional(),
  errorMessage: z.string().trim().max(500).optional(),
});

export const POST = withApiKey<{ id: string }>(
  { scopes: ["discord:creator:setup"] },
  async (request, context) => {
    const params = ParamsSchema.safeParse(context.params);
    const body = BodySchema.safeParse(await request.json().catch(() => null));
    if (!params.success || !body.success) {
      return apiError(400, "invalid_request", "Invalid acknowledgement payload.");
    }
    try {
      return await acknowledgeCreatorSignupJob({
        id: params.data.id,
        guildId: CREATOR_SETUP_GUILD_ID,
        ...body.data,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Creator signup lease not found.") {
        return apiError(409, "lease_not_found", "The job lease is no longer active.");
      }
      throw error;
    }
  },
);
