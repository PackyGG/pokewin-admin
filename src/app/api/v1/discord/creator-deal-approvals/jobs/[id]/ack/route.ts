import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { acknowledgeCreatorDealApprovalJob, CreatorDealApprovalError } from "@/lib/creator-deal-approvals";
import { CREATOR_SETUP_GUILD_ID } from "@/lib/discord-creator-setups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({
  leaseToken: z.string().uuid(),
  status: z.enum(["delivered", "failed"]),
  discordMessageId: z.string().regex(/^\d{17,20}$/).optional(),
  errorCode: z.string().trim().max(80).optional(),
  errorMessage: z.string().trim().max(500).optional(),
});

export const POST = withApiKey<{ id: string }>(
  { scopes: ["discord:creator:setup"] },
  async (request, context) => {
    const params = ParamsSchema.safeParse(context.params);
    const body = BodySchema.safeParse(await request.json().catch(() => null));
    if (!params.success || !body.success) return apiError(400, "invalid_request", "Invalid approval delivery acknowledgement.");
    if (body.data.status === "delivered" && !body.data.discordMessageId) return apiError(400, "invalid_request", "discordMessageId is required for delivered jobs.");
    try {
      return await acknowledgeCreatorDealApprovalJob({ id: params.data.id, guildId: CREATOR_SETUP_GUILD_ID, ...body.data });
    } catch (error) {
      if (error instanceof CreatorDealApprovalError) return apiError(error.statusCode, error.code, error.message);
      throw error;
    }
  },
);
