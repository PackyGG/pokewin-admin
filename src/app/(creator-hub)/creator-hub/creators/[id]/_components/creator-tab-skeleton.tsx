import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shared loading shape for the creator-detail tab area.
 *
 * Every tab opens with the same skeleton (section heading → KPI strip →
 * a band → a table/card of rows), so ONE neutral placeholder covers all of
 * them without the page having to pull a specific tab's module into its graph
 * just to borrow a skeleton (it previously imported `RiskTabSkeleton` from the
 * 500-line risk tab for exactly that).
 */
export function CreatorTabSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="h-5 w-48" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {/* KpiTile chassis = rounded-lg (flat tile standard) */}
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-16 w-full rounded-lg" />
      <Card size="sm" className="space-y-2 p-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </Card>
    </div>
  );
}
