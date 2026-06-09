import { Suspense } from "react";
import {
  Trophy,
  Coins,
  Layers,
  Percent,
  Activity,
  ListOrdered,
  Wallet,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn, PeriodChips } from "@/components/ux";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import {
  getLiveLeaderboards,
  parseLiveLeaderboardRank,
  parseLiveLeaderboardView,
  type LiveLeaderboardRank,
  type LiveLeaderboardView,
} from "./_queries/live-leaderboards";
import { LiveLeaderboardsRanklist } from "./_components/live-leaderboards-ranklist";

export const metadata = { title: "Live Leaderboards · Creator Hub" };

const VIEW_CHIPS = [
  { value: "active", label: "Live" },
  { value: "upcoming", label: "Upcoming" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All" },
] as const;

const SORT_CHIPS = [
  { value: "house_cost", label: "House cost ↓" },
  { value: "house_cost_asc", label: "House cost ↑" },
  { value: "prize_pool", label: "Prize ↓" },
  { value: "prize_pool_asc", label: "Prize ↑" },
  { value: "wager", label: "Wager ↓" },
  { value: "wager_asc", label: "Wager ↑" },
  { value: "ending_soon", label: "Ending soon" },
  { value: "starting_soon", label: "Starting soon" },
  { value: "recently_ended", label: "Recently ended" },
] as const;

const VIEW_SUBTITLES: Record<LiveLeaderboardView, string> = {
  active: "Creator leaderboards running right now",
  upcoming: "Approved boards scheduled to start",
  ended: "Completed creator affiliate leaderboards",
  all: "Every approved creator leaderboard — all lifecycle stages",
};

export default async function CreatorHubLeaderboardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const sp = await searchParams;
  const rank = parseLiveLeaderboardRank(sp.rank);
  const view = parseLiveLeaderboardView(sp.view);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Trophy}
          accent="amber"
          title="Live Leaderboards"
          subtitle={VIEW_SUBTITLES[view]}
        />
      </PageHero>

      <Suspense key={`${view}:${rank}`} fallback={<RanklistSkeleton />}>
        <LiveLeaderboardsSection rank={rank} view={view} />
      </Suspense>
    </div>
  );
}

async function LiveLeaderboardsSection({
  rank,
  view,
}: {
  rank: LiveLeaderboardRank;
  view: LiveLeaderboardView;
}) {
  const data = await getLiveLeaderboards(rank, view);

  const liveSub =
    view === "active"
      ? data.upcomingCount > 0
        ? `${formatNumber(data.upcomingCount)} upcoming · ${formatNumber(data.endedCount)} ended`
        : `${formatNumber(data.endedCount)} ended`
      : view === "all"
        ? `${formatNumber(data.activeCount)} live · ${formatNumber(data.upcomingCount)} upcoming · ${formatNumber(data.endedCount)} ended`
        : `${formatNumber(data.rows.length)} in this view`;

  return (
    <FadeIn className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <KpiTile
          label="Live Now"
          value={formatNumber(data.activeCount)}
          sub={liveSub}
          icon={Activity}
          accent="emerald"
        />
        <KpiTile
          label="View House Cost"
          value={formatCurrency(data.viewHouseCostUsd)}
          sub="Σ pool × house share"
          icon={Coins}
          accent="rose"
        />
        <KpiTile
          label="View Prize Pools"
          value={formatCurrency(data.viewPrizeUsd)}
          sub="full pools, net of refunds"
          icon={Layers}
          accent="blue"
        />
        <KpiTile
          label="View Wager"
          value={formatCurrency(data.viewWagerUsd)}
          sub="code-scoped window total"
          icon={Wallet}
          accent="emerald"
        />
        <KpiTile
          label="Blended House Share"
          value={`${data.viewHouseSharePct.toFixed(1)}%`}
          sub="prize-weighted — the % we pay"
          icon={Percent}
          accent="rose"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={ListOrdered} title="Ranked boards" />
        <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
          <PeriodChips
            items={VIEW_CHIPS}
            current={view}
            paramKey="view"
            defaultValue="active"
            ariaNoun="filter"
          />
          <PeriodChips
            items={SORT_CHIPS}
            current={rank}
            paramKey="rank"
            defaultValue="house_cost"
            ariaNoun="sort"
            className="xl:max-w-[720px]"
          />
        </div>
        <LiveLeaderboardsRanklist
          rows={data.rows}
          view={view}
          backendUnavailable={data.backendUnavailable}
        />
      </div>
    </FadeIn>
  );
}

function RanklistSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>
      <div className="space-y-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[80px] rounded-xl" />
        ))}
      </div>
    </div>
  );
}
