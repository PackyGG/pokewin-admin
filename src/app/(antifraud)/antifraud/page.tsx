import { Suspense, type ElementType } from "react";
import {
  Ban,
  CircleDollarSign,
  ListChecks,
  LockKeyhole,
  ShieldAlert,
  UserCheck,
} from "lucide-react";

import {
  KpiTile,
  TILE_COLORS,
  type AccentColor,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { safeQuery } from "@/lib/errors/safe-query";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import {
  getAntifraudOverviewData,
  type AntifraudOverviewData,
} from "@/lib/antifraud/overview";
import {
  getAntifraudMonitorOverview,
  type AntifraudMonitorOverview,
} from "@/lib/antifraud/monitor-api";
import {
  getAntifraudCaseThroughput,
  getAntifraudDetectionHealth,
  type AntifraudCaseThroughput,
  type AntifraudDetectionHealth,
} from "@/lib/antifraud/overview-operations";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { OverviewActionFeed } from "./_components/overview-panels";
// Recharts is the heaviest client dependency in this sub-app and only the two
// 30-day charts need it. The lazy boundary lives in its own client module
// (`overview-charts-lazy`) because `next/dynamic` called from a Server
// Component leaves the chart in the page's initial chunk group.
import {
  ChartRowSkeleton,
  OverviewCharts,
} from "./_components/overview-charts-lazy";
import {
  CaseThroughputPanel,
  CaseThroughputSkeleton,
  DetectionHealthPanel,
  DetectionHealthSkeleton,
} from "./_components/overview-operations";
import { PanelErrorBoundary } from "./_components/panel-error-boundary";

export const metadata = { title: "Antifraud Dashboard" };

const QUERY_TIMEOUT_MS = 10_000;

const EMPTY_OVERVIEW: AntifraudOverviewData = {
  metrics: {
    legitimateFiatDepositCents: 0,
    fraudulentFiatDepositCents: 0,
    manualKycLocks: 0,
    systemKycLocks: 0,
    manualBans: 0,
    automaticBans: 0,
    autoLockReviewsLeft: 0,
  },
  live: {
    signups24h: 0,
    locks24h: 0,
    legitimateFiatCents24h: 0,
    fraudulentFiatCents24h: 0,
  },
  days: [],
  feed: [],
};

/**
 * Fallbacks for the two operational reads. Both bands return `null` when their
 * read failed, exactly like the mirror-backed bands — these constants only
 * exist because `safeQuery` requires a same-shaped fallback, and they are
 * never rendered.
 */
const EMPTY_THROUGHPUT: AntifraudCaseThroughput = {
  days: [],
  openedTotal: 0,
  clearedTotal: 0,
  flaggedTotal: 0,
  medianDecisionMinutes: null,
  p90DecisionMinutes: null,
  oldestOpenHours: null,
};

const EMPTY_DETECTION: AntifraudDetectionHealth = {
  kinds: [],
  totalSignals30d: 0,
  bands: [],
};

type OverviewPromise = Promise<SafeQueryResult<AntifraudOverviewData>>;
type ThroughputPromise = Promise<SafeQueryResult<AntifraudCaseThroughput>>;
type DetectionPromise = Promise<SafeQueryResult<AntifraudDetectionHealth>>;
type MonitorPromise = Promise<
  SafeQueryResult<{
    configured: boolean;
    data: AntifraudMonitorOverview | null;
    error: boolean;
  }>
>;

/**
 * Each band waits only on the data it renders.
 *
 * The four reads are started here and deliberately NOT awaited: they are
 * handed to the bands as promises, so the KPI strip, action feed and 30-day
 * charts each paint the moment THEIR read lands, instead of waiting on the
 * slowest. `safeQuery`
 * always resolves (it catches and returns a fallback), so a hoisted promise
 * here can never surface as an unhandled rejection.
 *
 * Feed and charts share the one overview promise, so this adds no queries —
 * and `getAntifraudOverviewData` internally awaits the `cache()`-wrapped
 * `getAntifraudMonitorOverview`, so the KPI band's separate monitor read is
 * deduped rather than doubled. Do not "fix" that by merging them again.
 *
 * The composed fallbacks below add up to exactly `loading.tsx`, so the route
 * skeleton stays valid without touching it.
 */
export default async function AntifraudOverviewPage() {
  await requireAntifraudPageAccess();
  const snapshotAt = new Date().toISOString();

  const overviewPromise: OverviewPromise = safeQuery(
    () => getAntifraudOverviewData(),
    EMPTY_OVERVIEW,
    "antifraud.overview-dashboard",
    QUERY_TIMEOUT_MS,
  );
  const monitorPromise: MonitorPromise = safeQuery(
    () => getAntifraudMonitorOverview(),
    { configured: false, data: null, error: true },
    "antifraud.monitor-overview",
    QUERY_TIMEOUT_MS,
  );
  // Two more Admin-DB-only reads, each owning its own band below. They stay
  // independent of the overview so neither must wait on the MAIN mirror.
  const throughputPromise: ThroughputPromise = safeQuery(
    () => getAntifraudCaseThroughput(),
    EMPTY_THROUGHPUT,
    "antifraud.case-throughput",
    QUERY_TIMEOUT_MS,
  );
  const detectionPromise: DetectionPromise = safeQuery(
    () => getAntifraudDetectionHealth(),
    EMPTY_DETECTION,
    "antifraud.detection-health",
    QUERY_TIMEOUT_MS,
  );

  return (
    <div className="space-y-4" data-snapshot-at={snapshotAt}>
      <Suspense fallback={<KpiBandSkeleton />}>
        <KpiBand overview={overviewPromise} monitor={monitorPromise} />
      </Suspense>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,2.2fr)]">
        <Suspense fallback={<Skeleton className="h-[336px] w-full rounded-xl" />}>
          <FeedBand overview={overviewPromise} />
        </Suspense>
        <Suspense fallback={<ChartRowSkeleton />}>
          <ChartsBand overview={overviewPromise} />
        </Suspense>
      </div>

      <Suspense fallback={<CaseThroughputSkeleton />}>
        <ThroughputBand throughput={throughputPromise} />
      </Suspense>

      <Suspense fallback={<DetectionHealthSkeleton />}>
        <DetectionBand detection={detectionPromise} />
      </Suspense>
    </div>
  );
}

