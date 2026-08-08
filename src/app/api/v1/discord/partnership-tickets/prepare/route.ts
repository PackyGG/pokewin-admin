import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { PARTNERSHIP_PANEL_CHANNEL_ID, preparePartnershipTicket } from "@/lib/discord-partnership-tickets";
import { GuildId, partnershipError, Snowflake, strictJson } from "../_shared";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
const Body = z.object({
  guildId: GuildId, sourceChannelId: z.literal(PARTNERSHIP_PANEL_CHANNEL_ID),
  applicantDiscordUserId: Snowflake, applicantUsername: z.string().trim().min(1).max(100),
  applicantDisplayName: z.string().trim().min(1).max(100), interactionId: Snowflake,
  socialMediaLinks: z.string().trim().min(1).max(1000),
  currentPastPartnerSites: z.string().trim().min(1).max(1000),
  statsExpectations: z.string().trim().min(1).max(2000),
  additionalNotes: z.string().trim().min(1).max(1000).nullable().optional(),
}).strict();
export const POST = withApiKey({ scopes: ["discord:partnership-tickets"] }, async (request, { principal }) => {
  const raw = await strictJson(request); if (raw instanceof Response) return raw;
  const parsed = Body.safeParse(raw); if (!parsed.success) return apiError(400, "invalid_request", "Invalid partnership application.");
  try { return await preparePartnershipTicket({ ...parsed.data, apiKeyId: principal.keyId, apiKeyPrefix: principal.prefix }); }
  catch (error) { return partnershipError(error); }
});
