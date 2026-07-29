import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { cancelCreatorSetup } from "@/lib/discord-creator-setups";
import {
  jsonBody,
  ReservationIdSchema,
  setupError,
} from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  reservationId: ReservationIdSchema,
});

export const POST = withApiKey(
  { scopes: ["discord:creator:setup"] },
  async (request) => {
    const raw = await jsonBody(request);
    if (raw instanceof Response) return raw;

    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return apiError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Invalid creator setup reservation.",
      );
    }

    try {
      return await cancelCreatorSetup(parsed.data.reservationId);
    } catch (error) {
      return setupError(error);
    }
  },
);
