"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { requireRole } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

/**
 * Creator Hub — `creators/[id]` **Sessions** tab server action.
 *
 * Persists the manager-entered **Kick VOD URL** for one stream/fill session in
 * the ADMIN DB (`creator_session_meta`), keyed on the backend `session_id`.
 * Owner spec: the VOD URL is editable INLINE in the row AND in the detail
 * modal — both call this one action.
 *
 * GATE: manager-only (`requireRole(['admin','creator_manager'])`, the Hub's
 * access set) — redirects on failure, same as every protected action. The VOD
 * URL is admin-domain data → ADMIN DB write is allowed; MAIN/prod is never
 * touched, no schema migration runs.
 *
 * AUDIT: every set/clear leaves an `admin_audit_event` so the edit is
 * traceable (the actor admin + the session + the new value).
 *
 * RESILIENCE: the substrate table is `prisma db execute`-provisioned (drifted
 * admin migration history). On an environment where it's missing, the upsert
 * would throw P2021 / Postgres 42P01 — we self-heal (idempotent CREATE … IF
 * NOT EXISTS, mirroring `changelog/ensure-schema.ts`) and retry once.
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

let sessionMetaEnsured = false;

/** Idempotently create `creator_session_meta` if it's missing (self-heal). */
async function ensureSessionMetaSchema(): Promise<void> {
  if (sessionMetaEnsured) return;
  await adminDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "creator_session_meta" (
      "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "session_id"     TEXT NOT NULL,
      "target_user_id" TEXT NOT NULL,
      "kick_vod_url"   TEXT,
      "notes"          TEXT,
      "updated_by"     UUID,
      "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
      "updated_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
    )
  `);
  await adminDb.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "creator_session_meta_session_id_key" ON "creator_session_meta" ("session_id")`,
  );
  await adminDb.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "creator_session_meta_target_user_idx" ON "creator_session_meta" ("target_user_id")`,
  );
  sessionMetaEnsured = true;
}

function isMissingTableError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "P2021" || code === "42P01";
}

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
  const session = await requireRole(["admin", "creator_manager"]);

  const parsed = SetVodSchema.parse({
    sessionId: input.sessionId.trim(),
    targetUserId: input.targetUserId.trim(),
    vodUrl: input.vodUrl.trim(),
  });

  const value = parsed.vodUrl === "" ? null : parsed.vodUrl;

  const upsert = () =>
    adminDb.creator_session_meta.upsert({
      where: { session_id: parsed.sessionId },
      create: {
        session_id: parsed.sessionId,
        target_user_id: parsed.targetUserId,
        kick_vod_url: value,
        updated_by: session.userId,
      },
      update: {
        kick_vod_url: value,
        updated_by: session.userId,
        updated_at: new Date(),
      },
      // Only the id is consumed — explicit select avoids a RETURNING * crash if
      // the generated client knows a column prod hasn't provisioned yet.
      select: { id: true },
    });

  try {
    await upsert();
  } catch (err) {
    if (isMissingTableError(err)) {
      await ensureSessionMetaSchema();
      await upsert();
    } else {
      throw err;
    }
  }

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
