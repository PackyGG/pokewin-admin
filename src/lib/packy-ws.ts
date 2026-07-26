"use client";

/**
 * Client for the packy.gg live event stream via a server-side proxy.
 *
 * Uses an EventSource to /api/packy-live. The Node.js route proxies the
 * existing chat WebSocket and fans permission-filtered chat events out as
 * SSE `packy` events.
 *
 * Public API is the `subscribePackyWs(eventType, handler)` imperative
 * subscription (one shared EventSource fans out to every subscriber).
 * Consumers call it from their own `useEffect`.
 */

// ─── Types ────────────────────────────────────────────────────────

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
  // `active.users.count` is broadcast by the gateway without a
  // subscription; kept in the union as protocol documentation even
  // though no component currently renders it.
  | { type: "active.users.count"; payload: { count: number }; timestamp: string }
  | {
      type: "chat.pull.history";
      payload: { messages: ChatMessage[] };
      timestamp: string;
    }
  | { type: string; payload: unknown; timestamp: string };

// ─── Singleton state ──────────────────────────────────────────────

const SSE_PATH = "/api/packy-live";

type Handler = (evt: PackyEvent) => void;
const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;
let visibilityBound = false;

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

  let es: EventSource;
  try {
    es = new EventSource(SSE_PATH, { withCredentials: true });
  } catch (err) {
    console.error("[packy-ws] failed to construct EventSource", err);
    source = null;
    return;
  }
  source = es;
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
  });
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
