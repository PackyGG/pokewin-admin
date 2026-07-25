import WebSocket from "ws";

import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { parseAntifraudEvent, type AntifraudEvent } from "@/lib/antifraud/ws";

/**
 * Server-side proxy for the antifraud backend's live WebSocket feed.
 *
 * The browser opens an EventSource here; THIS route owns the WebSocket to the
 * separate fraud service. That split is the whole point:
 *
 *   • the backend token never reaches the browser,
 *   • the stream is gated by the dashboard session (same rule as the pages),
 *   • the backend only has to trust one origin, and
 *   • EventSource reconnects for free, which a raw browser WebSocket does not.
 *
 * Same topology as the existing `/api/packy-live` proxy, minus the hand-rolled
 * HTTP upgrade — that one exists only because packy.gg pins the browser
 * handshake headers; our own backend has no such requirement, so the plain `ws`
 * client is correct here.
 *
 * NOT-YET-CONFIGURED IS A NORMAL STATE. The backend service does not exist yet.
 * With `ANTIFRAUD_WS_URL` unset the route still opens a valid stream, emits one
 * `transport: unconfigured` frame so the UI can say "offline" honestly, and
 * then just heartbeats. It deliberately does NOT close: an immediately-closed
 * SSE response makes EventSource reconnect in a tight loop.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Keep-alive comment cadence — under every proxy's idle timeout. */
const HEARTBEAT_MS = 15_000;

/** Per-admin concurrent-stream cap (per Node instance), as on /api/packy-live. */
const MAX_CONCURRENT = 3;
const openStreams = new Map<string, number>();

function backendConfig(): { url?: string; token?: string } {
  return {
    url: process.env.ANTIFRAUD_WS_URL || undefined,
    token: process.env.ANTIFRAUD_WS_TOKEN || undefined,
  };
}

export async function GET(request: Request): Promise<Response> {
  // Same access rule as the workspace pages. requireAntifraudAccess throws on
  // denial (it is the action-shaped gate) — a redirect would be meaningless to
  // an EventSource, so translate it into a 401 the client can see.
  let userId: string;
  try {
    const session = await requireAntifraudAccess();
    userId = session.userId;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const currentOpen = openStreams.get(userId) ?? 0;
  if (currentOpen >= MAX_CONCURRENT) {
    return new Response("Too many concurrent streams", { status: 429 });
  }
  openStreams.set(userId, currentOpen + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const next = (openStreams.get(userId) ?? 1) - 1;
    if (next <= 0) openStreams.delete(userId);
    else openStreams.set(userId, next);
  };

  const encoder = new TextEncoder();
  const { url, token } = backendConfig();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let socket: WebSocket | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const send = (event: AntifraudEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Controller already torn down by an aborted request.
        }
      };

      const comment = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ${text}\n\n`));
        } catch {
          // ignore
        }
      };

      const shutdown = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        if (socket) {
          socket.removeAllListeners();
          try {
            socket.close();
          } catch {
            // already closing
          }
          socket = null;
        }
        release();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      request.signal.addEventListener("abort", shutdown);

      heartbeat = setInterval(() => comment("keepalive"), HEARTBEAT_MS);

      if (!url) {
        // No backend yet — say so once, then hold the pipe open (see header).
        send({
          type: "transport",
          state: "unconfigured",
          message:
            "The antifraud backend is not connected yet. Cases and signals still work from the dashboard database.",
          at: new Date().toISOString(),
        });
        return;
      }

      send({
        type: "transport",
        state: "connecting",
        at: new Date().toISOString(),
      });

      try {
        socket = new WebSocket(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          handshakeTimeout: 10_000,
        });
      } catch {
        send({
          type: "transport",
          state: "error",
          message: "Could not reach the antifraud backend",
          at: new Date().toISOString(),
        });
        return;
      }

      socket.on("open", () => {
        send({
          type: "transport",
          state: "open",
          at: new Date().toISOString(),
        });
      });

      socket.on("message", (data: WebSocket.RawData) => {
        // The backend is a separate service: nothing it sends is trusted until
        // it parses into a known event shape. Malformed frames are dropped.
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          return;
        }
        const event = parseAntifraudEvent(parsed);
        if (event) send(event);
      });

      socket.on("error", () => {
        // Never surface the upstream error text — it can contain the URL (and
        // therefore hints about the token). A generic line is enough for the UI.
        send({
          type: "transport",
          state: "error",
          message: "Antifraud backend connection failed",
          at: new Date().toISOString(),
        });
      });

      socket.on("close", () => {
        send({
          type: "transport",
          state: "closed",
          message: "Antifraud backend disconnected",
          at: new Date().toISOString(),
        });
        // Let EventSource own the retry: end this response so the browser
        // reconnects on its normal backoff instead of us reimplementing it.
        shutdown();
      });
    },
    cancel() {
      release();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
