import { verifySession } from "@/lib/dal";
import https from "node:https";
import crypto from "node:crypto";
import type { Duplex, Writable } from "node:stream";
import WsDefault from "ws";

// `Receiver` and `PerMessageDeflate` are runtime-only exports on the
// ws package (attached to the WebSocket class for CJS interop). They
// are NOT typed by @types/ws, so we narrow minimal shapes ourselves.
type ReceiverLike = Writable & {
  on(
    event: "message",
    cb: (
      data: Buffer | ArrayBuffer | Buffer[] | string,
      isBinary: boolean,
    ) => void,
  ): ReceiverLike;
  on(
    event: "conclude",
    cb: (code: number, reason: Buffer) => void,
  ): ReceiverLike;
  on(event: "error", cb: (err: Error) => void): ReceiverLike;
  removeAllListeners(event?: string): ReceiverLike;
};
type ReceiverCtor = new (opts?: {
  binaryType?: "nodebuffer" | "arraybuffer" | "fragments";
  extensions?: Record<string, unknown>;
  isServer?: boolean;
  maxPayload?: number;
  skipUTF8Validation?: boolean;
}) => ReceiverLike;
type PerMessageDeflateCtor = new (
  options: Record<string, unknown>,
  isServer: boolean,
  maxPayload: number,
) => {
  accept(offers: Record<string, unknown>[]): Record<string, unknown>;
  offer(): Record<string, unknown>;
};
const WsExtras = WsDefault as unknown as {
  Receiver: ReceiverCtor;
  PerMessageDeflate: PerMessageDeflateCtor & { extensionName: string };
};
const Receiver = WsExtras.Receiver;
const PerMessageDeflate = WsExtras.PerMessageDeflate;

/**
 * Server-side proxy for the packy.gg live event stream.
 *
 * Why manual handshake?
 *   The `ws` npm client ALWAYS generates its own random
 *   `Sec-WebSocket-Key` at the handshake request and validates the
 *   server's `Sec-WebSocket-Accept` against that internal key. There's
 *   no public API to force a specific key. To send a handshake whose
 *   headers are 1:1 identical with a known-working browser session —
 *   including the literal `Sec-WebSocket-Key` value — we perform the
 *   HTTP upgrade manually via `https.request({ method: "GET" })` and
 *   then hand the upgraded socket to `ws`'s exported `Receiver` class
 *   for frame decoding.
 *
 *   The WS spec requires the key to be base64 of 16 random bytes — the
 *   server only uses it as an input to
 *   `Sec-WebSocket-Accept = base64(sha1(key + GUID))` and doesn't check
 *   the contents for randomness or uniqueness. So pinning the value
 *   still produces a valid handshake; it's just not RFC-random.
 *
 * Flow:
 *   1. Client opens SSE to `/api/packy-live`.
 *   2. Route opens TLS+HTTPS upgrade to wss://api.packy.gg/v1/ws with
 *      the full reference header set verbatim (see PACKY_WS_HEADERS).
 *   3. On HTTP 101 upgrade, we verify Sec-WebSocket-Accept against our
 *      fixed key, then install a `Receiver` on the raw socket.
 *   4. Every upstream WS text frame is forwarded verbatim as an SSE
 *      `event: packy` so the existing client decoder can parse it.
 *   5. Server-initiated rotation at 4 min — client reopens via
 *      EventSource's native auto-reconnect on the proxy side.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PACKY_HOST = "api.packy.gg";
const PACKY_PATH = "/v1/ws";
const ROTATION_MS = 240_000;
const HEARTBEAT_MS = 15_000;

// RFC 6455 §1.3 — appended to the client key before hashing to produce
// the Sec-WebSocket-Accept value. Constant by spec.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Full handshake header set copied 1:1 from the reference working
 * browser WS to the packy.gg gateway. Sent literally — no library
 * between us and the wire.
 */
const PACKY_WS_KEY = "HA6rWURBabK4mgLQ3rdlrA==";
const PACKY_WS_HEADERS: Record<string, string> = {
  Host: PACKY_HOST,
  Upgrade: "websocket",
  Origin: "https://beta.packy.gg",
  "Cache-Control": "no-cache",
  "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
  Pragma: "no-cache",
  Connection: "Upgrade",
  "Sec-WebSocket-Key": PACKY_WS_KEY,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
};

/**
 * Precomputed — the Sec-WebSocket-Accept value we expect the gateway to
 * return, given the fixed PACKY_WS_KEY. If the response header doesn't
 * match this, we treat it as a failed handshake and tear down.
 */
const EXPECTED_ACCEPT = crypto
  .createHash("sha1")
  .update(PACKY_WS_KEY + WS_GUID)
  .digest("base64");

