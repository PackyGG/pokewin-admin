import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { completePartnershipTicketAction } from "@/lib/discord-partnership-tickets";
import { partnershipError, Snowflake, strictJson, Uuid } from "../../../../_shared";
export const runtime="nodejs"; export const dynamic="force-dynamic";
const Params=z.object({ticketId:Uuid,operationId:Uuid}).strict(); const Body=z.object({observedChannelId:Snowflake,observedCategoryId:Snowflake.optional(),observedChannelDeleted:z.boolean().optional()}).strict().refine(v=>v.observedCategoryId!==undefined||v.observedChannelDeleted===true,"An observed result is required");
export const POST=withApiKey<{ticketId:string;operationId:string}>({scopes:["discord:partnership-tickets"]},async(request,{params,principal})=>{const p=Params.safeParse(params);const raw=await strictJson(request);if(raw instanceof Response)return raw;const b=Body.safeParse(raw);if(!p.success||!b.success)return apiError(400,"invalid_request","Invalid action completion.");try{return await completePartnershipTicketAction({...p.data,...b.data,apiKeyId:principal.keyId,apiKeyPrefix:principal.prefix});}catch(error){return partnershipError(error);}});
