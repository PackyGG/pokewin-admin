import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { acknowledgeDiscordGiveawayJob } from "@/lib/discord-giveaways";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Uuid = z.uuid();
const Snowflake = z.string().trim().regex(/^\d{17,20}$/);
const BodySchema = z.discriminatedUnion("status", [
  z.object({
    leaseToken: Uuid,
    revision: z.number().int().min(1),
    status: z.literal("delivered"),
    discordMessageId: Snowflake,
  }).strict(),
  z.object({
    leaseToken: Uuid,
    revision: z.number().int().min(1),
    status: z.literal("failed"),
    errorCode: z.string().trim().min(1).max(80),
    errorMessage: z.string().trim().min(1).max(500),
  }).strict(),
]);

export const POST = withApiKey<{ id: string }>(
  { scopes: ["discord:giveaways"] },
  async (request, context) => {
    const id = Uuid.safeParse(context.params.id);
    const body = BodySchema.safeParse(await request.json().catch(() => null));
    if (!id.success || !body.success) {
      return apiError(400, "invalid_request", "Invalid giveaway acknowledgement payload.");
    }
    return acknowledgeDiscordGiveawayJob({ id: id.data, ...body.data });
  },
);
