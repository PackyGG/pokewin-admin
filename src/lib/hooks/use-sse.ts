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
 * ── Cross-tab sharing (one EventSource per URL per ORIGIN) ───────────
 * On browsers with the Web Locks API + BroadcastChannel, tabs additionally
 * share ONE physical connection across the whole origin. Every tab races
 * for an exclusive lock (`sse-leader:${url}`); the winner is the LEADER
 * and owns the real EventSource with all the machinery below (backoff,
 * visibility, stale watchdog, resume cursors). Everyone else is a
 * FOLLOWER: no EventSource at all — the leader re-broadcasts every
 * `init`/`row`/`reconnect`/`giveup`/`stale` over a BroadcastChannel
 * (`sse:${url}`) and followers deliver those frames to their local
 * subscribers exactly like a direct connection would.
 *
 * Leadership is per-tab-lifetime: the lock auto-releases when the leader
 * tab closes, crashes, or drops its last subscriber with no followers
 * left, at which point a queued follower is granted the lock, promotes
 * itself, and reopens from the shared resume cursor — every `row`
 * broadcast carries its event id, so a follower that becomes leader
 * resumes exactly after the last frame it delivered (no gap, no dupe).
 * A follower that mounts late sends `hello`; the leader answers with a
 * `welcome` carrying the last `init` snapshot + current cursor so late
 * mounts still get state. Followers forward `retrySseConnection` calls
 * to the leader over the same channel.
 *
 * Follower liveness: followers announce presence every 10s while they
 * have subscribers AND are visible. A hidden leader keeps the stream
 * open as long as it saw a follower in the last 30s (a hidden leader
 * must not starve visible tabs); once no follower has pinged for 30s the
 * normal hidden-tab shutdown applies, and a leader with zero local
 * subscribers and no live followers tears down and releases the lock.
 *
 * Degradation: if BroadcastChannel or `navigator.locks` is unavailable
 * (SSR, very old browser), every tab falls back to exactly the per-tab
 * singleton behavior above. Nothing changes server-side either way.
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
 * hold streams open — EXCEPT a leader with live followers (see above).
 * `offline`/`online` are handled the same way so a wifi drop doesn't
 * burn the failure budget.
 *
 * Resume cursors survive teardown AND reloads: the last delivered event
 * id is kept in a module-level map keyed by URL (client-side navigation
 * that unmounts every subscriber resumes instead of losing the gap) and
 * mirrored into sessionStorage (`sse-cursor:${url}`) so a full page
 * reload also resumes instead of starting cold. Storage access is
 * best-effort — private mode / disabled storage degrades silently.
 */

type Subscriber<T> = {
  onInit: (rows: T[]) => void;
  onRow: (row: T) => void;
  onReconnect?: () => void;
  onGiveUp?: () => void;
  onStale?: () => void;
};

/** One `useSseStream` mount: the subscriber plus the limits it asked for. */
type Entry = {
  sub: Subscriber<unknown>;
  maxFailures: number;
  staleAfterMs: number | null;
  resumeParam: string | null;
};

