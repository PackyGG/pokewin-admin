import { Suspense } from "react";
import { LineChart, Scale } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/fade-in";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency } from "@/lib/utils/format";

import { getCreatorDetailCached } from "../_queries/overview-data";
import {
  OverviewKpiStrip,
  OverviewKpiStripSkeleton,
} from "./overview-kpi-strip";
import { CreatorNetPanel } from "./creator-net-panel";
import { CreatorPnlPanel } from "../../../../../(admin)/creators/[userId]/creator-pnl-panel";
import {
  WindowedPnlTilesSkeleton,
} from "./windowed-pnl-tiles";
import {
  getCreatorActivitySeries,
  parseCreatorActivityPeriod,
  type CreatorActivityPeriod,
} from "@/lib/creator-hub/creator-activity-series";

import { ActivityChart } from "./activity-chart";
import { ActivityPeriodControl } from "./activity-period-control";
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
 *      • Affiliates PnL (lifetime + windowed tiles — same panel as /creators/[id]).
 *      • Activity chart (wager / deposits / GGR time-series).
 *
 * LAZY / never-preload: every heavy region streams in its OWN keyed Suspense
 * boundary so the banner + tab bar paint immediately and each read runs in
 * parallel rather than serially behind a shared blocking await. The activity
 * chart boundary is additionally keyed on `activityPeriod` so only the active
 * window is fetched (never preloading all windows).
 */
export function OverviewTab({
  userId,
  activityPeriod,
}: {
  userId: string;
  activityPeriod: CreatorActivityPeriod;
}) {
  // KPI strip aggregate — kicked off once for the top strip only.
  //
  // Budget contract: `getCreatorDetail` runs TWO SERIAL inner waves, each
  // bounded by withTimeout(REWARD_QUERY_TIMEOUT_MS = 15s) — worst-case
  // ~30s before ITS OWN timeout fires. An outer 15s here used to cut a
  // cold-but-succeeding run off halfway and band the strip even though
  // the query would have completed (and warmed the cache). 32s > 15s+15s
  // keeps the outer wrapper the LAST resort, not the first to fire. The
  // warm path resolves in milliseconds either way.
  const profilePromise = safeQueryOrNull(
    () => getCreatorDetailCached(userId),
    "creator-hub.creators.profile",
    32_000,
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

        {/* Affiliates PnL — full parity with /creators/[id] (lifetime wager,
            FTDs, deposits, card WD, windowed tiles). */}
        <Suspense fallback={<WindowedPnlTilesSkeleton />}>
          <CreatorPnlPanel
            userId={userId}
            profileResultPromise={profilePromise}
          />
        </Suspense>

        {/* Activity chart — bucketed wager / deposits / GGR for the active
            window only (`activityPeriod` keys this boundary). */}
        <Suspense
          key={activityPeriod}
          fallback={<ActivityChartSkeleton />}
        >
          <ActivitySlot
            userId={userId}
            activityPeriod={activityPeriod}
          />
        </Suspense>
      </div>
    </FadeIn>
  );
}

type CreatorProfile = Awaited<ReturnType<typeof getCreatorDetailCached>>;
type ProfilePromise = Promise<{
  data: CreatorProfile | null;
  error: string | null;
  kind?: "timeout" | "error" | null;
}>;

async function KpiStripSlot({
  profilePromise,
}: {
  profilePromise: ProfilePromise;
}) {
  const { data, kind } = await profilePromise;
  // Truthful band copy: a hard failure (e.g. an enum-drift 22P02) must not
  // masquerade as "taking too long".
  return <OverviewKpiStrip profile={data} failureKind={kind ?? null} />;
}

async function ActivitySlot({
  userId,
  activityPeriod,
}: {
  userId: string;
  activityPeriod: CreatorActivityPeriod;
}) {
  const { data, error } = await safeQueryOrNull(
    () => getCreatorActivitySeries(userId, activityPeriod),
    "creator-hub.creators.activitySeries",
    45_000,
  );

  const totals = data?.totals;
  const ggrPositive = (totals?.ggrUsd ?? 0) > 0;
  const ggrNegative = (totals?.ggrUsd ?? 0) < 0;

  const chips = data
    ? [
        {
          label: "Wager",
          value: formatCurrency(totals?.wagerUsd ?? 0),
          colorClass: "text-emerald-600 dark:text-emerald-400",
        },
        {
          label: "Deposits",
          value: formatCurrency(totals?.depositsUsd ?? 0),
          colorClass: "text-teal-600 dark:text-teal-400",
        },
        {
          label: "GGR",
          value: formatCurrency(totals?.ggrUsd ?? 0),
          colorClass: ggrPositive
            ? "text-emerald-600 dark:text-emerald-400"
            : ggrNegative
              ? "text-rose-600 dark:text-rose-400"
              : "text-muted-foreground",
        },
      ]
    : [
        { label: "Wager", value: "—", colorClass: "text-muted-foreground" },
        { label: "Deposits", value: "—", colorClass: "text-muted-foreground" },
        { label: "GGR", value: "—", colorClass: "text-muted-foreground" },
      ];

  const series =
    data?.series.map((p) => ({
      label: p.label,
      wagerUsd: p.wagerUsd,
      depositsUsd: p.depositsUsd,
      ggrUsd: p.ggrUsd,
    })) ?? [];

  return (
    <ActivityChart
      headlineChips={chips}
      series={series}
      periodControl={<ActivityPeriodControl current={activityPeriod} />}
      emptyNote={
        error
          ? "Activity time-series timed out — refresh to retry."
          : undefined
      }
    />
  );
}

/** Parse `?activityPeriod=` for the Overview activity chart (7d / 30d / 90d). */
export { parseCreatorActivityPeriod };

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
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-[200px] w-full rounded-md" />
    </Card>
  );
}
