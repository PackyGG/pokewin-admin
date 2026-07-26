import { queryRows } from "@/lib/drizzle-query";
import "server-only";

import { adminDrizzle } from "@/lib/admin-db";
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
 * RESILIENCE: the sidecar is provisioned through reviewed ADMIN SQL. A read
 * failure degrades to "no meta" so the session list still renders. A backend
 * miss (creator not promoted / 404) degrades to an empty list.
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
    queryRows<
      {
        session_id: string;
        kick_vod_url: string | null;
        notes: string | null;
      }[]
    >(
      adminDrizzle,
      `
        SELECT session_id, kick_vod_url, notes
          FROM creator_session_meta
         WHERE session_id = ANY($1::text[])
      `,
      sessionIds,
    );

  let rows: Awaited<ReturnType<typeof run>>;
  try {
    rows = await run();
  } catch (err) {
    console.error("[creator-hub.creators.sessions] meta read failed:", err);
    return { byId, degraded: true };
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
