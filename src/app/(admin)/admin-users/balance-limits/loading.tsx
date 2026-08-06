import { Skeleton } from "@/components/ui/skeleton";
import {
  KpiStripSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /admin-users/balance-limits: PageHero with back arrow + Wallet
 * icon (custom shape — not the standard PageHeroSkeleton because the back
 * link sits inside the hero), 4 KPI tiles, search/add toolbar, and a 7-col
 * table (Admin / Role / Period / Cap / Set By / Updated / Actions).
 */
export default function BalanceLimitsLoading() {
  return (
    <div className="space-y-6">
      {/* Hero — back arrow + icon chip + title/subtitle (no trailing action). */}
      <div className="rounded-2xl border bg-card">
        <div className="p-5 md:p-6">
          <div className="flex items-center gap-3">
            <Skeleton className="size-9 rounded-md" />
            <Skeleton className="size-10 rounded-xl" />
            <div className="space-y-2">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-4 w-72" />
            </div>
          </div>
        </div>
      </div>

      <KpiStripSkeleton count={4} />

      <div className="space-y-4">
        <ToolbarSkeleton filters={1} />
        <TableSkeleton rows={10} columns={7} />
      </div>
    </div>
  );
}
