import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { listPartnershipTicketRecovery } from "@/lib/discord-partnership-tickets";
import { GuildId, strictJson } from "../_shared";
export const runtime="nodejs"; export const dynamic="force-dynamic";
const Body=z.object({guildId:GuildId,limit:z.number().int().min(1).max(100).default(100)}).strict();
export const POST=withApiKey({scopes:["discord:partnership-tickets"]},async(request)=>{const raw=await strictJson(request);if(raw instanceof Response)return raw;const parsed=Body.safeParse(raw);if(!parsed.success)return apiError(400,"invalid_request","Invalid recovery request.");return listPartnershipTicketRecovery(parsed.data);});
