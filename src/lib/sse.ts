/**
 * Shared Server-Sent Events (SSE) helper for live feeds.
 *
 * We use SSE instead of a third-party websocket service because:
 *   1. No external dependency (Pusher/Ably/Supabase Realtime are not needed).
 *   2. SSE is one-way server→client, which exactly matches our live feeds
 *      (the admin panel only READS live events — inputs go through the
 *      existing server-action pathway).
 *   3. Vercel Fluid Compute streams a `Response` for up to `maxDuration`
 *      seconds (default 300s = 5 min). We rotate every ~4 min to stay well
 *      under that cap — the client then reopens a fresh connection.
 *
 * Transport:
 *   - `Content-Type: text/event-stream`
 *   - Each message is `event: <name>\ndata: <json>\n\n`
 *   - Heartbeats are SSE comments (`:heartbeat\n\n`) every 15s so proxies
 *     (Cloudflare, nginx) don't close the idle connection.
 *
 * Event names emitted:
 *   - `init`        → initial snapshot (array of rows)
 *   - `row`         → a single new row
 *   - `reconnect`   → server-initiated rotation; client should reopen
 */

/**
 * Build an SSE `Response`. The caller supplies:
 *   - `initial()` — called once on open, its result is sent as `event: init`
 *   - `produce(lastCursor)` — called every `intervalMs`, emits new rows
 *     and advances the cursor.
 *
 * The cursor is a string (typically an ISO timestamp). `produce` returns
 * `{ rows, nextCursor }`. We emit one `event: row` per row, then track the
 * new cursor for the next tick. If `produce` throws, we swallow the error
 * and keep the stream alive — the client sees no interruption and the next
 * tick simply retries.
 */
export function sseResponse<T>(params: {
  request: Request;
  initial: () => Promise<{ rows: T[]; cursor: string | null }>;
  produce: (
    lastCursor: string | null,
  ) => Promise<{ rows: T[]; nextCursor: string | null }>;
  intervalMs?: number;
  maxDurationMs?: number;
}): Response {
  const {
    request,
    initial,
    produce,
    intervalMs = 3000,
    // 4 min — well under Vercel's 5min default maxDuration cap.
    maxDurationMs = 240_000,
  } = params;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let cursor: string | null = null;

      const timers: {
        tick: ReturnType<typeof setInterval> | null;
        heartbeat: ReturnType<typeof setInterval> | null;
        rotation: ReturnType<typeof setTimeout> | null;
      } = {
        tick: null,
        heartbeat: null,
        rotation: null,
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timers.tick) clearInterval(timers.tick);
        if (timers.heartbeat) clearInterval(timers.heartbeat);
        if (timers.rotation) clearTimeout(timers.rotation);
        try {
          controller.close();
        } catch {
          // Already closed — ignore.
        }
      };

      const write = (chunk: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      const writeEvent = (event: string, data: unknown): boolean => {
        return write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // If the client disconnects (tab close, navigation), Node aborts the
      // underlying request — we react by tearing everything down so we
      // don't keep polling the DB for a ghost connection.
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup, { once: true });

      // Kick off with the initial snapshot. Wrapped in an async IIFE so we
      // can use `await` without returning a promise to ReadableStream.start
      // (which would delay the controller being usable).
      (async () => {
        try {
          const snap = await initial();
          cursor = snap.cursor;
          writeEvent("init", snap.rows);
        } catch {
          // Failed initial fetch — still keep the connection open so the
          // client can recover on the next tick instead of bouncing
          // through EventSource's auto-reconnect loop.
          writeEvent("init", []);
        }

        // Periodic produce. Cursor advances only on success so we never
        // skip rows after a transient error.
        timers.tick = setInterval(async () => {
          if (closed) return;
          try {
            const { rows, nextCursor } = await produce(cursor);
            if (rows.length > 0) {
              for (const row of rows) {
                if (!writeEvent("row", row)) return;
              }
              cursor = nextCursor ?? cursor;
            } else if (nextCursor != null) {
              // No rows but cursor advanced (e.g. time-based watermark).
              cursor = nextCursor;
            }
          } catch {
            // Silent — the next tick will retry.
          }
        }, intervalMs);

        // Heartbeat — SSE comment lines keep intermediaries from timing
        // out the stream during quiet periods.
        timers.heartbeat = setInterval(() => {
          if (closed) return;
          write(`:heartbeat\n\n`);
        }, 15_000);

        // Server-initiated rotation. We tell the client to reconnect
        // before Vercel's maxDuration kills the function; the client's
        // hook opens a fresh EventSource immediately.
        timers.rotation = setTimeout(() => {
          if (closed) return;
          writeEvent("reconnect", { reason: "rotation" });
          cleanup();
        }, maxDurationMs);
      })();
    },
    cancel() {
      // The consumer cancelled (e.g. Next.js aborted the response). Nothing
      // to do — the start() closure's cleanup runs via the abort signal.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable buffering on platforms that respect this header (nginx,
      // some CDN layers). Vercel streams responses natively but the hint
      // is harmless elsewhere.
      "X-Accel-Buffering": "no",
    },
  });
}
