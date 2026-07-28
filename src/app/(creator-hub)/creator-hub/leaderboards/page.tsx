import { cache, Suspense } from "react";
import {
  Trophy,
  Coins,
  Layers,
  Percent,
  Activity,
  Wallet,
  AlertTriangle,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { FadeIn, PeriodChips } from "@/components/ux";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { formatTime } from "@/lib/timezone/core";

import { HubNotice } from "../_components/hub-notice";
import {
  getLiveLeaderboards,
  parseLiveLeaderboardRank,
  parseLiveLeaderboardView,
  type LiveLeaderboardRank,
  type LiveLeaderboardView,
} from "./_queries/live-leaderboards";
import { LiveLeaderboardsRanklist } from "./_components/live-leaderboards-ranklist";
import { LeaderboardRankSelect } from "./_components/rank-select";
import {
  LeaderboardsKpiSkeleton,
  LeaderboardsRanklistSkeleton,
} from "./_components/list-skeletons";

export const metadata = { title: "Live Leaderboards · Creator Hub" };

const VIEW_CHIPS = [
  { value: "active", label: "Live" },
  { value: "upcoming", label: "Upcoming" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All" },
] as const;

/**
 * Per-request memo so the two streamed sections below (KPI strip + ranklist)
 * share ONE `getLiveLeaderboards` execution instead of each paying for the
 * username hydration + wager-map pass. Same args → one call per request.
 */
const loadLeaderboards = cache(
  (rank: LiveLeaderboardRank, view: LiveLeaderboardView) =>
    getLiveLeaderboards(rank, view),
);

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
      {/* Page opener — SectionHeading owns the page identity (the old
          PageHero title block renders nothing by owner decision). The
          controls live in its action slot so they stay mounted in the shell:
          a filter/sort switch never removes the control just clicked. */}
      <div className="space-y-3">
        <SectionHeading
          icon={Trophy}
          title="Live Leaderboards"
          action={
            <>
              <PeriodChips
                items={VIEW_CHIPS}
                current={view}
                paramKey="view"
                defaultValue="active"
                ariaNoun="filter"
              />
              <LeaderboardRankSelect current={rank} />
            </>
          }
        />

        {/* KPI strip — keyed on the VIEW only: the tiles are sums over the
            visible set, so re-sorting can't change them. Keeping `rank` out
            of the key means a sort switch doesn't re-skeleton the strip. */}
        <Suspense key={`kpis:${view}`} fallback={<LeaderboardsKpiSkeleton />}>
          <KpiSection rank={rank} view={view} />
        </Suspense>
      </div>

      <Suspense
        key={`rows:${view}:${rank}`}
        fallback={<LeaderboardsRanklistSkeleton />}
      >
        <RanklistSection rank={rank} view={view} />
      </Suspense>
    </div>
  );
}

async function KpiSection({
  rank,
  view,
}: {
  rank: LiveLeaderboardRank;
  view: LiveLeaderboardView;
}) {
  const data = await loadLeaderboards(rank, view);

  const liveSub =
    view === "active"
      ? data.upcomingCount > 0
        ? `${formatNumber(data.upcomingCount)} upcoming · ${formatNumber(data.endedCount)} ended`
        : `${formatNumber(data.endedCount)} ended`
      : view === "all"
        ? `${formatNumber(data.activeCount)} live · ${formatNumber(data.upcomingCount)} upcoming · ${formatNumber(data.endedCount)} ended`
        : `${formatNumber(data.rows.length)} in this view`;

  return (
    <FadeIn>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          as of {formatTime(data.snapshotMs)} UTC · refreshes every 60s
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <KpiTile
            label="Live Now"
            value={formatNumber(data.activeCount)}
            sub={liveSub}
            icon={Activity}
            accent="emerald"
            live={data.activeCount > 0}
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
      </div>
    </FadeIn>
  );
}

async function RanklistSection({
  rank,
  view,
}: {
  rank: LiveLeaderboardRank;
  view: LiveLeaderboardView;
}) {
  const data = await loadLeaderboards(rank, view);

  const degraded: string[] = [];
  if (data.sponsorshipUnavailable) {
    degraded.push(
      "the house-share lookup failed, so every board is shown at 100% house share (house cost may be overstated)",
    );
  }
  if (data.usernamesUnavailable) {
    degraded.push("creator usernames couldn't be resolved (rows show raw ids)");
  }

  return (
    <FadeIn>
      <div className="space-y-3">
        {degraded.length > 0 && (
          <HubNotice tone="amber" icon={AlertTriangle} title="Partial data">
            {degraded.join("; ")}. The figures refresh automatically — retry in
            a minute.
          </HubNotice>
        )}
        <LiveLeaderboardsRanklist
          rows={data.rows}
          view={view}
          backendUnavailable={data.backendUnavailable}
        />
      </div>
    </FadeIn>
  );
}
