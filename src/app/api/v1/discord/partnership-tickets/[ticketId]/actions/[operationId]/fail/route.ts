import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { failPartnershipTicketAction } from "@/lib/discord-partnership-tickets";
import { partnershipError, strictJson, Uuid } from "../../../../_shared";
export const runtime="nodejs"; export const dynamic="force-dynamic";
const Params=z.object({ticketId:Uuid,operationId:Uuid}).strict(); const Body=z.object({errorCode:z.string().trim().min(1).max(80).regex(/^[a-z0-9_:-]+$/i),errorMessage:z.string().trim().min(1).max(1000)}).strict();
export const POST=withApiKey<{ticketId:string;operationId:string}>({scopes:["discord:partnership-tickets"]},async(request,{params,principal})=>{const p=Params.safeParse(params);const raw=await strictJson(request);if(raw instanceof Response)return raw;const b=Body.safeParse(raw);if(!p.success||!b.success)return apiError(400,"invalid_request","Invalid action failure.");try{return await failPartnershipTicketAction({...p.data,...b.data,apiKeyId:principal.keyId,apiKeyPrefix:principal.prefix});}catch(error){return partnershipError(error);}});
