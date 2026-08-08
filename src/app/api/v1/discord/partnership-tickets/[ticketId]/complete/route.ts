import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { PARTNERSHIP_OPEN_CATEGORY_ID, completePartnershipTicket } from "@/lib/discord-partnership-tickets";
import { GuildId, partnershipError, Snowflake, strictJson, Uuid } from "../../_shared";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
const Params = z.object({ ticketId: Uuid }).strict();
const Body = z.object({ guildId: GuildId, applicantDiscordUserId: Snowflake, ticketChannelId: Snowflake, categoryId: z.literal(PARTNERSHIP_OPEN_CATEGORY_ID), initialMessageId: Snowflake }).strict();
export const POST = withApiKey<{ticketId:string}>({ scopes: ["discord:partnership-tickets"] }, async (request, { params, principal }) => {
  const p=Params.safeParse(params); const raw=await strictJson(request); if(raw instanceof Response)return raw; const b=Body.safeParse(raw);
  if(!p.success||!b.success)return apiError(400,"invalid_request","Invalid ticket completion.");
  try{return await completePartnershipTicket({ticketId:p.data.ticketId,...b.data,apiKeyId:principal.keyId,apiKeyPrefix:principal.prefix});}catch(error){return partnershipError(error);}
});
