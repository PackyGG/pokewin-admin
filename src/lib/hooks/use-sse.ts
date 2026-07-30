"use client";

import * as React from "react";

/**
 * Browser-side subscription to a server SSE stream.
 *
 * Contract matches `sseResponse` in `@/lib/sse`:
 *   - `init`      → `onInit(rows)` (single call when the connection opens)
 *   - `row`       → `onRow(row)`   (one call per new row)
 *   - `reconnect` → client tears down and opens a fresh EventSource
 *     immediately (server-initiated rotation before Vercel's function
 *     maxDuration cap).
 *
 * ── Connection dedupe (one EventSource per URL per tab) ──────────────
 * The actual EventSource lives in a module-level singleton keyed by URL,
 * NOT inside the hook. Every component that calls `useSseStream` with the
 * same URL shares ONE underlying connection — mounting the same feed in
 * several places (or the same component twice) no longer opens N streams
 * to the server. This mirrors the WS singleton in `@/lib/packy-ws`.
 *
 * Scope note: this dedupes within a single browser TAB (one JS context).
 * Separate tabs are separate JS contexts and each open one connection —
 * true cross-tab dedupe would need shared state (BroadcastChannel leader
 * election / SharedWorker), which is intentionally out of scope. The
 * server keeps a best-effort per-instance cap as a backstop.
 *
 * Reconnect/backoff: the browser's EventSource has its own near-instant
 * first reconnect; on top of that the singleton adds backoff (1s → 2s →
 * 4s → … → 30s) for repeated failures so a DB outage doesn't hammer the
 * server. After `maxFailures` consecutive cold failures it gives up and
 * notifies every subscriber so callers can fall back to polling. A
 * give-up is NOT forever: it clears when the network comes back
 * (`online`), when a hidden tab becomes visible again, or when a caller
 * invokes `retrySseConnection(url)`.
 *
 * Terminal frames: a server that wants the client to STOP retrying (bad
 * config, permanent refusal) sends `event: fatal` before closing. A plain
 * clean EOF is otherwise retried by the browser forever, which turned
 * "service unconfigured" into a silent 15s reconnect loop.
 *
 * Visibility: the connection closes on `visibilitychange → hidden` and
 * reopens when the tab becomes visible again, so background tabs don't
 * hold streams open. `offline`/`online` are handled the same way so a
 * wifi drop doesn't burn the failure budget.
 *
 * Resume cursors survive teardown: the last delivered event id is kept in
 * a module-level map keyed by URL, so a client-side navigation that
 * unmounts every subscriber still resumes from where it left off instead
 * of silently losing the gap.
 */

type Subscriber<T> = {
  onInit: (rows: T[]) => void;
  onRow: (row: T) => void;
  onReconnect?: () => void;
  onGiveUp?: () => void;
  onStale?: () => void;
};

type Connection = {
  url: string;
  resumeParam: string | null;
  lastEventId: string | null;
  maxFailures: number;
  subscribers: Set<Subscriber<unknown>>;
  source: EventSource | null;
  failures: number;
  opened: boolean;
  /** When the current EventSource fired `open`; 0 while not open. */
  openedAt: number;
  backoffTimer: ReturnType<typeof setTimeout> | null;
  gaveUp: boolean;
  visibilityBound: boolean;
  onVisibility: (() => void) | null;
  onOnline: (() => void) | null;
  onOffline: (() => void) | null;
  /**
   * Last `init` payload received on the current (or most recent)
   * connection. Replayed to subscribers that join after `init` already
   * fired so a late mount still gets the snapshot instead of waiting for
   * the next row.
   */
  lastInit: unknown[] | null;
  staleAfterMs: number | null;
  staleTimer: ReturnType<typeof setTimeout> | null;
};

const connections = new Map<string, Connection>();

/**
 * Last delivered event id per URL. Deliberately OUTSIDE the connection so a
 * full teardown (route change unmounting every subscriber) does not lose the
 * replay cursor — the next mount resumes instead of starting cold.
 */
const resumeCursors = new Map<string, string>();

/**
 * A run this long before dropping counts as "healthy": the next failure
 * restarts the backoff schedule instead of escalating it.
 */
const STABLE_SESSION_MS = 30_000;

/**
 * Clear a gave-up connection and try again. Called internally on
 * `online`/visibility recovery; exported so consumers can wire a manual
 * "reconnect" affordance or a periodic retry to their polling fallback.
 */
export function retrySseConnection(url: string): void {
  const conn = connections.get(url);
  if (!conn || conn.subscribers.size === 0) return;
  conn.gaveUp = false;
  conn.failures = 0;
  if (conn.backoffTimer) {
    clearTimeout(conn.backoffTimer);
    conn.backoffTimer = null;
  }
  connect(conn);
}