type Connection = {
  url: string;
  resumeParam: string | null;
  lastEventId: string | null;
  maxFailures: number;
  subscribers: Set<Subscriber<unknown>>;
  /**
   * The limits each LOCAL subscriber asked for, so an unsubscribe can
   * loosen `maxFailures`/`staleAfterMs` back to the survivors' tightest
   * request — a strict one-off subscriber must not permanently tighten
   * the shared connection. (The leader's broadcast relay is deliberately
   * absent from this map: with no local subscribers left, limits fall
   * back to the defaults.)
   */
  prefs: Map<Subscriber<unknown>, { maxFailures: number; staleAfterMs: number | null }>;
  /** Set while this tab leads a cross-tab share for the URL. */
  share: Share | null;
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

/** Cross-tab state for one URL: channel, role, and local mounts. */
type Share = {
  url: string;
  channel: BroadcastChannel;
  role: "follower" | "leader";
  entries: Set<Entry>;
  /** Follower-side mirror of the leader's last `init` snapshot. */
  lastInit: unknown[] | null;
  /** Follower-side mirror of the leader's give-up state. */
  gaveUp: boolean;
  /** Leader side: last time any follower pinged presence/hello. */
  lastFollowerSeen: number;
  presenceTimer: ReturnType<typeof setInterval> | null;
  leaderTimer: ReturnType<typeof setInterval> | null;
  lockAbort: AbortController | null;
  /** Resolving this releases the leadership lock. */
  releaseLock: (() => void) | null;
  closed: boolean;
};

type ShareMessage =
  | { t: "hello" }
  | { t: "presence" }
  | { t: "retry" }
  | { t: "init"; rows: unknown[] }
  | { t: "row"; row: unknown; cursor: string | null }
  | { t: "reconnect" }
  | { t: "giveup" }
  | { t: "stale" }
  | {
      t: "welcome";
      rows: unknown[] | null;
      cursor: string | null;
      gaveUp: boolean;
    };

const connections = new Map<string, Connection>();

const shares = new Map<string, Share>();

/**
 * Last delivered event id per URL. Deliberately OUTSIDE the connection so a
 * full teardown (route change unmounting every subscriber) does not lose the
 * replay cursor — the next mount resumes instead of starting cold. Mirrored
 * to sessionStorage so a reload resumes too.
 */
const resumeCursors = new Map<string, string>();

/**
 * A run this long before dropping counts as "healthy": the next failure
 * restarts the backoff schedule instead of escalating it.
 */
const STABLE_SESSION_MS = 30_000;

const DEFAULT_MAX_FAILURES = 8;

/** How often followers announce themselves to the leader. */
const PRESENCE_INTERVAL_MS = 10_000;

/** A follower that hasn't pinged in this long no longer counts as alive. */
const FOLLOWER_TTL_MS = 30_000;

function readStoredCursor(url: string): string | null {
  try {
    return window.sessionStorage.getItem(`sse-cursor:${url}`);
  } catch {
    // Private mode / storage disabled — resume-in-memory still works.
    return null;
  }
}

function writeStoredCursor(url: string, id: string): void {
  try {
    window.sessionStorage.setItem(`sse-cursor:${url}`, id);
  } catch {
    // Best-effort only.
  }
}

function rememberCursor(url: string, id: string): void {
  resumeCursors.set(url, id);
  writeStoredCursor(url, id);
}

function sharingAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof BroadcastChannel !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.locks &&
    typeof navigator.locks.request === "function"
  );
}

/**
 * Clear a gave-up connection and try again. Called internally on
 * `online`/visibility recovery; exported so consumers can wire a manual
 * "reconnect" affordance or a periodic retry to their polling fallback.
 * In a cross-tab share a follower forwards the request to the leader.
 */
