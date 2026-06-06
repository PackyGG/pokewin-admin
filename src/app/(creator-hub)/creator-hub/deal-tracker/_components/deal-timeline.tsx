"use client";

import Link from "next/link";
import {
  Calendar,
  ChevronRight,
  Flag,
  HandCoins,
  Play,
  Trophy,
} from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { useFormatDateTime } from "@/components/timezone-provider";

import type { TimelineEvent, TimelineEventKind } from "../_lib/timeline-types";

const KIND_META: Record<
  TimelineEventKind,
  { icon: typeof HandCoins; chip: string; iconClass: string; label: string }
> = {
  deal_start: {
    icon: Play,
    chip: "bg-emerald-500/15",
    iconClass: "text-emerald-600 dark:text-emerald-400",
    label: "Deal start",
  },
  deal_end: {
    icon: Flag,
    chip: "bg-amber-500/15",
    iconClass: "text-amber-600 dark:text-amber-400",
    label: "Deal end",
  },
  leaderboard_start: {
    icon: Trophy,
    chip: "bg-blue-500/15",
    iconClass: "text-blue-600 dark:text-blue-400",
    label: "LB start",
  },
  leaderboard_end: {
    icon: Trophy,
    chip: "bg-rose-500/15",
    iconClass: "text-rose-600 dark:text-rose-400",
    label: "LB end",
  },
};

const STATUS_DOT: Record<TimelineEvent["status"], string> = {
  past: "bg-muted-foreground/40",
  today: "bg-pink-500 ring-4 ring-pink-500/20",
  upcoming: "bg-blue-500",
};

function formatDaysFromNow(days: number): string {
  const rounded = Math.round(days);
  if (rounded === 0) return "Today";
  if (rounded === 1) return "Tomorrow";
  if (rounded === -1) return "Yesterday";
  if (rounded > 0) return `In ${rounded}d`;
  return `${Math.abs(rounded)}d ago`;
}

function groupByDate(
  events: TimelineEvent[],
  formatDate: (iso: string) => string,
): { dateLabel: string; events: TimelineEvent[] }[] {
  const map = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    const key = formatDate(e.atIso).split(",")[0] ?? formatDate(e.atIso);
    const list = map.get(key) ?? [];
    list.push(e);
    map.set(key, list);
  }
  return [...map.entries()].map(([dateLabel, evts]) => ({
    dateLabel,
    events: evts,
  }));
}

export function DealTimeline({
  events,
  backendUnavailable,
}: {
  events: TimelineEvent[];
  backendUnavailable: boolean;
}) {
  const formatDateTime = useFormatDateTime();
  const groups = groupByDate(events, formatDateTime);

  if (backendUnavailable && events.length === 0) {
    return (
      <EmptyState
        icon={Calendar}
        title="Timeline unavailable"
        description="The backend roster or leaderboard walk failed — try refreshing."
      />
    );
  }

  if (events.length === 0) {
    return (
      <EmptyState
        icon={Calendar}
        title="No milestones in this window"
        description="Widen the horizon or check back when new deals and leaderboards are scheduled."
      />
    );
  }

  return (
    <div className="space-y-6">
      {backendUnavailable && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground">
          Some data sources were unavailable — the timeline may be incomplete.
        </div>
      )}

      {groups.map((group) => (
        <div key={group.dateLabel} className="space-y-3">
          <div className="sticky top-0 z-10 -mx-1 bg-background/80 px-1 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur-sm">
            {group.dateLabel}
          </div>

          <div className="relative space-y-2 pl-4 before:absolute before:inset-y-0 before:left-[7px] before:w-px before:bg-border">
            {group.events.map((event) => {
              const meta = KIND_META[event.kind];
              const Icon = meta.icon;
              return (
                <div
                  key={event.id}
                  className="relative flex gap-3 rounded-2xl border bg-card p-3.5 sm:p-4"
                >
                  <span
                    className={cn(
                      "absolute -left-4 top-5 size-2.5 shrink-0 rounded-full",
                      STATUS_DOT[event.status],
                    )}
                  />

                  <span
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-xl",
                      meta.chip,
                    )}
                  >
                    <Icon className={cn("size-4", meta.iconClass)} />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{event.title}</span>
                      <Badge variant="outline" className="h-5 text-[10px]">
                        {meta.label}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDaysFromNow(event.daysFromNow)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">
                      {event.subtitle}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <Link
                        href={`/creator-hub/creators/${event.creatorUserId}`}
                        className="font-medium text-blue-500 hover:underline"
                      >
                        {event.creatorUsername ??
                          event.creatorUserId.slice(0, 8)}
                      </Link>
                      {event.valueUsd != null && event.valueUsd > 0 && (
                        <span className="text-rose-600 dark:text-rose-400">
                          {formatCurrency(event.valueUsd)} house
                        </span>
                      )}
                      <span className="text-muted-foreground">
                        {formatDateTime(event.atIso)}
                      </span>
                    </div>
                  </div>

                  <Link
                    href={event.href}
                    className="flex size-8 shrink-0 items-center justify-center self-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title="Open creator"
                  >
                    <ChevronRight className="size-4" />
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
