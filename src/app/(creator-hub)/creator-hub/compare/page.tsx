import { Suspense } from "react";
import { Scale } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { DASHBOARD_PERIOD_LABELS } from "@/lib/queries/dashboard-period";

import { parseCompareSearchParams } from "./_lib/compare-params";
import { getComparePageData } from "./_queries/compare-creators";
import { ComparePicker } from "./_components/compare-picker";
import { CompareView } from "./_components/compare-view";
import { ComparePeriodControl } from "./_components/compare-period-control";
import { RosterError } from "../creators/_components/roster-error";

export const metadata = { title: "Compare · Creator Hub" };

/**
 * Creator Comparison — side-by-side 2–3 creators (acquisition, cost, ROI,
 * deal). Launch via `?compare=id1,id2` from the roster or multi-select +
 * search on this page.
 *
 * Reuses the roster's batched metrics orchestration (`listRosterCreators`).
 * ACCESS: Hub layout enforces `canAccessCreatorHub`; page adds DAL gate.
 */
export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const params = parseCompareSearchParams(await searchParams);
  const windowLabel = DASHBOARD_PERIOD_LABELS[params.period];

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Scale}
          accent="purple"
          title="Compare Creators"
          subtitle="Side-by-side acquisition, cost, ROI, and deal metrics"
        />
      </PageHero>

      <div className="space-y-3">
        <SectionHeading
          icon={Scale}
          title="Selection"
          action={<ComparePeriodControl current={params.period} />}
        />
        <Suspense
          key={`picker-${params.period}`}
          fallback={<PickerSkeleton />}
        >
          <PickerSection
            selectedIds={params.compare}
            period={params.period}
          />
        </Suspense>
      </div>

      <Suspense
        key={`compare-${params.period}-${params.compare.join(",")}`}
        fallback={<CompareSkeleton count={params.compare.length || 2} />}
      >
        <CompareSection
          selectedIds={params.compare}
          period={params.period}
          windowLabel={windowLabel}
        />
      </Suspense>
    </div>
  );
}

async function PickerSection({
  selectedIds,
  period,
}: {
  selectedIds: string[];
  period: ReturnType<typeof parseCompareSearchParams>["period"];
}) {
  const { pickerCreators, rosterUnavailable } = await getComparePageData(
    selectedIds,
    period,
  );

  if (rosterUnavailable) {
    return <RosterError />;
  }

  return (
    <FadeIn>
      <ComparePicker creators={pickerCreators} selectedIds={selectedIds} />
    </FadeIn>
  );
}

async function CompareSection({
  selectedIds,
  period,
  windowLabel,
}: {
  selectedIds: string[];
  period: ReturnType<typeof parseCompareSearchParams>["period"];
  windowLabel: string;
}) {
  const { selected, missingIds, rosterUnavailable } = await getComparePageData(
    selectedIds,
    period,
  );

  if (rosterUnavailable) {
    return <RosterError />;
  }

  return (
    <FadeIn>
      <CompareView
        creators={selected}
        windowLabel={windowLabel}
        missingIds={missingIds}
      />
    </FadeIn>
  );
}

function PickerSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-9 max-w-md" />
    </div>
  );
}

function CompareSkeleton({ count }: { count: number }) {
  const cols = Math.min(Math.max(count, 2), 3);
  const colClass =
    cols === 2
      ? "grid-cols-1 md:grid-cols-2"
      : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3";
  return (
    <div className="space-y-6">
      <Skeleton className="h-3 w-64" />
      <div className={`grid gap-4 ${colClass}`}>
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-2xl" />
        ))}
      </div>
      {Array.from({ length: 4 }).map((_, s) => (
        <div key={s} className="space-y-3">
          <Skeleton className="h-6 w-32" />
          <div className={`grid gap-4 ${colClass}`}>
            {Array.from({ length: cols }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