export function retrySseConnection(url: string): void {
  const share = shares.get(url);
  if (share && share.role === "follower") {
    if (share.entries.size === 0) return;
    postToShare(share, { t: "retry" });
    return;
  }
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

function getConnection(url: string): Connection {
  let conn = connections.get(url);
  if (!conn) {
    let cursor = resumeCursors.get(url) ?? null;
    if (cursor === null && typeof window !== "undefined") {
      cursor = readStoredCursor(url);
      if (cursor) resumeCursors.set(url, cursor);
    }
    conn = {
      url,
      resumeParam: null,
      lastEventId: cursor,
      maxFailures: DEFAULT_MAX_FAILURES,
      subscribers: new Set(),
      prefs: new Map(),
      share: null,
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
  }
  return conn;
}

/** True while this leader saw a follower recently enough to matter. */
function hasRemoteInterest(conn: Connection): boolean {
  return (
    conn.share !== null &&
    Date.now() - conn.share.lastFollowerSeen < FOLLOWER_TTL_MS
  );
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
    document.visibilityState === "hidden" &&
    !hasRemoteInterest(conn)
  ) {
    // Don't open into a hidden tab; reopen on visibilitychange. A hidden
    // LEADER with live followers is the exception — closing would starve
    // the visible tabs it feeds.
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
        rememberCursor(conn.url, message.lastEventId);
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
      // A hidden leader with live followers keeps streaming — the
      // share's leader timer applies the shutdown once they're gone.
      if (hasRemoteInterest(conn)) return;
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
  conn.share = null;
  // `resumeCursors` intentionally survives so the next mount resumes.
  connections.delete(conn.url);
}

/**
 * Re-derive `maxFailures`/`staleAfterMs` from the surviving subscribers'
 * requests: tightest wins while they're mounted, defaults return when the
 * last strict subscriber leaves.
 */
function recomputeLimits(conn: Connection) {
  let maxFailures = Infinity;
  let staleAfterMs: number | null = null;
  for (const pref of conn.prefs.values()) {
    maxFailures = Math.min(maxFailures, pref.maxFailures);
    if (pref.staleAfterMs) {
      staleAfterMs =
        staleAfterMs === null
          ? pref.staleAfterMs
          : Math.min(staleAfterMs, pref.staleAfterMs);
    }
  }
  conn.maxFailures = Number.isFinite(maxFailures)
    ? maxFailures
    : DEFAULT_MAX_FAILURES;
  const previous = conn.staleAfterMs;
  conn.staleAfterMs = staleAfterMs;
  if (previous !== staleAfterMs) {
    if (!staleAfterMs && conn.staleTimer) {
      clearTimeout(conn.staleTimer);
      conn.staleTimer = null;
    } else if (conn.opened) {
      armStaleTimer(conn);
    }
  }
}

/** Attach one local mount to a connection (direct mode or leader mode). */
function attachLocal(conn: Connection, entry: Entry) {
  conn.prefs.set(entry.sub, {
    maxFailures: entry.maxFailures,
    staleAfterMs: entry.staleAfterMs,
  });
  if (!conn.resumeParam && entry.resumeParam) {
    conn.resumeParam = entry.resumeParam;
  }
  conn.subscribers.add(entry.sub);
  recomputeLimits(conn);
  ensureVisibilityBinding(conn);

  if (conn.gaveUp) {
    // The shared connection already exhausted its retries. Tell this
    // late joiner immediately so it falls back like everyone else.
    try {
      entry.sub.onGiveUp?.();
    } catch {
      // ignore
    }
  } else if (conn.source) {
    // Connection already live — replay the last snapshot so a late mount
    // gets the same `init` the earlier subscribers did.
    if (conn.lastInit) {
      try {
        entry.sub.onInit(conn.lastInit);
      } catch {
        // ignore
      }
    }
  } else if (!conn.backoffTimer) {
    // A pending backoff timer means a retry is already scheduled — a new
    // subscriber must not bypass the schedule with an immediate attempt.
    connect(conn);
  }
}

function detachLocal(conn: Connection, entry: Entry) {
  conn.subscribers.delete(entry.sub);
  conn.prefs.delete(entry.sub);
  recomputeLimits(conn);
}

function postToShare(share: Share, msg: ShareMessage) {
  try {
    share.channel.postMessage(msg);
  } catch {
    // Channel closed mid-flight — nothing to do.
  }
}

/** Fan one message out to this tab's local subscribers (follower side). */
function deliverToEntries(
  share: Share,
  deliver: (sub: Subscriber<unknown>) => void,
) {
  for (const entry of share.entries) {
    try {
      deliver(entry.sub);
    } catch {
      // One subscriber throwing must not break the fan-out.
    }
  }
}

/** This tab won the leadership lock: own the real EventSource. */
function becomeLeader(share: Share) {
  share.role = "leader";
  if (share.presenceTimer) {
    clearInterval(share.presenceTimer);
    share.presenceTimer = null;
  }

  const conn = getConnection(share.url);
  conn.share = share;

  // The relay subscriber: everything the real connection emits is
  // re-broadcast to follower tabs. It lives in `subscribers` (so the
  // connection stays alive for followers even with zero local mounts)
  // but NOT in `prefs` (it has no limit preferences of its own).
  const relay: Subscriber<unknown> = {
    onInit: (rows) => postToShare(share, { t: "init", rows }),
    onRow: (row) =>
      postToShare(share, { t: "row", row, cursor: conn.lastEventId }),
    onReconnect: () => postToShare(share, { t: "reconnect" }),
    onGiveUp: () => postToShare(share, { t: "giveup" }),
    onStale: () => postToShare(share, { t: "stale" }),
  };
  conn.subscribers.add(relay);

  for (const entry of share.entries) {
    attachLocal(conn, entry);
  }

  // Leader housekeeping: reap the share once nobody (local or remote)
  // needs it, and apply/undo the hidden-tab shutdown as follower
  // presence comes and goes.
  share.leaderTimer = setInterval(() => {
    const current = connections.get(share.url);
    if (!current || current.share !== share) return;
    const remote = hasRemoteInterest(current);
    if (share.entries.size === 0 && !remote) {
      teardownShare(share);
      return;
    }
    const hidden =
      typeof document !== "undefined" &&
      document.visibilityState === "hidden";
    if (hidden && !remote) {
      closeSource(current);
      if (current.backoffTimer) {
        clearTimeout(current.backoffTimer);
        current.backoffTimer = null;
      }
      return;
    }
    if (hidden && remote && !current.source && !current.gaveUp && !current.backoffTimer) {
      // A follower pinged while this hidden leader was shut down —
      // reopen on its behalf.
      connect(current);
    }
  }, PRESENCE_INTERVAL_MS);
}

/** Handle one BroadcastChannel frame, routed by current role. */
function handleShareMessage(share: Share, msg: ShareMessage) {
  if (share.closed) return;
  if (share.role === "leader") {
    const conn = connections.get(share.url);
    switch (msg.t) {
      case "hello": {
        share.lastFollowerSeen = Date.now();
        // Answer with current state so a late-joining tab doesn't wait
        // for the next natural `init`. Followers ignore null fields.
        postToShare(share, {
          t: "welcome",
          rows: conn?.lastInit ?? null,
          cursor: conn?.lastEventId ?? null,
          gaveUp: conn?.gaveUp ?? false,
        });
        // The follower may have pinged while this hidden leader had shut
        // the stream down — the leader timer reopens within one tick.
        return;
      }
      case "presence":
        share.lastFollowerSeen = Date.now();
        return;
      case "retry":
        if (conn) {
          conn.gaveUp = false;
          conn.failures = 0;
          if (conn.backoffTimer) {
            clearTimeout(conn.backoffTimer);
            conn.backoffTimer = null;
          }
          connect(conn);
        }
        return;
      default:
        return;
    }
  }

  // Follower side: mirror cursor + state, fan frames out locally.
  switch (msg.t) {
    case "init":
      share.lastInit = msg.rows;
      share.gaveUp = false;
      deliverToEntries(share, (sub) => sub.onInit(msg.rows));
      return;
    case "row":
      if (msg.cursor) rememberCursor(share.url, msg.cursor);
      deliverToEntries(share, (sub) => sub.onRow(msg.row));
      return;
    case "reconnect":
      deliverToEntries(share, (sub) => sub.onReconnect?.());
      return;
    case "giveup":
      share.gaveUp = true;
      deliverToEntries(share, (sub) => sub.onGiveUp?.());
      return;
    case "stale":
      deliverToEntries(share, (sub) => sub.onStale?.());
      return;
    case "welcome":
      if (msg.cursor) rememberCursor(share.url, msg.cursor);
      if (share.lastInit === null && msg.rows) {
        share.lastInit = msg.rows;
        const rows = msg.rows;
        deliverToEntries(share, (sub) => sub.onInit(rows));
      }
      if (msg.gaveUp && !share.gaveUp) {
        share.gaveUp = true;
        deliverToEntries(share, (sub) => sub.onGiveUp?.());
      }
      return;
    default:
      return;
  }
}

function ensureShare(url: string): Share | null {
  let share = shares.get(url);
  if (share) return share;

  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(`sse:${url}`);
  } catch {
    // Construction failed — caller falls back to the per-tab path.
    return null;
  }

  const created: Share = {
    url,
    channel,
    role: "follower",
    entries: new Set(),
    lastInit: null,
    gaveUp: false,
    lastFollowerSeen: 0,
    presenceTimer: null,
    leaderTimer: null,
    lockAbort: null,
    releaseLock: null,
    closed: false,
  };
  share = created;
  channel.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as ShareMessage;
    if (!msg || typeof msg.t !== "string") return;
    handleShareMessage(created, msg);
  };
  shares.set(url, share);

  // Race for leadership. Uncontended (the common single-tab case) the
  // lock is granted immediately; otherwise this tab queues as a
  // follower and promotes when the current leader tab dies or lets go.
  const abort = new AbortController();
  share.lockAbort = abort;
  navigator.locks
    .request(`sse-leader:${url}`, { mode: "exclusive", signal: abort.signal }, () => {
      // A teardown can race the grant — release instantly in that case.
      if (created.closed) return;
      becomeLeader(created);
      // Hold the lock for the lifetime of the share; resolving the
      // promise releases it and hands leadership to the next tab.
      return new Promise<void>((resolve) => {
        created.releaseLock = resolve;
      });
    })
    .catch(() => {
      // Aborted before grant, or a locks-API failure. If the share is
      // still alive we can't lead OR follow safely — degrade this tab
      // to the plain per-tab path by reporting the share unusable.
      if (!created.closed && shares.get(url) === created) {
        teardownShare(created);
      }
    });

  return share;
}

