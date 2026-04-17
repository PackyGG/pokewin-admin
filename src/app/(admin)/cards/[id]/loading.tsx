import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/** Matches /cards/[id]: detail hero, card image + stats, packs list. */
export default function CardDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <div className="flex gap-8 items-start flex-wrap">
        <Skeleton
          className="rounded-lg shrink-0"
          style={{ width: 200, aspectRatio: "3/4" }}
        />
        <div className="flex-1 grid grid-cols-2 lg:grid-cols-5 gap-x-8 gap-y-5 min-w-[240px]">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={180} />
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton
              key={i}
              className="rounded-xl"
              style={{ aspectRatio: "3/4" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
