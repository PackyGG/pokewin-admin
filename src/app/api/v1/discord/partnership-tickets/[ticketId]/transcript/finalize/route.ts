import { z } from "zod";
import { apiError, withApiKey } from "@/lib/api-auth/with-api-key";
import { finalizePartnershipTranscript } from "@/lib/discord-partnership-tickets";
import { partnershipError, strictJson, Uuid } from "../../../_shared";
export const runtime="nodejs"; export const dynamic="force-dynamic";
const Params=z.object({ticketId:Uuid}).strict();const Body=z.object({closeOperationId:Uuid,messageCount:z.number().int().min(0).max(1_000_000),contentSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const POST=withApiKey<{ticketId:string}>({scopes:["discord:partnership-tickets"]},async(request,{params})=>{const p=Params.safeParse(params);const raw=await strictJson(request);if(raw instanceof Response)return raw;const b=Body.safeParse(raw);if(!p.success||!b.success)return apiError(400,"invalid_request","Invalid transcript finalization.");try{return await finalizePartnershipTranscript({ticketId:p.data.ticketId,...b.data});}catch(error){return partnershipError(error);}});
