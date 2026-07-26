"use client";

import * as React from "react";
import {
  Activity,
  CircleDot,
  PackageOpen,
  Radio,
  Swords,
  TrendingUp,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  subscribePackyWs,
  subscribePackyWsConnectionState,
  type PackyConnectionState,
  type PackyEvent,
} from "@/lib/packy-ws";

type AdminActivityEvent = Extract<PackyEvent, { type: "admin.activity" }>;
type ActivityKind = "pack" | "upgrader" | "battle";

type LiveActivityItem = {
  id: number;
  kind: ActivityKind;
  title: string;
  userId: string | null;
  entityId: string | null;
  at: string;
};

const MAX_EVENTS = 8;

const KIND_STYLE: Record<
  ActivityKind,
  { icon: React.ElementType; className: string }
> = {
  pack: {
    icon: PackageOpen,
    className: "bg-emerald-500/10 text-emerald-500",
  },
  upgrader: {
    icon: TrendingUp,
    className: "bg-emerald-500/10 text-emerald-500",
  },
  battle: {
    icon: Swords,
    className: "bg-cyan-500/10 text-cyan-500",
  },
};

function classifyAction(action: string): Pick<LiveActivityItem, "kind" | "title"> | null {
  const normalized = action.toLowerCase().replaceAll("-", "_").replaceAll(".", "_");

  if (normalized.includes("pack") && normalized.includes("open")) {
    return { kind: "pack", title: "Pack opened" };
  }
  if (normalized.includes("upgrader")) {
    return { kind: "upgrader", title: "Upgrader bet" };
  }
  if (normalized.includes("battle")) {
    if (normalized.includes("creat")) {
      return { kind: "battle", title: "Battle created" };
    }
    if (normalized.includes("join")) {
      return { kind: "battle", title: "Battle joined" };
    }
    if (
      normalized.includes("settle") ||
      normalized.includes("complete") ||
      normalized.includes("finish")
    ) {
      return { kind: "battle", title: "Battle settled" };
    }
    return { kind: "battle", title: "Battle activity" };
  }
  return null;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function eventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "now";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function LiveActivity() {
  const [connection, setConnection] =
    React.useState<PackyConnectionState>("connecting");
  const [events, setEvents] = React.useState<LiveActivityItem[]>([]);
  const nextId = React.useRef(0);

  React.useEffect(() => {
    const unsubscribeState = subscribePackyWsConnectionState(setConnection);
    const unsubscribeActivity = subscribePackyWs<AdminActivityEvent>(
      "admin.activity",
      (event) => {
        if (!event.payload.topics.includes("gaming")) return;
        const classified = classifyAction(event.payload.action);
        if (!classified) return;

        nextId.current += 1;
        const item: LiveActivityItem = {
          id: nextId.current,
          ...classified,
          userId: event.payload.user_id,
          entityId: event.payload.entity_id ?? null,
          at: event.timestamp,
        };
        setEvents((current) => [item, ...current].slice(0, MAX_EVENTS));
      },
    );

    return () => {
      unsubscribeState();
      unsubscribeActivity();
    };
  }, []);

  const isLive = connection === "live";
  const statusLabel =
    connection === "live"
      ? "Live"
      : connection === "paused"
        ? "Paused"
        : connection === "reconnecting"
          ? "Reconnecting"
          : "Connecting";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-500">
            <Activity className="size-4" />
          </span>
          <h2 className="text-sm font-semibold">Live activity</h2>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
            isLive
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-border bg-muted/60 text-muted-foreground",
          )}
        >
          {isLive ? <Radio className="size-3" /> : <CircleDot className="size-3" />}
          {statusLabel}
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
        {events.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-1.5 px-4 py-8 text-center">
            <Activity className="size-5 text-muted-foreground" />
            <span className="text-sm font-semibold">
              {isLive ? "Waiting for player activity" : `${statusLabel}…`}
            </span>
            <span className="max-w-xs text-xs text-muted-foreground">
              Pack openings, upgrader bets and battle activity appear here as
              the backend publishes them.
            </span>
          </div>
        ) : (
          <ul
            className="divide-y divide-border/60"
            aria-live="polite"
            aria-label="Live player activity"
          >
            {events.map((event) => {
              const style = KIND_STYLE[event.kind];
              const Icon = style.icon;
              return (
                <li
                  key={event.id}
                  className="flex items-start gap-2.5 px-3 py-2.5 sm:px-4"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md",
                      style.className,
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold">
                      {event.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {event.userId ? `Player ${shortId(event.userId)}` : "Player"}
                      {event.entityId
                        ? ` · Event ${shortId(event.entityId)}`
                        : ""}
                    </span>
                  </span>
                  <time
                    dateTime={event.at}
                    className="shrink-0 text-[10px] tabular-nums text-muted-foreground"
                  >
                    {eventTime(event.at)}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
