import { Suspense } from "react";
import {
  Trophy,
  Coins,
  Layers,
  Percent,
  Activity,
  ListOrdered,
} from "lucide-react";

import { requireRole } from "@/lib/dal";
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
  type LiveLeaderboardRank,
} from "./_queries/live-leaderboards";
import { LiveLeaderboardsRanklist } from "./_components/live-leaderboards-ranklist";

export const metadata = { title: "Live Leaderboards · Creator Hub" };

/**
 * Creator Hub — Live Leaderboards ranklist.
 *
 * A ranked list of every CURRENTLY-RUNNING creator affiliate leaderboard, live
 * across all creators, with the soon-to-start boards as context underneath.
 * Built on the existing data layer (the approved-leaderboard backend walk + the
 * admin-side sponsored-% / house-share map + MAIN username hydration) — no new
 * MAIN schema, no duplicated cost logic.
 *
 * House-POV (STRICT): a leaderboard's prize pool is money the house pays out to
 * players, so the headline figure per board is the HOUSE COST (= pool × house
 * share %) → rose. The full pool is neutral context; active/upcoming counts are
 * operational.
 *
 * ACCESS: admin + creator_manager only (the Hub layout enforces it; this page
 * adds the explicit DAL gate too, per the house convention).
 *
 * ACTIVE-TIMEFRAME-ONLY / LAZY: the ranklist body is wrapped in a Suspense
 * boundary keyed on the rank metric. The underlying backend walk is cached
 * (60s) and ranking is an in-memory sort of that one cached read, so switching
 * the rank metric never re-hits the backend (no API spam).
 */

const RANK_CHIPS = [
  { value: "house_cost", label: "House cost" },
  { value: "prize_pool", label: "Prize pool" },
  { value: "ending_soon", label: "Ending soon" },
] as const;

export default async function CreatorHubLeaderboardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole(["admin", "creator_manager"]);

  const rank = parseLiveLeaderboardRank((await searchParams).rank);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Trophy}
          accent="amber"
          title="Live Leaderboards"
          subtitle="Every creator leaderboard running right now — ranked by house cost"
        />
      </PageHero>

      {/* The KPI strip + ranklist both depend on the same cached read, so the
          whole data block streams behind ONE Suspense boundary keyed on the
          rank metric (lazy; only the active view loads). */}
      <Suspense key={rank} fallback={<RanklistSkeleton />}>
        <LiveLeaderboardsSection rank={rank} />
      </Suspense>
    </div>
  );
}

// ─── Data-bearing section (streamed via Suspense) ───────────────────

async function LiveLeaderboardsSection({
  rank,
}: {
  rank: LiveLeaderboardRank;
}) {
  const data = await getLiveLeaderboards(rank);

  return (
    <FadeIn className="space-y-6">
      {/* KPI strip — house-POV: house cost + house share are rose (what we
          pay), the full active prize pool is neutral context, the live count
          is operational/emerald. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label="Live Now"
          value={formatNumber(data.activeCount)}
          sub={
            data.upcomingCount > 0
              ? `${formatNumber(data.upcomingCount)} upcoming`
              : "boards running"
          }
          icon={Activity}
          accent="emerald"
        />
        <KpiTile
          label="Active House Cost"
          value={formatCurrency(data.activeHouseCostUsd)}
          sub="Σ pool × house share"
          icon={Coins}
          accent="rose"
        />
        <KpiTile
          label="Active Prize Pools"
          value={formatCurrency(data.activePrizeUsd)}
          sub="full pools, net of refunds"
          icon={Layers}
          accent="blue"
        />
        <KpiTile
          label="Blended House Share"
          value={`${data.activeHouseSharePct.toFixed(1)}%`}
          sub="prize-weighted — the % we pay"
          icon={Percent}
          accent="rose"
        />
      </div>

      {/* Ranklist — header + rank-metric chips + the ranked rows. */}
      <div className="space-y-3">
        <SectionHeading
          icon={ListOrdered}
          title="Ranked boards"
          action={
            <PeriodChips
              items={RANK_CHIPS}
              current={rank}
              paramKey="rank"
              defaultValue="house_cost"
              ariaNoun="ranking"
            />
          }
        />
        <LiveLeaderboardsRanklist
          active={data.active}
          upcoming={data.upcoming}
          backendUnavailable={data.backendUnavailable}
        />
      </div>
    </FadeIn>
  );
}

// ─── Skeleton ───────────────────────────────────────────────────────

function RanklistSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
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
