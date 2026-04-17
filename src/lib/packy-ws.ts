"use client";

import * as React from "react";

/**
 * Browser-side client for the packy.gg live WebSocket
 * (`wss://api.packy.gg/v1/ws`).
 *
 * Design:
 *   - One shared `WebSocket` per tab. All React hooks and imperative
 *     subscribers go through the same module-level singleton so we don't
 *     open N connections for N components.
 *   - Opens lazily on the first subscriber and closes again once the
 *     last subscriber unsubscribes — the admin panel can sit on pages
 *     that don't care about live data without keeping the socket open.
 *   - Auto-reconnect with exponential backoff: 1s → 2s → 4s → … capped
 *     at 30s. Connect attempts reset after a successful `open`.
 *   - Pauses when the tab is hidden. `document.visibilityState` flips
 *     to "hidden" on tab-switch / minimize, so we close the socket and
 *     reopen it on the next `visibilitychange`. Mirrors the pattern
 *     already used by `useSseStream` for our own SSE feeds.
 *   - Malformed messages are logged to `console.error` (so operators
 *     can notice a schema drift during development) and skipped.
 *
 * URL:
 *   Configurable via `NEXT_PUBLIC_PACKY_WS_URL`. Falls back to the
 *   production endpoint so the feature still works in environments that
 *   haven't added the env var yet.
 *
 * Not wrapped in a try/catch at the module level on purpose — this file
 * is `"use client"` and any import-time failure surfaces during dev in
 * the React tree where it's easier to diagnose.
 */

// ─── Types ────────────────────────────────────────────────────────

/**
 * A single card pull broadcast over the live stream. Shape mirrors the
 * sample payload from the packy.gg gateway. Most fields aren't used by
 * the admin UI today but are kept verbatim so downstream consumers can
 * grow into them without re-plumbing the transport layer.
 */
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

/**
 * A chat message broadcast over the live stream. The exact shape isn't
 * documented publicly — we treat `payload.messages` as an array of
 * records with loose typing and normalize at the consumer boundary. The
 * fields below are the ones the consumer attempts to read; anything
 * missing is treated as null/empty.
 */
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

const DEFAULT_URL = "wss://api.packy.gg/v1/ws";
const MAX_BACKOFF_MS = 30_000;

// Handlers are stored by event `type`. Unknown event types can still be
// subscribed to (the emit path never rejects); malformed JSON is logged
// and skipped earlier in parseMessage().
type Handler = (evt: PackyEvent) => void;
const handlers = new Map<string, Set<Handler>>();

// Connection status subscribers — used by hooks that want to render a
// "Connected / Reconnecting / Offline" chip.
type StatusHandler = (status: ConnectionStatus) => void;
const statusHandlers = new Set<StatusHandler>();

let ws: WebSocket | null = null;
let retryAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityBound = false;
let currentStatus: ConnectionStatus = "closed";

function getWsUrl(): string {
  const fromEnv =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_PACKY_WS_URL
      : undefined;
  return fromEnv && fromEnv.trim() ? fromEnv : DEFAULT_URL;
}

function setStatus(next: ConnectionStatus) {
  if (next === currentStatus) return;
  currentStatus = next;
  for (const h of statusHandlers) {
    try {
      h(next);
    } catch {
      // A misbehaving consumer must not break the status broadcast.
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
    const parsed: unknown = JSON.parse(raw);
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
      // Swallow handler errors so one bad consumer can't break others.
      console.error("[packy-ws] handler threw for", evt.type, err);
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer != null) return;
  if (totalSubscribers() === 0) return;
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    // Tab is hidden — don't reconnect now. `handleVisibility` will
    // kick us back on when the tab is visible again.
    setStatus("closed");
    return;
  }
  setStatus("reconnecting");
  const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** retryAttempt);
  retryAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
  }, delay);
}

function closeSocket(reason: "manual" | "hidden" | "teardown") {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    // Remove handlers before close() so a synchronous "close" event
    // during teardown doesn't re-enter openSocket().
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // Already closing / closed — ignore.
    }
    ws = null;
  }
  if (reason !== "hidden") {
    retryAttempt = 0;
  }
  setStatus("closed");
}