function getConnection(
  url: string,
  maxFailures: number,
  resumeParam: string | null,
): Connection {
  let conn = connections.get(url);
  if (!conn) {
    conn = {
      url,
      resumeParam,
      lastEventId: resumeCursors.get(url) ?? null,
      maxFailures,
      subscribers: new Set(),
      source: null,
      failures: 0,
      opened: false,
      openedAt: 0,
      backoffTimer: null,
      gaveUp: false,
      visibilityBound: false,
      onVisibility: null,
      onOnline: null,
      onOffline: null,
      lastInit: null,
      staleAfterMs: null,
      staleTimer: null,
    };
    connections.set(url, conn);
  } else if (!conn.resumeParam && resumeParam) {
    conn.resumeParam = resumeParam;
  }
  return conn;
}

function emitInit<T>(conn: Connection, rows: T[]) {
  for (const sub of conn.subscribers) {
    try {
      (sub as Subscriber<T>).onInit(rows);
    } catch {
      // One subscriber throwing must not break the fan-out.
    }
  }
}

function emitRow<T>(conn: Connection, row: T) {
  for (const sub of conn.subscribers) {
    try {
      (sub as Subscriber<T>).onRow(row);
    } catch {
      // ignore — keep broadcasting
    }
  }
}

function emitReconnect(conn: Connection) {
  for (const sub of conn.subscribers) {
    try {
      sub.onReconnect?.();
    } catch {
      // ignore
    }
  }
}

function emitGiveUp(conn: Connection) {
  for (const sub of conn.subscribers) {
    try {
      sub.onGiveUp?.();
    } catch {
      // ignore
    }
  }
}

function armStaleTimer(conn: Connection) {
  if (!conn.staleAfterMs) return;
  if (conn.staleTimer) clearTimeout(conn.staleTimer);
  conn.staleTimer = setTimeout(() => {
    conn.staleTimer = null;
    for (const sub of conn.subscribers) {
      try {
        sub.onStale?.();
      } catch {
        // One subscriber cannot block transport recovery.
      }
    }
    const wasOpen = closeSource(conn);
    if (!wasOpen || conn.subscribers.size === 0) return;
    // A stale cycle is a failure too: a buffering middlebox that swallows
    // frames must escalate through backoff and eventually give up, instead
    // of dropping + reopening at full speed forever.
    conn.failures += 1;
    if (conn.failures >= conn.maxFailures) {
      conn.gaveUp = true;
      emitGiveUp(conn);
      return;
    }
    emitReconnect(conn);
    const delay = Math.min(30_000, 1000 * 2 ** (conn.failures - 1));
    conn.backoffTimer = setTimeout(() => {
      conn.backoffTimer = null;
      connect(conn);
    }, delay);
  }, conn.staleAfterMs);
}

function closeSource(conn: Connection): boolean {
  const wasOpened = conn.opened;
  if (conn.source) {
    try {
      conn.source.close();
    } catch {
      // already closed — ignore
    }
    conn.source = null;
  }
  conn.opened = false;
  conn.openedAt = 0;
  if (conn.staleTimer) {
    clearTimeout(conn.staleTimer);
    conn.staleTimer = null;
  }
  return wasOpened;
}