function teardownShare(share: Share) {
  if (share.closed) return;
  share.closed = true;
  shares.delete(share.url);
  if (share.presenceTimer) {
    clearInterval(share.presenceTimer);
    share.presenceTimer = null;
  }
  if (share.leaderTimer) {
    clearInterval(share.leaderTimer);
    share.leaderTimer = null;
  }
  const conn = connections.get(share.url);
  if (conn && conn.share === share) {
    teardownConnection(conn);
  }
  // Abort a still-pending lock request AND resolve a held lock — only
  // one of the two is active, the other is a no-op.
  share.lockAbort?.abort();
  share.lockAbort = null;
  share.releaseLock?.();
  share.releaseLock = null;
  try {
    share.channel.close();
  } catch {
    // ignore
  }
}

/** Attach one local mount as a follower (no EventSource in this tab). */
function followerAttach(share: Share, entry: Entry) {
  if (share.gaveUp) {
    try {
      entry.sub.onGiveUp?.();
    } catch {
      // ignore
    }
  } else if (share.lastInit) {
    try {
      entry.sub.onInit(share.lastInit);
    } catch {
      // ignore
    }
  }
  // Ask the leader for the current snapshot + cursor. Harmless if no
  // leader exists yet (this tab may be about to win the lock itself) —
  // the eventual leader's natural `init` broadcast covers that window.
  postToShare(share, { t: "hello" });

  if (!share.presenceTimer) {
    share.presenceTimer = setInterval(() => {
      if (share.role !== "follower") return;
      if (share.entries.size === 0) return;
      // Only VISIBLE followers keep a hidden leader streaming — a set of
      // tabs that are all hidden should still shut the stream down.
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      postToShare(share, { t: "presence" });
    }, PRESENCE_INTERVAL_MS);
  }
}

