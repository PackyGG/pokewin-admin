import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /system/commands docs: hero, 3 KPI tiles, three sections —
 * example queries (2-col grid of cards), quick actions (single card with
 * row list), navigation (multiple grouped cards). Kept generic with simple
 * card placeholders since the real content is dense text-based rows.
 */
export default function CommandsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      <KpiStripSkeleton count={3} />

      {/* Example queries — 2-col grid. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      </div>

      {/* Quick actions — single bordered card. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <Skeleton className="h-48 rounded-xl" />
      </div>

      {/* Navigation — multiple grouped cards. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={110} />
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
