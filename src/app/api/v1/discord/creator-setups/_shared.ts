import { z } from "zod";

import { apiError } from "@/lib/api-auth/with-api-key";
import {
  CREATOR_SETUP_GUILD_ID,
  CreatorSetupError,
} from "@/lib/discord-creator-setups";

export const DiscordIdSchema = z
  .string()
  .trim()
  .regex(/^\d{17,20}$/, "Discord identifiers must contain 17 to 20 digits");

export const ReservationIdSchema = z
  .string()
  .trim()
  .uuid("reservationId must be a UUID");

export function rejectWrongGuild(guildId: string): Response | null {
  return guildId === CREATOR_SETUP_GUILD_ID
    ? null
    : apiError(403, "wrong_guild", "Creator setup is not enabled in this server.");
}

export function setupError(error: unknown): Response {
  if (error instanceof CreatorSetupError) {
    return apiError(error.status, error.code, error.message);
  }
  throw error;
}

export async function jsonBody(request: Request): Promise<unknown | Response> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return apiError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }
  try {
    return await request.json();
  } catch {
    return apiError(400, "invalid_json", "Request body must be valid JSON.");
  }
}