async function KpiBand({
  overview,
  monitor,
}: {
  overview: OverviewPromise;
  monitor: MonitorPromise;
}) {
  const [overviewResult, monitorResult] = await Promise.all([
    overview,
    monitor,
  ]);

  if (overviewResult.error) {
    return (
      <UnavailablePanel
        title="Dashboard metrics are unavailable"
        detail={
          overviewResult.kind === "timeout"
            ? "The read-only dashboard query took too long. The live connection above remains independent."
            : "The Admin or MAIN mirror read failed. No zero values are being shown as real data."
        }
      />
    );
  }

  const monitorData = monitorResult.data;
  const monitorUnavailable =
    monitorResult.error !== null ||
    monitorData.error ||
    monitorData.data === null;

  return (
    <>
      <KpiGrid
        data={overviewResult.data}
        monitor={monitorData.data}
        monitorUnavailable={monitorUnavailable}
      />
      {monitorUnavailable && (
        <UnavailablePanel
          compact
          title="Monitor queue counts are unavailable"
          detail={
            monitorResult.error !== null
              ? "The monitor queue request failed or timed out. Retry after the service recovers; MAIN and Admin metrics remain current."
              : monitorData.configured
              ? "The monitor service did not return its Antifraud-DB counts. MAIN and Admin metrics remain current."
              : "Configure the monitor API URL and read token to load signup and Fiat review queues."
          }
        />
      )}
    </>
  );
}

async function FeedBand({ overview }: { overview: OverviewPromise }) {
  const overviewResult = await overview;
  if (overviewResult.error) return null;
  return (
    <PanelErrorBoundary label="Live action feed">
      <OverviewActionFeed initialItems={overviewResult.data.feed} />
    </PanelErrorBoundary>
  );
}

async function ChartsBand({ overview }: { overview: OverviewPromise }) {
  const overviewResult = await overview;
  if (overviewResult.error) return null;
  return (
    <PanelErrorBoundary label="Thirty-day charts">
      <OverviewCharts days={overviewResult.data.days} />
    </PanelErrorBoundary>
  );
}

/**
 * Is the queue keeping up? Admin-DB only, so it survives a mirror outage —
 * and returns `null` rather than a zero-filled chart when its own read fails.
 */
async function ThroughputBand({
  throughput,
}: {
  throughput: ThroughputPromise;
}) {
  const result = await throughput;
  if (result.error) return null;
  return (
    <PanelErrorBoundary label="Case flow">
      <CaseThroughputPanel data={result.data} />
    </PanelErrorBoundary>
  );
}

/** What is firing, what went quiet, and whether each risk band earns its keep. */
async function DetectionBand({
  detection,
}: {
  detection: DetectionPromise;
}) {
  const result = await detection;
  if (result.error) return null;
  return (
    <PanelErrorBoundary label="Detection health">
      <DetectionHealthPanel data={result.data} />
    </PanelErrorBoundary>
  );
}

