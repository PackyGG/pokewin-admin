import { requirePageAccess } from "@/lib/dal";
import https from "node:https";
import crypto from "node:crypto";
import type { Duplex, Writable } from "node:stream";
// Namespace import — we need `Receiver` + `PerMessageDeflate` which
// the ws package exports as top-level names from its ESM entry
// (wrapper.mjs). `import WsDefault from "ws"` ONLY gives the
// WebSocket class in ESM (the CJS `WebSocket.Receiver` attribute
// isn't set on the ESM default export), so the previous
// `as unknown as { Receiver }` cast hit an undefined at runtime and
// the proxy silently failed on every upgrade. @types/ws doesn't
// declare these names, but the runtime values exist — grab them off
// the namespace import and cast to the constructor shapes.
import * as ws from "ws";

/**
 * Server-side proxy for the packy.gg live event stream. Opens the
 * upstream WebSocket with the exact handshake headers the browser
 * reference uses (browsers can't set Origin / Sec-WebSocket-Key
 * directly — the spec pins them), then fans every message out to
 * authenticated admins over SSE.
 */

// `Receiver` is a Writable stream but the @types/ws package doesn't
// export its class type — narrow the minimum shape we rely on so the
// strict-mode build stays honest.
type ReceiverWithEvents = Writable & {
  on(
    event: "message",
    cb: (
      data: Buffer | ArrayBuffer | Buffer[] | string,
      isBinary: boolean,
    ) => void,
  ): ReceiverWithEvents;
  on(
    event: "conclude",
    cb: (code: number, reason: Buffer) => void,
  ): ReceiverWithEvents;
  on(event: "error", cb: (err: Error) => void): ReceiverWithEvents;
  removeAllListeners(event?: string): ReceiverWithEvents;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PACKY_HOST = "api.packy.gg";
const PACKY_PATH = "/v1/ws";
const ROTATION_MS = 240_000;
const HEARTBEAT_MS = 15_000;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Full handshake header set copied 1:1 from the reference browser WS
 * to the packy.gg gateway. Sent literally — manual HTTP upgrade so
 * the `ws` library can't rewrite Sec-WebSocket-Key.
 */
const PACKY_WS_KEY = "LMUTEH207xvS5FA2bTrXCw==";
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

const EXPECTED_ACCEPT = crypto
  .createHash("sha1")
  .update(PACKY_WS_KEY + WS_GUID)
  .digest("base64");

// Per-user concurrent-stream cap. Maps `userId → openCount` for THIS
// route in THIS Node.js process. Caps at 3 so a single admin tab-storm
// can't pin three SSE-rotating proxy upstreams + crowd out other admins.
//
// In-memory only: each Vercel function instance has its own map, so the
// real ceiling is `MAX_CONCURRENT × instance_count`. Acceptable until a
// shared cache is wired up.
const MAX_CONCURRENT = 1;
const openStreams = new Map<string, number>();

export async function GET(request: Request): Promise<Response> {
  // Match the rest of the live SSE family — gate on the dashboard
  // capability so non-admin roles without /dashboard access can't open
  // a long-running upstream proxy. requirePageAccess throws via Next's
  // redirect() on failure, which is meaningless for an SSE endpoint.
  // Catch + return 401 so the EventSource client sees the failure.
  let userId: string;
  try {
    const session = await requirePageAccess("/dashboard");
    userId = session.userId;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

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

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let req: ReturnType<typeof https.request> | null = null;
      let socket: Duplex | null = null;
      let receiver: ReceiverWithEvents | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let rotation: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        // Decrement the per-user open-stream counter on close/abort/error
        // so a 4th tab can connect once one of the first 3 hangs up. The
        // helper is idempotent — calling it twice is safe.
        decrementOnce();
        if (heartbeat) clearInterval(heartbeat);
        if (rotation) clearTimeout(rotation);
        if (receiver) {
          try {
            receiver.removeAllListeners();
            receiver.end();
          } catch {
            // ignore
          }
          receiver = null;
        }
        if (socket) {
          try {
            socket.removeAllListeners();
            socket.destroy();
          } catch {
            // ignore
          }
          socket = null;
        }
        if (req) {
          try {
            req.destroy();
          } catch {
            // ignore
          }
          req = null;
        }
        try {
          controller.close();
        } catch {
          // ignore
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

      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup, { once: true });

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

        const extHeader = res.headers["sec-websocket-extensions"];
        const extensions: Record<string, unknown> = {};
        if (extHeader && String(extHeader).includes("permessage-deflate")) {
          // PerMessageDeflate constructor args: (options, isServer,
          // maxPayload). @types/ws doesn't expose this class, so we
          // grab it off the namespace import and cast to the real
          // constructor shape. `extensionName` is a static on the
          // class ("permessage-deflate") used as the extensions-map
          // key Receiver expects.
          const PmdCtor = (
            ws as unknown as {
              PerMessageDeflate: {
                new (
                  options: Record<string, unknown>,
                  isServer: boolean,
                  maxPayload: number,
                ): {
                  accept(
                    offers: Record<string, unknown>[],
                  ): Record<string, unknown>;
                };
                extensionName: string;
              };
            }
          ).PerMessageDeflate;
          if (typeof PmdCtor !== "function") {
            writeEvent(
              "error",
              JSON.stringify({
                message:
                  "PerMessageDeflate not available — ws import misresolved",
              }),
            );
            rawSocket.destroy();
            cleanup();
            return;
          }
          const pmd = new PmdCtor({}, false, 100 * 1024 * 1024);
          try {
            pmd.accept([{}]);
            extensions[PmdCtor.extensionName] = pmd;
          } catch {
            // fall back uncompressed
          }
        }

        // @types/ws doesn't export Receiver either — same namespace
        // cast pattern.
        const ReceiverCtor = (
          ws as unknown as {
            Receiver: new (opts?: {
              binaryType?: "nodebuffer" | "arraybuffer" | "fragments";
              extensions?: Record<string, unknown>;
              isServer?: boolean;
              maxPayload?: number;
              skipUTF8Validation?: boolean;
            }) => ReceiverWithEvents;
          }
        ).Receiver;
        if (typeof ReceiverCtor !== "function") {
          writeEvent(
            "error",
            JSON.stringify({
              message: "Receiver not available — ws import misresolved",
            }),
          );
          rawSocket.destroy();
          cleanup();
          return;
        }
        receiver = new ReceiverCtor({
          binaryType: "nodebuffer",
          extensions,
          isServer: false,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
        });

        receiver.on("message", (data) => {
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

        // ── Opt into the feeds we care about ────────────────────────
        // The gateway broadcasts `active.users.count` without any
        // action from us, but pull + chat feeds are pull-based: the
        // client has to send a `*.feed.subscribe` message after the
        // handshake to start receiving `live.pull.history` /
        // `chat.pull.history` frames. Without these, pulls never
        // arrive — confirmed end-to-end via the probe scripts in
        // scripts/test-packy-ws-*.mjs.
        //
        // Send via ws.Sender so the frames are properly masked (WS
        // spec requires client→server text frames to be masked).
        const SenderCtor = (
          ws as unknown as {
            Sender: new (
              socket: Duplex,
              extensions: Record<string, unknown>,
            ) => {
              send(
                data: string | Buffer,
                options: {
                  binary: boolean;
                  mask: boolean;
                  fin: boolean;
                  compress: boolean;
                },
              ): void;
            };
          }
        ).Sender;
        if (typeof SenderCtor === "function") {
          const sender = new SenderCtor(rawSocket, extensions);
          const subscribes = [
            { type: "live.pull.feed.subscribe" },
            { type: "chat.pull.feed.subscribe" },
          ];
          for (const msg of subscribes) {
            try {
              sender.send(JSON.stringify(msg), {
                binary: false,
                mask: true,
                fin: true,
                compress: false,
              });
            } catch (err) {
              writeEvent(
                "error",
                JSON.stringify({
                  phase: "subscribe",
                  msg: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          }
        } else {
          writeEvent(
            "error",
            JSON.stringify({
              message: "Sender not available — ws import misresolved",
            }),
          );
        }

        writeEvent("open", "{}");
      });

      req.end();

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
      // abort listener handles cleanup
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
