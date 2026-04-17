import { verifySession } from "@/lib/dal";
import WebSocket from "ws";

/**
 * Server-side proxy for the packy.gg live WebSocket.
 *
 * Why this exists:
 *   The upstream WebSocket at `wss://api.packy.gg/v1/ws` enforces an
 *   `Origin: https://beta.packy.gg` handshake check. When the admin panel
 *   (running at `pokewin-admin.vercel.app`) opens a direct browser
 *   WebSocket, the browser pins Origin to its own hostname and the
 *   handshake is rejected by the gateway.
 *
 *   Browsers don't apply Origin checks to server-to-server requests, so
 *   we open the WS here on the Node.js runtime with a spoofed Origin and
 *   fan events out to authenticated admin sessions via SSE. The browser
 *   never touches the upstream socket.
 *
 * Transport:
 *   - EventSource from the admin client (`/api/packy-live`).
 *   - Each upstream WS message is forwarded verbatim as an SSE `packy`
 *     event so the existing client decoder can re-use its parser.
 *   - Heartbeat comment line every 15s to keep CDNs / proxies from
 *     timing out the stream during quiet periods.
 *   - Server-initiated rotation at 4 minutes (below Vercel's default 5
 *     min maxDuration) — the client reopens immediately. Matches the
 *     rotation pattern used by the existing `sseResponse` helper.
 */

// Must run on the Node.js runtime — the `ws` package uses net/tls APIs
// that aren't available on the Edge runtime.
export const runtime = "nodejs";
// Long-lived stream — don't let Next try to evaluate this at build time.
export const dynamic = "force-dynamic";
// Allow the function up to 5 minutes. We self-rotate at 4 to stay well
// below this cap.
export const maxDuration = 300;

const PACKY_WS_URL = "wss://api.packy.gg/v1/ws";
const ROTATION_MS = 240_000; // 4 min
const HEARTBEAT_MS = 15_000;

/**
 * Exact handshake headers copied 1:1 from the known-working browser WS
 * to the packy.gg gateway. Everything from the reference handshake goes
 * through verbatim except:
 *
 *   - Sec-WebSocket-Key: intentionally omitted. The WS protocol
 *     *requires* a fresh random key per handshake — the server's
 *     Sec-WebSocket-Accept response is sha1(key + GUID), and the `ws`
 *     library verifies the response against the key IT generated. If
 *     we pin Sec-WebSocket-Key to a fixed value here, our outbound
 *     header would override ws's generated key but ws would still
 *     verify against its own → verification fails, handshake drops.
 *   - Sec-WebSocket-Extensions: routed via the `perMessageDeflate`
 *     option below so ws actually negotiates + decompresses; setting
 *     it via headers alone would make the server send compressed
 *     frames that ws doesn't know how to inflate.
 *
 * Everything else (Upgrade, Connection, Sec-WebSocket-Version) is
 * spread AFTER ws's defaults so it wins on duplicate — values match
 * what ws would emit anyway, so no difference on the wire, but the
 * explicit listing makes the intent auditable.
 */
const PACKY_WS_HEADERS: Record<string, string> = {
  Upgrade: "websocket",
  Origin: "https://beta.packy.gg",
  "Cache-Control": "no-cache",
  "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
  Pragma: "no-cache",
  Connection: "Upgrade",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Sec-WebSocket-Version": "13",
};

