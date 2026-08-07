import "server-only";

import { getReadDrizzleDb } from "@/lib/db";
import { creator_stream_sessions } from "@/lib/db-schema/main/schema";

// Creator deal/stream sessions are mirrored in MAIN. Read them in one bounded
// query instead of walking the per-creator backend endpoint: the old cold-cache
// fan-out launched hundreds of concurrent Cloudflare requests and produced
// retry storms before falling back to this same PostgreSQL source.
const TTL_MS = 5 * 60 * 1000;

// An empty `session_windows` relation with the right column shape — used
// when there are no windows (no creators, no sessions, or the backend is
// unreachable) so the dashboard SQL is structurally identical either way.
export const EMPTY_CREATOR_SESSION_WINDOWS_CTE =
  "session_windows(uid, win_start, win_end) AS (" +
  "SELECT NULL::text, NULL::timestamptz, NULL::timestamptz WHERE false)";

let cache: { at: number; sql: string } | null = null;
// Single-flight guard: the in-progress build, if one is running. Without
// it, every concurrent caller on a cold instance (the dashboard/GGR/edge-
// plan pages fire 15+ scope-dependent legs in parallel) kicks off its OWN
// per-creator read — the former HTTP implementation measured 263× HTTP 429
// + 451× 8s fetch timeouts on one cold render.
// `cache` is only written AFTER `buildCte()` resolves, so the TTL check
// alone cannot dedupe concurrent misses; this promise does.
let inflight: Promise<string> | null = null;

/**
 * SQL fragment — a `session_windows(uid, win_start, win_end)` CTE listing
 * every creator deal/stream session, fetched from the read-only MAIN mirror.
 * The dashboard wager aggregate joins against it to drop wagers a
 * creator made while live on a deal — house-funded "sponsored" play that
 * isn't a real customer bet.
 *
 * Returns a ready-to-inject CTE definition. A
 * still-live session (no `ended_at`) is treated as running until "now".
 *
 * Cross-request cached for 5 minutes, and SINGLE-FLIGHT: concurrent
 * callers during a cache miss all await the one in-progress build instead
 * of each launching their own database read. Best-effort: any database
 * failure yields the empty-relation CTE, so the dashboard still renders
 * and the wager exclusion is simply a no-op until the mirror recovers.
 */
export async function getCreatorSessionWindowsCte(): Promise<string> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.sql;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      let sql = EMPTY_CREATOR_SESSION_WINDOWS_CTE;
      try {
        sql = await buildCte();
      } catch (e) {
        console.error(
          "[creator-session-windows] build failed (wager exclusion off):",
          e,
        );
      }
      cache = { at: Date.now(), sql };
      return sql;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function buildCte(): Promise<string> {
  const db = await getReadDrizzleDb();
  const nowMs = Date.now();
  const sessions = await db
    .select({
      userId: creator_stream_sessions.user_id,
      activatedAt: creator_stream_sessions.activated_at,
      endedAt: creator_stream_sessions.ended_at,
    })
    .from(creator_stream_sessions);

  const rows = sessions.flatMap((session) => {
    const startMs = Date.parse(session.activatedAt);
    const endMs = session.endedAt ? Date.parse(session.endedAt) : nowMs;
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      return [];
    }

    // Defensive — user ids are alphanumeric, but double up any embedded
    // single quote before inlining it into this trusted CTE fragment.
    const uid = session.userId.replace(/'/g, "''");
    return [
      `('${uid}'::text,` +
        `'${new Date(startMs).toISOString()}'::timestamptz,` +
        `'${new Date(endMs).toISOString()}'::timestamptz)`,
    ];
  });
  if (rows.length === 0) return EMPTY_CREATOR_SESSION_WINDOWS_CTE;
  return `session_windows(uid, win_start, win_end) AS (VALUES ${rows.join(",")})`;
}
