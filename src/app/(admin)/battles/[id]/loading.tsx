import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /battles/[id]: detail hero with status/mode badges + cancel
 * button (only if waiting), conditional 5-tile KPI strip (only on
 * completed battles), a Details section (pack art + InfoRow stack), and
 * a Teams section (2-col team cards with player rows + card grids). The
 * KPI strip is the completed-battle case; rendering it keeps the most
 * common (settled) layout shift-free, and it simply doesn't appear for
 * the brief instant before content for a non-completed battle resolves.
 */
export default function BattleDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <KpiStripSkeleton count={5} />

      {/* Details — pack art beside the InfoRow stack. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5 md:p-6">
          <div className="flex flex-wrap gap-4 sm:gap-6">
            <Skeleton className="h-36 w-24 shrink-0 rounded sm:h-48 sm:w-32" />
            <div className="min-w-0 flex-1 space-y-3 sm:min-w-[240px]">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-baseline gap-3">
                  <Skeleton className="h-3.5 w-20 shrink-0 rounded" />
                  <Skeleton
                    className="h-3.5 rounded"
                    style={{ width: `${40 + ((i * 11) % 35)}%` }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Teams — two team cards, each with a couple of player rows and a
          small card grid. */}
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={70} />
        <div className="grid gap-3 sm:gap-4 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, t) => (
            <div
              key={t}
              className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5"
            >
              <div className="mb-4 flex items-center gap-2">
                <Skeleton className="h-4 w-16 rounded" />
                <Skeleton className="ml-auto h-4 w-16 rounded" />
              </div>
              <div className="space-y-4">
                {Array.from({ length: 2 }).map((_, p) => (
                  <div key={p} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-4 w-24 rounded" />
                      <Skeleton className="h-4 w-12 rounded-full" />
                      <Skeleton className="ml-auto h-4 w-14 rounded" />
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                      {Array.from({ length: 3 }).map((_, c) => (
                        <Skeleton
                          key={c}
                          className="rounded-lg"
                          style={{ aspectRatio: "2 / 3.2" }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
