import { Suspense } from "react";
import { LineChart, Scale } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/fade-in";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { getCreatorDetailCached } from "../_queries/overview-data";
import {
  OverviewKpiStrip,
  OverviewKpiStripSkeleton,
} from "./overview-kpi-strip";
import { CreatorNetPanel } from "./creator-net-panel";
import {
  WindowedPnlTiles,
  WindowedPnlTilesSkeleton,
} from "./windowed-pnl-tiles";
import { ActivityChart } from "./activity-chart";
import { DealCard } from "./deal-card";
import { LeaderboardsCard } from "./leaderboards-card";

/**
 * Overview tab for `creators/[id]`.
 *
 * Layout (owner spec, top → bottom):
 *   1. KPI strip (clicks / signups / FTDs / wager / earned …).
 *   2. Deal | Affiliate Leaderboards — 50/50 row, stacks on narrow screens.
 *   3. Performance section:
 *      • Creator Net (P&L) box with (i) hover + breakdown.
 *      • Small windowed PnL tiles (1d / 3d / 7d / 2w / 1m).
 *      • Activity chart (sign-ups / FTDs / wager / deposits).
 *
 * LAZY / never-preload: every heavy region streams in its OWN keyed Suspense
 * boundary so the banner + tab bar paint immediately and each read runs in
 * parallel rather than serially behind a shared blocking await. The KPI strip
 * + the activity-chart headline share the SAME `getCreatorDetail` aggregate
 * via one in-flight promise, so that 12-round-trip read fires exactly once.
 */
export function OverviewTab({ userId }: { userId: string }) {
  // Single shared aggregate read — consumed by BOTH the KPI strip (top) and
  // the activity-chart headline chips (bottom), kicked off ONCE (not awaited
  // on this component's path) and handed to both slots so it fires once.
  // Timeout-bounded so a slow scan degrades per-slot instead of hanging.
  const profilePromise = safeQueryOrNull(
    () => getCreatorDetailCached(userId),
    "creator-hub.creators.profile",
    15_000,
  );

  return (
    <FadeIn className="space-y-5 sm:space-y-6">
      {/* 1 ── KPI strip */}
      <Suspense fallback={<OverviewKpiStripSkeleton />}>
        <KpiStripSlot profilePromise={profilePromise} />
      </Suspense>

      {/* 2 ── Deal | Affiliate Leaderboards (50/50). Each card streams in its
          own boundary so a slow backend call on one doesn't block the other. */}
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <Suspense fallback={<HalfCardSkeleton />}>
          <DealCard userId={userId} />
        </Suspense>
        <Suspense fallback={<HalfCardSkeleton />}>
          <LeaderboardsCard userId={userId} />
        </Suspense>
      </div>

      {/* 3 ── Performance */}
      <div className="space-y-4">
        <SectionHeading icon={LineChart} title="Performance" />

        {/* Creator Net (P&L) — its own ledger + cost reads. */}
        <Suspense fallback={<CreatorNetSkeleton />}>
          <CreatorNetPanel userId={userId} />
        </Suspense>

        {/* Small windowed PnL tiles (1d / 3d / 7d / 2w / 1m). */}
        <Suspense fallback={<WindowedPnlTilesSkeleton />}>
          <WindowedPnlTiles userId={userId} />
        </Suspense>

        {/* Activity chart — headline chips from the shared aggregate; the
            per-creator time-series isn't wired yet (honest placeholder body). */}
        <Suspense fallback={<ActivityChartSkeleton />}>
          <ActivitySlot profilePromise={profilePromise} />
        </Suspense>
      </div>
    </FadeIn>
  );
}

type CreatorProfile = Awaited<ReturnType<typeof getCreatorDetailCached>>;
type ProfilePromise = Promise<{
  data: CreatorProfile | null;
  error: string | null;
}>;

async function KpiStripSlot({
  profilePromise,
}: {
  profilePromise: ProfilePromise;
}) {
  const { data } = await profilePromise;
  return <OverviewKpiStrip profile={data} />;
}

async function ActivitySlot({
  profilePromise,
}: {
  profilePromise: ProfilePromise;
}) {
  const { data } = await profilePromise;

  // REAL totals we have today (house-POV colors). The 3-day momentum figures
  // aren't on this aggregate, so we surface the lifetime wager + funnel
  // counts the aggregate DOES carry. Deposits has no lifetime figure on this
  // read, so it's omitted rather than fabricated.
  const chips = data
    ? [
        {
          label: "Signups",
          value: formatNumber(data.signups.total),
          colorClass: "text-blue-600 dark:text-blue-400",
        },
        {
          label: "FTDs",
          value: formatNumber(data.ftdCount),
          colorClass: "text-cyan-600 dark:text-cyan-400",
        },
        {
          label: "Wager (all-time)",
          value: formatCurrency(data.totalWagerVolumeUsd),
          colorClass: "text-emerald-600 dark:text-emerald-400",
        },
        {
          label: "Active affi (7d)",
          value: formatNumber(data.activeReferrals7d),
          colorClass: "text-amber-600 dark:text-amber-400",
        },
      ]
    : [
        { label: "Signups", value: "—", colorClass: "text-muted-foreground" },
        { label: "FTDs", value: "—", colorClass: "text-muted-foreground" },
        {
          label: "Wager (all-time)",
          value: "—",
          colorClass: "text-muted-foreground",
        },
        {
          label: "Active affi (7d)",
          value: "—",
          colorClass: "text-muted-foreground",
        },
      ];

  return (
    <ActivityChart
      headlineChips={chips}
      placeholderNote="Per-creator sign-ups / FTDs / wager / deposits time-series not wired yet — totals above are live."
    />
  );
}

// ── Suspense fallbacks ───────────────────────────────────────────────

function HalfCardSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-6 w-40" />
      <Card size="sm" className="space-y-3 p-4">
        <Skeleton className="h-5 w-32" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </Card>
    </div>
  );
}

function CreatorNetSkeleton() {
  return (
    <Card size="sm" className="space-y-3 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <Scale className="size-4 text-muted-foreground" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-9 w-40" />
      <Skeleton className="h-3 w-56" />
      <div className="space-y-1.5 pt-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
      </div>
    </Card>
  );
}

function ActivityChartSkeleton() {
  return (
    <Card size="sm" className="space-y-3 p-4 sm:p-5">
      <Skeleton className="h-5 w-24" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-[200px] w-full rounded-md" />
    </Card>
  );
}