function shareUnsubscribe(share: Share, entry: Entry) {
  if (!share.entries.delete(entry)) return;
  if (share.role === "leader") {
    const conn = connections.get(share.url);
    if (conn && conn.share === share) detachLocal(conn, entry);
    // Leadership is per-tab-lifetime: with followers still alive the
    // connection stays open and keeps broadcasting even with zero local
    // subscribers. The leader timer reaps once followers are gone too.
    if (share.entries.size === 0 && conn && !hasRemoteInterest(conn)) {
      teardownShare(share);
    }
  } else if (share.entries.size === 0) {
    teardownShare(share);
  }
}

function subscribe<T>(
  url: string,
  maxFailures: number,
  resumeParam: string | null,
  staleAfterMs: number | null,
  sub: Subscriber<T>,
): () => void {
  const entry: Entry = {
    sub: sub as Subscriber<unknown>,
    maxFailures,
    staleAfterMs,
    resumeParam,
  };

  const share = sharingAvailable() ? ensureShare(url) : null;
  if (!share) {
    // Per-tab fallback: exactly the pre-sharing behavior.
    const conn = getConnection(url);
    attachLocal(conn, entry);
    return () => {
      detachLocal(conn, entry);
      if (conn.subscribers.size === 0) teardownConnection(conn);
    };
  }

  share.entries.add(entry);
  if (share.role === "leader") {
    attachLocal(getConnection(url), entry);
  } else {
    followerAttach(share, entry);
  }
  return () => shareUnsubscribe(share, entry);
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
  const maxFailures = options?.maxFailures ?? DEFAULT_MAX_FAILURES;
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