function KpiGrid({
  data,
  monitor,
  monitorUnavailable,
}: {
  data: AntifraudOverviewData;
  monitor: AntifraudMonitorOverview | null;
  monitorUnavailable: boolean;
}) {
  // Refunded deposits are dropped from both fiat legs upstream, so this money
  // sits outside the tile's two numbers rather than inside the fraud one.
  const refundedCents = monitor?.fiat?.refundedLifetimeCents ?? 0;
  const fraudRefundedCents = monitor?.fiat?.fraudulentRefundedLifetimeCents ?? 0;
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      <SplitKpi
        label="Fiat deposits"
        icon={CircleDollarSign}
        left={{
          label: "Legitimate",
          value: formatCurrency(
            data.metrics.legitimateFiatDepositCents / 100,
          ),
          accent: "emerald",
        }}
        right={{
          label: "Fraud",
          value: formatCurrency(
            data.metrics.fraudulentFiatDepositCents / 100,
          ),
          accent: "rose",
        }}
        footnote={
          refundedCents > 0
            ? `Already refunded (not counted above): ${formatCurrency(
                refundedCents / 100,
              )}${
                fraudRefundedCents > 0
                  ? ` · fraud ${formatCurrency(fraudRefundedCents / 100)}`
                  : ""
              }`
            : undefined
        }
      />
      <SplitKpi
        label="KYC locked"
        icon={UserCheck}
        left={{
          label: "Manual",
          value: formatNumber(data.metrics.manualKycLocks),
          accent: "cyan",
        }}
        right={{
          label: "System",
          value: formatNumber(data.metrics.systemKycLocks),
          accent: "amber",
        }}
      />
      <SplitKpi
        label="Banned accounts"
        icon={Ban}
        left={{
          label: "Manual",
          value: formatNumber(data.metrics.manualBans),
          accent: "orange",
        }}
        right={{
          label: "Automatic",
          value: formatNumber(data.metrics.automaticBans),
          accent: "rose",
        }}
      />
      <KpiTile
        label="Signup reviews left"
        value={
          monitorUnavailable || !monitor
            ? "—"
            : formatNumber(monitor.signupReviewsLeft)
        }
        sub={monitorUnavailable ? "Monitor unavailable" : "Open signup cases"}
        icon={ListChecks}
        accent="blue"
      />
      <KpiTile
        label="Fiat reviews left"
        value={
          monitorUnavailable || !monitor
            ? "—"
            : formatNumber(monitor.fiatReviewsLeft)
        }
        sub={monitorUnavailable ? "Monitor unavailable" : "Review or bad verdict"}
        icon={ShieldAlert}
        accent="amber"
      />
      <KpiTile
        label="Auto-lock reviews left"
        value={formatNumber(data.metrics.autoLockReviewsLeft)}
        sub="Active automatic locks"
        icon={LockKeyhole}
        accent="rose"
      />
    </div>
  );
}

function SplitKpi({
  label,
  icon: Icon,
  left,
  right,
  footnote,
}: {
  label: string;
  icon: ElementType;
  left: { label: string; value: string; accent: AccentColor };
  right: { label: string; value: string; accent: AccentColor };
  footnote?: string;
}) {
  // Flat tile matching KpiTile (same surface, radius, padding and the
  // canonical 11px/0.14em micro-caps eyebrow) so the mixed KPI grid reads
  // as one family. h-full keeps split and plain tiles one clean row height.
  return (
    <div
      role="group"
      aria-label={`${label}: ${left.label} ${left.value}, ${right.label} ${right.value}${
        footnote ? `, ${footnote}` : ""
      }`}
      className="h-full rounded-lg border bg-card px-3 py-2.5 sm:px-4 sm:py-3"
    >
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground sm:size-4" aria-hidden />
        <span className="truncate text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 divide-x divide-border/60">
        {[left, right].map((item) => (
          <div key={item.label} className="min-w-0 px-2 first:pl-0 last:pr-0">
            <p
              className={cn(
                "truncate text-lg font-bold leading-tight tracking-tight tabular-nums sm:text-xl",
                TILE_COLORS[item.accent].text,
              )}
            >
              {item.value}
            </p>
            <p className="mt-0.5 truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {item.label}
            </p>
          </div>
        ))}
      </div>
      {footnote && (
        <p className="mt-2 text-[10px] leading-tight text-muted-foreground">
          {footnote}
        </p>
      )}
    </div>
  );
}

function UnavailablePanel({
  title,
  detail,
  compact = false,
}: {
  title: string;
  detail: string;
  compact?: boolean;
}) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-xl border border-amber-500/30 bg-amber-500/5",
        compact ? "px-3 py-2.5" : "p-5",
      )}
    >
      <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
        {title}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

/**
 * Per-band fallbacks. Stacked in page order they are byte-for-byte the shape
 * `loading.tsx` renders, so the route-level skeleton and these boundaries can
 * never disagree about the page's geometry.
 */
function KpiBandSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-24 w-full rounded-xl" />
      ))}
    </div>
  );
}