function connect(conn: Connection) {
  if (typeof window === "undefined") return;
  if (conn.gaveUp) return;
  if (conn.subscribers.size === 0) return;
  if (conn.source) return;
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    // Don't open into a hidden tab; reopen on visibilitychange.
    return;
  }

  let source: EventSource;
  try {
    const sourceUrl = new URL(conn.url, window.location.href);
    if (conn.resumeParam && conn.lastEventId) {
      sourceUrl.searchParams.set(conn.resumeParam, conn.lastEventId);
    }
    source = new EventSource(sourceUrl.toString());
  } catch {
    // Construction failed (very old browser). Treat as give-up so
    // callers fall back to polling.
    conn.gaveUp = true;
    emitGiveUp(conn);
    return;
  }
  conn.source = source;

  source.addEventListener("open", () => {
    if (conn.source !== source) return;
    conn.opened = true;
    conn.openedAt = Date.now();
    // Deliberately NOT resetting `failures` here: a flapping endpoint that
    // opens and immediately dies would otherwise retry at 1s forever. The
    // error handler resets the schedule only after a session that lasted
    // `STABLE_SESSION_MS`.
    armStaleTimer(conn);
  });

  source.addEventListener("init", (ev) => {
    if (conn.source !== source) return;
    try {
      const parsed = JSON.parse((ev as MessageEvent<string>).data);
      if (Array.isArray(parsed)) {
        armStaleTimer(conn);
        conn.lastInit = parsed as unknown[];
        emitInit(conn, parsed);
      }
    } catch {
      // Malformed frame — ignore; next row/init recovers state.
    }
  });

  source.addEventListener("row", (ev) => {
    if (conn.source !== source) return;
    try {
      const message = ev as MessageEvent<string>;
      if (message.lastEventId) {
        conn.lastEventId = message.lastEventId;
        resumeCursors.set(conn.url, message.lastEventId);
      }
      const parsed = JSON.parse(message.data);
      armStaleTimer(conn);
      emitRow(conn, parsed);
    } catch {
      // Ignore malformed row.
    }
  });

  source.addEventListener("fatal", () => {
    if (conn.source !== source) return;
    // The server says retrying is pointless (unconfigured / permanent
    // refusal). Without this a clean EOF is retried by the browser every
    // `retry:` interval forever.
    closeSource(conn);
    conn.gaveUp = true;
    emitGiveUp(conn);
  });

  source.addEventListener("reconnect", () => {
    if (conn.source !== source) return;
    emitReconnect(conn);
    // Graceful rotation: close and reopen right away. Counts as a
    // successful cycle, not a failure.
    closeSource(conn);
    conn.failures = 0;
    connect(conn);
  });

  source.addEventListener("error", () => {
    if (conn.source !== source) return;
    // EventSource fires `error` on both transient disconnects (it will
    // auto-reconnect) AND terminal failures (readyState CLOSED). Only act
    // on the terminal case; otherwise let the browser's own retry run.
    if (source.readyState !== EventSource.CLOSED) return;

    const sessionMs = conn.openedAt ? Date.now() - conn.openedAt : 0;
    const wasHealthy = closeSource(conn);
    if (wasHealthy) {
      // The connection opened before dying. Only a session that actually
      // LASTED resets the schedule — an endpoint that opens and drops
      // instantly (proxy accepts, then resets the body) must escalate
      // through the same 1s → 2s → … → 30s ramp and eventually give up,
      // not hammer at 1s forever.
      conn.failures = sessionMs >= STABLE_SESSION_MS ? 1 : conn.failures + 1;
      if (conn.failures >= conn.maxFailures) {
        conn.gaveUp = true;
        emitGiveUp(conn);
        return;
      }
      const delay = Math.min(30_000, 1000 * 2 ** (conn.failures - 1));
      conn.backoffTimer = setTimeout(() => {
        conn.backoffTimer = null;
        connect(conn);
      }, delay);
      return;
    }

    // Never opened — almost certainly a server-side rejection (most
    // commonly the per-user `MAX_CONCURRENT` 429 on the live routes,
    // or an auth bounce). The previous behaviour was the same 1s →
    // 2s → 4s → … schedule, which spammed the console with 429s for
    // ~2 minutes before giving up and falling back to polling. Two
    // changes mitigate that:
    //   1. Harder backoff: 5s, 15s, 45s, 90s, 180s. The 429 isn't
    //      transient — the server is genuinely overloaded for this
    //      user, so retrying after 1s makes no difference.
    //   2. Lower give-up threshold for the never-opened case: 3
    //      attempts (~70s) instead of `maxFailures` (default 8 →
    //      multiple minutes). The polling fallback uses a server
    //      action that goes through a different path and is unaffected
    //      by this route's per-instance counter, so falling back faster
    //      is strictly better.
    conn.failures += 1;
    const NO_OPEN_GIVE_UP = 3;
    if (conn.failures >= Math.min(conn.maxFailures, NO_OPEN_GIVE_UP)) {
      conn.gaveUp = true;
      emitGiveUp(conn);
      return;
    }

    const NO_OPEN_BACKOFF_MS = [5_000, 15_000, 45_000, 90_000, 180_000];
    const delay =
      NO_OPEN_BACKOFF_MS[
        Math.min(conn.failures - 1, NO_OPEN_BACKOFF_MS.length - 1)
      ];
    conn.backoffTimer = setTimeout(() => {
      conn.backoffTimer = null;
      connect(conn);
    }, delay);
  });
}

