import { Suspense } from "react";
import { HostLink } from "@/components/host-link";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Fingerprint,
  ShieldAlert,
  UserCheck,
} from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatCurrency,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import { listRecentSignals, listReviews } from "@/lib/antifraud/reviews";
import { getAntifraudOverviewMetrics } from "@/lib/antifraud/overview";
import { LiveFeed } from "./_components/live-feed";
import { OverviewLiveSync } from "./_components/overview-live-sync";
import { ReviewSeverityBadge, ReviewStatusBadge } from "./_components/badges";

export const metadata = { title: "Antifraud" };

/**
 * Antifraud → Overview.
 *
 * The workspace landing page: the state of the review queue, the live signal
 * strip fed by the (separate) fraud backend, and what's waiting for this
 * analyst.
 *
 * Shell-first: the hero + the live strip paint immediately and every data leg
 * streams in behind its own Suspense boundary (loading.tsx renders the matching
 * skeletons). Every read is a single-table ADMIN-DB query served by one of the
 * indexes created with the tables — the MAIN (prod game) DB is not touched by
 * this page at all.
 */

const QUERY_TIMEOUT_MS = 10_000;

export default async function AntifraudOverviewPage() {
  await requireAntifraudPageAccess();
  const snapshotAt = new Date().toISOString();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <OverviewLiveSync snapshotAt={snapshotAt} />

      <Suspense fallback={<KpiSkeleton />}>
        <OverviewKpis />
      </Suspense>

      {/* Client island — subscribes to /api/antifraud/monitor/stream. Rendered outside
          Suspense on purpose: it has no server data to wait for and it is the
          one part of the page that should appear instantly. */}
      <LiveFeed />

      <div className="grid gap-6 lg:grid-cols-2">
        <Suspense fallback={<ListSkeleton title="Needs attention" />}>
          <QueuePreview />
        </Suspense>
        <Suspense fallback={<ListSkeleton title="Recent signals" />}>
          <SignalHistory />
        </Suspense>
      </div>

    </div>
  );
}

// ─── KPI strip ────────────────────────────────────────────────────────

async function OverviewKpis() {
  const { data: metrics } = await safeQuery(
    () => getAntifraudOverviewMetrics(),
    {
      totalFiatDepositCents: 0,
      fraudAccountFiatDepositCents: 0,
      kycAccountCount: 0,
      automatedFraudKycCount: 0,
    },
    "antifraud.overview-metrics",
    QUERY_TIMEOUT_MS,
  );

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <KpiTile
        label="Total fiat deposits"
        value={formatCurrency(metrics.totalFiatDepositCents / 100)}
        sub="lifetime paid volume"
        icon={CircleDollarSign}
        accent="blue"
      />
      <KpiTile
        label="Fraud account deposits"
        value={formatCurrency(metrics.fraudAccountFiatDepositCents / 100)}
        sub="paid by flagged accounts"
        icon={ShieldAlert}
        accent="rose"
      />
      <KpiTile
        label="KYC accounts"
        value={formatNumber(metrics.kycAccountCount)}
        sub="historical verification records"
        icon={UserCheck}
        accent="cyan"
      />
      <KpiTile
        label="Automatic KYC / flagged"
        value={formatNumber(metrics.automatedFraudKycCount)}
        sub="system-required fraud KYC"
        icon={Fingerprint}
        accent="amber"
      />
    </div>
  );
}

// ─── Queue preview ────────────────────────────────────────────────────

async function QueuePreview() {
  const { data: reviews } = await safeQuery(
    () => listReviews({ status: "unresolved", limit: 8 }),
    [],
    "antifraud.queue-preview",
    QUERY_TIMEOUT_MS,
  );

  return (
    <div className="space-y-4">
      <SectionHeading
        icon={ShieldAlert}
        title="Needs attention"
        action={
          <HostLink
            href="/antifraud/reviews"
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Open queue →
          </HostLink>
        }
      />
      {reviews.length === 0 ? (
        <EmptyCard
          icon={CheckCircle2}
          title="Queue is clear"
          body="No open account reviews. New cases appear here automatically when the fraud backend flags an account, or when someone opens one by hand."
        />
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
          {reviews.map((review) => (
            <li key={review.id}>
              <HostLink
                href={`/antifraud/reviews/${review.id}`}
                className="flex items-start gap-3 px-3 py-2.5 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 sm:px-4"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">
                      {review.targetUsername ?? review.targetUserId}
                    </span>
                    <ReviewStatusBadge status={review.status} />
                  </span>
                  <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                    {review.reason}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {formatRelative(review.createdAt)}
                </span>
              </HostLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Signal history ───────────────────────────────────────────────────

async function SignalHistory() {
  const { data: signals } = await safeQuery(
    () => listRecentSignals(8),
    [],
    "antifraud.recent-signals",
    QUERY_TIMEOUT_MS,
  );

  return (
    <div className="space-y-4">
      <SectionHeading icon={AlertTriangle} title="Recent signals" />
      {signals.length === 0 ? (
        <EmptyCard
          icon={AlertTriangle}
          title="No signals recorded yet"
          body="Once the antifraud backend service posts to the ingest webhook, every signal it produces is stored here — even when nobody has the dashboard open."
        />
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
          {signals.map((signal) => (
            <li
              key={signal.id}
              className="flex items-start gap-3 px-3 py-2.5 sm:px-4"
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">
                    {signal.kind}
                  </span>
                  <ReviewSeverityBadge severity={signal.severity} />
                  {signal.targetUsername && (
                    <span className="truncate text-[11px] text-muted-foreground">
                      @{signal.targetUsername}
                    </span>
                  )}
                </span>
                <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                  {signal.summary}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {formatRelative(signal.receivedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Personal / team section ──────────────────────────────────────────

function EmptyCard({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ElementType;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-8 text-center">
      <Icon className="size-5 text-muted-foreground" />
      <span className="text-sm font-semibold">{title}</span>
      <span className="max-w-sm text-xs text-muted-foreground">{body}</span>
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-24 w-full rounded-2xl" />
      ))}
    </div>
  );
}

function ListSkeleton({ title }: { title: string }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="h-4 w-40" />
        <span className="sr-only">{title}</span>
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  );
}
