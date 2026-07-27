"use client";

import * as React from "react";
import {
  Activity,
  Boxes,
  CheckCircle2,
  CircleDashed,
  Database,
  ListFilter,
  Search,
} from "lucide-react";

import { KpiTile } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AntifraudMonitorEvent } from "@/lib/antifraud/monitor-api";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "live" | "planned";

export function EventCatalog({
  events,
}: {
  events: AntifraudMonitorEvent[];
}) {
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("all");
  const normalizedQuery = query.trim().toLowerCase();
  const categories = [...new Set(events.map((event) => event.category))];
  const visible = events.filter(
    (event) =>
      (status === "all" || event.status === status) &&
      (!normalizedQuery ||
        [event.name, event.key, event.category, event.description, event.source]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery)),
  );
  const live = events.filter((event) => event.status === "live").length;
  const planned = events.length - live;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Documented events"
          value={events.length.toLocaleString()}
          sub="One shared vocabulary"
          icon={Activity}
          accent="cyan"
        />
        <KpiTile
          label="Live now"
          value={live.toLocaleString()}
          sub="Selectable in active flows"
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Planned"
          value={planned.toLocaleString()}
          sub="Available for disabled drafts"
          icon={CircleDashed}
          accent="amber"
        />
        <KpiTile
          label="Categories"
          value={categories.length.toLocaleString()}
          sub={categories.join(" · ")}
          icon={Boxes}
          accent="blue"
        />
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-3 sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search event, key, source or category"
            className="pl-9"
            aria-label="Search event catalog"
          />
        </label>
        <div className="flex items-center gap-1" aria-label="Event status filter">
          <ListFilter className="mr-1 size-4 text-muted-foreground" aria-hidden />
          {(["all", "live", "planned"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={status === value ? "default" : "ghost"}
              onClick={() => setStatus(value)}
            >
              {value === "all"
                ? "All"
                : value === "live"
                  ? "Live"
                  : "Planned"}
            </Button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:px-4">
          <span>{visible.length} events</span>
          <span>Status</span>
        </div>
        {visible.length === 0 ? (
          <div className="px-4 py-14 text-center">
            <Search className="mx-auto size-6 text-muted-foreground" aria-hidden />
            <p className="mt-2 text-sm font-medium">No events found</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Change the search or status filter.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {visible.map((event) => (
              <article
                key={event.key}
                className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(150px,0.35fr)_auto] sm:items-center sm:px-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold">{event.name}</h2>
                    <Badge variant="outline" className="h-5 text-[10px]">
                      {event.category}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {event.description}
                  </p>
                  <code className="mt-1.5 block w-fit max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {event.key}
                  </code>
                </div>
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <Database className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{event.source}</span>
                </div>
                <Badge
                  variant="outline"
                  className={cn(
                    "w-fit gap-1",
                    event.status === "live"
                      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
                      : "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300",
                  )}
                >
                  {event.status === "live" ? (
                    <CheckCircle2 className="size-3" aria-hidden />
                  ) : (
                    <CircleDashed className="size-3" aria-hidden />
                  )}
                  {event.status === "live" ? "Live" : "Planned"}
                </Badge>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
