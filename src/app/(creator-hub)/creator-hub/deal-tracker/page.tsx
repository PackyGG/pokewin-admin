import { Suspense } from "react";
import {
  CalendarRange,
  HandCoins,
  Trophy,
  Clock,
  Flag,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/utils/format";

import { HubKpiBox } from "../_components/hub-kpi-box";
import {
  getDealTimeline,
  parseDealTrackerWindow,
  DEAL_TRACKER_WINDOWS,
} from "./_queries/deal-timeline";
import { DealTimeline } from "./_components/deal-timeline";
import { DealTrackerWindowSelector } from "./_components/deal-tracker-window-selector";

export const metadata = { title: "Deal Tracker · Creator Hub" };

/**
 * Creator Hub — Deal Tracker.
 *
 * A chronological timeline of deal windows and affiliate leaderboard
 * milestones (starts + ends), built on the existing backend creator roster
 * and approved-leaderboard walks — no new MAIN schema.
 *
 * ACCESS: `canAccessCreatorHub` — enforced explicitly in addition to the
 * layout gate.
 */
export default async function CreatorHubDealTrackerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const window = parseDealTrackerWindow((await searchParams).window);
  const windowLabel =
    DEAL_TRACKER_WINDOWS.find((w) => w.value === window)?.label ?? "30 days";

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={CalendarRange}
            accent="cyan"
            title="Deal Tracker"
            subtitle={`Deal windows & leaderboard milestones · ±${windowLabel}`}
          />
          <DealTrackerWindowSelector current={window} />
        </div>
      </PageHero>

      <Suspense key={window} fallback={<DealTrackerSkeleton />}>
        <DealTrackerSection trackerWindow={window} />
      </Suspense>
    </div>
  );
}

async function DealTrackerSection({
  trackerWindow,
}: {
  trackerWindow: ReturnType<typeof parseDealTrackerWindow>;
}) {
  const data = await getDealTimeline(trackerWindow);

  return (
    <FadeIn className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <HubKpiBox
          label="Upcoming"
          icon={Clock}
          accent="blue"
          value={formatNumber(data.counts.upcoming)}
          sub="milestones ahead"
        />
        <HubKpiBox
          label="Deal ends"
          icon={Flag}
          accent="rose"
          value={formatNumber(data.counts.dealEnds)}
          sub="weekly windows closing"
        />
        <HubKpiBox
          label="Deal starts"
          icon={HandCoins}
          accent="emerald"
          value={formatNumber(data.counts.dealStarts)}
          sub="new / renewed deals"
        />
        <HubKpiBox
          label="LB ends"
          icon={Trophy}
          accent="rose"
          value={formatNumber(data.counts.lbEnds)}
          sub="leaderboards wrapping up"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={CalendarRange} title="Timeline" />
        <DealTimeline
          events={data.events}
          backendUnavailable={data.backendUnavailable}
        />
      </div>
    </FadeIn>
  );
}

function DealTrackerSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
