import {
  FolderOpen,
  Hourglass,
  PauseCircle,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { TILE_COLORS, type AccentColor } from "@/components/modern-panels";
import type { AntifraudLiveMirrorMetrics } from "@/lib/antifraud/overview";
import type { ReviewQueueStats } from "@/lib/antifraud/reviews";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * The two "right now" bands above the lifetime KPI strip.
 *
 * The dashboard used to open with six lifetime counters — true, but never
 * actionable. `PulseBar` shows what the last 24h produced; `QueueStrip` states
 * what is waiting for a human, and links straight into that queue. Engine
 * health remains available in Antifraud Settings instead of occupying the
 * dashboard.
 *
 * Both are deliberately chrome-free: no section headings and no helper copy.
 * The numbers carry the whole meaning.
 */

// ─── Pulse bar ────────────────────────────────────────────────────────────

export function PulseBar({
  live,
}: {
  live: AntifraudLiveMirrorMetrics;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 rounded-lg border bg-card px-3 py-2 sm:px-4"
      aria-label="Antifraud activity in the last 24 hours"
    >
      <span className="ml-auto flex items-center gap-3 sm:gap-4">
        <span className="hidden text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground sm:inline">
          24h
        </span>
        <Pulse label="Signups" value={formatNumber(live.signups24h)} />
        <Pulse
          label="Locks"
          value={formatNumber(live.locks24h)}
          accent={live.locks24h > 0 ? "amber" : undefined}
        />
        {/* House POV: a deposit is money the player hands over — emerald.
            Fraudulent volume is money we stand to give back — rose. */}
        <Pulse
          label="Deposits"
          value={formatCompactUsd(live.legitimateFiatCents24h / 100)}
          accent="emerald"
        />
        <Pulse
          label="Fraud"
          value={formatCompactUsd(live.fraudulentFiatCents24h / 100)}
          accent={live.fraudulentFiatCents24h > 0 ? "rose" : undefined}
        />
      </span>
    </div>
  );
}

function Pulse({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: AccentColor;
}) {
  return (
    <span
      className="flex items-baseline gap-1.5"
      aria-label={`${label} last 24 hours: ${value}`}
    >
      <span
        className={cn(
          "text-sm font-bold tabular-nums leading-none",
          accent ? TILE_COLORS[accent].text : "text-foreground",
        )}
      >
        {value}
      </span>
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
    </span>
  );
}

// ─── Queue strip ──────────────────────────────────────────────────────────

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
