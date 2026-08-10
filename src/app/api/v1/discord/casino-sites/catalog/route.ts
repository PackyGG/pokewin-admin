import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { getDiscordCasinoCatalog } from "@/lib/discord-casino-catalog";
import {
  DiscordIdSchema,
  jsonBody,
  rejectWrongGuild,
} from "../../creator-setups/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({ guildId: DiscordIdSchema }).strict();

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
        parsed.error.issues[0]?.message ?? "Invalid casino catalog request.",
      );
    }
    const wrongGuild = rejectWrongGuild(parsed.data.guildId);
    if (wrongGuild) return wrongGuild;

    return Response.json({ data: await getDiscordCasinoCatalog() });
  },
);
