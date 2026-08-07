"use client";

/**
 * Client for the packy.gg live event stream via a server-side proxy.
 *
 * Uses an EventSource to /api/packy-live. The Node.js route proxies the
 * existing WebSocket and fans permission-filtered chat and admin activity
 * events out as SSE `packy` events.
 *
 * Public API is the `subscribePackyWs(eventType, handler)` imperative
 * subscription (one shared EventSource fans out to every subscriber).
 * Consumers call it from their own `useEffect`.
 */

// ─── Types ────────────────────────────────────────────────────────

type ChatMessage = {
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
  | {
      type: "admin.activity";
      payload: {
        user_id: string | null;
        topics: Array<
          | "deposits"
          | "card_payments"
          | "withdrawals"
          | "balance"
          | "gaming"
        >;
        action: string;
        entity_id?: string | null;
      };
      timestamp: string;
    }
  | { type: string; payload: unknown; timestamp: string };

// ─── Singleton state ──────────────────────────────────────────────

const SSE_PATH = "/api/packy-live";

type Handler = (evt: PackyEvent) => void;
const handlers = new Map<string, Set<Handler>>();
type PackyConnectionState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "unavailable"
  | "paused";
type ConnectionStateHandler = (state: PackyConnectionState) => void;
const connectionStateHandlers = new Set<ConnectionStateHandler>();
let source: EventSource | null = null;
let visibilityBound = false;
let hasOpened = false;
let connectionState: PackyConnectionState = "connecting";

/**
 * Reconnect escalation, mirroring `src/lib/hooks/use-sse.ts`.
 *
 * EventSource retries on its own ONLY after a clean 2xx EOF. Anything that
 * lands it in `readyState === CLOSED` (a non-2xx response, a hard network
 * failure) is permanent as far as the browser is concerned, so the escalation
 * below is what actually keeps this wire alive.
 */
const MAX_FAILURES = 8;
/** A session shorter than this is a flap, not a recovery — keep escalating. */
const STABLE_SESSION_MS = 30_000;
let failures = 0;
let openedAt = 0;
let backoffTimer: ReturnType<typeof setTimeout> | null = null;
let gaveUp = false;

function clearBackoff() {
  if (backoffTimer) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
}

function setConnectionState(next: PackyConnectionState) {
  connectionState = next;
  for (const handler of connectionStateHandlers) {
    try {
      handler(next);
    } catch (err) {
      console.error("[packy-ws] connection state handler threw", err);
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
    // The proxy frames multi-line payloads as multiple SSE `data:` lines
    // per spec; EventSource already rejoined them with "\n" here, so the
    // raw string is parseable as-is. (The old `\\n` un-escape hack would
    // corrupt legitimate `\n` escape sequences inside JSON strings —
    // e.g. a multi-line chat message — into raw newlines and break parse.)
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
      console.error("[packy-ws] handler threw for", evt.type, err);
    }
  }
}

function closeSource(reason: "manual" | "hidden" | "teardown" | "rotation") {
  clearBackoff();
  openedAt = 0;
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
    // A graceful server rotation is a successful cycle, not a failure.
    failures = 0;
    setConnectionState("reconnecting");
    openSource();
  } else if (reason === "teardown") {
    hasOpened = false;
    failures = 0;
    gaveUp = false;
    setConnectionState("connecting");
  } else if (reason === "hidden") {
    setConnectionState("paused");
  }
}

function openSource() {
  if (typeof window === "undefined") return;
  // Escalation exhausted — only `online` or a tab refocus reopens the door.
  if (gaveUp) return;
  if (totalSubscribers() === 0) return;
  if (source) return;
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    return;
  }
  setConnectionState(hasOpened ? "reconnecting" : "connecting");

  let es: EventSource;
  try {
    es = new EventSource(SSE_PATH, { withCredentials: true });
  } catch (err) {
    console.error("[packy-ws] failed to construct EventSource", err);
    source = null;
    return;
  }
  source = es;
  es.onopen = () => {
    if (source !== es) return;
    hasOpened = true;
    openedAt = Date.now();
    // Deliberately NOT resetting `failures` here (same reasoning as use-sse):
    // an endpoint that opens and dies immediately would otherwise retry at 1s
    // forever. Only a session that LASTED resets the schedule, below.
  };
  es.onerror = () => {
    if (source !== es) return;
    // EventSource fires `error` for BOTH a transient drop it will retry itself
    // (readyState CONNECTING) and a terminal failure (readyState CLOSED). Only
    // the terminal case needs us; the old handler just relabelled the state and
    // left the dead EventSource in `source` forever.
    if (es.readyState !== EventSource.CLOSED) {
      if (connectionState !== "unavailable") setConnectionState("reconnecting");
      return;
    }

    const sessionMs = openedAt ? Date.now() - openedAt : 0;
    closeSource("manual");
    failures = sessionMs >= STABLE_SESSION_MS ? 1 : failures + 1;
    if (failures >= MAX_FAILURES) {
      gaveUp = true;
      setConnectionState("unavailable");
      return;
    }
    setConnectionState("reconnecting");
    backoffTimer = setTimeout(
      () => {
        backoffTimer = null;
        openSource();
      },
      Math.min(30_000, 1000 * 2 ** (failures - 1)),
    );
  };

  es.addEventListener("fatal", () => {
    if (source !== es) return;
    // The proxy says retrying is pointless (permanent refusal). Without this
    // its clean EOF would be retried every `retry:` interval forever.
    closeSource("manual");
    gaveUp = true;
    setConnectionState("unavailable");
  });

  es.addEventListener("upstream-open", () => {
    if (source === es) setConnectionState("live");
  });

  es.addEventListener("upstream-error", () => {
    if (source === es) setConnectionState("unavailable");
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
  });
}

function handleVisibility() {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible") {
    // A refocus is a fresh chance: clear a give-up that happened while the tab
    // was hidden or the machine asleep. Drop a dead EventSource FIRST — the
    // old `!source` guard made this a permanent no-op, because a CLOSED
    // EventSource still sits in `source`.
    gaveUp = false;
    failures = 0;
    if (source && source.readyState === EventSource.CLOSED) {
      closeSource("manual");
    }
    if (totalSubscribers() > 0 && !source) {
      openSource();
    }
  } else {
    closeSource("hidden");
  }
}

function handleOffline() {
  // Without this a wifi drop burns the whole failure budget on retries that
  // cannot succeed.
  closeSource("manual");
  if (connectionState !== "paused") setConnectionState("reconnecting");
}

function handleOnline() {
  gaveUp = false;
  failures = 0;
  if (totalSubscribers() > 0 && !source) {
    openSource();
  }
}

function ensureVisibilityBinding() {
  if (visibilityBound) return;
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", handleVisibility);
  if (typeof window !== "undefined") {
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
  }
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

function subscribePackyWsConnectionState(
  handler: ConnectionStateHandler,
): () => void {
  if (typeof window === "undefined") return () => {};
  connectionStateHandlers.add(handler);
  handler(connectionState);
  return () => {
    connectionStateHandlers.delete(handler);
  };
}
