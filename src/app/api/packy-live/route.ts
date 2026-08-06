import {
  getUserPermissions,
  sessionIsAdmin,
  sessionIsOwner,
  verifySession,
} from "@/lib/dal";
import { pageAccessGranted } from "@/lib/admin-pages";
import { resolveBackendApiConfig } from "@/lib/backend-api/config";
import { requireAntifraudReadAccess } from "@/lib/require-antifraud-access";
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
 * Authenticated SSE proxy for the existing packy.gg WebSocket. Chat and
 * identifier-only gaming activity are filtered independently per staff access.
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

const ROTATION_MS = 240_000;
const HEARTBEAT_MS = 15_000;
/** Reconnect delay advertised to the browser's own EventSource retry. */
const CLIENT_RETRY_MS = 10_000;
/** Longer pause on a capacity refusal so the per-user counter can drain. */
const CAPACITY_RETRY_MS = 15_000;
const PRODUCTION_DASHBOARD_ORIGIN = "https://packydash.com";
const PRODUCTION_FRAUD_ORIGIN = "https://fraud.packydash.com";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Stable browser-compatible handshake headers. The target host,
 * privileged credential and random nonce are derived per connection.
 */
const PACKY_WS_BASE_HEADERS: Record<string, string> = {
  Upgrade: "websocket",
  "Cache-Control": "no-cache",
  "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
  Pragma: "no-cache",
  Connection: "Upgrade",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Sec-WebSocket-Version": "13",
  "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
};

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "private, no-store, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  Vary: "Cookie, Origin",
};

/**
 * A 200 `text/event-stream` response that carries a single terminal frame and
 * then ends. Mirrors `api/antifraud/monitor/stream/route.ts`.
 *
 * Per the HTML spec a NON-2xx response makes an EventSource fail PERMANENTLY —
 * `readyState` goes CLOSED and the browser never retries. Answering a capacity
 * or backend refusal with a bare 429/503 therefore killed this live wire for
 * the whole life of the page while the UI still claimed "Live". A clean 2xx EOF
 * lets the browser reconnect on its own after `retry:` instead.
 *
 * `fatal: true` additionally emits an `event: fatal` frame so the client stops
 * retrying permanently. Only a permanent refusal may set it — a capacity
 * refusal must keep the normal `retry:`-spaced reconnect so the counter drains.
 */
