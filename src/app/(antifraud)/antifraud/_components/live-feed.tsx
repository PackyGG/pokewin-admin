"use client";

import * as React from "react";
import { Activity, Radio, WifiOff } from "lucide-react";

import { useSseStream } from "@/lib/hooks/use-sse";
import { cn } from "@/lib/utils";
import {
  MONITOR_STREAM_PATH,
  parseMonitorFrame,
  type MonitorActivityEvent,
  type MonitorSeverity,
} from "./monitor-stream";

/**
 * Live signal strip — the browser end of the monitor pipe.
 *
 * It subscribes to `/api/antifraud/monitor/stream` (our SSE proxy over the
 * service's ticket-authenticated WebSocket) and renders the frames the service
 * actually publishes. The honest states matter more than the happy path: the
 * strip says "not connected" when the service is unconfigured, "reconnecting"
 * on a blip, and only claims "live" once the PROXY reports the upstream socket
 * open — not merely once the SSE pipe exists.
 *
 * It is purely additive to the page — every number and list on the dashboard is
 * rendered server-side from the admin DB, so an offline service costs the page
 * its live ticker and nothing else.
 */

type Connection = "connecting" | "live" | "offline" | "unconfigured";

const MAX_EVENTS = 8;

const SEVERITY_DOT: Record<MonitorSeverity, string> = {
  low: "bg-slate-400",
  medium: "bg-blue-500",
  high: "bg-amber-500",
  critical: "bg-rose-500",
};

const SEVERITY_WORD: Record<MonitorSeverity, string> = {
  low: "Low severity",
  medium: "Medium severity",
  high: "High severity",
  critical: "Critical severity",
};

export function LiveFeed() {
  const [connection, setConnection] = React.useState<Connection>("connecting");
  const [message, setMessage] = React.useState<string | null>(null);
  const [warning, setWarning] = React.useState<string | null>(null);
  const [events, setEvents] = React.useState<MonitorActivityEvent[]>([]);

  useSseStream<unknown>(
    MONITOR_STREAM_PATH,
    {
      onInit: () => {},
      onRow: (raw) => {
        const incoming = parseMonitorFrame(raw);
        if (!incoming) return;

        if (incoming.kind === "transport") {
          if (incoming.state === "open") {
            setConnection("live");
            setMessage(null);
          } else if (incoming.state === "unconfigured") {
            setConnection("unconfigured");
            setMessage(incoming.message);
          } else if (incoming.state === "connecting") {
            setConnection("connecting");
            setMessage(null);
          } else {
            setConnection("offline");
            setMessage(
              incoming.terminal
                ? incoming.message
                  ? `${incoming.message} Retrying automatically.`
                  : "Offline — retrying automatically."
                : incoming.message,
            );
          }
          return;
        }

        if (incoming.kind === "unsupported") {
          // Never drop a frame in silence: an event type the dashboard does not
          // know about means the service shipped ahead of this page, and the
          // analyst has to be able to see that rather than trust a short feed.
          setWarning(
            `The monitor service sent "${incoming.eventType}", which this dashboard does not render yet.`,
          );
          return;
        }

        setConnection("live");
        setEvents((prev) =>
          prev.some((event) => event.id === incoming.event.id)
            ? prev
            : [incoming.event, ...prev].slice(0, MAX_EVENTS),
        );
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
        setMessage((current) => current ?? "Offline — reload to reconnect.");
      },
      onStale: () => {
        setConnection("offline");
        setMessage("Live heartbeat became stale. Reconnecting automatically.");
      },
    },
    { resumeParam: "after", staleAfterMs: 45_000 },
  );

  const label =
    connection === "live"
      ? "Live"
      : connection === "connecting"
        ? "Connecting…"
        : connection === "unconfigured"
          ? "Not connected"
          : "Offline";

  const Icon =
    connection === "live" ? Radio : connection === "offline" ? WifiOff : Activity;

  return (
    <div className="rounded-xl border border-border/60 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-md",
              connection === "live"
                ? "bg-emerald-500/10 text-emerald-500"
                : connection === "offline"
                  ? "bg-rose-500/10 text-rose-500"
                  : "bg-muted text-muted-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden />
          </span>
          <span className="truncate text-sm font-semibold" id="live-signals-title">
            Live signals
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
            {label}
          </span>
        </div>
        {connection === "live" && (
          <span className="text-[11px] text-muted-foreground">
            {events.length === 0
              ? "Waiting for events"
              : `${events.length} in this session`}
          </span>
        )}
      </div>

      {warning && (
        <p
          role="status"
          className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300 sm:px-4"
        >
          {warning}
        </p>
      )}

      <div className="p-3 sm:p-4">
        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {message ??
              (connection === "live"
                ? "Connected. Events from the monitor service will appear here as they happen."
                : "Signals will stream here once the antifraud monitor service is connected. Cases and history below are served from the dashboard database and are unaffected.")}
          </p>
        ) : (
          <ul
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-labelledby="live-signals-title"
            className="space-y-2"
          >
            {events.map((event) => (
              <li
                key={event.id}
                className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-background/40 px-2.5 py-2"
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                    event.severity
                      ? SEVERITY_DOT[event.severity]
                      : "bg-muted-foreground/50",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="sr-only">
                    {event.severity
                      ? `${SEVERITY_WORD[event.severity]}. `
                      : "Informational. "}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-xs font-semibold">
                      {event.title}
                    </span>
                    {event.score != null && (
                      <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                        score {event.score}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground">
                    {event.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
