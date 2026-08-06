import {
  FolderOpen,
  Hourglass,
  PauseCircle,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { TILE_COLORS, type AccentColor } from "@/components/modern-panels";
import type { AntifraudPollerHealth } from "@/lib/antifraud/monitor-api";
import type { AntifraudLiveMirrorMetrics } from "@/lib/antifraud/overview";
import type { ReviewQueueStats } from "@/lib/antifraud/reviews";
import {
  formatCompactUsd,
  formatNumber,
  formatRelativeStrict,
} from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * The two "right now" bands above the lifetime KPI strip.
 *
 * The dashboard used to open with six lifetime counters — true, but never
 * actionable, and blind to the one failure that silently empties every queue
 * (a stalled ingestion poller). `PulseBar` states whether the engine is
 * running and what the last 24h produced; `QueueStrip` states what is waiting
 * for a human, and links straight into that queue.
 *
 * Both are deliberately chrome-free: no section headings, no helper copy. The
 * numbers and one status word carry the whole meaning.
 */

// ─── Pulse bar ────────────────────────────────────────────────────────────

type PulseTone = "ok" | "warn" | "bad" | "idle";

const TONE_DOT: Record<PulseTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-rose-500",
  idle: "bg-muted-foreground/40",
};

const TONE_TEXT: Record<PulseTone, string> = {
  ok: "text-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-rose-600 dark:text-rose-400",
  idle: "text-muted-foreground",
};

/**
 * Health verdict for the ingestion loop, mirroring the ranking in
 * `automation/_lib/system-issues.ts` so the dashboard and the Automation
 * defect list never disagree about what "degraded" means.
 */
function pollerVerdict(
  poller: AntifraudPollerHealth | null,
  configured: boolean,
): { tone: PulseTone; label: string } {
  if (!configured) return { tone: "idle", label: "Monitor not configured" };
  if (!poller) return { tone: "idle", label: "Engine status unreadable" };
  if (poller.status === "degraded") {
    return { tone: "bad", label: "Ingestion degraded" };
  }
  if (poller.consecutiveFailures > 0) {
    return {
      tone: "bad",
      label: `${formatNumber(poller.consecutiveFailures)} failed tick${
        poller.consecutiveFailures === 1 ? "" : "s"
      }`,
    };
  }
  if (poller.signupBacklogPossible) {
    return { tone: "warn", label: "Signup backlog possible" };
  }
  if (poller.signupFailuresPending > 0) {
    return {
      tone: "warn",
      label: `${formatNumber(poller.signupFailuresPending)} signup${
        poller.signupFailuresPending === 1 ? "" : "s"
      } pending recovery`,
    };
  }
  if (poller.status === "starting") return { tone: "warn", label: "Starting" };
  if (poller.status === "standby") return { tone: "idle", label: "Standby" };
  return { tone: "ok", label: "Ingestion healthy" };
}

export function PulseBar({
  poller,
  pollerConfigured,
  live,
}: {
  poller: AntifraudPollerHealth | null;
  pollerConfigured: boolean;
  live: AntifraudLiveMirrorMetrics;
}) {
  const verdict = pollerVerdict(poller, pollerConfigured);
  const tick = poller?.lastSuccessfulTickAt;

  return (
    <HostLink
      href="/antifraud/settings?tab=health"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card px-3 py-2 transition-colors hover:border-foreground/20 hover:bg-muted/40 sm:px-4"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="relative flex size-2 shrink-0">
          {verdict.tone === "ok" && (
            <span
              className="absolute inset-0 rounded-full bg-emerald-500 opacity-60 motion-safe:animate-ping"
              aria-hidden
            />
          )}
          <span
            className={cn(
              "relative size-2 rounded-full",
              TONE_DOT[verdict.tone],
            )}
            aria-hidden
          />
        </span>
        <span
          className={cn(
            "truncate text-xs font-semibold",
            TONE_TEXT[verdict.tone],
          )}
        >
          {verdict.label}
        </span>
        {tick && (
          <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
            · tick {formatRelativeStrict(tick)}
          </span>
        )}
      </span>

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
    </HostLink>
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
