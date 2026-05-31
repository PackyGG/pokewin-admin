import { Skeleton } from "@/components/ui/skeleton";
import {
  KpiStripSkeleton,
  PageHeroSkeleton,
  PaginationSkeleton,
  SectionHeadingSkeleton,
  ToolbarSkeleton,
} from "@/components/loading-skeletons";

export default function UpgraderLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={5} />
      {/* Tier distribution panel skeleton — 7 colour tiers shown as a
          2/4-col grid inside a rounded card to mirror the live layout. */}
      <div className="rounded-2xl border bg-card p-4 sm:p-5">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border bg-background/40 p-3"
            >
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-14" />
              </div>
              <Skeleton className="mt-2 h-5 w-12" />
              <Skeleton className="mt-2 h-1 w-full rounded-full" />
            </div>
          ))}
        </div>
      </div>
      {/* Output cards section: heading + toolbar + grid + pagination,
          matching the live page shell so the swap-in doesn't pop. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton />
        <ToolbarSkeleton filters={2} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {Array.from({ length: 24 }).map((_, i) => (
            <Skeleton
              key={i}
              className="rounded-xl"
              style={{ aspectRatio: "3 / 4.6" }}
            />
          ))}
        </div>
        <PaginationSkeleton />
      </div>
    </div>
  );
}