function ensureVisibilityBinding(conn: Connection) {
  if (conn.visibilityBound) return;
  if (typeof document === "undefined") return;
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      // A refocus is a fresh chance: clear a give-up that happened while
      // the tab was hidden or the machine was asleep.
      conn.gaveUp = false;
      conn.failures = 0;
      if (!conn.source && conn.subscribers.size > 0) connect(conn);
    } else {
      closeSource(conn);
      if (conn.backoffTimer) {
        clearTimeout(conn.backoffTimer);
        conn.backoffTimer = null;
      }
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  conn.onVisibility = onVisibility;

  if (typeof window !== "undefined") {
    // Without these a wifi drop burns the whole failure budget on retries
    // that cannot succeed, and nothing reconnects when the network returns.
    const onOffline = () => {
      closeSource(conn);
      if (conn.backoffTimer) {
        clearTimeout(conn.backoffTimer);
        conn.backoffTimer = null;
      }
    };
    const onOnline = () => {
      conn.gaveUp = false;
      conn.failures = 0;
      if (!conn.source && conn.subscribers.size > 0) connect(conn);
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    conn.onOffline = onOffline;
    conn.onOnline = onOnline;
  }
  conn.visibilityBound = true;
}

function teardownConnection(conn: Connection) {
  closeSource(conn);
  if (conn.backoffTimer) {
    clearTimeout(conn.backoffTimer);
    conn.backoffTimer = null;
  }
  if (conn.staleTimer) {
    clearTimeout(conn.staleTimer);
    conn.staleTimer = null;
  }
  if (conn.visibilityBound && conn.onVisibility && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", conn.onVisibility);
  }
  if (typeof window !== "undefined") {
    if (conn.onOffline) window.removeEventListener("offline", conn.onOffline);
    if (conn.onOnline) window.removeEventListener("online", conn.onOnline);
  }
  conn.visibilityBound = false;
  conn.onVisibility = null;
  conn.onOffline = null;
  conn.onOnline = null;
  // `resumeCursors` intentionally survives so the next mount resumes.
  connections.delete(conn.url);
}

function subscribe<T>(
  url: string,
  maxFailures: number,
  resumeParam: string | null,
  staleAfterMs: number | null,
  sub: Subscriber<T>,
): () => void {
  const conn = getConnection(url, maxFailures, resumeParam);
  // Keep the tightest give-up threshold any active subscriber asked for.
  conn.maxFailures = Math.min(conn.maxFailures, maxFailures);
  if (staleAfterMs) {
    conn.staleAfterMs = conn.staleAfterMs
      ? Math.min(conn.staleAfterMs, staleAfterMs)
      : staleAfterMs;
  }

  conn.subscribers.add(sub as Subscriber<unknown>);
  ensureVisibilityBinding(conn);

  if (conn.gaveUp) {
    // The shared connection already exhausted its retries. Tell this
    // late joiner immediately so it falls back like everyone else.
    try {
      sub.onGiveUp?.();
    } catch {
      // ignore
    }
  } else if (conn.source) {
    // Connection already live — replay the last snapshot so a late mount
    // gets the same `init` the earlier subscribers did.
    if (conn.lastInit) {
      try {
        sub.onInit(conn.lastInit as T[]);
      } catch {
        // ignore
      }
    }
  } else if (!conn.backoffTimer) {
    // A pending backoff timer means a retry is already scheduled — a new
    // subscriber must not bypass the schedule with an immediate attempt.
    connect(conn);
  }

  return () => {
    conn.subscribers.delete(sub as Subscriber<unknown>);
    if (conn.subscribers.size === 0) {
      teardownConnection(conn);
    }
  };
}

export function useSseStream<T>(
  url: string,
  handlers: {
    onInit: (rows: T[]) => void;
    onRow: (row: T) => void;
    onReconnect?: () => void;
    onGiveUp?: () => void;
    onStale?: () => void;
  },
  options?: {
    enabled?: boolean;
    maxFailures?: number;
    /** Query key used to resume when visibility creates a fresh EventSource. */
    resumeParam?: string;
    /** Reopen a silently wedged stream when no frame arrives in this window. */
    staleAfterMs?: number;
  },
): void {
  const enabled = options?.enabled ?? true;
  const maxFailures = options?.maxFailures ?? 8;
  const resumeParam = options?.resumeParam ?? null;
  const staleAfterMs = options?.staleAfterMs ?? null;

  // Pin handlers in a ref so the shared subscriber object always calls
  // the latest callbacks without re-subscribing on every parent render.
  const handlersRef = React.useRef(handlers);
  handlersRef.current = handlers;

  React.useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    if (typeof EventSource === "undefined") {
      // No EventSource (very old browsers / SSR). Caller fallback kicks in.
      handlersRef.current.onGiveUp?.();
      return;
    }

    // Stable subscriber that forwards to the current ref-pinned handlers.
    const sub: Subscriber<T> = {
      onInit: (rows) => handlersRef.current.onInit(rows),
      onRow: (row) => handlersRef.current.onRow(row),
      onReconnect: () => handlersRef.current.onReconnect?.(),
      onGiveUp: () => handlersRef.current.onGiveUp?.(),
      onStale: () => handlersRef.current.onStale?.(),
    };

    return subscribe<T>(url, maxFailures, resumeParam, staleAfterMs, sub);
  }, [url, enabled, maxFailures, resumeParam, staleAfterMs]);
}
