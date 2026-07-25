"use client";

import * as React from "react";
import { Activity, Radio, WifiOff } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  subscribeAntifraudStream,
  type AntifraudEvent,
  type AntifraudSignalEvent,
} from "@/lib/antifraud/ws";

/**
 * Live signal strip — the browser end of the fraud-backend pipe.
 *
 * It subscribes to `/api/antifraud/stream` (our SSE proxy over the backend
 * WebSocket) and renders whatever arrives. Because the backend service does not
 * exist yet, the honest states matter more than the happy path: the strip says
 * "not connected" when nothing is configured, "reconnecting" on a blip, and
 * only claims "live" once the proxy reports an open upstream.
 *
 * It is purely additive to the page — every number and list on the dashboard is
 * rendered server-side from the admin DB, so an offline backend costs the page
 * its live ticker and nothing else.
 */

type Connection = "connecting" | "live" | "offline" | "unconfigured";

const MAX_EVENTS = 8;

const SEVERITY_DOT: Record<string, string> = {
  low: "bg-slate-400",
  medium: "bg-blue-500",
  high: "bg-amber-500",
  critical: "bg-rose-500",
};

export function LiveFeed() {
  const [connection, setConnection] = React.useState<Connection>("connecting");
  const [message, setMessage] = React.useState<string | null>(null);
  const [events, setEvents] = React.useState<AntifraudSignalEvent[]>([]);

  React.useEffect(() => {
    return subscribeAntifraudStream((event: AntifraudEvent) => {
      if (event.type === "transport") {
        if (event.state === "open") {
          setConnection("live");
          setMessage(null);
        } else if (event.state === "unconfigured") {
          setConnection("unconfigured");
          setMessage(event.message ?? null);
        } else if (event.state === "connecting") {
          setConnection("connecting");
          setMessage(null);
        } else {
          setConnection("offline");
          setMessage(event.message ?? null);
        }
        return;
      }
      if (event.type === "status") {
        setConnection(event.state === "down" ? "offline" : "live");
        setMessage(event.message ?? null);
        return;
      }
      if (event.type === "signal") {
        setConnection("live");
        setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
      }
    });
  }, []);

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
            <Icon className="size-3.5" />
          </span>
          <span className="truncate text-sm font-semibold">Live signals</span>
          <span
            className={cn(
              "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
              connection === "live"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : connection === "offline"
                  ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                  : "border-border bg-muted/60 text-muted-foreground",
            )}
          >
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

      <div className="p-3 sm:p-4">
        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {message ??
              (connection === "live"
                ? "Connected. Signals from the fraud backend will appear here as they happen."
                : "Signals will stream here once the antifraud backend service is connected. Cases and history below are served from the dashboard database and are unaffected.")}
          </p>
        ) : (
          <ul className="space-y-2">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex items-start gap-2.5 rounded-lg border border-border/50 bg-background/40 px-2.5 py-2"
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                    SEVERITY_DOT[event.severity] ?? "bg-blue-500",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="truncate text-xs font-semibold">
                      {event.kind}
                    </span>
                    {event.username && (
                      <span className="truncate text-[11px] text-muted-foreground">
                        @{event.username}
                      </span>
                    )}
                    {event.riskScore != null && (
                      <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                        risk {event.riskScore}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-[11px] text-muted-foreground">
                    {event.summary}
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
