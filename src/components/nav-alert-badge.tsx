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
const STORAGE_VERSION = "v1";

function storageKey(viewerId: string, key: NavAlertKey): string {
  return `nav-alert-seen:${STORAGE_VERSION}:${viewerId}:${key}`;
}

function readSeenAt(viewerId: string, key: NavAlertKey): string | null {
  const value = readBrowserStorage(storageKey(viewerId, key));
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
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

  const markSeen = React.useCallback(
    (key: NavAlertKey) => {
      writeBrowserStorage(storageKey(viewerId, key), new Date().toISOString());
      setCounts((previous) =>
        previous[key] === 0 ? previous : { ...previous, [key]: 0 },
      );
    },
    [viewerId],
  );

  const refresh = React.useCallback(async () => {
    if (!enabled) return;

    const request: Partial<Record<NavAlertKey, string>> & {
      scope: "main" | "antifraud";
    } = { scope };
    const now = new Date().toISOString();

    for (const key of keys) {
      if (key === activeKey) {
        writeBrowserStorage(storageKey(viewerId, key), now);
        continue;
      }

      const seenAt = readSeenAt(viewerId, key);
      if (!seenAt) {
        // First use establishes a clean baseline. Historical rows should not
        // appear as hundreds of "new" items the moment this feature ships.
        writeBrowserStorage(storageKey(viewerId, key), now);
        continue;
      }
      request[key] = seenAt;
    }

    if (Object.keys(request).length === 1) {
      if (activeKey) {
        setCounts((previous) =>
          previous[activeKey] === 0
            ? previous
            : { ...previous, [activeKey]: 0 },
        );
      }
      return;
    }

    try {
      const next = await fetchNavAlertCounts(request);
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
    if (!enabled) {
      setCounts(EMPTY_COUNTS);
      return;
    }

    let timer: ReturnType<typeof setInterval> | null = null;
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
        void refresh();
        arm();
      } else {
        disarm();
      }
    };

    if (document.visibilityState === "visible") {
      void refresh();
      arm();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disarm();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, refresh]);

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
