"use client";

import * as React from "react";

/**
 * Client for the packy.gg live event stream via a server-side proxy.
 *
 * Uses an EventSource to /api/packy-live. The Node.js route on our
 * server opens the real WebSocket with the exact reference browser
 * handshake (headers the browser can't set directly) and forwards
 * every frame as an SSE `packy` event. All hooks below keep the same
 * public API so consumers don't care about the transport.
 */

// ─── Types ────────────────────────────────────────────────────────

export type Pull = {
  card: {
    pack_id: string;
    pack_name: string;
    pack_image_url: string;
    id: string;
    name: string;
    price: string;
    image_url: string;
    color: string;
    hp: number;
    rarity: string;
    artist: string;
    set_name: string | null;
    card_number: string | null;
    animation: boolean;
    source: "pack" | "battle" | "reward";
    battle_id: string | null;
    private: boolean;
  };
  timestamp: string;
};

export type ChatMessage = {
  id: string;
  user_id: string;
  username: string | null;
  image: string | null;
  role: string | null;
  level: number | null;
  content: string;
  created_at: string;
};

export type PackyEvent =
  | { type: "active.users.count"; payload: { count: number }; timestamp: string }
  | { type: "live.pull.history"; payload: { pulls: Pull[] }; timestamp: string }
  | {
      type: "chat.pull.history";
      payload: { messages: ChatMessage[] };
      timestamp: string;
    }
  | { type: string; payload: unknown; timestamp: string };

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

// ─── Singleton state ──────────────────────────────────────────────

const SSE_PATH = "/api/packy-live";

type Handler = (evt: PackyEvent) => void;
const handlers = new Map<string, Set<Handler>>();

type StatusHandler = (status: ConnectionStatus) => void;
const statusHandlers = new Set<StatusHandler>();

let source: EventSource | null = null;
let visibilityBound = false;
let currentStatus: ConnectionStatus = "closed";

function setStatus(next: ConnectionStatus) {
  if (next === currentStatus) return;
  currentStatus = next;
  for (const h of statusHandlers) {
    try {
      h(next);
    } catch {
      // ignore — keep broadcasting
    }
  }
}

function totalSubscribers(): number {
  let count = 0;
  for (const set of handlers.values()) count += set.size;
  return count;
}

function parseMessage(raw: string): PackyEvent | null {
  try {
    // The proxy escapes embedded newlines as `\n` to survive SSE
    // `data:` framing. Reverse that before JSON.parse.
    const normalized = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
    const parsed: unknown = JSON.parse(normalized);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as PackyEvent;
    }
    console.error("[packy-ws] malformed event — missing type", parsed);
    return null;
  } catch (err) {
    console.error("[packy-ws] malformed JSON frame", err);
    return null;
  }
}

function dispatch(evt: PackyEvent) {
  const set = handlers.get(evt.type);
  if (!set || set.size === 0) return;
  for (const h of set) {
    try {
      h(evt);
    } catch (err) {
      console.error("[packy-ws] handler threw for", evt.type, err);
    }
  }
}

function closeSource(reason: "manual" | "hidden" | "teardown" | "rotation") {
  if (source) {
    source.onopen = null;
    source.onerror = null;
    source.onmessage = null;
    try {
      source.close();
    } catch {
      // already closed — ignore
    }
    source = null;
  }
  setStatus("closed");
  if (reason === "rotation") {
    openSource();
  }
}

function openSource() {
  if (typeof window === "undefined") return;
  if (totalSubscribers() === 0) return;
  if (source) return;
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    return;
  }

  setStatus("connecting");

  let es: EventSource;
  try {
    es = new EventSource(SSE_PATH, { withCredentials: true });
  } catch (err) {
    console.error("[packy-ws] failed to construct EventSource", err);
    setStatus("closed");
    return;
  }
  source = es;

  // Proxy emits `event: open` the moment the upstream WS opens — we
  // care about upstream readiness, not the SSE handshake.
  es.addEventListener("open", () => {
    setStatus("open");
  });

  es.addEventListener("packy", (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    const evt = parseMessage(ev.data);
    if (evt) dispatch(evt);
  });

  es.addEventListener("reconnect", () => {
    if (source !== es) return;
    closeSource("rotation");
  });

  es.addEventListener("close", (ev: MessageEvent) => {
    if (ev.data) {
      try {
        const parsed = JSON.parse(ev.data);
        console.warn(
          `[packy-ws] upstream WS closed code=${parsed.code} reason=${
            parsed.reason || "(none)"
          }`,
        );
      } catch {
        // non-JSON payload — ignore
      }
    }
    setStatus("reconnecting");
  });

  es.onerror = () => {
    if (source !== es) return;
    if (es.readyState === 2) {
      setStatus("closed");
    } else {
      setStatus("reconnecting");
    }
  };
}

