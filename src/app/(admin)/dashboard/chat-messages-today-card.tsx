"use client";

import { MessageSquare, Users, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AnimatedNumber } from "@/components/animated-number";
import { formatNumber } from "@/lib/utils/format";

/**
 * "Chat messages (today)" dashboard tile — on-site chat volume for the
 * current calendar day since 00:00 UTC (NOT a rolling past-24h window).
 */
export function ChatMessagesTodayCard({
  messageCount,
  uniqueChatters,
  deletedCount,
  dayLabel,
}: {
  messageCount: number;
  uniqueChatters: number;
  deletedCount: number;
  dayLabel: string;
}) {
  return (
    <Card className="bg-violet-500/10">
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground">
            Chat Messages
          </CardTitle>
          <span className="text-tiny text-muted-foreground tabular-nums">
            {dayLabel}
          </span>
        </div>
        <MessageSquare className="size-4 shrink-0 text-violet-400" />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-stat-value truncate text-violet-600 dark:text-violet-300">
          <AnimatedNumber value={messageCount} format="number" />
        </div>
        <p className="text-tiny text-muted-foreground">
          On-site chat sent since 00:00 UTC
        </p>
        <div className="grid grid-cols-2 gap-1.5 -mx-0.5">
          <StatChip
            icon={Users}
            label="Unique chatters"
            value={formatNumber(uniqueChatters)}
          />
          <StatChip
            icon={Trash2}
            label="Deleted"
            value={formatNumber(deletedCount)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function StatChip({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Users;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-violet-500/15 bg-background/40 px-2 py-1.5 min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate flex items-center gap-1">
        <Icon className="size-2.5 shrink-0 opacity-70" />
        {label}
      </p>
      <p className="text-xs font-semibold tabular-nums truncate text-foreground/90">
        {value}
      </p>
    </div>
  );
}
