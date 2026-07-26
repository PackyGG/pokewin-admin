import {
  getUserPermissions,
  sessionIsAdmin,
  sessionIsOwner,
  verifySession,
} from "@/lib/dal";
import { pageAccessGranted } from "@/lib/admin-pages";
import {
  subscribeAdminLiveActivity,
  type AdminLiveTopic as AdminActivityTopic,
} from "@/lib/admin-live-activity";
import { resolveBackendApiConfig } from "@/lib/backend-api/config";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { revalidateTag } from "next/cache";
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
 * One authenticated SSE endpoint for dashboard live data. Chat is proxied
 * from the existing packy.gg WebSocket; admin activity is detected locally
 * through shared, read-only MAIN DB snapshots. Nothing outside this repo
 * needs an admin-specific WebSocket protocol.
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
const PRODUCTION_DASHBOARD_ORIGIN = "https://packydash.com";

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

function filterAndInvalidateAdminActivity(
  raw: string,
  allowedTopics: ReadonlySet<AdminActivityTopic>,
  canReceiveChat: boolean,
): string | null {
  try {
    const event = JSON.parse(raw) as {
      type?: unknown;
      payload?: {
        user_id?: unknown;
        topics?: unknown;
      };
    };
    if (event.type === "chat.pull.history") {
      return canReceiveChat ? raw : null;
    }
    if (event.type !== "admin.activity") return null;
    if (!Array.isArray(event.payload?.topics)) return null;
    const topics = event.payload.topics.filter(
      (topic): topic is AdminActivityTopic =>
        typeof topic === "string" &&
        allowedTopics.has(topic as AdminActivityTopic),
    );
    if (topics.length === 0) {
      return null;
    }
    const topicSet = new Set(topics);
    if (topicSet.has("deposits")) {
      revalidateTag("transactions-deposits-list");
    }
    if (topicSet.has("withdrawals")) {
      revalidateTag("transactions-withdrawals-list");
    }
    // These writes feed the dashboard's short-lived activity aggregates.
    // Evict the shared tag so a live refresh cannot serve a still-warm entry.
    if (
      topicSet.has("deposits") ||
      topicSet.has("card_payments") ||
      topicSet.has("withdrawals") ||
      topicSet.has("balance") ||
      topicSet.has("gaming")
    ) {
      revalidateTag("dashboard-activity");
    }
    if (typeof event.payload.user_id === "string") {
      revalidateTag(`users-detail-${event.payload.user_id}`);
    }
    event.payload.topics = topics;
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
  const trustedOrigins = new Set([PRODUCTION_DASHBOARD_ORIGIN]);
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

  // Authenticate against current DB-backed roles, then derive the exact
  // live topic families this staff member may receive.
  let userId: string;
  let allowedTopics: Set<AdminActivityTopic>;
  let canReceiveChat: boolean;
  let dbEnv: DbEnv | null = null;
  try {
    const session = await verifySession();
    userId = session.userId;
    const fullAccess = sessionIsAdmin(session) || sessionIsOwner(session);
    const permissions = fullAccess
      ? []
      : await getUserPermissions(session.userId);
    const canViewUsers = fullAccess || pageAccessGranted(permissions, "/users");
    const canViewTransactions =
      fullAccess || pageAccessGranted(permissions, "/transactions/deposits");
    canReceiveChat = fullAccess || pageAccessGranted(permissions, "/chat");
    allowedTopics = new Set<AdminActivityTopic>();
    if (canViewUsers) {
      allowedTopics.add("balance");
      allowedTopics.add("gaming");
    }
    if (canViewTransactions) {
      allowedTopics.add("deposits");
      allowedTopics.add("card_payments");
      allowedTopics.add("withdrawals");
    }
    if (allowedTopics.size === 0 && !canReceiveChat) {
      return new Response("Forbidden", { status: 403 });
    }
    if (allowedTopics.size > 0) {
      dbEnv = await readDbEnv();
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
  } | null = null;
  if (canReceiveChat) {
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
          Host: backendUrl.host,
          Origin: requestOrigin,
          "Sec-WebSocket-Key": websocketKey,
          "x-api-key": backend.adminKey,
        },
      };
    } catch (error) {
      // Activity events are produced locally from read-only MAIN DB queries,
      // so missing chat configuration must not take deposits/withdrawals/users
      // offline with it.
      console.error("[packy-live] chat backend unavailable", error);
    }
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
      let unsubscribeActivity: (() => void) | null = null;
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
        unsubscribeActivity?.();
        unsubscribeActivity = null;
        cleanupUpstream();
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

      if (dbEnv && allowedTopics.size > 0) {
        unsubscribeActivity = subscribeAdminLiveActivity(
          dbEnv,
          allowedTopics,
          (event) => {
            const payload = filterAndInvalidateAdminActivity(
              JSON.stringify(event),
              allowedTopics,
              canReceiveChat,
            );
            if (payload) writeEvent("packy", payload);
          },
        );
      }

      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", cleanup, { once: true });

      if (!upstream) {
        writeEvent(
          "open",
          JSON.stringify({
            activity: dbEnv ? "connected" : "disabled",
            chat: canReceiveChat ? "unavailable" : "disabled",
          }),
        );
      } else {
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
          writeEvent(
            "error",
            JSON.stringify({
              message: "upstream-init-failed",
              detail: err instanceof Error ? err.message : String(err),
            }),
          );
          req = null;
        }
      }

      if (req && upstream) {
        const activeReq = req;
        const activeUpstream = upstream;

        activeReq.on("error", (err) => {
          writeEvent(
            "error",
            JSON.stringify({
              message: err.message ?? String(err),
              phase: "request",
            }),
          );
          cleanupUpstream();
        });

        activeReq.on("response", (res) => {
          writeEvent(
            "error",
            JSON.stringify({
              message: "upstream-did-not-upgrade",
              status: res.statusCode ?? 0,
            }),
          );
          res.resume();
          cleanupUpstream();
        });

        activeReq.on("timeout", () => {
          writeEvent(
            "error",
            JSON.stringify({ message: "upstream-timeout", phase: "request" }),
          );
          cleanupUpstream();
        });

        activeReq.on("upgrade", (res, rawSocket, head) => {
          if (closed) {
            rawSocket.destroy();
            return;
          }

          const accept = res.headers["sec-websocket-accept"];
          if (accept !== activeUpstream.expectedAccept) {
            writeEvent(
              "error",
              JSON.stringify({
                message: "accept-mismatch",
                expected: activeUpstream.expectedAccept,
                got: String(accept ?? "(none)"),
              }),
            );
            rawSocket.destroy();
            cleanupUpstream();
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
              cleanupUpstream();
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
            cleanupUpstream();
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
            const filteredPayload = filterAndInvalidateAdminActivity(
              payload,
              allowedTopics,
              canReceiveChat,
            );
            if (filteredPayload == null) return;
            payload = filteredPayload;
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
            cleanupUpstream();
          });

          receiver.on("error", (err) => {
            writeEvent(
              "error",
              JSON.stringify({
                message: err.message ?? String(err),
                phase: "receiver",
              }),
            );
            cleanupUpstream();
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
              cleanupUpstream();
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
            cleanupUpstream();
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
              ...(canReceiveChat ? [{ type: "chat.pull.feed.subscribe" }] : []),
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
      // abort listener handles cleanup
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      Vary: "Cookie, Origin",
    },
  });
}
