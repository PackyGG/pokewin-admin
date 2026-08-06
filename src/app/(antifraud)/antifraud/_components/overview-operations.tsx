import type { ReactNode } from "react";
import { Radar, ScanEye, SlidersHorizontal, Timer } from "lucide-react";

import { SectionHeading, TILE_COLORS } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import {
  REVIEW_SEVERITY_LABELS,
  type ReviewSeverity,
} from "@/lib/antifraud/constants";
import type {
  AntifraudCaseThroughput,
  AntifraudDetectionHealth,
} from "@/lib/antifraud/overview-operations";
import { formatNumber, formatRelativeStrict } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { OverviewThroughputChart } from "./overview-charts-lazy";

/**
 * The dashboard's lower half: how the queue is trending, what is detecting,
 * and whether the risk bands are worth what they cost to review.
 *
 * Everything here is server-rendered except the one chart, which is reached
 * through the client lazy boundary so Recharts stays out of the initial chunk.
 *
 * Colour discipline: these panels plot CASES and SIGNALS, never money, so they
 * follow `REVIEW_STATUS_COLORS` (flagged rose = the bad outcome, cleared
 * emerald = the clean one) rather than the House-POV money rule. Tiles stay
 * flat — the accent is on the icon and the number only.
 */

// ─── Case throughput ──────────────────────────────────────────────────────

/** "47m" / "6.4h" / "2.1d" — one significant unit, never a fake precision. */
function formatMinutes(minutes: number | null): string {
  if (minutes === null || minutes < 0) return "—";
  if (minutes < 90) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function formatHours(hours: number | null): string {
  if (hours === null || hours < 0) return "—";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function CaseThroughputPanel({
  data,
}: {
  data: AntifraudCaseThroughput;
}) {
  const decidedTotal = data.clearedTotal + data.flaggedTotal;
  // Positive backlog = more cases arrived than were decided over the window.
  // That is the number an operator wants before it becomes a visible pile.
  const backlogDelta = data.openedTotal - decidedTotal;

  return (
    <section className="space-y-3 rounded-xl border border-border/60 bg-card p-3 sm:p-4">
      <SectionHeading
        icon={Timer}
        title={
          <span>
            Case flow
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              30 days
            </span>
          </span>
        }
      />
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat
          label="Opened"
          value={formatNumber(data.openedTotal)}
          accent="blue"
        />
        <Stat
          label="Decided"
          value={formatNumber(decidedTotal)}
          sub={`${formatNumber(data.flaggedTotal)} flagged · ${formatNumber(
            data.clearedTotal,
          )} cleared`}
          accent={backlogDelta > 0 ? "amber" : "emerald"}
        />
        <Stat
          label="Median decision"
          value={formatMinutes(data.medianDecisionMinutes)}
          sub={
            data.p90DecisionMinutes === null
              ? "No decisions in window"
              : `p90 ${formatMinutes(data.p90DecisionMinutes)}`
          }
          accent="cyan"
        />
        <Stat
          label="Oldest waiting"
          value={formatHours(data.oldestOpenHours)}
          sub={
            data.oldestOpenHours === null
              ? "Queue empty"
              : "Undecided case age"
          }
          accent={
            data.oldestOpenHours !== null && data.oldestOpenHours >= 72
              ? "rose"
              : "amber"
          }
        />
      </div>
      <OverviewThroughputChart days={data.days} />
      <p className="text-[11px] leading-tight text-muted-foreground">
        Bars are decisions, the line is cases arriving. The line running above
        the bars is a backlog forming
        {backlogDelta > 0
          ? ` — ${formatNumber(backlogDelta)} more opened than decided over the window.`
          : "."}
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent: keyof typeof TILE_COLORS;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 truncate text-xl font-bold leading-tight tabular-nums",
          TILE_COLORS[accent].text,
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {sub}
        </p>
      )}
    </div>
  );
}

// ─── Detection health ─────────────────────────────────────────────────────

export function DetectionHealthPanel({
  data,
}: {
  data: AntifraudDetectionHealth;
}) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <DetectionMix data={data} />
      <RiskBandOutcomes data={data} />
    </div>
  );
}

