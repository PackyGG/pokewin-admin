import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { CreatorDealApprovalError, respondToCreatorDealApproval } from "@/lib/creator-deal-approvals";
import { CREATOR_SETUP_GUILD_ID } from "@/lib/discord-creator-setups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Snowflake = z.string().regex(/^\d{17,20}$/);
const ParamsSchema = z.object({ requestId: z.string().uuid() });
const BodySchema = z.object({
  guildId: z.literal(CREATOR_SETUP_GUILD_ID), categoryId: Snowflake,
  channelId: Snowflake, messageId: Snowflake, actorDiscordUserId: Snowflake,
  interactionId: Snowflake, action: z.enum(["approve", "decline"]),
});

export const POST = withApiKey<{ requestId: string }>(
  { scopes: ["discord:creator:setup"] },
  async (request, context) => {
    const params = ParamsSchema.safeParse(context.params);
    const body = BodySchema.safeParse(await request.json().catch(() => null));
    if (!params.success || !body.success) return apiError(400, "invalid_request", "Invalid creator approval decision.");
    try {
      return await respondToCreatorDealApproval({ requestId: params.data.requestId, ...body.data });
    } catch (error) {
      if (error instanceof CreatorDealApprovalError) return apiError(error.statusCode, error.code, error.message);
      throw error;
    }
  },
);
