"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Activity, RefreshCw, Radio, WifiOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useSseStream } from "@/lib/hooks/use-sse";
import { cn } from "@/lib/utils";
import {
  MONITOR_STREAM_PATH,
  parseMonitorFrame,
} from "./monitor-stream";

/**
 * Keeps the overview's server-rendered numbers honest once the page is parked.
 *
 * The KPI strip and the queue preview are async server components: correct at
 * first paint and frozen from then on. This island is their update path — it
 * listens on the SAME wire the live strip uses and, when a frame arrives that
 * the current server render predates, it (a) marks the snapshot stale in a way
 * the analyst can see and (b) debounces a `router.refresh()`, which re-runs the
 * server components against the admin DB.
 *
 * WHY A REFRESH AND NOT CLIENT-SIDE COUNTER MATH: the tiles count rows in the
 * ADMIN DB (`antifraud_reviews`, written by the signed `/api/antifraud/ingest`
 * webhook), while these frames come from the separate monitor service and its
 * own case store. A `case.decided` frame therefore does NOT imply an admin-DB
 * row changed. Incrementing the tiles from frames would invent numbers; asking
 * the server to re-read is the only version of "live" that stays true.
 *
 * The refresh is stream-triggered, never a timer — nothing fires on a quiet
 * page.
 */

type Connection = "connecting" | "live" | "offline" | "unconfigured";

/** Coalesce a burst of frames into one server round-trip. */
const REFRESH_DEBOUNCE_MS = 4_000;

export function OverviewLiveSync({ snapshotAt }: { snapshotAt: string }) {
  const router = useRouter();
  const [connection, setConnection] = React.useState<Connection>("connecting");
  const [streamEnabled, setStreamEnabled] = React.useState(true);
  const [pending, setPending] = React.useState(0);
  const [isRefreshing, startRefresh] = React.useTransition();
  const [clockLabel, setClockLabel] = React.useState<string | null>(null);
  const newestEventMs = React.useRef(0);

  const snapshotMs = React.useMemo(() => {
    const parsed = Date.parse(snapshotAt);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [snapshotAt]);

  const refresh = React.useCallback(() => {
    startRefresh(() => router.refresh());
  }, [router]);

  // Formatted in an effect so the server-rendered HTML (server timezone) and
  // the hydrated output (viewer timezone) cannot disagree.
  React.useEffect(() => {
    setClockLabel(
      new Date(snapshotAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }, [snapshotAt]);

  // A new server render landed — this snapshot is current again.
  React.useEffect(() => {
    setPending((current) =>
      snapshotMs >= newestEventMs.current ? 0 : current,
    );
  }, [snapshotMs]);

  const refreshTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  useSseStream<unknown>(MONITOR_STREAM_PATH, {
    onInit: () => {},
    onRow: (raw) => {
      const incoming = parseMonitorFrame(raw);
      if (!incoming) return;
      if (incoming.kind === "transport") {
        setConnection(
          incoming.state === "open"
            ? "live"
            : incoming.state === "unconfigured"
              ? "unconfigured"
              : incoming.state === "connecting"
                ? "connecting"
                : "offline",
        );
        if (incoming.terminal) setStreamEnabled(false);
        return;
      }
      if (incoming.kind !== "activity") return;

      setConnection("live");

      // Only frames the current server render could not have seen make it
      // stale. An unparsable timestamp counts as newer — better a redundant
      // refresh than a silently stale board.
      const eventMs = Date.parse(incoming.event.at);
      if (Number.isFinite(eventMs) && eventMs <= snapshotMs) return;
      newestEventMs.current = Math.max(
        newestEventMs.current,
        Number.isFinite(eventMs) ? eventMs : Date.now(),
      );

      setPending((count) => count + 1);
      // Throttle, not a resetting debounce: a continuous stream must still
      // refresh on a fixed cadence instead of deferring forever.
      if (!refreshTimer.current) {
        refreshTimer.current = setTimeout(() => {
          refreshTimer.current = null;
          refresh();
        }, REFRESH_DEBOUNCE_MS);
      }
    },
    onReconnect: () => {
      setConnection((current) =>
        current === "unconfigured" ? current : "connecting",
      );
    },
    onGiveUp: () => {
      setConnection((current) =>
        current === "unconfigured" ? current : "offline",
      );
    },
  }, { enabled: streamEnabled, resumeParam: "after" });

  React.useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const stale = pending > 0;
  const Icon =
    connection === "live" ? Radio : connection === "offline" ? WifiOff : Activity;
  const connectionLabel =
    connection === "live"
      ? "Live"
      : connection === "connecting"
        ? "Connecting…"
        : connection === "unconfigured"
          ? "Not connected"
          : "Offline";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border bg-card px-3 py-2.5 sm:px-4 sm:py-3",
        stale && "border-amber-500/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 sm:size-4",
            connection === "live"
              ? "text-emerald-500"
              : connection === "offline"
                ? "text-rose-500"
                : "text-muted-foreground",
          )}
        />
        <span className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Queue snapshot
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          as of{" "}
          <time dateTime={snapshotAt} className="tabular-nums">
            {clockLabel ?? "—"}
          </time>
        </span>
        <span
          role="status"
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
            connection === "live"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : connection === "offline"
                ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                : "border-border bg-muted/60 text-muted-foreground",
          )}
        >
          <span className="sr-only">Live signal stream: </span>
          {connectionLabel}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <p
          aria-live="polite"
          className={cn(
            "text-xs",
            stale
              ? "text-amber-700 dark:text-amber-300"
              : "text-muted-foreground",
          )}
        >
          {isRefreshing
            ? "Refreshing…"
            : stale
              ? `${pending} live ${pending === 1 ? "event" : "events"} since this snapshot — the numbers below are behind`
              : "Numbers below match this snapshot"}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={refresh}
          disabled={isRefreshing}
        >
          <RefreshCw
            aria-hidden
            className={cn(
              "size-3.5",
              isRefreshing && "motion-safe:animate-spin",
            )}
          />
          Refresh
        </Button>
      </div>
    </div>
  );
}
