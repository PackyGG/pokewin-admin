import WebSocket from "ws";

import { requireAntifraudReadAccess } from "@/lib/require-antifraud-access";
import { buildCacheKey, rateLimit } from "@/lib/cache/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * SSE proxy for the antifraud monitor's websocket feed.
 *
 * Wire format matches `sseResponse` in `@/lib/sse` so the browser side can use
 * the shared `useSseStream` hook:
 *   - `event: row`        → one monitor frame (`{ id, type, at, data }`)
 *   - `id: <redis-id>`    → replay cursor retained by EventSource
 *
 * Resilience contract (the reason this route is not a thin pipe):
 *   1. A transient upstream blip must NOT end the SSE response. The websocket
 *      is reconnected INSIDE the route with jittered exponential backoff, and
 *      the client is told about it through `transport` frames.
 *   2. A refusal must NEVER be a non-2xx response. Per the HTML spec an
 *      EventSource that receives a non-2xx (or a non-`text/event-stream`)
 *      response fails the connection PERMANENTLY, which turned a 30-second
 *      redeploy into a dead console. Capacity refusals therefore return 200
 *      with a terminal `transport` frame instead. Auth failures (401/403) keep
 *      their status on purpose — a logged-out session must not be retried.
 *   3. The heartbeat is a real `transport` frame, not an SSE comment, so the
 *      client can detect a silently stalled connection (comments are invisible
 *      to EventSource) as well as keeping proxies from closing the socket.
 *   4. The upstream websocket is pinged every 20s and terminated when no
 *      message/pong arrives for 60s, so a half-open TCP connection can't keep
 *      the heartbeat reporting "open" while no events flow.
 *   5. Permanent refusals (unconfigured service, auth-shaped rejections) also
 *      emit an `event: fatal` frame so the client stops retrying for good.
 *      The rate-limit refusal deliberately does NOT send `fatal` — the
 *      client's normal `retry:`-spaced EventSource reconnect drains it.
 *   6. Rotation writes an `event: reconnect` frame right before closing so
 *      the client reopens instantly (cursor preserved) instead of waiting
 *      out the 15s retry window.
 *   7. Replay is best-effort: after 2 consecutive replay failures the route
 *      goes live without history, and a replay overflow or truncated replay
 *      is surfaced to the UI instead of wedging the reconnect loop.
 */

const HEARTBEAT_MS = 15_000;
const MAX_FRAME_BYTES = 128_000;
const MAX_STREAM_STARTS_PER_MINUTE = 10;
/** Rotate well under `maxDuration` so the client reopens gracefully. */
const ROTATE_AFTER_MS = 240_000;
const UPSTREAM_RETRY_MIN_MS = 1_000;
const UPSTREAM_RETRY_MAX_MS = 30_000;
/** Ping the upstream socket this often to catch half-open TCP connections. */
const UPSTREAM_PING_MS = 20_000;
/** Terminate the upstream socket when no message/pong arrives in this window. */
const UPSTREAM_IDLE_MS = 60_000;
/** After this many consecutive replay failures, go live without history. */
const REPLAY_FAILURE_LIMIT = 2;
/** Pending live frames beyond this during replay → drop the replay, go live. */
const REPLAY_PENDING_LIMIT = 500;
const REPLAY_TRUNCATED_MESSAGE = "History truncated — refresh for full state";
const CAPACITY_RETRY_MIN_MS = 15_000;
/** Reconnect delay advertised to the browser's own EventSource retry. */
const CLIENT_RETRY_MS = 15_000;

const SSE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream; charset=utf-8",
  "X-Accel-Buffering": "no",
  "X-Content-Type-Options": "nosniff",
};

type TransportState = "connecting" | "open" | "closed" | "unconfigured" | "error";
type LiveEnvelope = {
  id: string;
  schemaVersion: 1;
  correlationId: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
};

const REPLAY_ID = /^\d+-\d+$/;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 60_000;

function monitorConfig(): { baseUrl?: string; token?: string } {
  return {
    baseUrl: process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, ""),
    token: process.env.ANTIFRAUD_MONITOR_API_TOKEN,
  };
}

function transport(
  state: TransportState,
  message?: string,
  terminal = false,
): { type: "transport"; at: string; data: Record<string, unknown> } {
  return {
    type: "transport",
    at: new Date().toISOString(),
    data: {
      state,
      ...(message ? { message } : {}),
      ...(terminal ? { terminal: true } : {}),
    },
  };
}