export async function GET(request: Request): Promise<Response> {
  // Only authenticated admin sessions may open the proxy — otherwise
  // anyone could use the admin host as a free relay to packy.gg.
  try {
    await verifySession();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let req: ReturnType<typeof https.request> | null = null;
      let socket: Duplex | null = null;
      let receiver: ReceiverLike | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let rotation: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (rotation) clearTimeout(rotation);
        if (receiver) {
          try {
            receiver.removeAllListeners();
            receiver.end();
          } catch {
            // Ignore — already closed.
          }
          receiver = null;
        }
        if (socket) {
          try {
            socket.removeAllListeners();
            socket.destroy();
          } catch {
            // Ignore.
          }
          socket = null;
        }
        if (req) {
          try {
            req.destroy();
          } catch {
            // Ignore.
          }
          req = null;
        }
        try {
          controller.close();
        } catch {
          // Already closed.
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

      // Browser aborts the SSE response when the tab closes / navigates.
      // Tear down everything so we don't keep an upstream WS alive for
      // a ghost consumer.
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup, { once: true });

      // ── 1. HTTPS upgrade with the exact reference handshake ───────
      try {
        req = https.request({
          host: PACKY_HOST,
          port: 443,
          path: PACKY_PATH,
          method: "GET",
          headers: PACKY_WS_HEADERS,
          timeout: 15_000,
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

      req.on("error", (err) => {
        writeEvent(
          "error",
          JSON.stringify({
            message: err.message ?? String(err),
            phase: "request",
          }),
        );
        cleanup();
      });

      req.on("response", (res) => {
        // The server refused the upgrade — we got a regular HTTP
        // response instead. Surface the status so the client can see
        // e.g. 403/401 and report it.
        writeEvent(
          "error",
          JSON.stringify({
            message: "upstream-did-not-upgrade",
            status: res.statusCode ?? 0,
          }),
        );
        cleanup();
      });

      req.on("upgrade", (res, rawSocket, head) => {
        if (closed) {
          rawSocket.destroy();
          return;
        }

        // ── 2. Verify Sec-WebSocket-Accept against our fixed key ────
        const accept = res.headers["sec-websocket-accept"];
        if (accept !== EXPECTED_ACCEPT) {
          writeEvent(
            "error",
            JSON.stringify({
              message: "accept-mismatch",
              expected: EXPECTED_ACCEPT,
              got: String(accept ?? "(none)"),
            }),
          );
          rawSocket.destroy();
          cleanup();
          return;
        }

        socket = rawSocket;

        // ── 3. Set up frame decoding ────────────────────────────────
        // The server may or may not negotiate permessage-deflate (it
        // depends on their config). Parse Sec-WebSocket-Extensions and
        // wire up PerMessageDeflate if so.
        const extHeader = res.headers["sec-websocket-extensions"];
        const extensions: Record<string, unknown> = {};
        if (extHeader && String(extHeader).includes("permessage-deflate")) {
          const pmd = new PerMessageDeflate(
            {},
            false, // isServer = false (we are the client)
            100 * 1024 * 1024, // 100MB cap — matches ws's default upper bound
          );
          // `pmd.accept(...)` primes the extension with the server's
          // offer. Empty object = "use negotiated defaults", which is
          // what we want for standard permessage-deflate with no extra
          // params.
          try {
            pmd.accept([{}]);
            extensions[PerMessageDeflate.extensionName] = pmd;
          } catch {
            // If negotiation somehow fails, fall back to uncompressed
            // — the server will send compressed frames anyway and the
            // receiver will emit errors, surfaced below.
          }
        }

        receiver = new Receiver({
          binaryType: "nodebuffer",
          extensions,
          isServer: false,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
        });

        receiver.on("message", (data, isBinary) => {
          // packy.gg broadcasts compact JSON text frames. We stringify
          // defensively in case anything arrives as a Buffer.
          let payload: string;
          if (typeof data === "string") {
            payload = data;
          } else if (Buffer.isBuffer(data)) {
            payload = data.toString("utf8");
          } else if (Array.isArray(data)) {
            payload = Buffer.concat(data as Buffer[]).toString("utf8");
          } else if (data instanceof ArrayBuffer) {
            payload = Buffer.from(new Uint8Array(data)).toString("utf8");
          } else {
            return;
          }
          if (isBinary) {
            // Shouldn't happen for this gateway but forward anyway as
            // a best-effort string — the client will log + skip if
            // parseJson fails.
          }
          if (payload.includes("\n")) {
            payload = payload.replace(/\n/g, "\\n");
          }
          writeEvent("packy", payload);
        });

        receiver.on("conclude", (code, reason) => {
          writeEvent(
            "close",
            JSON.stringify({
              code,
              reason: reason?.toString("utf8") ?? "",
            }),
          );
          cleanup();
        });

        receiver.on("error", (err) => {
          writeEvent(
            "error",
            JSON.stringify({
              message: err.message ?? String(err),
              phase: "receiver",
            }),
          );
          cleanup();
        });

        // Hand data from the socket into the receiver. `head` is any
        // bytes that already arrived in the upgrade packet — feed
        // those first so nothing is lost.
        if (head && head.length > 0) {
          receiver.write(head);
        }
        rawSocket.on("data", (chunk) => {
          if (closed || !receiver) return;
          receiver.write(chunk);
        });
        rawSocket.on("close", () => {
          if (!closed) {
            writeEvent(
              "close",
              JSON.stringify({ code: 1006, reason: "socket-closed" }),
            );
            cleanup();
          }
        });
        rawSocket.on("error", (err) => {
          writeEvent(
            "error",
            JSON.stringify({
              message: err.message ?? String(err),
              phase: "socket",
            }),
          );
          cleanup();
        });

        // Tell the SSE client the upstream is up — the hook flips its
        // status to "open".
        writeEvent("open", "{}");
      });

      req.end();

      // ── 4. Keepalives + rotation ──────────────────────────────────
      heartbeat = setInterval(() => {
        if (closed) return;
        write(`:heartbeat\n\n`);
      }, HEARTBEAT_MS);

      rotation = setTimeout(() => {
        if (closed) return;
        writeEvent("reconnect", JSON.stringify({ reason: "rotation" }));
        cleanup();
      }, ROTATION_MS);
    },
    cancel() {
      // Consumer disconnected. Cleanup fires via request.signal abort.
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
