"use client";

import * as React from "react";

/**
 * Browser-side subscription to a server SSE stream.
 *
 * Contract matches `sseResponse` in `@/lib/sse`:
 *   - `init`      → `onInit(rows)` (single call on open)
 *   - `row`       → `onRow(row)`   (one call per new row)
 *   - `reconnect` → client tears down and opens a fresh EventSource
 *     immediately (server-initiated rotation before Vercel's function
 *     maxDuration cap).
 *
 * On network errors the browser's EventSource has its own built-in
 * exponential backoff, but the *first* reconnect is near-instant. We add
 * our own backoff (1s → 2s → 4s → … → 30s max) for repeated failures so
 * a DB outage doesn't hammer the server. After `maxFailures` consecutive
 * failures we give up and call `onGiveUp` so the caller can fall back to
 * the old polling code.
 *
 * Pauses when the tab is hidden: we close the EventSource on
 * `visibilitychange → hidden` and reopen when the tab becomes visible
 * again. The server would otherwise happily keep streaming into a
 * background tab, which is fine but wasteful.
 */
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

  // Pin handlers in a ref so the effect below doesn't re-run when parent
  // components re-render and pass fresh callback identities.
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

    let source: EventSource | null = null;
    let failures = 0;
    let backoffTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    // Track whether the most recent EventSource ever successfully opened,
    // so we can distinguish "transient network blip on already-healthy
    // stream" from "can't even reach the server". Only the latter counts
    // toward the give-up threshold — otherwise a single blip on a long
    // running connection would edge us closer to the fallback each time.
    let opened = false;

    const connect = () => {
      if (disposed) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        // Don't open a stream into a hidden tab; we'll reconnect on visibility change.
        return;
      }

      source = new EventSource(url);

      source.addEventListener("open", () => {
        opened = true;
        failures = 0;
      });

      source.addEventListener("init", (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent<string>).data);
          if (Array.isArray(parsed)) {
            handlersRef.current.onInit(parsed as T[]);
          }
        } catch {
          // Malformed frame — ignore; next row/init will recover state.
        }
      });

      source.addEventListener("row", (ev) => {
        try {
          const parsed = JSON.parse((ev as MessageEvent<string>).data);
          handlersRef.current.onRow(parsed as T);
        } catch {
          // Ignore malformed row.
        }
      });

      source.addEventListener("reconnect", () => {
        handlersRef.current.onReconnect?.();
        // Graceful rotation: close the current stream and open a new one
        // right away. Counts as a successful cycle, not a failure.
        source?.close();
        source = null;
        opened = false;
        failures = 0;
        connect();
      });

      source.addEventListener("error", () => {
        // EventSource fires `error` both on transient disconnects (it will
        // auto-reconnect) AND on terminal failures when readyState is
        // CLOSED. We only take action in the CLOSED case — otherwise let
        // the browser's own retry run.
        if (!source) return;
        if (source.readyState !== EventSource.CLOSED) return;

        source.close();
        source = null;

        // Reset "opened" now that the stream is dead, so the next
        // connect() knows whether it fails from scratch or not.
        const wasHealthy = opened;
        opened = false;

        if (wasHealthy) {
          // First failure after a healthy run — treat as a soft retry.
          failures = 0;
        } else {
          failures += 1;
        }

        if (failures >= maxFailures) {
          handlersRef.current.onGiveUp?.();
          return;
        }

        // Exponential backoff capped at 30s. 1s, 2s, 4s, 8s, 16s, 30s, 30s…
        const delay = Math.min(30_000, 1000 * 2 ** failures);
        backoffTimer = setTimeout(connect, delay);
      });
    };

    // Reconnect on tab-visibility changes so background tabs don't hold
    // open streams forever.
    const onVisibility = () => {
      if (disposed) return;
      if (document.visibilityState === "visible") {
        if (!source) connect();
      } else {
        if (source) {
          source.close();
          source = null;
          opened = false;
        }
        if (backoffTimer) {
          clearTimeout(backoffTimer);
          backoffTimer = null;
        }
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    connect();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (backoffTimer) clearTimeout(backoffTimer);
      if (source) {
        source.close();
        source = null;
      }
    };
  }, [url, enabled, maxFailures]);
}
