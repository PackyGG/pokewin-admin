import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { CreatorDealApprovalError, respondToCreatorDealApproval } from "@/lib/creator-deal-approvals";
import { CREATOR_SETUP_GUILD_ID } from "@/lib/discord-creator-setups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Snowflake = z.string().regex(/^\d{17,20}$/);
const BodySchema = z.object({
  requestId: z.string().uuid(),
  guildId: z.literal(CREATOR_SETUP_GUILD_ID),
  categoryId: Snowflake,
  channelId: Snowflake,
  messageId: Snowflake,
  actorDiscordUserId: Snowflake,
  interactionId: Snowflake,
  action: z.enum(["continue", "approve", "decline"]),
});

export const POST = withApiKey(
  { scopes: ["discord:creator:setup"] },
  async (request) => {
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError(400, "invalid_request", parsed.error.issues[0]?.message ?? "Invalid creator approval response.");
    try {
      return await respondToCreatorDealApproval(parsed.data);
    } catch (error) {
      if (error instanceof CreatorDealApprovalError) return apiError(error.statusCode, error.code, error.message);
      throw error;
    }
  },
);