function DetectionMix({ data }: { data: AntifraudDetectionHealth }) {
  const peak = data.kinds[0]?.total30d ?? 0;

  return (
    <section className="space-y-3 rounded-xl border border-border/60 bg-card p-3 sm:p-4">
      <SectionHeading
        icon={Radar}
        title={
          <span>
            What is detecting
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              30 days
            </span>
          </span>
        }
      />
      {data.kinds.length === 0 ? (
        <EmptyNote>
          No signals were recorded in the last 30 days. With the ingestion
          engine healthy that means nothing tripped a detector — if the pulse
          bar above is not green, treat this as an ingestion problem first.
        </EmptyNote>
      ) : (
        <ul className="space-y-2.5">
          {data.kinds.map((kind) => {
            const silent = kind.last7d === 0;
            const width = peak > 0 ? (kind.total30d / peak) * 100 : 0;
            return (
              <li key={kind.kind} className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-xs font-medium">
                    {kind.label}
                  </span>
                  {/* A detector that produced for weeks and then stopped is
                      how a broken producer looks from here — the count alone
                      never says it. */}
                  {silent && (
                    <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                      Silent 7d
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-sm font-bold tabular-nums">
                    {formatNumber(kind.total30d)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        silent ? "bg-muted-foreground/40" : "bg-blue-500/70",
                      )}
                      style={{ width: `${width}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {kind.lastSeenAt
                      ? formatRelativeStrict(kind.lastSeenAt)
                      : "—"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] leading-tight text-muted-foreground">
        Top {Math.min(10, Math.max(data.kinds.length, 1))} signal kinds by
        volume, newest activity on the right. A producer that has been quiet
        for longer than 30 days does not appear at all.
      </p>
    </section>
  );
}

function RiskBandOutcomes({ data }: { data: AntifraudDetectionHealth }) {
  const bands = [...data.bands].reverse().filter((band) => band.cases > 0);

  return (
    <section className="space-y-3 rounded-xl border border-border/60 bg-card p-3 sm:p-4">
      <SectionHeading
        icon={SlidersHorizontal}
        title={
          <span>
            Risk bands
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              opened in 30 days
            </span>
          </span>
        }
      />
      {bands.length === 0 ? (
        <EmptyNote>
          No cases were opened in the last 30 days, so there is nothing to
          score the bands against yet.
        </EmptyNote>
      ) : (
        <ul className="space-y-3">
          {bands.map((band) => {
            const decided = band.flagged + band.cleared;
            const hitRate = decided > 0 ? (band.flagged / decided) * 100 : null;
            return (
              <li key={band.severity} className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      "truncate text-xs font-semibold",
                      SEVERITY_TEXT[band.severity],
                    )}
                  >
                    {REVIEW_SEVERITY_LABELS[band.severity]}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                    {formatNumber(band.cases)} case
                    {band.cases === 1 ? "" : "s"}
                  </span>
                  <span className="ml-auto shrink-0 text-sm font-bold tabular-nums">
                    {hitRate === null ? "—" : `${Math.round(hitRate)}%`}
                    <span className="ml-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      fraud
                    </span>
                  </span>
                </div>
                <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-muted">
                  <Segment
                    value={band.flagged}
                    total={band.cases}
                    className="bg-rose-500/70"
                  />
                  <Segment
                    value={band.cleared}
                    total={band.cases}
                    className="bg-emerald-500/70"
                  />
                  <Segment
                    value={band.open}
                    total={band.cases}
                    className="bg-muted-foreground/30"
                  />
                </div>
                <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
                  {formatNumber(band.flagged)} flagged ·{" "}
                  {formatNumber(band.cleared)} cleared ·{" "}
                  {formatNumber(band.open)} still open
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] leading-tight text-muted-foreground">
        Share of decided cases that ended up flagged. A band that reviews a lot
        and flags almost nothing is costing analyst time, not catching fraud.
      </p>
    </section>
  );
}

const SEVERITY_TEXT: Record<ReviewSeverity, string> = {
  low: "text-muted-foreground",
  medium: TILE_COLORS.blue.text,
  high: TILE_COLORS.amber.text,
  critical: TILE_COLORS.rose.text,
};

function Segment({
  value,
  total,
  className,
}: {
  value: number;
  total: number;
  className: string;
}) {
  if (value <= 0 || total <= 0) return null;
  return (
    <div className={className} style={{ width: `${(value / total) * 100}%` }} />
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-border/60 px-3 py-4">
      <ScanEye className="mt-px size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

// ─── Skeletons ────────────────────────────────────────────────────────────

/**
 * Both match their panel's real height, and both are mirrored verbatim in
 * `loading.tsx`. Change one, change all three.
 */
export function CaseThroughputSkeleton() {
  return <Skeleton className="h-[420px] w-full rounded-xl" />;
}

export function DetectionHealthSkeleton() {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Skeleton className="h-[344px] w-full rounded-xl" />
      <Skeleton className="h-[344px] w-full rounded-xl" />
    </div>
  );
}