function sseFrame(event: string, value: unknown, id?: string): string {
  const cursor = id && REPLAY_ID.test(id) ? `id: ${id}\n` : "";
  return `${cursor}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

/**
 * A 200 `text/event-stream` response that carries a single terminal transport
 * frame and then ends. Used for every capacity refusal so the browser's
 * EventSource is not permanently poisoned by a non-2xx status.
 *
 * `fatal: true` additionally emits an `event: fatal` frame so the client hook
 * stops retrying permanently. Only permanent refusals (unconfigured service,
 * auth-shaped rejections) may set it — a rate-limit refusal must keep the
 * client's normal `retry:`-spaced reconnect so the limiter can drain.
 */
function terminalStream(
  state: TransportState,
  message: string,
  fatal = false,
): Response {
  const body =
    `retry: ${CLIENT_RETRY_MS}\n\n` +
    sseFrame("row", transport(state, message, true)) +
    (fatal ? sseFrame("fatal", { message }) : "");
  return new Response(new TextEncoder().encode(body), { headers: SSE_HEADERS });
}

async function createTicket(
  baseUrl: string,
  token: string,
  actorId: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/ws/tickets`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ actorId }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Ticket request returned ${response.status}`);
  const payload = (await response.json()) as {
    data?: { ticket?: unknown };
  };
  if (typeof payload.data?.ticket !== "string" || payload.data.ticket.length < 20) {
    throw new Error("Ticket response was invalid");
  }
  return payload.data.ticket;
}

function parseEnvelope(value: unknown): LiveEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    !REPLAY_ID.test(row.id) ||
    row.schemaVersion !== 1 ||
    typeof row.correlationId !== "string" ||
    !CORRELATION_ID.test(row.correlationId) ||
    typeof row.type !== "string" ||
    typeof row.at !== "string" ||
    !row.data ||
    typeof row.data !== "object" ||
    Array.isArray(row.data)
  ) {
    return null;
  }
  return row as LiveEnvelope;
}

/**
 * Catch up from the service's bounded Redis replay stream. Paging matters when
 * one Railway outage spans more than the route's 200-event page size.
 *
 * `truncated` is true when history is known-incomplete: the service trimmed
 * its retained stream (`truncated: true` in the payload) or the page cap was
 * hit with more pages remaining. The caller surfaces that to the UI instead
 * of pretending the replay was complete.
 */
async function replayEvents(
  baseUrl: string,
  token: string,
  after: string | null,
): Promise<{ events: LiveEnvelope[]; truncated: boolean }> {
  const events: LiveEnvelope[] = [];
  let cursor = after;
  let truncated = false;

  for (let page = 0; page < 10; page += 1) {
    const url = new URL(`${baseUrl}/v1/live/replay`);
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("after", cursor);
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error("Replay request failed");
    const payload = (await response.json()) as {
      data?: unknown;
      cursor?: unknown;
      truncated?: unknown;
    };
    if (!Array.isArray(payload.data)) throw new Error("Replay response invalid");
    if (payload.truncated === true) truncated = true;
    for (const value of payload.data) {
      const event = parseEnvelope(value);
      if (event) events.push(event);
    }
    const next =
      typeof payload.cursor === "string" && REPLAY_ID.test(payload.cursor)
        ? payload.cursor
        : null;
    if (payload.data.length < 200 || !next || next === cursor) {
      return { events, truncated };
    }
    cursor = next;
  }

  // Page cap reached with more history still unread.
  return { events, truncated: true };
}

function websocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Monitor API URL must use HTTP or HTTPS");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/live`;
  url.search = "";
  return url.toString();
}