export async function GET(request: Request): Promise<Response> {
  // Only authenticated admin sessions may open the proxy — otherwise
  // anyone could use the admin host as a free relay to packy.gg.
  // verifySession redirects on failure, but redirect doesn't make sense
  // for an SSE endpoint, so we translate that into a plain 401.
  try {
    await verifySession();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let upstream: WebSocket | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let rotation: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (rotation) clearTimeout(rotation);
        if (upstream) {
          // Remove listeners before close() so we don't re-enter any
          // handlers during teardown.
          upstream.removeAllListeners();
          try {
            upstream.close();
          } catch {
            // Already closing — ignore.
          }
          upstream = null;
        }
        try {
          controller.close();
        } catch {
          // Already closed — ignore.
        }
      };

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      const writeEvent = (event: string, data: string) => {
        write(`event: ${event}\ndata: ${data}\n\n`);
      };

      // React to the browser disconnecting (tab close, nav, reload) so
      // we don't keep the upstream WS alive for a ghost client.
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup, { once: true });

      // Open the upstream WebSocket with the full handshake header set
      // the gateway expects (see PACKY_WS_HEADERS). Any error here
      // falls through to the `error` / `close` handlers below — we
      // never throw synchronously out of start().
      try {
        upstream = new WebSocket(PACKY_WS_URL, {
          headers: PACKY_WS_HEADERS,
          // Emits `Sec-WebSocket-Extensions: permessage-deflate;
          // client_max_window_bits` exactly as the browser handshake
          // does. `ws` at runtime accepts `true` for the bare form
          // (no `=N`) but @types/ws only types the numeric form —
          // cast through unknown to keep the types happy without
          // changing the wire.
          perMessageDeflate: {
            clientMaxWindowBits: true as unknown as number,
          },
          // Extra-long handshake timeout — we've observed up to ~8s on
          // cold paths. The default (none) means it could hang forever.
          handshakeTimeout: 15_000,
        });
      } catch (err) {
        writeEvent(
          "error",
          JSON.stringify({
            message: "upstream-init-failed",
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
        cleanup();
        return;
      }

      upstream.on("open", () => {
        writeEvent("open", "{}");
      });

      upstream.on("message", (raw) => {
        // `ws` emits Buffer / ArrayBuffer / Buffer[] depending on binary
        // vs text. packy.gg broadcasts JSON text, so we coerce to string
        // and forward verbatim.
        let payload: string;
        if (typeof raw === "string") {
          payload = raw;
        } else if (Buffer.isBuffer(raw)) {
          payload = raw.toString("utf8");
        } else if (Array.isArray(raw)) {
          payload = Buffer.concat(raw as Buffer[]).toString("utf8");
        } else if (raw instanceof ArrayBuffer) {
          payload = Buffer.from(new Uint8Array(raw)).toString("utf8");
        } else {
          // Unknown frame kind — skip, don't tear down.
          return;
        }

        // SSE `data:` fields cannot contain raw newlines. Packy payloads
        // are compact JSON (no newlines), but we escape defensively in
        // case the gateway ever pretty-prints.
        if (payload.includes("\n")) {
          payload = payload.replace(/\n/g, "\\n");
        }
        writeEvent("packy", payload);
      });

      upstream.on("close", (code, reason) => {
        // Surface the close code + reason to the client so the devtools
        // console shows *why* the relay dropped. Then tear down — the
        // client will open a fresh EventSource which spawns a new proxy.
        writeEvent(
          "close",
          JSON.stringify({
            code,
            reason: reason ? reason.toString("utf8") : "",
          }),
        );
        cleanup();
      });

      upstream.on("error", (err) => {
        writeEvent(
          "error",
          JSON.stringify({
            message: err.message ?? String(err),
          }),
        );
        // Don't cleanup here — `close` will follow, and we keep teardown
        // centralised in one place to avoid double-close races.
      });

      // Heartbeat comment — SSE comments are ignored by EventSource, but
      // they keep the underlying TCP connection from being idle-closed by
      // intermediaries.
      heartbeat = setInterval(() => {
        if (closed) return;
        write(`:heartbeat\n\n`);
      }, HEARTBEAT_MS);

      // Server-initiated rotation. Vercel caps function execution, so we
      // close cleanly before that cap triggers; client reopens via its
      // EventSource's automatic reconnect.
      rotation = setTimeout(() => {
        if (closed) return;
        writeEvent("reconnect", JSON.stringify({ reason: "rotation" }));
        cleanup();
      }, ROTATION_MS);
    },
    cancel() {
      // The consumer tore down the response. Cleanup runs via the
      // request.signal abort listener registered in start().
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tells intermediaries that respect this header not to buffer the
      // response body. Vercel streams natively so this is a hint only.
      "X-Accel-Buffering": "no",
    },
  });
}
