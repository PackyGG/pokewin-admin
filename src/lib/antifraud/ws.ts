/**
 * The wire contract with the (separate, not-yet-built) antifraud backend
 * service, plus the browser-side subscription client.
 *
 * TOPOLOGY — deliberately the same shape as the existing packy.gg live feed
 * (`src/lib/packy-ws.ts` + `/api/packy-live`), because it is the shape that
 * works on Vercel:
 *
 *     fraud backend ──WebSocket──▶ /api/antifraud/stream ──SSE──▶ browser
 *
 * The browser NEVER holds a WebSocket to the fraud backend directly. A Node
 * route on our side owns that connection, which means: the backend token never
 * reaches the client, the connection is authenticated with the dashboard
 * session, and the backend only ever has to trust one origin.
 *
 * The backend also has a SECOND, push-only path for durable events — the signed
 * `/api/antifraud/ingest` webhook — so a fraud signal is persisted even when no
 * analyst has the dashboard open. The WebSocket is for LIVE awareness; the
 * webhook is the system of record. Neither is required for the workspace to
 * function: with no backend configured the pages render from the admin DB and
 * the live strip simply reports "offline".
 *
 * This module is isomorphic (imported by both the SSE route and the browser
 * hook), so it must stay free of server-only imports.
 */

// ─── Wire contract ────────────────────────────────────────────────────────

/** Severity vocabulary, shared with `antifraud_signals.severity`. */
export type AntifraudSeverity = "low" | "medium" | "high" | "critical";

/** A fraud signal as the backend emits it. */
export type AntifraudSignalEvent = {
  type: "signal";
  /** The backend's own event id — the idempotency key for /ingest. */
  id: string;
  /** Rule key: 'multi_account' | 'bonus_abuse' | 'vpn' | 'chargeback' | … */
  kind: string;
  severity: AntifraudSeverity;
  /** 0–100. */
  riskScore?: number | null;
  /** MAIN-DB `user.id` of the account the signal is about. */
  userId?: string | null;
  username?: string | null;
  /** One-line human summary rendered in the live strip. */
  summary: string;
  /** Free-form rule detail. Rendered as JSON on the review. */
  payload?: Record<string, unknown> | null;
  /** ISO-8601. */
  at: string;
};

/** A backend-side status/metrics frame — drives the dashboard's health tiles. */
export type AntifraudStatusEvent = {
  type: "status";
  /** Backend's own view of itself. */
  state: "ok" | "degraded" | "down";
  /** Optional counters the backend chooses to publish. */
  metrics?: Record<string, number> | null;
  message?: string | null;
  at: string;
};

/** Emitted by OUR proxy (never by the backend) to describe the pipe itself. */
export type AntifraudTransportEvent = {
  type: "transport";
  state: "connecting" | "open" | "closed" | "unconfigured" | "error";
  message?: string | null;
  at: string;
};

export type AntifraudEvent =
  | AntifraudSignalEvent
  | AntifraudStatusEvent
  | AntifraudTransportEvent;

export type AntifraudEventType = AntifraudEvent["type"];

/**
 * Parse + validate one frame. Anything that isn't a recognised, well-formed
 * event is dropped rather than trusted — the backend is a separate service and
 * this is the boundary where its output stops being assumed correct.
 */
export function parseAntifraudEvent(raw: unknown): AntifraudEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  const at = typeof obj.at === "string" ? obj.at : new Date().toISOString();

  if (type === "signal") {
    if (typeof obj.id !== "string" || typeof obj.kind !== "string") return null;
    if (typeof obj.summary !== "string") return null;
    return {
      type: "signal",
      id: obj.id,
      kind: obj.kind,
      severity: normalizeSeverity(obj.severity),
      riskScore: normalizeScore(obj.riskScore),
      userId: typeof obj.userId === "string" ? obj.userId : null,
      username: typeof obj.username === "string" ? obj.username : null,
      summary: obj.summary.slice(0, 500),
      payload:
        obj.payload && typeof obj.payload === "object"
          ? (obj.payload as Record<string, unknown>)
          : null,
      at,
    };
  }

  if (type === "status") {
    const state = obj.state;
    return {
      type: "status",
      state:
        state === "ok" || state === "degraded" || state === "down"
          ? state
          : "degraded",
      metrics:
        obj.metrics && typeof obj.metrics === "object"
          ? (obj.metrics as Record<string, number>)
          : null,
      message: typeof obj.message === "string" ? obj.message : null,
      at,
    };
  }

  if (type === "transport") {
    const state = obj.state;
    const known = ["connecting", "open", "closed", "unconfigured", "error"];
    return {
      type: "transport",
      state: (known.includes(state as string)
        ? state
        : "error") as AntifraudTransportEvent["state"],
      message: typeof obj.message === "string" ? obj.message : null,
      at,
    };
  }

  return null;
}

export function normalizeSeverity(value: unknown): AntifraudSeverity {
  return value === "low" || value === "high" || value === "critical"
    ? value
    : "medium";
}

export function normalizeScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Severity ranking, for "is this worth a ping?" decisions. */
export const SEVERITY_RANK: Record<AntifraudSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * The severity at or above which an incoming signal notifies the on-call staff
 * (see the ingest route). Below this a signal is persisted silently and shows
 * up in the queue without waking anybody.
 */
export const NOTIFY_SEVERITY_FLOOR: AntifraudSeverity = "high";

// ─── Browser subscription client ──────────────────────────────────────────

/** SSE endpoint our proxy exposes. */
export const ANTIFRAUD_SSE_PATH = "/api/antifraud/stream";

type Handler = (event: AntifraudEvent) => void;

/**
 * Subscribe to the live feed. Returns an unsubscribe function.
 *
 * ONE EventSource is shared by every subscriber in the tab (the fraud backend
 * shouldn't see N connections because a page renders N widgets), and it is torn
 * down when the last subscriber leaves. Browser-only — calling this during SSR
 * is a no-op that returns a no-op unsubscribe.
 */
export function subscribeAntifraudStream(handler: Handler): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return () => {};
  }
  handlers.add(handler);
  ensureSource();
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) closeSource();
  };
}

const handlers = new Set<Handler>();
let source: EventSource | null = null;

function dispatch(event: AntifraudEvent) {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch (err) {
      console.error("[antifraud-ws] handler threw", err);
    }
  }
}

function ensureSource() {
  if (source) return;
  try {
    source = new EventSource(ANTIFRAUD_SSE_PATH);
  } catch {
    dispatch({
      type: "transport",
      state: "error",
      message: "Could not open the live stream",
      at: new Date().toISOString(),
    });
    return;
  }

  source.onopen = () => {
    dispatch({
      type: "transport",
      state: "open",
      at: new Date().toISOString(),
    });
  };

  source.onmessage = (message: MessageEvent<string>) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    const event = parseAntifraudEvent(parsed);
    if (event) dispatch(event);
  };

  source.onerror = () => {
    // EventSource reconnects on its own; report the blip and let it.
    dispatch({
      type: "transport",
      state: "error",
      message: "Live stream interrupted — reconnecting",
      at: new Date().toISOString(),
    });
  };
}

function closeSource() {
  if (!source) return;
  source.onopen = null;
  source.onmessage = null;
  source.onerror = null;
  try {
    source.close();
  } catch {
    // already closed
  }
  source = null;
}
