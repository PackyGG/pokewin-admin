import "server-only";

import { adminDb } from "@/lib/admin-db";
import {
  BackendApiError,
  creatorsApi,
  type CreatorSessionResponse,
} from "@/lib/backend-api";

/**
 * Creator Hub — `creators/[id]` **Sessions** tab data.
 *
 * Owner spec (iridescent-mixing-lecun.md → "New tab: Sessions"):
 *   • List the creator's deal/stream sessions — ONE row per session, showing
 *     every available datum (activated_at → ended_at, duration, fill granted /
 *     spent / remaining, conversion/voucher, tips + sponsor spent, status, …).
 *   • A manager-entered **Kick VOD URL per session** — stored in the ADMIN DB
 *     (never MAIN), editable inline + in the modal.
 *
 * DATA SOURCES (two systems, merged in code — no cross-DB join):
 *   1. **Backend admin API** (`creatorsApi.listSessions`) — the authoritative
 *      session records (the SAME source the legacy `/creators/[userId]`
 *      Sessions tab uses via `get-creator-deal-data`). MAIN/prod is read-only;
 *      this is a backend READ, no write.
 *   2. **ADMIN DB** (`creator_session_meta`) — the manager-entered sidecar
 *      (Kick VOD URL + notes), keyed on the backend `session_id`. Writable —
 *      admin-domain data only.
 *
 * The two are merged by session id into one row shape the client renders.
 *
 * RESILIENCE (owner: ADD an ensure-schema/IF-NOT-EXISTS guard + catch
 * P2021/42P01 in read paths): the substrate table is provisioned via
 * `prisma db execute` (the admin DB is db-push/execute-managed with a drifted
 * migration history), so on an environment where the table hasn't been
 * provisioned yet a read would throw P2021 ("table does not exist") / Postgres
 * 42P01. {@link readSessionMetaByIds} self-heals the table (idempotent
 * CREATE … IF NOT EXISTS, mirroring `changelog/ensure-schema.ts`) and degrades
 * to "no meta" so the session list still renders. A backend miss (creator not
 * promoted / 404) degrades to an empty list, never a crash.
 *
 * LAZY: the only caller is the Sessions tab component, which is mounted solely
 * when that tab is opened — so this never runs on Overview / other tabs.
 */

// Page size — sessions are cheap rows; show a generous page so a creator's
// stream history is visible without aggressive pagination, while still bounding
// the backend call.
const SESSIONS_PER_PAGE = 50;

/** One session row = the backend record + the admin-DB VOD/notes sidecar. */
export type CreatorSessionRow = CreatorSessionResponse & {
  /** Manager-entered Kick VOD URL (admin DB), or null when unset. */
  kickVodUrl: string | null;
  /** Manager-entered free-text note (admin DB), or null when unset. */
  notes: string | null;
};

export type SessionsData = {
  rows: CreatorSessionRow[];
  total: number;
  /** True when the per-session meta (VOD/notes) read degraded — rows still
   *  render, but VOD URLs may be missing this load. */
  metaDegraded: boolean;
};

// Module-level flag so the IF-NOT-EXISTS self-heal runs at most once per
// server process (reset on failure so the next caller retries). Same pattern
// as `changelog/ensure-schema.ts`.
let sessionMetaEnsured = false;

/**
 * Create `creator_session_meta` + its indexes if missing — the runtime
 * self-heal the owner asked for. Idempotent (IF NOT EXISTS); mirrors the
 * mirror in `prisma/admin/schema.prisma` + the substrate SQL. No-op after the
 * first success in this process.
 */
export async function ensureSessionMetaSchema(): Promise<void> {
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

/** Postgres "undefined_table" (42P01) / Prisma "table does not exist" (P2021). */
function isMissingTableError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "P2021" || code === "42P01";
}

/**
 * Read the admin-DB VOD/notes sidecar for a set of session ids, returned as a
 * map keyed on session id. Self-heals the table on a missing-table error and
 * retries once; any other failure degrades to an empty map with `degraded`
 * flagged so the caller can still render the sessions (just without VOD URLs).
 */
export async function readSessionMetaByIds(sessionIds: string[]): Promise<{
  byId: Map<string, { kickVodUrl: string | null; notes: string | null }>;
  degraded: boolean;
}> {
  const byId = new Map<
    string,
    { kickVodUrl: string | null; notes: string | null }
  >();
  if (sessionIds.length === 0) return { byId, degraded: false };

  const run = () =>
    adminDb.creator_session_meta.findMany({
      where: { session_id: { in: sessionIds } },
      select: { session_id: true, kick_vod_url: true, notes: true },
    });

  let rows: Awaited<ReturnType<typeof run>>;
  try {
    rows = await run();
  } catch (err) {
    if (isMissingTableError(err)) {
      // Table not provisioned on this environment yet — create it, retry once.
      try {
        await ensureSessionMetaSchema();
        rows = await run();
      } catch (retryErr) {
        console.error(
          "[creator-hub.creators.sessions] meta read failed after ensure-schema:",
          retryErr,
        );
        return { byId, degraded: true };
      }
    } else {
      console.error(
        "[creator-hub.creators.sessions] meta read failed:",
        err,
      );
      return { byId, degraded: true };
    }
  }

  for (const r of rows) {
    byId.set(r.session_id, {
      kickVodUrl: r.kick_vod_url ?? null,
      notes: r.notes ?? null,
    });
  }
  return { byId, degraded: false };
}

/**
 * Fetch the creator's sessions (newest-first as the backend returns them),
 * merged with the admin-DB VOD/notes sidecar.
 *
 * @param userId backend/text user id of the creator.
 * @param page   1-based page (defaults to 1). Status filtering is intentionally
 *               omitted — the owner wants the full session list with every
 *               datum; the table sorts/groups client-side.
 */
export async function getCreatorSessionsData(
  userId: string,
  page = 1,
): Promise<SessionsData> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;

  // 1 ── Authoritative session records from the backend admin API. A 404
  //      (user not a creator on the backend) → empty list, not an error.
  let backend: { data: CreatorSessionResponse[]; total: number };
  try {
    backend = await creatorsApi.listSessions(userId, {
      limit: SESSIONS_PER_PAGE,
      offset: (safePage - 1) * SESSIONS_PER_PAGE,
    });
  } catch (err) {
    if (err instanceof BackendApiError && err.isNotFound) {
      return { rows: [], total: 0, metaDegraded: false };
    }
    throw err;
  }

  if (backend.data.length === 0) {
    return { rows: [], total: backend.total, metaDegraded: false };
  }

  // 2 ── Admin-DB VOD/notes sidecar for exactly these sessions.
  const { byId, degraded } = await readSessionMetaByIds(
    backend.data.map((s) => s.id),
  );

  const rows: CreatorSessionRow[] = backend.data.map((s) => {
    const meta = byId.get(s.id);
    return {
      ...s,
      kickVodUrl: meta?.kickVodUrl ?? null,
      notes: meta?.notes ?? null,
    };
  });

  return { rows, total: backend.total, metaDegraded: degraded };
}

export const SESSIONS_PAGE_SIZE = SESSIONS_PER_PAGE;
