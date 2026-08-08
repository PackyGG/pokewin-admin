import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { acknowledgeDiscordRainNotificationJob } from "@/lib/discord-rain-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.uuid() });
const BodySchema = z.object({
  leaseToken: z.uuid(),
  status: z.enum(["delivered", "failed"]),
  discordMessageId: z.string().trim().regex(/^\d{17,20}$/).optional(),
  errorCode: z.string().trim().max(80).optional(),
  errorMessage: z.string().trim().max(500).optional(),
}).superRefine((body, context) => {
  if (body.status === "delivered" && !body.discordMessageId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["discordMessageId"],
      message: "discordMessageId is required for delivered jobs.",
    });
  }
});

export const POST = withApiKey<{ id: string }>(
  { scopes: ["discord:rains"] },
  async (request, context) => {
    const params = ParamsSchema.safeParse(context.params);
    const body = BodySchema.safeParse(await request.json().catch(() => null));
    if (!params.success || !body.success) {
      return apiError(400, "invalid_request", "Invalid rain notification acknowledgement.");
    }
    try {
      return await acknowledgeDiscordRainNotificationJob({
        id: params.data.id,
        ...body.data,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Rain notification lease not found.") {
        return apiError(409, "lease_not_found", "The rain notification lease is no longer active.");
      }
      throw error;
    }
  },
);
