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
 */

const HEARTBEAT_MS = 15_000;
const MAX_FRAME_BYTES = 128_000;
const MAX_STREAM_STARTS_PER_MINUTE = 10;
/** Rotate well under `maxDuration` so the client reopens gracefully. */
const ROTATE_AFTER_MS = 240_000;
const UPSTREAM_RETRY_MIN_MS = 1_000;
const UPSTREAM_RETRY_MAX_MS = 30_000;
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
 */
function terminalStream(state: TransportState, message: string): Response {
  const body =
    `retry: ${CLIENT_RETRY_MS}\n\n` +
    sseFrame("row", transport(state, message, true));
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
 */
async function replayEvents(
  baseUrl: string,
  token: string,
  after: string | null,
): Promise<LiveEnvelope[]> {
  const events: LiveEnvelope[] = [];
  let cursor = after;

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
    };
    if (!Array.isArray(payload.data)) throw new Error("Replay response invalid");
    for (const value of payload.data) {
      const event = parseEnvelope(value);
      if (event) events.push(event);
    }
    const next =
      typeof payload.cursor === "string" && REPLAY_ID.test(payload.cursor)
        ? payload.cursor
        : null;
    if (payload.data.length < 200 || !next || next === cursor) break;
    cursor = next;
  }

  return events;
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
      "Too many stream restarts. Reload the page to reconnect.",
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
      let attempt = 0;
      let consecutiveFailures = 0;
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
              // A brand-new browser already loaded an authoritative snapshot.
              // Replay is only for resuming a stream that has a known cursor;
              // otherwise retained history could regress the current snapshot.
              void (lastDeliveredId
                ? replayEvents(baseUrl, token, lastDeliveredId)
                : Promise.resolve([]))
                .then((replayed) => {
                  if (
                    closed ||
                    socket !== next ||
                    next.readyState !== WebSocket.OPEN
                  ) {
                    return;
                  }
                  for (const event of replayed) forward(event);
                  replaying = false;
                  for (const event of pending) forward(event);
                  pending.length = 0;
                  attempt = 0;
                  consecutiveFailures = 0;
                  setState("open");
                })
                .catch(() => {
                  console.error("[antifraud-monitor] replay failed");
                  if (closed || socket !== next) return;
                  next.close();
                });
            });
            next.on("message", (frame) => {
              if (closed || socket !== next) return;
              try {
                const payload = frame.toString();
                if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) return;
                const value = JSON.parse(payload) as unknown;
                const envelope = parseEnvelope(value);
                if (!envelope) return;
                if (replaying) {
                  pending.push(envelope);
                  if (pending.length > 500) next.close();
                } else {
                  forward(envelope);
                }
              } catch {
                // Ignore malformed upstream frames.
              }
            });
            next.on("error", () => {
              console.error("[antifraud-monitor] websocket failed");
              // `ws` always emits `close` after `error`; reconnect from there.
            });
            next.on("close", (code) => {
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
        close();
        return;
      }

      // The heartbeat re-states the live transport state: it keeps proxies from
      // closing an idle connection AND lets the client notice a stalled stream.
      heartbeat = setInterval(() => {
        send(transport(state));
      }, HEARTBEAT_MS);

      rotation = setTimeout(() => {
        // A normal SSE close lets the browser reconnect the same EventSource,
        // preserving Last-Event-ID so the next route instance can replay.
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
