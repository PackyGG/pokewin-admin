"use client";

import * as React from "react";

import {
  readBrowserStorage,
  writeBrowserStorage,
} from "@/lib/client-runtime-safety";
import { cn } from "@/lib/utils";
import { fetchNavAlertCounts } from "./nav-alert-badge-actions";

export type NavAlertKey = "fiat" | "reviews" | "signups";

type NavAlertCounts = Record<NavAlertKey, number>;

const EMPTY_COUNTS: NavAlertCounts = {
  fiat: 0,
  reviews: 0,
  signups: 0,
};
const POLL_MS = 60_000;
/**
 * The mount-time poll used to fire synchronously, racing the page's own
 * Suspense reads for the same handful of database connections while the shell
 * was still painting. Badges are ambient information — yielding until the
 * browser is idle (or this deadline, whichever comes first) costs nothing and
 * keeps the first render's connections for the content.
 */
const FIRST_POLL_DELAY_MS = 2_000;
const STORAGE_VERSION = "v2";

function storageKey(viewerId: string, key: NavAlertKey): string {
  return `nav-alert-seen:${STORAGE_VERSION}:${viewerId}:${key}`;
}

function readSeenAt(viewerId: string, key: NavAlertKey): string | null {
  const value = readBrowserStorage(storageKey(viewerId, key));
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function laterIso(current: string | null, candidate: string): string {
  if (!current) return candidate;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function advanceSeenAt(
  viewerId: string,
  key: NavAlertKey,
  checkedAt: string,
): void {
  const next = laterIso(readSeenAt(viewerId, key), checkedAt);
  writeBrowserStorage(storageKey(viewerId, key), next);
}

export function useNavAlertBadges({
  keys,
  viewerId,
  scope,
  activeKey,
  enabled = true,
}: {
  keys: readonly NavAlertKey[];
  viewerId: string;
  scope: "main" | "antifraud";
  activeKey?: NavAlertKey;
  enabled?: boolean;
}) {
  const [counts, setCounts] = React.useState<NavAlertCounts>(EMPTY_COUNTS);
  const checkedAtRef = React.useRef<string | null>(null);
  const requestSequenceRef = React.useRef(0);

  const markSeen = React.useCallback(
    (key: NavAlertKey) => {
      // A click invalidates an older in-flight response, preventing it from
      // restoring a badge after the operator has opened the destination.
      requestSequenceRef.current += 1;
      const checkedAt = checkedAtRef.current;
      if (checkedAt) advanceSeenAt(viewerId, key, checkedAt);
      setCounts((previous) =>
        previous[key] === 0 ? previous : { ...previous, [key]: 0 },
      );
    },
    [viewerId],
  );

  const refresh = React.useCallback(async () => {
    if (!enabled) return;
    const requestSequence = ++requestSequenceRef.current;

    const request: Partial<Record<NavAlertKey, string>> & {
      scope: "main" | "antifraud";
    } = { scope };
    const baselineKeys: NavAlertKey[] = [];

    for (const key of keys) {
      if (key === activeKey) {
        baselineKeys.push(key);
        continue;
      }

      const seenAt = readSeenAt(viewerId, key);
      if (!seenAt) {
        // First use establishes a clean baseline. Historical rows should not
        // appear as hundreds of "new" items the moment this feature ships.
        baselineKeys.push(key);
        continue;
      }
      request[key] = seenAt;
    }

    try {
      const next = await fetchNavAlertCounts(request);
      if (requestSequence !== requestSequenceRef.current) return;

      checkedAtRef.current = laterIso(
        checkedAtRef.current,
        next.checkedAt,
      );
      for (const key of baselineKeys) {
        advanceSeenAt(viewerId, key, next.checkedAt);
      }

      setCounts((previous) => {
        let changed = false;
        const merged = { ...previous };
        for (const key of keys) {
          const value = next[key];
          if (typeof value !== "number" || value === previous[key]) continue;
          merged[key] = value;
          changed = true;
        }
        if (activeKey && merged[activeKey] !== 0) {
          merged[activeKey] = 0;
          changed = true;
        }
        return changed ? merged : previous;
      });
    } catch {
      // Chrome-level polling is best-effort. Keep the last known badge through
      // a transient auth, database, or monitor-service failure.
    }
  }, [activeKey, enabled, keys, scope, viewerId]);

  React.useEffect(() => {
    requestSequenceRef.current += 1;
    checkedAtRef.current = null;
    setCounts(EMPTY_COUNTS);
  }, [scope, viewerId]);

  React.useEffect(() => {
    if (activeKey) markSeen(activeKey);
  }, [activeKey, markSeen]);

  React.useEffect(() => {
    if (!enabled) {
      requestSequenceRef.current += 1;
      checkedAtRef.current = null;
      setCounts(EMPTY_COUNTS);
      return;
    }

    let timer: ReturnType<typeof setInterval> | null = null;
    let firstPollTimeout: ReturnType<typeof setTimeout> | null = null;
    let firstPollIdle: number | null = null;

    const cancelFirstPoll = () => {
      if (firstPollTimeout !== null) {
        clearTimeout(firstPollTimeout);
        firstPollTimeout = null;
      }
      if (firstPollIdle !== null) {
        if (typeof window.cancelIdleCallback === "function") {
          window.cancelIdleCallback(firstPollIdle);
        }
        firstPollIdle = null;
      }
    };
    // Deferred, never skipped: `requestIdleCallback`'s timeout guarantees it
    // runs even on a busy main thread, and browsers without it fall back to a
    // plain timer.
    const scheduleFirstPoll = () => {
      cancelFirstPoll();
      const run = () => {
        firstPollTimeout = null;
        firstPollIdle = null;
        void refresh();
      };
      if (typeof window.requestIdleCallback === "function") {
        firstPollIdle = window.requestIdleCallback(run, {
          timeout: FIRST_POLL_DELAY_MS,
        });
      } else {
        firstPollTimeout = setTimeout(run, FIRST_POLL_DELAY_MS);
      }
    };

    const arm = () => {
      if (!timer) timer = setInterval(() => void refresh(), POLL_MS);
    };
    const disarm = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Returning to the tab is an explicit signal — refresh right away.
        cancelFirstPoll();
        void refresh();
        arm();
      } else {
        cancelFirstPoll();
        disarm();
      }
    };
    const relevantStorageKeys = new Set(
      keys.map((key) => storageKey(viewerId, key)),
    );
    const onStorage = (event: StorageEvent) => {
      if (
        document.visibilityState === "visible" &&
        event.key &&
        relevantStorageKeys.has(event.key)
      ) {
        void refresh();
      }
    };

    if (document.visibilityState === "visible") {
      scheduleFirstPoll();
      arm();
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", onStorage);
    return () => {
      requestSequenceRef.current += 1;
      cancelFirstPoll();
      disarm();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
    };
  }, [enabled, keys, refresh, viewerId]);

  return { counts, markSeen };
}

export function NavAlertBadge({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  if (count <= 0) return null;
  const label = count > 99 ? "99+" : String(count);

  return (
    <span
      aria-label={`${count > 99 ? "More than 99" : count} new`}
      title={`${count > 99 ? "99+" : count} new since your last visit`}
      className={cn(
        "ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold leading-none text-primary-foreground",
        "group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:right-0 group-data-[collapsible=icon]:top-0 group-data-[collapsible=icon]:size-2 group-data-[collapsible=icon]:min-w-0 group-data-[collapsible=icon]:p-0",
        className,
      )}
    >
      <span className="group-data-[collapsible=icon]:hidden">{label}</span>
    </span>
  );
}
