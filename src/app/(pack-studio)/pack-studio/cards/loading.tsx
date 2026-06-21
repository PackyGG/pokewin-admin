import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import {
  FilterBarSkeleton,
  EntityTableSkeleton,
  EntityPaginationSkeleton,
} from "@/components/entity-surface";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the Pack Studio Card Editor. Mirrors the
 * page shell — hero, KPI strip, a "Catalog" section heading, the filter bar,
 * and the list — so the first paint matches the eventual layout while the
 * server component resolves access + reads.
 */
export default function CardEditorLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={5} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={90} />
        <FilterBarSkeleton filters={2} />
        <Skeleton className="h-4 w-48" />
        <EntityTableSkeleton rows={14} columns={6} />
        <EntityPaginationSkeleton />
      </div>
    </div>
  );
}
