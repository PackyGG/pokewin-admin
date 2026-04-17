"use client";

import * as React from "react";

/**
 * Browser-side client for the packy.gg live event stream.
 *
 * Transport:
 *   The packy.gg WebSocket gateway (`wss://api.packy.gg/v1/ws`) enforces
 *   an `Origin: https://beta.packy.gg` handshake check. Browsers pin the
 *   Origin header to the page's own hostname, so a direct WS from
 *   `pokewin-admin.vercel.app` is always rejected by the gateway.
 *
 *   To work around that, we open an `EventSource` against a server-side
 *   proxy on our own origin (`/api/packy-live`). The Node.js route opens
 *   the real WebSocket with the correct Origin header and forwards every
 *   message to connected admins as an SSE `packy` event. Everything on
 *   the client side (hooks, event shape, dispatch) stays identical to
 *   the previous direct-WS design — just the wire changed.
 *
 * Design:
 *   - One shared `EventSource` per tab, opened lazily on the first
 *     subscriber and closed again once the last subscriber unsubscribes.
 *   - EventSource handles its own reconnect with a default ~3s retry, so
 *     we don't layer our own backoff on top of it. We still track a
 *     status machine for the UI indicator.
 *   - Pauses when the tab is hidden (`document.visibilityState`). The
 *     server-side proxy tears down its upstream WS when the SSE response
 *     aborts, so hidden tabs don't keep an upstream connection alive.
 *   - Malformed messages are logged to `console.error` and skipped.
 *
 * URL override:
 *   `NEXT_PUBLIC_PACKY_SSE_URL` — path of the SSE proxy. Defaults to
 *   `/api/packy-live`. Allows a custom proxy if ever needed without a
 *   code change.
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

const DEFAULT_SSE_PATH = "/api/packy-live";

// Handlers are stored by event `type`. Unknown event types can still be
// subscribed to (the emit path never rejects); malformed JSON is logged
// and skipped earlier in parseMessage().
type Handler = (evt: PackyEvent) => void;
const handlers = new Map<string, Set<Handler>>();

// Connection status subscribers — used by hooks that want to render a
// "Connected / Reconnecting / Offline" chip.
type StatusHandler = (status: ConnectionStatus) => void;
const statusHandlers = new Set<StatusHandler>();

let source: EventSource | null = null;
let visibilityBound = false;
let currentStatus: ConnectionStatus = "closed";

function getSseUrl(): string {
  const fromEnv =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_PACKY_SSE_URL
      : undefined;
  return fromEnv && fromEnv.trim() ? fromEnv : DEFAULT_SSE_PATH;
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
    // The proxy may escape embedded newlines as `\n` to survive the
    // SSE `data:` framing. Reverse that before JSON.parse.
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
      // Swallow handler errors so one bad consumer can't break others.
      console.error("[packy-ws] handler threw for", evt.type, err);
    }
  }
}

function closeSource(reason: "manual" | "hidden" | "teardown" | "rotation") {
  if (source) {
    // Null handlers before close so a synchronous "error" during
    // teardown doesn't re-enter openSource().
    source.onopen = null;
    source.onerror = null;
    source.onmessage = null;
    try {
      source.close();
    } catch {
      // Already closed — ignore.
    }
    source = null;
  }
  // On a clean teardown or hidden-pause, we just mark closed. On
  // rotation we want the next openSource() (triggered by the caller) to
  // flip through connecting again.
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
    es = new EventSource(getSseUrl(), { withCredentials: true });
  } catch (err) {
    console.error("[packy-ws] failed to construct EventSource", err);
    setStatus("closed");
    return;
  }
  source = es;

  // The proxy sends `open` the moment the upstream WS opens. Before
  // that we're merely "connecting" even if the SSE handshake itself is
  // complete — our users care about upstream readiness, not the proxy
  // leg.
  es.addEventListener("open", () => {
    setStatus("open");
  });

  // Native onopen fires when the SSE handshake succeeds. If the proxy
  // is reachable but the upstream WS is still negotiating, we leave the
  // status at `connecting` until the proxy emits its own `open` event
  // above.
  es.onopen = () => {
    // Stay in `connecting` until the proxy signals upstream-open via
    // the explicit `open` event. Keeps the indicator accurate.
  };

  es.addEventListener("packy", (ev: MessageEvent) => {
    if (typeof ev.data !== "string") return;
    const evt = parseMessage(ev.data);
    if (evt) dispatch(evt);
  });

  es.addEventListener("reconnect", () => {
    // Server-initiated rotation (before Vercel's maxDuration cap). Close
    // this EventSource and immediately open a new one.
    if (source !== es) return;
    closeSource("rotation");
  });

  es.addEventListener("close", (ev: MessageEvent) => {
    // Upstream WS dropped. EventSource will auto-reconnect to the
    // proxy, which will in turn open a new upstream WS.
    if (ev.data) {
      try {
        const parsed = JSON.parse(ev.data);
        console.warn(
          `[packy-ws] upstream WS closed code=${parsed.code} reason=${
            parsed.reason || "(none)"
          }`,
        );
      } catch {
        // Non-JSON payload — already logged at parse above.
      }
    }
    setStatus("reconnecting");
  });

  es.addEventListener("error-upstream" as "error", (ev: MessageEvent) => {
    if (ev.data) {
      console.warn("[packy-ws] upstream error event", ev.data);
    }
  });

  es.onerror = () => {
    // EventSource's native error — fires on network failure or when the
    // connection drops. EventSource auto-reconnects by default, so we
    // only flip the UI status; the next `open` will flip it back.
    if (source !== es) return;
    // readyState 0 = connecting (after a drop), 2 = closed permanently
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
    // Close on hide so we don't pump into a hidden tab. Reconnect
    // happens automatically when the tab becomes visible.
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

/**
 * Subscribe to a single event `type`. Returns an unsubscribe function.
 *
 * Opens the shared EventSource on first subscriber and closes it once
 * the last subscriber unsubscribes. Safe to call on the server — the
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

  // Open the source if this is the first subscriber across all types.
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
