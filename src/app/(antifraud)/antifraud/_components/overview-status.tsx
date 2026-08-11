import {
  FolderOpen,
  Hourglass,
  PauseCircle,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { TILE_COLORS, type AccentColor } from "@/components/modern-panels";
import type { ReviewQueueStats } from "@/lib/antifraud/reviews";
import { formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * What is waiting for a human, with direct links into each queue.
 * Deliberately chrome-free: the labels and counts carry the whole meaning.
 */

const QUEUES: {
  key: keyof ReviewQueueStats;
  label: string;
  tab: string;
  icon: LucideIcon;
  accent: AccentColor;
}[] = [
  {
    key: "priority",
    label: "High priority",
    tab: "priority",
    icon: ShieldAlert,
    accent: "rose",
  },
  {
    key: "normal",
    label: "Normal",
    tab: "normal",
    icon: FolderOpen,
    accent: "blue",
  },
  {
    key: "waitingKyc",
    label: "Waiting KYC",
    tab: "waiting_kyc",
    icon: Hourglass,
    accent: "amber",
  },
  {
    key: "postponed",
    label: "Postponed",
    tab: "postponed",
    icon: PauseCircle,
    accent: "cyan",
  },
];

export function QueueStrip({ stats }: { stats: ReviewQueueStats }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {QUEUES.map((queue) => {
        const count = stats[queue.key];
        const Icon = queue.icon;
        return (
          <HostLink
            key={queue.key}
            href={`/antifraud/reviews?tab=${queue.tab}&status=unresolved`}
            aria-label={`${queue.label}: ${formatNumber(count)} waiting`}
            // Single dense line — label left, count right. Reads as a
            // different object from the lifetime KpiTiles below on purpose:
            // these are clickable work, those are static history.
            className="group flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:border-foreground/20 hover:bg-muted/40 sm:px-4 sm:py-3"
          >
            <Icon
              className={cn(
                "size-4 shrink-0",
                count > 0 ? TILE_COLORS[queue.accent].icon : "text-muted-foreground",
              )}
              aria-hidden
            />
            <span className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {queue.label}
            </span>
            {/* An empty queue must not shout — only work that exists gets
                the accent. */}
            <span
              className={cn(
                "ml-auto text-xl font-bold leading-none tabular-nums",
                count > 0
                  ? TILE_COLORS[queue.accent].text
                  : "text-muted-foreground/50",
              )}
            >
              {formatNumber(count)}
            </span>
          </HostLink>
        );
      })}
    </div>
  );
}
