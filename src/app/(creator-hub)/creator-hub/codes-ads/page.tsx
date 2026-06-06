import { Suspense } from "react";
import { Code2 } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import {
  PageHero,
  PageHeroIdentity,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import {
  KpiStripSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";

import { CodesAdsTabs } from "./_components/codes-ads-tabs";
import { CodesTabContent } from "./_components/codes-tab";
import { AdsTabContent } from "./_components/ads-tab";
import { parseCodesAdsTab } from "./_lib/tab";

export const metadata = { title: "Codes & Ads · Creator Hub" };

/**
 * Creator Hub → Codes & Ads.
 *
 * Hub-styled port of admin `/creators/codes` + `/creators/ads` in one
 * surface with lazy tabs (`?tab=codes` default | `?tab=ads`). Reuses the
 * existing query layer — no duplicated SQL. Ads mutations gate on
 * `requireCreatorHubAccess` + the same capability keys as admin.
 *
 * ACTIVE-TAB-ONLY: only the selected tab's data is fetched on render
 * (Suspense key={tab}).
 */
export default async function CreatorHubCodesAdsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const params = await searchParams;
  const tab = parseCodesAdsTab(params.tab);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Code2}
          accent="pink"
          title="Codes & Ads"
          subtitle="Creator affiliate codes and house campaign tracking — status, ownership, and performance."
        />
      </PageHero>

      <CodesAdsTabs current={tab} />

      <Suspense key={tab} fallback={<CodesAdsTabFallback tab={tab} />}>
        {tab === "codes" ? (
          <CodesTabContent searchParams={params} />
        ) : (
          <AdsTabContent />
        )}
      </Suspense>
    </div>
  );
}

function CodesAdsTabFallback({ tab }: { tab: "codes" | "ads" }) {
  if (tab === "ads") {
    return (
      <div className="space-y-6">
        <div className="flex justify-end gap-2">
          <Skeleton className="h-6 w-32 rounded-full" />
          <Skeleton className="h-9 w-36 rounded-md" />
        </div>
        <KpiStripSkeleton count={6} />
        <Skeleton className="h-20 rounded-2xl" />
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <KpiStripSkeleton count={3} />
      <div className="space-y-4">
        <ToolbarSkeleton filters={0} />
        <TableSkeleton rows={12} columns={4} />
        <PaginationSkeleton />
      </div>
    </div>
  );
}
