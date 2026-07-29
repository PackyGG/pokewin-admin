import { z } from "zod";

import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { syncDiscordChannels } from "@/lib/discord-notifications/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Snowflake = z.string().trim().regex(/^\d{15,21}$/);
const BodySchema = z.object({
  guildId: Snowflake,
  guildName: z.string().trim().min(1).max(120),
  channels: z
    .array(
      z.object({
        id: Snowflake,
        name: z.string().trim().min(1).max(120),
        type: z.union([z.string(), z.number().int()]).transform(String),
        parentId: Snowflake.nullable(),
        parentName: z.string().trim().max(120).nullable().optional(),
        position: z.number().int().min(-1).max(100000),
        canView: z.boolean(),
        canSend: z.boolean(),
        canEmbed: z.boolean(),
      }),
    )
    .max(1000),
  syncedAt: z.iso.datetime(),
});

export const POST = withApiKey(
  { scopes: ["discord:antifraud"] },
  async (request) => {
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError(
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Invalid channel sync payload.",
      );
    }
    const configuredGuildId = process.env.ADMIN_GUILD_ID;
    if (!configuredGuildId) {
      return apiError(503, "not_configured", "Admin guild routing is not configured.");
    }
    if (parsed.data.guildId !== configuredGuildId) {
      return apiError(403, "guild_not_allowed", "This guild is not allowed.");
    }
    return syncDiscordChannels({
      ...parsed.data,
      syncedAt: new Date(parsed.data.syncedAt),
    });
  },
);
