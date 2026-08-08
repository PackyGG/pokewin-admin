import { z } from "zod";

import { apiError } from "@/lib/api-auth/with-api-key";
import {
  PARTNERSHIP_GUILD_ID,
  PartnershipTicketError,
} from "@/lib/discord-partnership-tickets";

export const Snowflake = z.string().trim().regex(/^\d{17,20}$/);
export const Uuid = z.string().uuid();
export const GuildId = z.literal(PARTNERSHIP_GUILD_ID);

export async function strictJson(request: Request): Promise<unknown | Response> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return apiError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  try { return await request.json(); }
  catch { return apiError(400, "invalid_json", "Request body must be valid JSON."); }
}

export function partnershipError(error: unknown): Response {
  if (error instanceof PartnershipTicketError) return apiError(error.statusCode, error.code, error.message);
  throw error;
}
