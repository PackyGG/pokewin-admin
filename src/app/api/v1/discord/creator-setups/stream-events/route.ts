import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { getCreatorSetupStreamEvents } from "@/lib/discord-creator-setups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withApiKey(
  { scopes: ["discord:creator:setup"] },
  async (request) => {
    const body = await request.json().catch(() => null);
    const parsed = z.object({ after: z.string().datetime({ offset: true }) }).safeParse(body);
    if (!parsed.success) return apiError(400, "invalid_request", "after must be an ISO datetime");
    return Response.json({ data: await getCreatorSetupStreamEvents(parsed.data) });
  },
);
