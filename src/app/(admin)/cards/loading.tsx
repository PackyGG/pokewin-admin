import { Skeleton } from "@/components/ui/skeleton";
import { PageHeroSkeleton, KpiStripSkeleton } from "@/components/loading-skeletons";
import {
  EntityTableSkeleton,
  FilterBarSkeleton,
  EntityPaginationSkeleton,
} from "@/components/entity-surface";

/**
 * Route-level skeleton for /cards. Matches the rebuilt frame: hero (create
 * button), 5-tile KPI strip, the filter bar (tabs + search + rarity + price +
 * view toggle), the count line, and the DEFAULT (table) view skeleton —
 * `resolveEntityView` defaults to the dense triage table, so the route-level
 * fallback shows the table shell (the inline page <Suspense> swaps to the grid
 * skeleton when `?view=grid`). CLS-safe: dimensions mirror the live layout.
 */
export default function CardsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={5} />
      <div className="space-y-3">
        <FilterBarSkeleton filters={1} />
        {/* Count-summary line ("Showing N of M cards") placeholder. */}
        <Skeleton className="h-4 w-48" />
        <EntityTableSkeleton rows={14} columns={7} />
        <EntityPaginationSkeleton />
      </div>
    </div>
  );
}
