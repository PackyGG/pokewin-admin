"use server";

import { queryRows } from "@/lib/drizzle-query";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
import { createAdminAuditEvent } from "@/lib/admin-audit";

/**
 * Creator Hub — `creators/[id]` **Sessions** tab server action.
 *
 * Persists the manager-entered **Kick VOD URL** for one stream/fill session in
 * the ADMIN DB (`creator_session_meta`), keyed on the backend `session_id`.
 * Owner spec: the VOD URL is editable INLINE in the row AND in the detail
 * modal — both call this one action.
 *
 * GATE: `requireCreatorHubAccess` (the Hub's access rule).
 * URL is admin-domain data → ADMIN DB write is allowed; MAIN/prod is never
 * touched, no schema migration runs.
 *
 * AUDIT: every set/clear leaves an `admin_audit_event` so the edit is
 * traceable (the actor admin + the session + the new value).
 *
 * The substrate table is provisioned through reviewed ADMIN SQL migrations.
 */

// A reasonable upper bound; a Kick VOD URL is a normal https URL. Empty string
// is the "clear" signal (stored as NULL). We validate the shape server-side —
// never trust the client.
const SetVodSchema = z.object({
  sessionId: z.string().min(1, "Missing session id").max(200),
  targetUserId: z.string().min(1, "Missing creator id").max(200),
  // Either a valid http(s) URL or empty (clear). Trimmed before validation.
  vodUrl: z
    .string()
    .max(1000, "URL is too long")
    .refine(
      (v) => v === "" || /^https?:\/\/\S+$/i.test(v),
      "Enter a valid http(s) URL, or clear it",
    ),
});

/**
 * Set (or clear) the Kick VOD URL for a session. An empty / whitespace
 * `vodUrl` clears it (stored as NULL). Returns the persisted value (null when
 * cleared) so the client can reflect it without a refetch.
 *
 * `updated_by` is the admin's session user id — it's a UUID column, and admin
 * session user ids are UUIDs, so it's written directly (best-effort: if a
 * non-UUID ever appeared it would throw and be surfaced to the caller, never
 * silently dropped).
 */
export async function setSessionVodUrl(input: {
  sessionId: string;
  targetUserId: string;
  vodUrl: string;
}): Promise<{ kickVodUrl: string | null }> {
  const session = await requireCreatorHubAccess();

  const parsed = SetVodSchema.parse({
    sessionId: input.sessionId.trim(),
    targetUserId: input.targetUserId.trim(),
    vodUrl: input.vodUrl.trim(),
  });

  const value = parsed.vodUrl === "" ? null : parsed.vodUrl;

  const upsert = () =>
    queryRows<{ id: string }[]>(
      adminDrizzle,
      `
        INSERT INTO creator_session_meta (
          session_id,
          target_user_id,
          kick_vod_url,
          updated_by
        )
        VALUES ($1, $2, $3, $4::uuid)
        ON CONFLICT (session_id) DO UPDATE
          SET kick_vod_url = EXCLUDED.kick_vod_url,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
        RETURNING id::text
      `,
      parsed.sessionId,
      parsed.targetUserId,
      value,
      session.userId,
      // Only the id is consumed — explicit select avoids a RETURNING * crash if
      // the generated client knows a column prod hasn't provisioned yet.
    );

  await upsert();

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: value ? "creator_session_vod_set" : "creator_session_vod_cleared",
    targetUserId: parsed.targetUserId,
    metadata: {
      via: "creator_hub_sessions_tab",
      session_id: parsed.sessionId,
      kick_vod_url: value,
    },
  });

  // The Hub detail route reads this sidecar; refresh so the server-rendered
  // value is consistent on the next navigation.
  revalidatePath(`/creator-hub/creators/${parsed.targetUserId}`);

  return { kickVodUrl: value };
}
