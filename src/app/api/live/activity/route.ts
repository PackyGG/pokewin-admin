import { requirePageAccess } from "@/lib/dal";
import {
  getLiveActivity,
  getLiveActivityWatermark,
  type LiveActivityItem,
} from "@/lib/queries/dashboard-live";
import { sseResponse } from "@/lib/sse";

// Per-user concurrent-stream cap for THIS route in THIS Node.js process.
// BEST-EFFORT ONLY — this is per-instance in-memory state. On Vercel each
// Fluid Compute instance has its own Map, so the real ceiling is
// `MAX_CONCURRENT × instance_count`, NOT a global per-user cap. The
// authoritative dedupe is client-side: the browser opens exactly one
// EventSource per stream type across all tabs/components (see the shared
// connection in `src/lib/hooks/use-sse.ts`). This server cap just stops a
// single instance from stacking duplicate upstreams for one admin.
const MAX_CONCURRENT = 1;
const openStreams = new Map<string, number>();

// This route streams and is expected to stay open for minutes at a time.
// Vercel's Fluid Compute runtime supports streaming Responses; keep the
// default Node runtime (NOT Edge) because the underlying Prisma query
// uses the pg driver. `dynamic = "force-dynamic"` prevents accidental
// caching at the framework layer — every connection is a fresh stream.
export const dynamic = "force-dynamic";
// Match Vercel's default maxDuration so the stream rotation window has
// the most headroom possible. The helper still rotates at 4min.
export const maxDuration = 300;

/**
 * Live activity feed over SSE. Replaces the 3s polling in
 * `src/app/(admin)/dashboard/recent-activity.tsx`. The query (see
 * `getLiveActivity`) is the same one the old poll endpoint used — we
 * simply drive it on the server side of a long-lived stream so the
 * client no longer has to round-trip every 3 seconds.
 */
export async function GET(request: Request): Promise<Response> {
  // Gate identical to the existing server-action wrapper
  // (`fetchRecentActivityLive`). Fails hard via redirect() if unauthed,
  // which turns into a normal HTTP redirect for the EventSource client.
  const session = await requirePageAccess("/dashboard");
  const userId = session.userId;

  // Cap per-user concurrent SSE streams. The 4th attempt is rejected
  // with 429 — the EventSource client surfaces this as `error` and the
  // page can warn the user instead of silently piling on connections.
  const currentOpen = openStreams.get(userId) ?? 0;
  if (currentOpen >= MAX_CONCURRENT) {
    return new Response("Too many concurrent streams", { status: 429 });
  }
  openStreams.set(userId, currentOpen + 1);
  let decremented = false;
  const decrementOnce = () => {
    if (decremented) return;
    decremented = true;
    const next = (openStreams.get(userId) ?? 1) - 1;
    if (next <= 0) openStreams.delete(userId);
    else openStreams.set(userId, next);
  };

  return sseResponse<LiveActivityItem>({
    request,
    onClose: decrementOnce,
    initial: async () => {
      const rows = await getLiveActivity({ sinceCreatedAt: null, limit: 30 });
      // Advance the cursor to the newest row so `produce()` only emits
      // events strictly newer than the snapshot.
      const cursor = rows.length > 0 ? rows[0].createdAt : null;
      return { rows, cursor };
    },
    produce: async (lastCursor) => {
      // Cheap watermark pre-check FIRST. The heavy include query
      // (`getLiveActivity` — 3 findMany with user joins + deposit-bonus
      // pairing + battle-participant borrow chain) only runs when a new
      // event actually landed since the last value we sent on this
      // stream. On an idle feed this collapses every ~6s tick to three
      // indexed `take: 1` lookups instead of the full feed query, which
      // is what was hammering the live prod DB per-connection.
      const watermark = await getLiveActivityWatermark(lastCursor);
      if (watermark == null) {
        // Nothing newer than the cursor — skip the heavy query entirely.
        return { rows: [], nextCursor: null };
      }

      const rows = await getLiveActivity({
        sinceCreatedAt: lastCursor,
        limit: 30,
      });
      if (rows.length === 0) {
        // Watermark advanced but the heavy query returned nothing (e.g.
        // a row that the broader watermark matched got filtered out by
        // the heavy query's row-level shaping). Advance the cursor to
        // the watermark so we don't re-trigger on the same row forever.
        return { rows: [], nextCursor: watermark };
      }
      // Emit oldest first so the client receives rows in chronological
      // order. `getLiveActivity` returns newest-first; reverse for the
      // stream and advance the cursor to the newest row.
      const ordered = [...rows].reverse();
      return { rows: ordered, nextCursor: rows[0].createdAt };
    },
    intervalMs: 6000,
  });
}