function openSocket() {
  if (typeof window === "undefined") return;
  if (totalSubscribers() === 0) return;
  if (ws) return;
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    return;
  }

  setStatus(retryAttempt === 0 ? "connecting" : "reconnecting");

  let socket: WebSocket;
  try {
    socket = new WebSocket(getWsUrl());
  } catch (err) {
    console.error("[packy-ws] failed to construct WebSocket", err);
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    retryAttempt = 0;
    setStatus("open");
  };

  socket.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    const evt = parseMessage(ev.data);
    if (evt) dispatch(evt);
  };

  socket.onerror = () => {
    // Don't null ws here — the browser will follow up with `close` and
    // we let that handler do the cleanup so reconnect state stays in
    // one place.
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    if (totalSubscribers() === 0) {
      setStatus("closed");
      return;
    }
    scheduleReconnect();
  };
}

function handleVisibility() {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible") {
    if (totalSubscribers() > 0 && !ws) {
      retryAttempt = 0;
      openSocket();
    }
  } else {
    // Close on hide so we don't pump into a hidden tab. Reconnect
    // happens automatically when the tab becomes visible.
    closeSocket("hidden");
  }
}

function ensureVisibilityBinding() {
  if (visibilityBound) return;
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", handleVisibility);
  visibilityBound = true;
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Subscribe to a single event `type`. Returns an unsubscribe function.
 *
 * Opens the shared socket on first subscriber and closes it once the
 * last subscriber unsubscribes. Safe to call on the server — the
 * returned function is a no-op if `window` isn't available.
 */
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

  // Open the socket if this is the first subscriber across all types.
  if (!ws && reconnectTimer == null) {
    openSocket();
  }

  return () => {
    const bucket = handlers.get(eventType);
    if (bucket) {
      bucket.delete(typed);
      if (bucket.size === 0) handlers.delete(eventType);
    }
    // If no more subscribers anywhere, tear the socket down. We don't
    // touch `visibilityBound` — the listener is idempotent and cheap,
    // so leaving it attached for the life of the tab is fine.
    if (totalSubscribers() === 0) {
      closeSocket("teardown");
    }
  };
}

/**
 * Subscribe to connection-status changes. Unsubscribes via the returned
 * function. Fires immediately with the current status on subscribe.
 */
export function subscribePackyWsStatus(
  handler: (status: ConnectionStatus) => void,
): () => void {
  statusHandlers.add(handler);
  try {
    handler(currentStatus);
  } catch {
    // Ignore — same logic as dispatch().
  }
  return () => {
    statusHandlers.delete(handler);
  };
}

// ─── React hooks ──────────────────────────────────────────────────

/**
 * Current active-users count as broadcast by the WS. `null` until the
 * first `active.users.count` message arrives — callers distinguish this
 * from "zero" in the UI so the indicator doesn't flash an incorrect 0
 * during the connect window.
 */
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

/**
 * Rolling window of the most recent pulls, newest-first. `max` caps the
 * array length so we don't grow memory on a long-running tab. Default
 * matches the dashboard "Live Pulls" card allowance.
 */
export function usePackyWsLivePulls(max: number = 50): Pull[] {
  const [pulls, setPulls] = React.useState<Pull[]>([]);

  React.useEffect(() => {
    return subscribePackyWs<
      Extract<PackyEvent, { type: "live.pull.history" }>
    >("live.pull.history", (evt) => {
      const incoming = evt.payload?.pulls;
      if (!Array.isArray(incoming) || incoming.length === 0) return;

      // Server broadcasts either a running history (batch on open) or
      // a single new pull per tick — either way we dedupe by the
      // composite (card.id + timestamp) because individual pulls don't
      // carry a stable id of their own in the sample payload.
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

        // Server payloads may arrive oldest-first inside a batch; sort
        // descending by timestamp so the freshest row ends up on top.
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

/**
 * Rolling window of the most recent chat messages. Shape normalizes
 * defensively because the WS message schema isn't formally documented
 * yet — fields present in the sample are trusted, anything missing
 * falls back to null/empty.
 */
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
        // Keep newest `max` — drop from the front because we sort asc.
        return combined.slice(Math.max(0, combined.length - max));
      });
    });
  }, [max]);

  return messages;
}

/**
 * Live connection status. Useful for rendering a "Connected /
 * Reconnecting / Offline" indicator next to a live-feed card.
 */
export function usePackyWsStatus(): ConnectionStatus {
  const [status, setStatus] = React.useState<ConnectionStatus>(currentStatus);

  React.useEffect(() => {
    return subscribePackyWsStatus(setStatus);
  }, []);

  return status;
}