function handleVisibility() {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible") {
    if (totalSubscribers() > 0 && !source) {
      openSource();
    }
  } else {
    closeSource("hidden");
  }
}

function ensureVisibilityBinding() {
  if (visibilityBound) return;
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", handleVisibility);
  visibilityBound = true;
}

// ─── Public API ───────────────────────────────────────────────────

export function subscribePackyWs<T extends PackyEvent>(
  eventType: T["type"],
  handler: (evt: T) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  ensureVisibilityBinding();

  let set = handlers.get(eventType);
  if (!set) {
    set = new Set();
    handlers.set(eventType, set);
  }
  const typed = handler as unknown as Handler;
  set.add(typed);

  if (!source) {
    openSource();
  }

  return () => {
    const bucket = handlers.get(eventType);
    if (bucket) {
      bucket.delete(typed);
      if (bucket.size === 0) handlers.delete(eventType);
    }
    if (totalSubscribers() === 0) {
      closeSource("teardown");
    }
  };
}

export function subscribePackyWsStatus(
  handler: (status: ConnectionStatus) => void,
): () => void {
  statusHandlers.add(handler);
  try {
    handler(currentStatus);
  } catch {
    // ignore
  }
  return () => {
    statusHandlers.delete(handler);
  };
}

// ─── React hooks ──────────────────────────────────────────────────

export function usePackyWsActiveUsers(): number | null {
  const [count, setCount] = React.useState<number | null>(null);

  React.useEffect(() => {
    return subscribePackyWs<
      Extract<PackyEvent, { type: "active.users.count" }>
    >("active.users.count", (evt) => {
      const next = evt.payload?.count;
      if (typeof next === "number" && Number.isFinite(next)) {
        setCount(next);
      }
    });
  }, []);

  return count;
}

export function usePackyWsLivePulls(max: number = 50): Pull[] {
  const [pulls, setPulls] = React.useState<Pull[]>([]);

  React.useEffect(() => {
    return subscribePackyWs<
      Extract<PackyEvent, { type: "live.pull.history" }>
    >("live.pull.history", (evt) => {
      const incoming = evt.payload?.pulls;
      if (!Array.isArray(incoming) || incoming.length === 0) return;

      setPulls((prev) => {
        const existing = new Set(prev.map((p) => `${p.card.id}|${p.timestamp}`));
        const fresh: Pull[] = [];
        for (const p of incoming) {
          const key = `${p?.card?.id ?? ""}|${p?.timestamp ?? ""}`;
          if (existing.has(key)) continue;
          fresh.push(p);
          existing.add(key);
        }
        if (fresh.length === 0) return prev;

        const combined = [...fresh, ...prev].sort((a, b) => {
          const ta = new Date(a.timestamp).getTime();
          const tb = new Date(b.timestamp).getTime();
          return tb - ta;
        });
        return combined.slice(0, max);
      });
    });
  }, [max]);

  return pulls;
}

export function usePackyWsChat(max: number = 50): ChatMessage[] {
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);

  React.useEffect(() => {
    return subscribePackyWs<
      Extract<PackyEvent, { type: "chat.pull.history" }>
    >("chat.pull.history", (evt) => {
      const incoming = evt.payload?.messages;
      if (!Array.isArray(incoming) || incoming.length === 0) return;

      setMessages((prev) => {
        const existing = new Set(prev.map((m) => m.id));
        const fresh: ChatMessage[] = [];
        for (const m of incoming) {
          if (!m || typeof m.id !== "string") continue;
          if (existing.has(m.id)) continue;
          fresh.push(m);
          existing.add(m.id);
        }
        if (fresh.length === 0) return prev;

        const combined = [...prev, ...fresh].sort((a, b) => {
          const ta = new Date(a.created_at).getTime();
          const tb = new Date(b.created_at).getTime();
          return ta - tb;
        });
        return combined.slice(Math.max(0, combined.length - max));
      });
    });
  }, [max]);

  return messages;
}

export function usePackyWsStatus(): ConnectionStatus {
  const [status, setStatus] = React.useState<ConnectionStatus>("closed");

  React.useEffect(() => {
    return subscribePackyWsStatus(setStatus);
  }, []);

  return status;
}
