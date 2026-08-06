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
  getAntifraudPollerHealth,
  type AntifraudMonitorOverview,
} from "@/lib/antifraud/monitor-api";
import { getReviewQueueStats } from "@/lib/antifraud/reviews";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  OverviewActionFeed,
  OverviewCharts,
} from "./_components/overview-panels";
import { PulseBar, QueueStrip } from "./_components/overview-status";
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

export default async function AntifraudOverviewPage() {
  await requireAntifraudPageAccess();
  const snapshotAt = new Date().toISOString();

  return (
    <div className="space-y-4">
      <Suspense fallback={<DashboardSkeleton />}>
        <Dashboard snapshotAt={snapshotAt} />
      </Suspense>
    </div>
  );
}

async function Dashboard({ snapshotAt }: { snapshotAt: string }) {
  const [overviewResult, monitorResult, pollerResult, queueResult] =
    await Promise.all([
      safeQuery(
        () => getAntifraudOverviewData(),
        EMPTY_OVERVIEW,
        "antifraud.overview-dashboard",
        QUERY_TIMEOUT_MS,
      ),
      safeQuery(
        () => getAntifraudMonitorOverview(),
        { configured: false, data: null, error: true },
        "antifraud.monitor-overview",
        QUERY_TIMEOUT_MS,
      ),
      safeQuery(
        () => getAntifraudPollerHealth(),
        { configured: false, data: null, error: true },
        "antifraud.poller-health",
        QUERY_TIMEOUT_MS,
      ),
      safeQuery(
        () => getReviewQueueStats(),
        { priority: 0, normal: 0, waitingKyc: 0, postponed: 0 },
        "antifraud.review-queue-stats",
        QUERY_TIMEOUT_MS,
      ),
    ]);

  // The Admin-DB queue read is independent of the mirror overview, so a failed
  // overview must not blank the one band that says what is waiting for a human.
  const queueStrip = queueResult.error ? null : (
    <QueueStrip stats={queueResult.data} />
  );

  if (overviewResult.error) {
    return (
      <div className="space-y-4">
        {queueStrip}
        <UnavailablePanel
          title="Dashboard metrics are unavailable"
          detail={
            overviewResult.kind === "timeout"
              ? "The read-only dashboard query took too long. The live connection above remains independent."
              : "The Admin or MAIN mirror read failed. No zero values are being shown as real data."
          }
        />
      </div>
    );
  }

  const monitor = monitorResult.data;
  const monitorUnavailable =
    monitorResult.error !== null || monitor.error || monitor.data === null;

  return (
    <div className="space-y-4" data-snapshot-at={snapshotAt}>
      <PulseBar
        poller={pollerResult.error ? null : pollerResult.data.data}
        pollerConfigured={
          pollerResult.error === null && pollerResult.data.configured
        }
        live={overviewResult.data.live}
      />

      {queueStrip}

      <KpiGrid
        data={overviewResult.data}
        monitor={monitor.data}
        monitorUnavailable={monitorUnavailable}
      />

      {monitorUnavailable && (
        <UnavailablePanel
          compact
          title="Monitor queue counts are unavailable"
          detail={
            monitorResult.error !== null
              ? "The monitor queue request failed or timed out. Retry after the service recovers; MAIN and Admin metrics remain current."
              : monitor.configured
              ? "The monitor service did not return its Antifraud-DB counts. MAIN and Admin metrics remain current."
              : "Configure the monitor API URL and read token to load signup and Fiat review queues."
          }
        />
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,2.2fr)]">
        <PanelErrorBoundary label="Live action feed">
          <OverviewActionFeed initialItems={overviewResult.data.feed} />
        </PanelErrorBoundary>
        <PanelErrorBoundary label="Thirty-day charts">
          <OverviewCharts days={overviewResult.data.days} />
        </PanelErrorBoundary>
      </div>
    </div>
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

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-11 rounded-lg" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-[52px] rounded-lg" />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(300px,0.8fr)_minmax(0,2.2fr)]">
        <Skeleton className="h-[336px] rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[336px] rounded-xl" />
          <Skeleton className="h-[336px] rounded-xl" />
        </div>
      </div>
    </div>
  );
}
