import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /transactions/[id]: detail hero with status + type badges, 3
 * KPI tiles (Amount / Balance Before / Balance After), and a 2-col
 * Details section. Game session and crypto cards render conditionally.
 *
 * The left card mirrors the InfoRow stack (label + value pairs); the
 * right card stands in for the game-session / crypto panel (header +
 * a small card-image grid). Shaping the rows instead of a flat block
 * keeps the swap-in shift-free and reads as "details are coming".
 */
export default function TransactionDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton />
      <KpiStripSkeleton count={3} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Details card — InfoRow label/value pairs. */}
          <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5">
            <div className="space-y-3">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="flex items-baseline gap-3">
                  <Skeleton className="h-3.5 w-24 shrink-0 rounded" />
                  <Skeleton
                    className="h-3.5 rounded"
                    style={{ width: `${45 + ((i * 13) % 40)}%` }}
                  />
                </div>
              ))}
            </div>
          </div>
          {/* Game-session / detail card — header + card-image grid. */}
          <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5">
            <div className="mb-4 flex items-center gap-2">
              <Skeleton className="size-4 rounded" />
              <Skeleton className="h-4 w-28 rounded" />
            </div>
            <Skeleton className="mb-2 h-3 w-20 rounded" />
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="overflow-hidden rounded-lg border bg-card">
                  <Skeleton className="w-full rounded-none" style={{ aspectRatio: "2 / 3" }} />
                  <div className="space-y-1 p-1.5">
                    <Skeleton className="h-3 w-3/4 rounded" />
                    <Skeleton className="h-3 w-1/2 rounded" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