function terminalStream(
  message: string,
  retryMs: number,
  fatal = false,
): Response {
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const body =
    `retry: ${retryMs}\n\n` +
    frame("upstream-error", { message, terminal: true }) +
    (fatal ? frame("fatal", { message }) : "");
  return new Response(new TextEncoder().encode(body), { headers: SSE_HEADERS });
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function filterPayload(
  raw: string,
  canReceiveChat: boolean,
  canReceiveGaming: boolean,
): string | null {
  try {
    const event = JSON.parse(raw) as {
      type?: unknown;
      payload?: { topics?: unknown };
    };
    if (
      canReceiveChat &&
      (event.type === "chat.pull.history" ||
        event.type === "active.users.count")
    ) {
      return raw;
    }
    if (
      !canReceiveGaming ||
      event.type !== "admin.activity" ||
      !Array.isArray(event.payload?.topics) ||
      !event.payload.topics.includes("gaming")
    ) {
      return null;
    }
    event.payload.topics = ["gaming"];
    return JSON.stringify(event);
  } catch {
    return null;
  }
}

// Per-user concurrent-stream cap. Maps `userId → openCount` for THIS
// route in THIS Node.js process. Caps at 3 so a single admin tab-storm
// can't pin three SSE-rotating proxy upstreams + crowd out other admins.
//
// In-memory only: each Vercel function instance has its own map, so the
// real ceiling is `MAX_CONCURRENT × instance_count`. Acceptable until a
// shared cache is wired up.
// Headroom (was 1) for rotation overlap + multi-tab; client singleton is
// the real per-tab limiter. 1 caused 429 lockouts on reconnect.
const MAX_CONCURRENT = 4;
const openStreams = new Map<string, number>();

export async function GET(request: Request): Promise<Response> {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const trustedOrigins = new Set([
    PRODUCTION_DASHBOARD_ORIGIN,
    PRODUCTION_FRAUD_ORIGIN,
  ]);
  const trustedRequestOrigin =
    trustedOrigins.has(requestOrigin) ||
    (process.env.NODE_ENV !== "production" && isLoopbackOrigin(requestOrigin));
  if (
    !trustedRequestOrigin ||
    (origin != null &&
      (origin !== requestOrigin || !trustedOrigins.has(origin)) &&
      !(
        process.env.NODE_ENV !== "production" &&
        origin === requestOrigin &&
        isLoopbackOrigin(origin)
      )) ||
    (fetchSite != null && fetchSite !== "same-origin")
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  // Authenticate against current DB-backed roles. The two upstream feeds are
  // authorized independently so Antifraud access never grants chat access.
  let userId: string;
  let canReceiveChat = false;
  let canReceiveGaming = false;
  try {
    const session = await verifySession();
    userId = session.userId;
    const fullAccess = sessionIsAdmin(session) || sessionIsOwner(session);
    const permissions = fullAccess
      ? []
      : await getUserPermissions(session.userId);
    canReceiveChat =
      fullAccess || pageAccessGranted(permissions, "/chat");
    canReceiveGaming =
      fullAccess || pageAccessGranted(permissions, "/users");
    if (!canReceiveGaming) {
      try {
        await requireAntifraudReadAccess();
        canReceiveGaming = true;
      } catch {
        // Antifraud access is independent from normal admin page permissions.
      }
    }
    if (!canReceiveChat && !canReceiveGaming) {
      return new Response("Forbidden", { status: 403 });
    }
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  let upstream: {
    headers: Record<string, string>;
    host: string;
    port: number;
    path: string;
    expectedAccept: string;
  };
  try {
    const backend = await resolveBackendApiConfig();
    const backendUrl = new URL(backend.baseUrl);
    if (backendUrl.protocol !== "https:") {
      throw new Error("Live backend must use HTTPS");
    }
    const websocketKey = crypto.randomBytes(16).toString("base64");
    upstream = {
      host: backendUrl.hostname,
      port: Number(backendUrl.port || "443"),
      path: `${backendUrl.pathname.replace(/\/+$/, "")}/ws`,
      expectedAccept: crypto
        .createHash("sha1")
        .update(websocketKey + WS_GUID)
        .digest("base64"),
      headers: {
        ...PACKY_WS_BASE_HEADERS,
        ...backend.cfHeaders,
        ...backend.bypassHeaders,
        Host: backendUrl.host,
        // The backend's privileged WS allowlist is intentionally pinned to
        // the apex dashboard origin. The browser-facing route independently
        // verifies the exact apex/fraud origin above before this handshake.
        Origin: PRODUCTION_DASHBOARD_ORIGIN,
        "Sec-WebSocket-Key": websocketKey,
        "x-api-key": backend.adminKey,
      },
    };
  } catch (error) {
    console.error("[packy-live] backend unavailable", error);
    // Permanent for this page load: the backend config could not be resolved,
    // so reconnecting changes nothing until the deployment does.
    return terminalStream(
      "The live backend is unavailable.",
      CLIENT_RETRY_MS,
      true,
    );
  }

  const currentOpen = openStreams.get(userId) ?? 0;
  if (currentOpen >= MAX_CONCURRENT) {
    // Transient: another tab (or a rotation overlap) holds the slots. NOT
    // fatal — the client must keep its `retry:`-spaced reconnect.
    return terminalStream(
      "Too many live streams open for this account — retrying automatically.",
      CAPACITY_RETRY_MS,
    );
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
  let cancelStream: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let upstreamFailed = false;
      let req: ReturnType<typeof https.request> | null = null;
      let socket: Duplex | null = null;
      let receiver: ReceiverWithEvents | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let rotation: ReturnType<typeof setTimeout> | null = null;

      const cleanupUpstream = () => {
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
            req.removeAllListeners();
            req.destroy();
          } catch {
            // ignore
          }
          req = null;
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        // Decrement the per-user open-stream counter on close/abort/error
        // so a 4th tab can connect once one of the first 3 hangs up. The
        // helper is idempotent — calling it twice is safe.
        decrementOnce();
        if (heartbeat) clearInterval(heartbeat);
        if (rotation) clearTimeout(rotation);
        cleanupUpstream();
        cancelStream = null;
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
        // SSE framing per spec: a payload may contain newlines (e.g. a
        // pretty-printed upstream JSON frame on the raw chat passthrough).
        // Emit one `data:` line per segment — EventSource rejoins them
        // with "\n" client-side, so this is lossless for any payload.
        // Escaping (`\n` → `\\n`) would corrupt passthrough JSON instead,
        // and a bare `\r` would still break framing.
        const dataLines = data
          .split(/\r\n|\r|\n/)
          .map((line) => `data: ${line}`)
          .join("\n");
        write(`event: ${event}\n${dataLines}\n\n`);
      };

      const failUpstream = (detail: Record<string, unknown>) => {
        if (closed || upstreamFailed) return;
        upstreamFailed = true;
        console.warn("[packy-live] upstream unavailable", detail);
        writeEvent("upstream-error", JSON.stringify(detail));
        setTimeout(cleanup, 0);
      };

      cancelStream = cleanup;
      write(`retry: ${CLIENT_RETRY_MS}\n\n`);

      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup, { once: true });

      try {
        req = https.request({
          host: upstream.host,
          port: upstream.port,
          path: upstream.path,
          method: "GET",
          headers: upstream.headers,
          timeout: 15_000,
        });
      } catch (err) {
        failUpstream({
          message: "upstream-init-failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        req = null;
      }

      if (req) {
        const activeReq = req;
        const activeUpstream = upstream;

        activeReq.on("error", (err) => {
          failUpstream({
            message: err.message ?? String(err),
            phase: "request",
          });
        });

        activeReq.on("response", (res) => {
          res.resume();
          failUpstream({
            message: "upstream-did-not-upgrade",
            status: res.statusCode ?? 0,
          });
        });

        activeReq.on("timeout", () => {
          failUpstream({ message: "upstream-timeout", phase: "request" });
        });

        activeReq.on("upgrade", (res, rawSocket, head) => {
          if (closed) {
            rawSocket.destroy();
            return;
          }

          const accept = res.headers["sec-websocket-accept"];
          if (accept !== activeUpstream.expectedAccept) {
            rawSocket.destroy();
            failUpstream({
              message: "accept-mismatch",
              got: String(accept ?? "(none)"),
            });
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
              rawSocket.destroy();
              failUpstream({
                message:
                  "PerMessageDeflate not available — ws import misresolved",
              });
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
            rawSocket.destroy();
            failUpstream({
              message: "Receiver not available — ws import misresolved",
            });
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
            const filteredPayload = filterPayload(
              payload,
              canReceiveChat,
              canReceiveGaming,
            );
            if (filteredPayload == null) return;
            writeEvent("packy", filteredPayload);
          });

          receiver.on("conclude", (code, reason) => {
            failUpstream({
              message: "upstream-closed",
              code,
              reason: reason?.toString("utf8") ?? "",
            });
          });

          receiver.on("error", (err) => {
            failUpstream({
              message: err.message ?? String(err),
              phase: "receiver",
            });
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
              failUpstream({
                message: "upstream-closed",
                code: 1006,
                reason: "socket-closed",
              });
            }
          });
          rawSocket.on("error", (err) => {
            failUpstream({
              message: err.message ?? String(err),
              phase: "socket",
            });
          });

          // ── Opt into the feeds we care about ────────────────────────
          // The gateway broadcasts `active.users.count` without any action
          // from us, but the chat feed is pull-based: the client has to
          // send `chat.pull.feed.subscribe` after the handshake to start
          // receiving `chat.pull.history` frames. Confirmed end-to-end via
          // the probe scripts in scripts/test-packy-ws-*.mjs.
          //
          // We deliberately do NOT subscribe to `live.pull.feed.subscribe`
          // anymore: no admin UI renders the pull feed (the only consumer,
          // usePackyWsLivePulls, was removed), so pulling those frames just
          // burned upstream bandwidth + proxy work for data nobody reads.
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
              ...(canReceiveChat
                ? [{ type: "chat.pull.feed.subscribe" }]
                : []),
              ...(canReceiveGaming
                ? [{ type: "admin.activity.feed.subscribe" }]
                : []),
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
                failUpstream({
                  phase: "subscribe",
                  message: err instanceof Error ? err.message : String(err),
                });
              }
            }
          } else {
            failUpstream({
              message: "Sender not available — ws import misresolved",
            });
          }

          writeEvent("upstream-open", "{}");
        });

        activeReq.end();
      }

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
      cancelStream?.();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
