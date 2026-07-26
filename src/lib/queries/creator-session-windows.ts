import "server-only";

import { sql } from "drizzle-orm";
import { getDrizzleDb } from "@/lib/db";
import { creatorsApi } from "@/lib/backend-api";

// Creator deal/stream sessions live ONLY in the backend creators API —
// there is no session table in the main DB, the endpoint is per-creator,
// and there is no bulk variant — so assembling the window list is a
// fan-out. The result is therefore cross-request cached: session windows
// change slowly and the dashboard polls every 60s, so this fan-out must
// not run on every refresh.
const TTL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 100;
// Caps the per-creator session walk. 10 pages = 1000 sessions/creator —
// far beyond any realistic streaming history; a guard against a runaway
// loop if `total` is ever reported wrong.
const MAX_PAGES = 10;

// An empty `session_windows` relation with the right column shape — used
// when there are no windows (no creators, no sessions, or the backend is
// unreachable) so the dashboard SQL is structurally identical either way.
const EMPTY_CTE =
  "session_windows(uid, win_start, win_end) AS (" +
  "SELECT NULL::text, NULL::timestamptz, NULL::timestamptz WHERE false)";

let cache: { at: number; sql: string } | null = null;
// Single-flight guard: the in-progress build, if one is running. Without
// it, every concurrent caller on a cold instance (the dashboard/GGR/edge-
// plan pages fire 15+ scope-dependent legs in parallel) kicks off its OWN
// per-creator backend fan-out — measured on one cold render: 263× HTTP 429
// + 451× 8s fetch timeouts, ~9s of stall burned out of every leg's budget.
// `cache` is only written AFTER `buildCte()` resolves, so the TTL check
// alone cannot dedupe concurrent misses; this promise does.
let inflight: Promise<string> | null = null;

/**
 * SQL fragment — a `session_windows(uid, win_start, win_end)` CTE listing
 * every creator deal/stream session, fetched from the backend creators
 * API. The dashboard wager aggregate joins against it to drop wagers a
 * creator made while live on a deal — house-funded "sponsored" play that
 * isn't a real customer bet.
 *
 * Returns a ready-to-inject CTE definition. A
 * still-live session (no `ended_at`) is treated as running until "now".
 *
 * Cross-request cached for 5 minutes, and SINGLE-FLIGHT: concurrent
 * callers during a cache miss all await the one in-progress build instead
 * of each launching their own backend fan-out. Best-effort: any backend
 * failure yields the empty-relation CTE, so the dashboard still renders
 * and the wager exclusion is simply a no-op until the backend recovers.
 */
export async function getCreatorSessionWindowsCte(): Promise<string> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.sql;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      let sql = EMPTY_CTE;
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
  const db = await getDrizzleDb();
  const result = await db.execute<{ id: string }>(sql`
    SELECT id
    FROM "user"
    WHERE role = 'creator'
  `);
  const creators = result.rows;
  if (creators.length === 0) return EMPTY_CTE;

  const nowMs = Date.now();
  // Per-creator walk in parallel — one creator's failed fetch must not
  // blank out the rest (Promise.allSettled). Creator count is small.
  const settled = await Promise.allSettled(
    creators.map((c) => fetchCreatorWindowRows(c.id, nowMs)),
  );

  const rows: string[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") rows.push(...r.value);
  }
  if (rows.length === 0) return EMPTY_CTE;
  return `session_windows(uid, win_start, win_end) AS (VALUES ${rows.join(",")})`;
}

/**
 * One creator's sessions → SQL VALUES tuples `('uid','start','end')`.
 * Throws on a backend failure (caller's allSettled absorbs it).
 */
async function fetchCreatorWindowRows(
  userId: string,
  nowMs: number,
): Promise<string[]> {
  // Defensive — user ids are alphanumeric, but double up any embedded
  // single quote before inlining it into the VALUES literal.
  const uid = userId.replace(/'/g, "''");
  const out: string[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await creatorsApi.listSessions(userId, {
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    });
    for (const s of res.data) {
      const startMs = Date.parse(s.activated_at);
      // A still-live session (no ended_at) runs until "now".
      const endMs = s.ended_at ? Date.parse(s.ended_at) : nowMs;
      if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
        continue;
      }
      out.push(
        `('${uid}'::text,` +
          `'${new Date(startMs).toISOString()}'::timestamptz,` +
          `'${new Date(endMs).toISOString()}'::timestamptz)`,
      );
    }
    if (res.data.length < PAGE_SIZE || (page + 1) * PAGE_SIZE >= res.total) {
      break;
    }
  }
  return out;
}
