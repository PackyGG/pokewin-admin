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
 * notifies every subscriber so callers can fall back to polling.
 *
 * Visibility: the connection closes on `visibilitychange → hidden` and
 * reopens when the tab becomes visible again, so background tabs don't
 * hold streams open.
 */

type Subscriber<T> = {
  onInit: (rows: T[]) => void;
  onRow: (row: T) => void;
  onReconnect?: () => void;
  onGiveUp?: () => void;
};

type Connection = {
  url: string;
  maxFailures: number;
  subscribers: Set<Subscriber<unknown>>;
  source: EventSource | null;
  failures: number;
  opened: boolean;
  backoffTimer: ReturnType<typeof setTimeout> | null;
  gaveUp: boolean;
  visibilityBound: boolean;
  onVisibility: (() => void) | null;
  /**
   * Last `init` payload received on the current (or most recent)
   * connection. Replayed to subscribers that join after `init` already
   * fired so a late mount still gets the snapshot instead of waiting for
   * the next row.
   */
  lastInit: unknown[] | null;
};

const connections = new Map<string, Connection>();

function getConnection(url: string, maxFailures: number): Connection {
  let conn = connections.get(url);
  if (!conn) {
    conn = {
      url,
      maxFailures,
      subscribers: new Set(),
      source: null,
      failures: 0,
      opened: false,
      backoffTimer: null,
      gaveUp: false,
      visibilityBound: false,
      onVisibility: null,
      lastInit: null,
    };
    connections.set(url, conn);
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

function closeSource(conn: Connection) {
  if (conn.source) {
    try {
      conn.source.close();
    } catch {
      // already closed — ignore
    }
    conn.source = null;
  }
  conn.opened = false;
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
    source = new EventSource(conn.url);
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
    conn.failures = 0;
  });

  source.addEventListener("init", (ev) => {
    if (conn.source !== source) return;
    try {
      const parsed = JSON.parse((ev as MessageEvent<string>).data);
      if (Array.isArray(parsed)) {
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
      const parsed = JSON.parse((ev as MessageEvent<string>).data);
      emitRow(conn, parsed);
    } catch {
      // Ignore malformed row.
    }
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

    closeSource(conn);

    const wasHealthy = conn.opened;
    if (wasHealthy) {
      // First failure after a healthy run — treat as a soft retry.
      conn.failures = 0;
    } else {
      conn.failures += 1;
    }

    if (conn.failures >= conn.maxFailures) {
      conn.gaveUp = true;
      emitGiveUp(conn);
      return;
    }

    // Exponential backoff capped at 30s. 1s, 2s, 4s, 8s, 16s, 30s, 30s…
    const delay = Math.min(30_000, 1000 * 2 ** conn.failures);
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
  conn.visibilityBound = true;
}

function teardownConnection(conn: Connection) {
  closeSource(conn);
  if (conn.backoffTimer) {
    clearTimeout(conn.backoffTimer);
    conn.backoffTimer = null;
  }
  if (conn.visibilityBound && conn.onVisibility && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", conn.onVisibility);
  }
  conn.visibilityBound = false;
  conn.onVisibility = null;
  connections.delete(conn.url);
}

function subscribe<T>(
  url: string,
  maxFailures: number,
  sub: Subscriber<T>,
): () => void {
  const conn = getConnection(url, maxFailures);
  // Keep the tightest give-up threshold any active subscriber asked for.
  conn.maxFailures = Math.min(conn.maxFailures, maxFailures);

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
  } else {
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
  },
  options?: { enabled?: boolean; maxFailures?: number },
): void {
  const enabled = options?.enabled ?? true;
  const maxFailures = options?.maxFailures ?? 8;

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
    };

    return subscribe<T>(url, maxFailures, sub);
  }, [url, enabled, maxFailures]);
}
