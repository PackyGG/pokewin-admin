import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";

/**
 * Mirrors /changelogs: hero with right-side action, 3-tile KPI strip,
 * section heading, then a stack of changelog cards. Each card skeleton
 * approximates the badge row + title + summary + 4 bullet rows + footer
 * so the swap to real content doesn't jank.
 */
export default function ChangelogsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={3} />
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="h-4 w-24" />
      </div>
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <ChangelogCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

function ChangelogCardSkeleton() {
  return (
    <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-20" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="size-4 shrink-0 rounded" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-border/40 pt-3">
        <Skeleton className="h-3 w-24" />
        <div className="flex gap-1">
          <Skeleton className="h-7 w-14" />
          <Skeleton className="h-7 w-16" />
        </div>
      </div>
    </div>
  );
}