export async function GET(request: Request): Promise<Response> {
  let actorId: string;
  try {
    const session = await requireAntifraudReadAccess();
    actorId = session.userId;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return new Response("Forbidden", { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return new Response("Forbidden", { status: 403 });
  }

  const limit = await rateLimit(
    buildCacheKey("ratelimit:antifraud-monitor-stream", [actorId]),
    MAX_STREAM_STARTS_PER_MINUTE,
    60,
  );
  if (!limit.allowed) {
    return terminalStream(
      "closed",
      "Too many stream restarts — retrying automatically in about a minute.",
    );
  }

  const { baseUrl, token } = monitorConfig();
  const encoder = new TextEncoder();
  const requestOrigin = new URL(request.url).origin;
  const resumeHeader = request.headers.get("last-event-id");
  const resumeQuery = new URL(request.url).searchParams.get("after");
  const resumeAfter =
    resumeHeader && REPLAY_ID.test(resumeHeader)
      ? resumeHeader
      : resumeQuery && REPLAY_ID.test(resumeQuery)
        ? resumeQuery
        : null;

  // Hoisted so `cancel()` can tear the timers down too. On Vercel Fluid
  // Compute the request abort signal does NOT reliably fire when an SSE
  // client disconnects, but the stream's `cancel()` does — without this the
  // heartbeat/backoff timers kept running for ghost connections.
  let teardown: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let socket: WebSocket | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let rotation: ReturnType<typeof setTimeout> | null = null;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let upstreamPing: ReturnType<typeof setInterval> | null = null;
      let lastUpstreamActivityAt = 0;
      let attempt = 0;
      let consecutiveFailures = 0;
      let replayFailures = 0;
      let state: TransportState = "connecting";
      let closed = false;
      let lastDeliveredId = resumeAfter;
      const deliveredIds = new Set<string>();

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };

      const send = (value: unknown) => write(sseFrame("row", value));

      const forward = (value: unknown) => {
        const event = parseEnvelope(value);
        if (!event || deliveredIds.has(event.id)) return;
        deliveredIds.add(event.id);
        if (deliveredIds.size > 2_000) {
          const oldest = deliveredIds.values().next().value;
          if (typeof oldest === "string") deliveredIds.delete(oldest);
        }
        lastDeliveredId = event.id;
        write(sseFrame("row", event, event.id));
      };

      const setState = (
        next: TransportState,
        message?: string,
      ) => {
        state = next;
        send(transport(next, message));
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (rotation) clearTimeout(rotation);
        if (retryTimer) clearTimeout(retryTimer);
        if (upstreamPing) clearInterval(upstreamPing);
        upstreamPing = null;
        if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
        socket = null;
        try {
          controller.close();
        } catch {
          // The request was already aborted.
        }
      };

      const scheduleReconnect = (message: string, minimumDelayMs = 0) => {
        if (closed || retryTimer) return;
        attempt += 1;
        consecutiveFailures += 1;
        const backoff = Math.min(
          UPSTREAM_RETRY_MAX_MS,
          UPSTREAM_RETRY_MIN_MS * 2 ** (attempt - 1),
        );
        // Jitter so several instances don't stampede the service together.
        const circuitOpen =
          consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD;
        const delay = Math.max(
          minimumDelayMs,
          circuitOpen
            ? CIRCUIT_OPEN_MS
            : Math.round(backoff * (0.5 + Math.random() * 0.5)),
        );
        setState(
          circuitOpen ? "error" : "connecting",
          circuitOpen
            ? "Monitor transport is degraded; retrying after a recovery pause"
            : message,
        );
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connectUpstream();
        }, delay);
      };

      const connectUpstream = () => {
        if (closed || !baseUrl || !token) return;
        void createTicket(baseUrl, token, actorId)
          .then((ticket) => {
            if (closed) return;
            let replaying = true;
            const pending: unknown[] = [];
            const next = new WebSocket(
              websocketUrl(baseUrl),
              [`antifraud-ticket.${ticket}`],
              {
                handshakeTimeout: 8_000,
                maxPayload: MAX_FRAME_BYTES,
                origin: requestOrigin,
                perMessageDeflate: false,
              },
            );
            socket = next;
            next.on("open", () => {
              if (closed || socket !== next) return;
              // Zombie detection: ping the upstream on an interval and
              // terminate when nothing (message or pong) arrived within the
              // idle window. A half-open TCP connection otherwise keeps the
              // heartbeat reporting "open" forever while no events flow.
              lastUpstreamActivityAt = Date.now();
              if (upstreamPing) clearInterval(upstreamPing);
              upstreamPing = setInterval(() => {
                if (closed || socket !== next) return;
                if (Date.now() - lastUpstreamActivityAt > UPSTREAM_IDLE_MS) {
                  if (upstreamPing) clearInterval(upstreamPing);
                  upstreamPing = null;
                  scheduleReconnect("Upstream idle, reconnecting");
                  next.terminate();
                  return;
                }
                next.ping();
              }, UPSTREAM_PING_MS);
              // A brand-new browser already loaded an authoritative snapshot.
              // Replay is only for resuming a stream that has a known cursor;
              // otherwise retained history could regress the current snapshot.
              void (lastDeliveredId
                ? replayEvents(baseUrl, token, lastDeliveredId)
                : Promise.resolve({ events: [], truncated: false }))
                .then(({ events: replayed, truncated }) => {
                  if (
                    closed ||
                    socket !== next ||
                    next.readyState !== WebSocket.OPEN ||
                    !replaying
                  ) {
                    // `!replaying`: the pending-buffer overflow path already
                    // dropped this replay and went live.
                    return;
                  }
                  for (const event of replayed) forward(event);
                  replaying = false;
                  for (const event of pending) forward(event);
                  pending.length = 0;
                  attempt = 0;
                  consecutiveFailures = 0;
                  replayFailures = 0;
                  setState("open");
                  if (truncated) send(transport("open", REPLAY_TRUNCATED_MESSAGE));
                })
                .catch(() => {
                  console.error("[antifraud-monitor] replay failed");
                  if (closed || socket !== next || !replaying) return;
                  replayFailures += 1;
                  if (replayFailures >= REPLAY_FAILURE_LIMIT) {
                    // A persistently failing replay endpoint must not wedge
                    // the whole route — go live without history instead of
                    // burning a healthy socket on every attempt.
                    if (next.readyState !== WebSocket.OPEN) return;
                    replaying = false;
                    for (const event of pending) forward(event);
                    pending.length = 0;
                    attempt = 0;
                    consecutiveFailures = 0;
                    setState("open", "Live only — event history unavailable");
                    return;
                  }
                  next.close();
                });
            });
            next.on("message", (frame) => {
              if (closed || socket !== next) return;
              lastUpstreamActivityAt = Date.now();
              try {
                const payload = frame.toString();
                if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) return;
                const value = JSON.parse(payload) as unknown;
                const envelope = parseEnvelope(value);
                if (!envelope) return;
                if (replaying) {
                  pending.push(envelope);
                  if (pending.length > REPLAY_PENDING_LIMIT) {
                    // A live burst outran the replay. Closing here would just
                    // reconnect into the same window and die again — drop the
                    // replay, go live, and tell the UI history is incomplete.
                    replaying = false;
                    for (const event of pending) forward(event);
                    pending.length = 0;
                    attempt = 0;
                    consecutiveFailures = 0;
                    setState("open", REPLAY_TRUNCATED_MESSAGE);
                  }
                } else {
                  forward(envelope);
                }
              } catch {
                // Ignore malformed upstream frames.
              }
            });
            next.on("pong", () => {
              if (closed || socket !== next) return;
              lastUpstreamActivityAt = Date.now();
            });
            next.on("error", () => {
              console.error("[antifraud-monitor] websocket failed");
              // `ws` always emits `close` after `error`; reconnect from there.
            });
            next.on("close", (code) => {
              if (socket === next && upstreamPing) {
                clearInterval(upstreamPing);
                upstreamPing = null;
              }
              if (closed || socket !== next) return;
              socket = null;
              if (code === 1013) {
                scheduleReconnect(
                  "Live stream capacity reached, retrying",
                  CAPACITY_RETRY_MIN_MS,
                );
              } else {
                scheduleReconnect("Live stream interrupted, reconnecting");
              }
            });
          })
          .catch(() => {
            console.error("[antifraud-monitor] ticket failed");
            if (closed) return;
            scheduleReconnect("Monitor service unavailable, reconnecting");
          });
      };

      teardown = close;
      request.signal.addEventListener("abort", close, { once: true });

      // Advertise the browser-side reconnect delay before anything else.
      write(`retry: ${CLIENT_RETRY_MS}\n\n`);

      if (!baseUrl || !token) {
        send(transport("unconfigured", "Monitor service is not configured", true));
        // Permanent refusal — tell the hook to stop retrying for good.
        write(sseFrame("fatal", { message: "Monitor service is not configured" }));
        close();
        return;
      }

      // The heartbeat re-states the live transport state: it keeps proxies from
      // closing an idle connection AND lets the client notice a stalled stream.
      heartbeat = setInterval(() => {
        send(transport(state));
      }, HEARTBEAT_MS);

      rotation = setTimeout(() => {
        // Tell the hook to reopen immediately (cursor preserved) instead of
        // sitting dark for the 15s `retry:` window, then close normally so
        // the next route instance can replay from Last-Event-ID.
        write(sseFrame("reconnect", { reason: "rotation" }));
        close();
      }, ROTATE_AFTER_MS);

      setState("connecting");
      connectUpstream();
    },
    cancel() {
      if (teardown) teardown();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
