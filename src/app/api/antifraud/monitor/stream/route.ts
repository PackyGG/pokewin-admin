import WebSocket from "ws";

import { requireAntifraudAccess } from "@/lib/require-antifraud-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const HEARTBEAT_MS = 15_000;
const MAX_FRAME_BYTES = 128_000;

type TransportState = "connecting" | "open" | "closed" | "unconfigured" | "error";

function monitorConfig(): { baseUrl?: string; token?: string } {
  return {
    baseUrl: process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, ""),
    token: process.env.ANTIFRAUD_MONITOR_API_TOKEN,
  };
}

function transport(state: TransportState, message?: string) {
  return {
    type: "transport",
    at: new Date().toISOString(),
    data: { state, ...(message ? { message } : {}) },
  };
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

function websocketUrl(baseUrl: string, ticket: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Monitor API URL must use HTTP or HTTPS");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/live`;
  url.search = new URLSearchParams({ ticket }).toString();
  return url.toString();
}

export async function GET(request: Request): Promise<Response> {
  let actorId: string;
  try {
    const session = await requireAntifraudAccess();
    actorId = session.userId;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { baseUrl, token } = monitorConfig();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let socket: WebSocket | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let closed = false;

      const send = (value: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
          );
        } catch {
          close();
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
        try {
          controller.close();
        } catch {
          // The request was already aborted.
        }
      };

      heartbeat = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            close();
          }
        }
      }, HEARTBEAT_MS);

      request.signal.addEventListener("abort", close, { once: true });

      if (!baseUrl || !token) {
        send(transport("unconfigured", "Monitor service is not configured"));
        return;
      }

      send(transport("connecting"));
      void createTicket(baseUrl, token, actorId)
        .then((ticket) => {
          if (closed) return;
          socket = new WebSocket(websocketUrl(baseUrl, ticket), {
            handshakeTimeout: 8_000,
            maxPayload: MAX_FRAME_BYTES,
          });
          socket.on("open", () => send(transport("open")));
          socket.on("message", (frame) => {
            try {
              const payload = frame.toString();
              if (Buffer.byteLength(payload) > MAX_FRAME_BYTES) return;
              const value = JSON.parse(payload) as unknown;
              if (value && typeof value === "object") send(value);
            } catch {
              // Ignore malformed upstream frames.
            }
          });
          socket.on("close", () => {
            send(transport("closed", "Live stream closed"));
            close();
          });
          socket.on("error", (error) => {
            console.error("[antifraud-monitor] websocket failed:", error.message);
            send(transport("error", "Live stream unavailable"));
            close();
          });
        })
        .catch((error) => {
          console.error("[antifraud-monitor] ticket failed:", error);
          send(transport("error", "Monitor service unavailable"));
          close();
        });
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
