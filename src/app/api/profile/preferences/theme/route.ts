import { z } from "zod";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  setAdminPreferences,
  THEME_VALUES,
  type AdminPreferences,
} from "@/lib/admin-preferences";
import { verifySession } from "@/lib/dal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ThemePreferenceSchema = z.object({
  theme: z.enum(THEME_VALUES as readonly [string, ...string[]]),
});

function response(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function PATCH(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (origin !== null && origin !== requestUrl.origin)
  ) {
    return response({ error: "forbidden" }, 403);
  }

  let session: Awaited<ReturnType<typeof verifySession>>;
  try {
    session = await verifySession();
  } catch {
    return response({ error: "unauthorized" }, 401);
  }

  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return response({ error: "unsupported_media_type" }, 415);
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return response({ error: "invalid_json" }, 400);
  }
  const parsed = ThemePreferenceSchema.safeParse(input);
  if (!parsed.success) {
    return response({ error: "invalid_theme" }, 400);
  }

  try {
    const theme = parsed.data.theme as AdminPreferences["theme"];
    await setAdminPreferences(session.userId, { theme });
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "admin_preferences_updated",
      metadata: {
        themeUpdated: true,
        timezoneUpdated: false,
        dateFormatUpdated: false,
      },
    });
    return response({ ok: true }, 200);
  } catch (error) {
    console.error("[theme-preferences] Failed to persist theme:", error);
    return response({ error: "persistence_failed" }, 503);
  }
}
