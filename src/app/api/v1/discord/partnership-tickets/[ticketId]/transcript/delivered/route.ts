import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { markPartnershipTranscriptDelivered, PARTNERSHIP_TRANSCRIPT_CHANNEL_ID } from "@/lib/discord-partnership-tickets";
import { partnershipError, Snowflake, strictJson, Uuid } from "../../../_shared";
export const runtime="nodejs"; export const dynamic="force-dynamic";
const Params=z.object({ticketId:Uuid}).strict();const Body=z.object({closeOperationId:Uuid,logChannelId:z.literal(PARTNERSHIP_TRANSCRIPT_CHANNEL_ID),logMessageId:Snowflake,attachmentId:Snowflake.nullable().optional(),attachmentUrl:z.string().url().max(2000).refine(value=>value.startsWith("https://")).nullable().optional()}).strict();
export const POST=withApiKey<{ticketId:string}>({scopes:["discord:partnership-tickets"]},async(request,{params,principal})=>{const p=Params.safeParse(params);const raw=await strictJson(request);if(raw instanceof Response)return raw;const b=Body.safeParse(raw);if(!p.success||!b.success)return apiError(400,"invalid_request","Invalid transcript delivery.");try{return await markPartnershipTranscriptDelivered({ticketId:p.data.ticketId,...b.data,apiKeyId:principal.keyId,apiKeyPrefix:principal.prefix});}catch(error){return partnershipError(error);}});
